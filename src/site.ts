/**
 * The generated site around the emitted pages: everything under
 * <docs>/.vitepress/, the docs-dir package.json that anchors the vitepress
 * install, the generated changelog page, a landing page while the user has
 * none, and a docs-dir .gitignore when none exists. Also owns guide-page
 * discovery, which llms.txt shares.
 *
 * The config is ONE baked string with luaudocs.toml's values inlined: no
 * runtime merge, no site-meta module. Users customize through luaudocs.toml and
 * the optional custom.css beside their index.md.
 *
 * Only value-dependent output is baked here. Everything with behavior of its
 * own lives under templates/runtime/ and is synced verbatim.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join, relative } from "node:path";
import pkg from "../package.json";
import { filesUnder, writeIfChanged, syncDir, SITE_DEPENDENCIES, type BuildContext } from "./build";
import { repoFileUrl, type LuauDocsConfig, type NavItem } from "./config";
import { packageRoot } from "./extract";
import {
	frontmatter,
	frontmatterField as field,
	mapOutsideCodeSpans,
	mapOutsideFences,
	moonwaveStaticTarget,
	outsideFences,
	imageReferenceLabels,
	rewriteTargets,
	stripFrontmatter,
	summarize,
	type TargetSlot,
} from "./markdown";
import type { SidebarItem } from "./nav";
import {
	API_DIR,
	compareTitles,
	generatedFrontmatter,
	GENERATED_MARK,
	isGeneratedFile,
	toPosix,
} from "./pages";
import type { TrailSegment } from "../templates/runtime/markup";
import { LANGUAGES } from "../templates/runtime/inline-highlight";

/*
 * ------------------------------------------------------------- guide discovery
 */

/** A sidebar node: a group carries `items`, a leaf carries `page`. */
export interface GuideItem {
	text: string;
	link?: string;
	items?: GuideItem[];
	order: number;
	/** a group's configured initial state, and whether it may toggle at all;
	 * either left unset takes the default for where the group sits */
	collapsed?: boolean;
	collapsible?: boolean;
	page?: DocPage;
	/** a leaf's source path under the guide dir: the key its trail is baked under */
	file?: string;
}

/** One markdown page, as llms.txt lists it. */
export interface DocPage {
	title: string;
	/** Site-relative and extensionless: "/guide/getting-started". */
	link: string;
	/** The raw markdown, kept so llms-full.txt never re-reads these files. */
	text: string;
	/** Frontmatter `description`, else the page's first prose sentence. */
	description?: string;
}

/** The site landing page, more often a VitePress hero than a real page. */
export interface HomePage {
	/** `hero.tagline`: the one summary a hero page carries. */
	tagline?: string;
	/** Absent for a hero page: frontmatter cards, with no prose to index. */
	page?: DocPage;
}

/** "getting-started" -> "Getting Started": the no-frontmatter fallback. */
function humanize(name: string): string {
	return name.replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

/** The first `# ` heading outside fenced code, so an opening example's
 * `# install` comment line is not read as the page title. */
function firstHeading(text: string): string | undefined {
	for (const segment of outsideFences(text)) {
		const heading = segment.match(/^#\s+(.+)$/m)?.[1]?.trim();
		if (heading !== undefined) {
			return heading;
		}
	}
	return undefined;
}

/**
 * The description takes frontmatter verbatim, since a hand-written summary is
 * already short, and only trims a derived paragraph to its first sentence.
 */
function docPage(text: string, file: string, link: string): DocPage {
	const block = frontmatter(text);
	// frontmatter comes off first: a `#` YAML comment there (the generated
	// landing page's marker line) would otherwise read as the first heading
	const heading = firstHeading(stripFrontmatter(text));
	const name = basename(file, ".md");
	return {
		title:
			field(block, "sidebar_label|title") ??
			heading ??
			(name === "index" ? "Overview" : humanize(name)),
		link,
		text,
		description: field(block, "description") ?? summarize(text),
	};
}

/** A docs-dir markdown path as the route it serves at: index.md collapses to
 * its directory, and .md drops. */
function pageRoute(rel: string): string {
	return rel.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, "");
}

/** Declaring no position sorts last, where ties fall back to the label. */
const UNORDERED = Number.POSITIVE_INFINITY;

/** An index page leads its folder, ahead of any position a sibling declares. */
const LEADS = Number.NEGATIVE_INFINITY;

/** The sidecar a folder's group settings live in, as docusaurus (and so
 * moonwave) spelled it. */
export const CATEGORY_FILES = ["_category_.json", "_category_.yml", "_category_.yaml"];

/** The keys read out of one, for the moonwave converter to report the rest. */
export const CATEGORY_KEYS = ["label", "position", "collapsed", "collapsible"] as const;
type CategoryKey = (typeof CATEGORY_KEYS)[number];

/**
 * A sidecar's top-level keys. The YAML spelling is read as the flat map it is,
 * each key through the frontmatter reader, so a nested value (a docusaurus
 * category `link`) is a key with nothing to read. A file that does not parse
 * is a typo in the user's own configuration, so it fails with its name rather
 * than ordering the sidebar by accident.
 */
export function parseCategory(file: string, text: string): Record<string, unknown> {
	if (!file.endsWith(".json")) {
		const record: Record<string, unknown> = {};
		for (const [, key] of text.matchAll(/^([A-Za-z_][\w-]*):/gm)) {
			record[key!] = field(text, key!);
		}
		return record;
	}
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch (error) {
		throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		throw new Error(`${file}: expected an object of sidebar keys`);
	}
	return data as Record<string, unknown>;
}

/**
 * The position a source declares: any number docusaurus accepts, so a
 * migrated `2.5` still slots between 2 and 3. Anything else sorts as if
 * unset: `Number("high")` is NaN, which would misplace the item among the
 * ones that did declare a position.
 */
function declaredOrder(declared: string | undefined): number {
	return /^-?\d+(\.\d+)?$/.test(declared ?? "") ? Number(declared) : UNORDERED;
}

/** A YAML boolean as YAML reads it: docusaurus accepted `True` in these files. */
function flag(value: string | undefined): boolean | undefined {
	const lower = value?.toLowerCase();
	return lower === "true" ? true : lower === "false" ? false : undefined;
}

/** One guide page, with the ordering key frontmatter can override. */
function guideEntry(abs: string, rel: string): GuideItem {
	const text = readFileSync(abs, "utf8");
	const page = docPage(text, abs, "/guide/" + pageRoute(rel));
	// an index page is the landing page of the folder it sits in, so it leads
	// that group; its own position places the folder, not the page
	const order =
		basename(abs) === "index.md"
			? LEADS
			: declaredOrder(field(frontmatter(text), "sidebar_position|order"));
	return { text: page.title, link: page.link, order, page, file: rel };
}

/**
 * A subdirectory's group entry, configured by the `_category_` sidecar beside
 * its pages or by the index.md that *is* the folder, the sidecar winning key
 * by key. `label` is the sidecar's alone: an index page's title names that
 * page, which leads the group, rather than naming the group.
 */
function folderEntry(dir: string, name: string, items: GuideItem[]): GuideItem {
	const file = CATEGORY_FILES.map((base) => join(dir, base)).find((path) => existsSync(path));
	const sidecar = file === undefined ? {} : parseCategory(file, readFileSync(file, "utf8"));
	const scalar = (key: CategoryKey): string | undefined => {
		const value = sidecar[key];
		// a structured value (a docusaurus category `link`) means nothing
		// here, and `typeof null` covers the null case with it
		return value !== undefined && typeof value !== "object" ? String(value) : undefined;
	};
	// the index page's frontmatter, from the walk that already read it
	const index = items.find((item) => item.file?.endsWith("/index.md"));
	const own = index?.page === undefined ? "" : frontmatter(index.page.text);
	const read = (key: CategoryKey, ownKey: string = key): string | undefined =>
		scalar(key) ?? field(own, ownKey);
	return {
		text: scalar("label") ?? humanize(name),
		items,
		order: declaredOrder(read("position", "sidebar_position|order")),
		collapsed: flag(read("collapsed")),
		collapsible: flag(read("collapsible")),
	};
}

/**
 * What the guide walk and the VitePress build both leave out: a folder or page
 * whose name starts with an underscore, the convention docusaurus (and so
 * moonwave) reads for partials and drafts. The build must skip them too, or
 * an unlisted page would still be a route and a search hit.
 */
const GUIDE_EXCLUDE = ["guide/**/_*.md", "guide/**/_*/**"];

/**
 * Guide pages sorted by frontmatter order then label; subdirectories nest.
 * Each folder sorts its own children, so a position is only ever read against
 * its siblings and a subdirectory numbers from 1 like the pages beside it.
 */
function guideItems(dir: string, prefix: string): GuideItem[] {
	const items: GuideItem[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith("_")) {
			continue;
		}
		if (entry.isDirectory()) {
			const sub = join(dir, entry.name);
			const children = guideItems(sub, `${prefix}${entry.name}/`);
			if (children.length > 0) {
				items.push(folderEntry(sub, entry.name, children));
			}
		} else if (entry.name.endsWith(".md")) {
			items.push(guideEntry(join(dir, entry.name), prefix + entry.name));
		}
	}
	items.sort((a, b) => a.order - b.order || compareTitles(a.text, b.text));
	return items;
}

/** The guide tree under `docsDir`, in the order the sidebar renders it. */
export function collectGuides(docsDir: string): GuideItem[] {
	const guideDir = join(docsDir, "guide");
	return existsSync(guideDir) ? guideItems(guideDir, "") : [];
}

/** The tree's leaves, depth-first: sidebar order is reading order. */
export function flattenGuides(items: GuideItem[]): DocPage[] {
	return items.flatMap((item) =>
		item.items ? flattenGuides(item.items) : item.page ? [item.page] : [],
	);
}

/**
 * Where a "Guide" navbar or hero entry lands: the tree's first page. The one
 * derivation, shared by the build and `init`'s moonwave conversion.
 */
export function firstGuidePage(guides: GuideItem[]): string | undefined {
	return flattenGuides(guides)[0]?.link;
}

/** A page outside the guide tree (the generated changelog), or undefined. */
export function readDocPage(file: string, link: string): DocPage | undefined {
	return existsSync(file) ? docPage(readFileSync(file, "utf8"), file, link) : undefined;
}

/**
 * A `layout: home` page is frontmatter cards with no prose body worth indexing,
 * but its tagline is the site summary when luaudocs.toml sets no description.
 * Any other index.md is an ordinary page, listed at the site root.
 */
export function readHomePage(docsDir: string): HomePage | undefined {
	const file = join(docsDir, "index.md");
	if (!existsSync(file)) {
		return undefined;
	}
	const text = readFileSync(file, "utf8");
	const block = frontmatter(text);
	if (field(block, "layout") === "home") {
		// `tagline` is unique to the hero; `text` also names every action button
		return { tagline: field(block, "tagline", "[ \\t]+") };
	}
	return { page: docPage(text, file, "/") };
}

/*
 * --------------------------------------------------------------- baked modules
 */

const GENERATED_NOTE = "// Generated by luaudocs; regenerated by every build. Do not edit.";

/** A value spliced into the baked config, re-indented to its nesting depth. */
function inlined(value: unknown, depth: number): string {
	return JSON.stringify(value, null, "\t").replace(/\n/g, `\n${"\t".repeat(depth)}`);
}

/**
 * The navbar row a site with no [[site.nav]] gets. Exported for the moonwave
 * converter, which must bake it ahead of converted navbar items: they appended
 * to this row in moonwave, while [[site.nav]] replaces it.
 */
export function derivedNav(
	guideLink: string | undefined,
	hasApi: boolean,
	hasChangelog: boolean,
): NavItem[] {
	return [
		// Guide and API each link one page of a section, so they carry the
		// pattern that keeps them lit across the rest of it; the changelog is a
		// single page, and its own link already marks it.
		...(guideLink ? [{ text: "Guide", link: guideLink, activeMatch: "^/guide/" }] : []),
		...(hasApi ? [{ text: "API", link: "/api/", activeMatch: "^/api/" }] : []),
		...(hasChangelog ? [{ text: "Changelog", link: "/changelog" }] : []),
	];
}

/**
 * A group's baked `collapsed` key. VitePress reads a group carrying none as
 * one that never collapses, which is what `collapsible: false` asks for and
 * what a section heading the sidebar (`top`) gets unless it declares either
 * key; a nested group nothing configures is collapsible, and open.
 */
function collapsedKey(item: GuideItem, top: boolean): { collapsed?: boolean } {
	const collapsible = item.collapsible ?? (!top || item.collapsed !== undefined);
	return collapsible ? { collapsed: item.collapsed ?? false } : {};
}

/**
 * The guide sidebar: only text/link/items reach the site config. The pages
 * sit under one "Guide" section, unless `guide/` holds nothing but folders:
 * then each folder heads a section of its own, since a lone "Guide" heading
 * over a column of groups would say nothing the navbar entry does not.
 */
function guideSidebarItems(guides: GuideItem[]): SidebarItem[] {
	const strip = (items: GuideItem[], top: boolean): SidebarItem[] =>
		items.map((item) => ({
			text: item.text,
			...(item.link !== undefined ? { link: item.link } : {}),
			...(item.items !== undefined
				? { ...collapsedKey(item, top), items: strip(item.items, false) }
				: {}),
		}));
	if (guides.length === 0) {
		return [];
	}
	return guides.every((item) => item.items !== undefined)
		? strip(guides, true)
		: [{ text: "Guide", items: strip(guides, false) }];
}

const HOME: TrailSegment = { text: "Home", link: "/" };

/**
 * What sits above each page, keyed by the docs-relative markdown file VitePress
 * renders it from: the lookup the render-time rule does per page.
 *
 * Two trees meet here: the API's comes from the emitter (the access path), a
 * guide's is its folders. Both hang off Home, so only the landing page is left
 * without one. A page never appears in its own trail, which is what drops a
 * folder's segment from the index page that *is* that folder.
 */
export function pageTrails(
	guides: GuideItem[],
	apiTrails: Map<string, TrailSegment[]> | undefined,
	changelog: boolean,
): Record<string, TrailSegment[]> {
	const trails: Record<string, TrailSegment[]> = {};
	const walk = (items: GuideItem[], above: TrailSegment[]) => {
		for (const item of items) {
			if (item.items !== undefined) {
				// a folder links to its own index.md when it has one, and is
				// plain text when it does not
				const index = item.items.find((child) => child.file?.endsWith("/index.md"));
				walk(item.items, [...above, { text: item.text, link: index?.link }]);
			} else if (item.file !== undefined) {
				const last = above[above.length - 1];
				trails[`guide/${item.file}`] =
					last?.link === item.link ? above.slice(0, -1) : above;
			}
		}
	};
	walk(guides, [HOME]);
	// the API index is in the emitter's map with an empty trail: it is the API's
	// own root, so only Home ends up above it
	for (const [file, trail] of apiTrails ?? []) {
		trails[`${API_DIR}/${file}`] = [HOME, ...trail];
	}
	if (changelog) {
		trails["changelog.md"] = [HOME];
	}
	return trails;
}

/** The baked trail map the render-time rule reads, one entry per page. */
function trailsModule(trails: Record<string, TrailSegment[]>): string {
	return [
		GENERATED_NOTE,
		'import type { PageTrails } from "./markup.ts";',
		"",
		`export const pageTrails: PageTrails = ${inlined(trails, 0)};`,
		"",
	].join("\n");
}

/** The baked sidebar data module the config imports both sidebars from. */
function sidebarModule(apiSidebar: SidebarItem[], guideSidebar: SidebarItem[]): string {
	return [
		GENERATED_NOTE,
		'import type { DefaultTheme } from "vitepress";',
		"",
		`export const apiSidebar: DefaultTheme.SidebarItem[] = ${inlined(apiSidebar, 0)};`,
		"",
		`export const guideSidebar: DefaultTheme.SidebarItem[] = ${inlined(guideSidebar, 0)};`,
		"",
	].join("\n");
}

/**
 * `[docs] url`'s path as the site base ("/repo/" for a project-pages deploy),
 * or undefined when the site sits at a domain root. Shared with the README
 * rewrite, which mints site-absolute targets VitePress will not prefix.
 */
function siteBase(config: LuauDocsConfig): string | undefined {
	if (!config.docs.url) {
		return undefined;
	}
	const path = new URL(config.docs.url).pathname.replace(/\/?$/, "/");
	return path === "/" ? undefined : path;
}

/**
 * A site-absolute path with the base prefixed, for the slots nothing else
 * prefixes: head tags, and a README's raw HTML hrefs.
 */
function withBase(base: string | undefined, path: string): string {
	return `${base ?? "/"}${path.replace(/^\//, "")}`;
}

/**
 * The whole .vitepress/config.mts, luaudocs.toml's values inlined. Nothing is
 * computed per serve and nothing merges a user config: the baked string IS the
 * config.
 */
function renderConfigMts(
	config: LuauDocsConfig,
	guideLink: string | undefined,
	hasApi: boolean,
	changelog: boolean,
): string {
	const repo = config.repo;
	const onGitHub = repo !== undefined && repo.url.startsWith("https://github.com/");
	const docsUrl = config.docs.url;

	// `[docs] url`'s path: a project-pages deploy needs it as the site base
	const base = siteBase(config);
	// public/ assets referenced from head tags must carry the base themselves,
	// and og:image must be absolute for crawlers, so it resolves against
	// [docs] url (which config validation stores with no trailing slash)
	const absolute = (path: string) =>
		docsUrl ? new URL(path.replace(/^\//, ""), `${docsUrl}/`).href : withBase(base, path);

	const head: Array<[string, Record<string, string>] | [string, Record<string, string>, string]> =
		[];
	if (config.site.favicon) {
		head.push(["link", { rel: "icon", href: withBase(base, config.site.favicon) }]);
	}
	head.push(["meta", { property: "og:site_name", content: config.title }]);
	head.push(["meta", { property: "og:title", content: config.title }]);
	head.push(["meta", { property: "og:type", content: "website" }]);
	if (config.description) {
		head.push(["meta", { property: "og:description", content: config.description }]);
	}
	if (docsUrl) {
		head.push(["meta", { property: "og:url", content: docsUrl }]);
	}
	if (config.site.ogImage) {
		head.push(["meta", { property: "og:image", content: absolute(config.site.ogImage) }]);
		head.push(["meta", { name: "twitter:card", content: "summary_large_image" }]);
	}
	// [[site.head]] verbatim, after the derived tags: analytics and site
	// verification, which the two customization files cannot express
	for (const entry of config.site.head ?? []) {
		const attrs = entry.attrs ?? {};
		head.push(
			entry.content === undefined ? [entry.tag, attrs] : [entry.tag, attrs, entry.content],
		);
	}

	// [[site.nav]] verbatim, or Guide/API/Changelog derived from what the site has
	const nav: NavItem[] = config.site.nav ?? derivedNav(guideLink, hasApi, changelog);

	const lines: string[] = [
		`\ttitle: ${JSON.stringify(config.title)},`,
		...(config.description !== undefined
			? [`\tdescription: ${JSON.stringify(config.description)},`]
			: []),
		"\tcleanUrls: true,",
		"\tlastUpdated: true,",
		`\tsrcExclude: ${JSON.stringify(GUIDE_EXCLUDE)},`,
		...(base !== undefined ? [`\tbase: ${JSON.stringify(base)},`] : []),
		...(docsUrl ? [`\tsitemap: { hostname: ${JSON.stringify(docsUrl)} },`] : []),
		`\thead: ${inlined(head, 1)},`,
		"\tmarkdown: {",
		'\t\tdefaultHighlightLang: "luau",',
		"\t\t// pre-loaded for the synchronous inline highlighter, off the list that",
		"\t\t// also gates which `{lang}` inline annotations are honored",
		`\t\tlanguages: [${LANGUAGES.map((lang) => JSON.stringify(lang)).join(", ")}],`,
		// the base is passed in: a signature link is raw HTML in Shiki's hast,
		// the one link slot VitePress does not prefix
		`\t\tcodeTransformers: [decodeLinks(), signatureLinks(${JSON.stringify(base ?? "/")})],`,
		"\t\tshikiSetup(shiki) {",
		"\t\t\thighlighter = shiki;",
		"\t\t},",
		"\t\tconfig(md) {",
		"\t\t\t// the markup rewrites and the page trail, over the raw page source",
		"\t\t\t// before parsing, so `<Frame>`, `<Tabs>` and `:::note` work in guide",
		"\t\t\t// pages and doc comments alike; fenced examples showing the syntax",
		"\t\t\t// are left alone",
		"\t\t\tinstallMarkupRule(md, pageTrails);",
		"\t\t\tinlineHighlightPlugin(md, () => highlighter);",
		"\t\t\t// inline whitespace Vue's compiler would otherwise drop",
		"\t\t\twhitespacePlugin(md);",
		"\t\t\t// tab and title-bar icons, keyed off the `data-title` every tab",
		"\t\t\t// strip carries; installed before the relay so a signature fence's",
		"\t\t\t// link payload is already encoded, not read as a `[title]`",
		"\t\t\tmd.use(groupIconMdPlugin);",
		"\t\t\t// installed last, so the links relay is the outermost fence renderer",
		"\t\t\trelayLinks(md);",
		"\t\t},",
		"\t},",
		"\tthemeConfig: {",
		"\t\toutline: { level: [2, 3] },",
		'\t\tsearch: { provider: "local" },',
		// `false` is a value here (logo-only navbar), so the test is presence
		...(config.site.siteTitle !== undefined
			? [`\t\tsiteTitle: ${JSON.stringify(config.site.siteTitle)},`]
			: []),
		...(config.site.logo ? [`\t\tlogo: ${inlined(config.site.logo, 2)},`] : []),
		...(config.site.footer ? [`\t\tfooter: ${inlined(config.site.footer, 2)},`] : []),
		...(nav.length > 0 ? [`\t\tnav: ${inlined(nav, 2)},`] : []),
		'\t\tsidebar: { "/api/": apiSidebar, "/guide/": guideSidebar },',
		...(onGitHub && repo
			? [
					"\t\teditLink: {",
					`\t\t\tpattern: ${JSON.stringify(
						`${repo.url}/edit/${repo.branch}/${toPosix(config.docs.dir)}/:path`,
					)},`,
					'\t\t\ttext: "Edit this page on GitHub",',
					"\t\t},",
					`\t\tsocialLinks: [{ icon: "github", link: ${JSON.stringify(repo.url)} }],`,
				]
			: []),
		"\t},",
		"\tvite: {",
		"\t\tplugins: [searchIndexCachePlugin(), groupIconVitePlugin({ customIcon: codeIcons })],",
		"\t},",
	];

	return [
		GENERATED_NOTE,
		"//",
		"// The VitePress entry for this site, baked from luaudocs.toml by every",
		"// build. Site options belong in luaudocs.toml; styling belongs in the",
		"// custom.css beside your index.md.",
		'import type { Highlighter } from "shiki";',
		'import { defineConfig } from "vitepress";',
		'import { groupIconMdPlugin, groupIconVitePlugin } from "vitepress-plugin-group-icons";',
		'import { codeIcons } from "./generated/icons.ts";',
		'import { installMarkupRule } from "./generated/markup.ts";',
		'import { inlineHighlightPlugin } from "./generated/inline-highlight.ts";',
		'import { searchIndexCachePlugin } from "./generated/search-cache.ts";',
		'import { whitespacePlugin } from "./generated/whitespace.ts";',
		'import { decodeLinks, relayLinks, signatureLinks } from "./generated/signature-links.ts";',
		'import { apiSidebar, guideSidebar } from "./generated/sidebar.ts";',
		'import { pageTrails } from "./generated/trails.ts";',
		"",
		"// VitePress's own highlighter, captured by shikiSetup below for the inline",
		"// plugin: no second Shiki instance exists, and inline code follows the",
		"// fenced examples' themes for free.",
		"let highlighter: Highlighter | undefined;",
		"",
		"export default defineConfig({",
		...lines,
		"});",
		"",
	].join("\n");
}

/** The theme entry: the default theme plus the styles the pages depend on. */
function renderThemeEntry(hasCustomCss: boolean): string {
	return [
		GENERATED_NOTE,
		'import DefaultTheme from "vitepress/theme";',
		// the icon rules the group-icons vite plugin mints for the titles this
		// site actually uses; without this import the tab strips render bare
		'import "virtual:group-icons.css";',
		'import "../generated/luaudocs.css";',
		...(hasCustomCss ? ['import "../../custom.css";'] : []),
		"",
		"export default DefaultTheme;",
		"",
	].join("\n");
}

/** Title -> package-name-safe slug for the generated docs package. */
function projectSlug(title: string): string {
	return (
		title
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "project"
	);
}

/**
 * Sits at the docs root rather than inside .vitepress/: compiled markdown
 * pages import vue, and bare imports resolve only *upward*. Ranges come from
 * the tool's own devDependencies, where vitepress is pinned exactly (a caret
 * would pull the next alpha into every fresh install). Shiki appears nowhere:
 * the runtime modules import only its types.
 */
function docsPackageJson(title: string): string {
	return `${JSON.stringify(
		{
			"//": "Generated by luaudocs; regenerated by every build. Do not edit.",
			name: `${projectSlug(title)}-docs`,
			private: true,
			type: "module",
			devDependencies: Object.fromEntries(
				SITE_DEPENDENCIES.map((name) => [name, pkg.devDependencies[name]]),
			),
		},
		null,
		"\t",
	)}\n`;
}

/*
 * ------------------------------------------------------------------- the sync
 */

/**
 * The directory listing is the manifest (through the same walk the packaged
 * template trees use, so it is sorted and reaches subdirectories), and a module
 * added there ships without a second list to update. Read once: the dev watcher
 * re-syncs the runtime on every rebuild.
 *
 * Bytes, not text: the directory holds a font as well as source, and a utf8
 * round-trip would corrupt it. Text survives one, so there is no extension
 * list to keep in step with the directory.
 */
let templateCache: Map<string, Buffer> | undefined;
function runtimeTemplates(): Map<string, Buffer> {
	if (!templateCache) {
		const dir = join(packageRoot(), "templates", "runtime");
		templateCache = new Map(filesUnder(dir).map(({ abs, rel }) => [rel, readFileSync(abs)]));
	}
	return templateCache;
}

const MISSING_README_WARNING =
	"warning: [docs] includeReadme is enabled but README.md was not found";

/**
 * The build's README copy, under .vitepress/. Three sites read this path: the
 * sync writes it, the landing page @includes it, and the warning below looks
 * for that include in a user-owned index.md.
 */
const README_COPY = "generated/readme.md";

/** moonwave's README hide markers, honored by `[docs] includeReadme`. */
const HIDE_BEFORE = "<!--moonwave-hide-before-this-line-->";
const HIDE_AFTER = "<!--moonwave-hide-after-this-line-->";

/**
 * A target a forge resolves against the repository root, split into its
 * normalized path and untouched `#`/`?` suffix so a caller can respell one and
 * keep the other. Anything that resolves without help is undefined: scheme'd
 * URLs, protocol-relative and site-absolute paths, bare anchors and queries. A
 * path climbing above the root is deliberately NOT one of them, or it would
 * ship unrewritten and unreported.
 */
function repoRelativeTarget(target: string): { path: string; suffix: string } | undefined {
	if (/^(?:[a-z][a-z0-9+.-]*:|\/|[#?])/i.test(target)) {
		return undefined;
	}
	const cut = target.search(/[#?]/);
	const suffix = cut === -1 ? "" : target.slice(cut);
	const path = (cut === -1 ? target : target.slice(0, cut)).replace(/^(?:\.\/)+/, "");
	return path === "" ? undefined : { path, suffix };
}

/**
 * README.md trimmed to the markers, for the landing page's @include, with its
 * link targets respelled for the site. `unresolved` lists the targets nothing
 * could be pointed at, for the caller to warn about: left as written they fail
 * VitePress's dead-link check, which names no cause.
 */
function readmeInclude(context: BuildContext): { text: string; unresolved: string[] } | undefined {
	const readmePath = join(context.root, "README.md");
	if (!existsSync(readmePath)) {
		return undefined;
	}
	let content = readFileSync(readmePath, "utf8");
	const before = content.lastIndexOf(HIDE_BEFORE);
	if (before !== -1) {
		content = content.slice(before + HIDE_BEFORE.length);
	}
	const after = content.indexOf(HIDE_AFTER);
	if (after !== -1) {
		content = content.slice(0, after);
	}
	const trimmed = `${content.trim()}\n`;
	const repo = context.config.repo;
	// `[docs] dir` as the prefix a repository-relative target matches against;
	// "" when the docs dir IS the root, so every such target sits inside it
	const dir = toPosix(relative(context.root, context.docsDir));
	const docsPrefix = dir === "" ? "" : `${dir}/`;
	// a raw HTML href is the one slot nothing else bases: VitePress bases a
	// markdown link itself, and Vite resolves an image or `src` as an asset
	// import, which a target already carrying the base fails
	const base = siteBase(context.config);
	const rooted = (path: string, slot: TargetSlot) =>
		slot === "href" ? withBase(base, path) : path;
	const unresolved = new Set<string>();
	// each target respells to whatever serves the same content on the site: a
	// .moonwave/static/ asset from the public/ copy, a docs-dir file from its
	// own page or asset URL, any other repository file straight from [repo]
	const convert = (target: string, slot: TargetSlot): string => {
		const rel = repoRelativeTarget(target);
		if (rel === undefined) {
			return target;
		}
		// the conversion copies .moonwave/static/ into public/, so a target
		// reaching into it IS a docs-dir public/ asset and routes as one below
		// -- but only where that copy actually happened, since plain `init` on
		// a moonwave repo leaves public/ without it
		const fromStatic = moonwaveStaticTarget(rel.path);
		const path =
			fromStatic !== undefined &&
			existsSync(join(context.docsDir, "public", fromStatic.slice(1)))
				? `${docsPrefix}public${fromStatic}`
				: rel.path;
		if (path.startsWith(docsPrefix)) {
			const below = path.slice(docsPrefix.length);
			if (below.startsWith("public/")) {
				return rooted(`/${below.slice("public/".length)}${rel.suffix}`, slot);
			}
			if (below.endsWith(".md")) {
				return rooted(`/${pageRoute(below)}${rel.suffix}`, slot);
			}
			// anything else in the docs dir is not served; fall through to [repo]
		}
		// `..` climbs out of what either side serves; a forge's blob page is
		// HTML, not the bytes an inline slot needs
		if (repo !== undefined && !rel.path.split("/").includes("..")) {
			const inline = slot === "image" || slot === "src";
			return `${repoFileUrl(repo, rel.path, inline)}${rel.suffix}`;
		}
		unresolved.add(target);
		return target;
	};
	// whole-document: the mapping below hands rewriteTargets one stretch of
	// prose at a time, and a definition sits nowhere near its uses
	const imageLabels = imageReferenceLabels(trimmed);
	// code that shows such a path is a mention, and stays verbatim
	const text = mapOutsideFences(trimmed, (segment) =>
		mapOutsideCodeSpans(segment, (prose) => rewriteTargets(prose, convert, imageLabels)),
	);
	return { text, unresolved: [...unresolved] };
}

/*
 * ---------------------------------------------------------------- landing page
 */

const INDEX_MARKER = [
	`${GENERATED_MARK}; rewritten by every build. Replace this file (or just`,
	"# delete this comment) to take over the landing page.",
];

/** The hero's action buttons: Get Started onto the first guide page, and the
 * API reference, which takes the accent theme when it stands alone. */
export function heroActions(
	guideLink: string | undefined,
	hasApi: boolean,
): Array<{ theme: string; text: string; link: string }> {
	return [
		...(guideLink ? [{ theme: "brand", text: "Get Started", link: guideLink }] : []),
		...(hasApi
			? [{ theme: guideLink ? "alt" : "brand", text: "API Reference", link: "/api/" }]
			: []),
	];
}

/**
 * One VitePress home-layout page, shared by the generated landing below and
 * the moonwave homepage conversion, so the two heroes cannot drift.
 */
export function homeLayoutPage(options: {
	/** Frontmatter comment lines (the generated marker); without them the page
	 * is user-owned from the start. */
	marker?: string[];
	title: string;
	tagline?: string;
	image?: string;
	actions: Array<{ theme: string; text: string; link: string }>;
	features?: Array<{ title: string; details?: string; iconSrc?: string }>;
	/** Appends the README through the build's generated copy, which
	 * `[docs] includeReadme` keeps fresh. */
	includeReadme?: boolean;
}): string {
	const lines = [
		"---",
		...(options.marker ?? []),
		// a marked page is rewritten by every build, so VitePress's edit-link and
		// last-updated affordances would send readers to a file their edits
		// cannot survive in. A page with no marker is the user's: it keeps both.
		...(options.marker !== undefined ? ["editLink: false", "lastUpdated: false"] : []),
		"layout: home",
		"",
		"hero:",
		`  name: ${JSON.stringify(options.title)}`,
		...(options.tagline !== undefined ? [`  tagline: ${JSON.stringify(options.tagline)}`] : []),
		...(options.image !== undefined ? [`  image: ${JSON.stringify(options.image)}`] : []),
		...(options.actions.length > 0 ? ["  actions:"] : []),
		...options.actions.flatMap((action) => [
			`    - theme: ${action.theme}`,
			`      text: ${action.text}`,
			`      link: ${action.link}`,
		]),
	];
	for (const [index, card] of (options.features ?? []).entries()) {
		if (index === 0) {
			lines.push("", "features:");
		}
		lines.push(`  - title: ${JSON.stringify(card.title)}`);
		if (card.details !== undefined) {
			lines.push(`    details: ${JSON.stringify(card.details)}`);
		}
		if (card.iconSrc !== undefined) {
			lines.push("    icon:", `      src: ${JSON.stringify(card.iconSrc)}`);
		}
	}
	lines.push("---", "");
	if (options.includeReadme) {
		lines.push(`<!--@include: ./.vitepress/${README_COPY}-->`, "");
	}
	return lines.join("\n");
}

/**
 * The landing page the build supplies while the user has none: README.md
 * (hide markers honored) when the project has one, a hero derived the same
 * way the navbar is otherwise. Content depends only on the config, the
 * guides, and the README, never on the model, so error builds rewrite it
 * like any other.
 */
function generatedIndex(
	context: BuildContext,
	guideLink: string | undefined,
	hasApi: boolean,
	readme: string | undefined,
): string {
	const { config } = context;
	if (readme !== undefined) {
		return [
			"---",
			...INDEX_MARKER,
			"editLink: false",
			"lastUpdated: false",
			"---",
			"",
			readme,
		].join("\n");
	}
	return homeLayoutPage({
		marker: INDEX_MARKER,
		title: config.title,
		tagline: config.description,
		actions: heroActions(guideLink, hasApi),
	});
}

/**
 * A docs dir with no .gitignore gets one listing what the build regenerates,
 * so a config-less project's first local run cannot land generated trees in
 * git history. Created only when missing: once it exists the file is the
 * user's, and `init` swaps a still-marked copy for the editable template. It
 * ignores itself too, so a wholly generated docs dir leaves git untouched.
 */
function syncGitignore(docsDir: string, suppliesIndex: boolean): void {
	const path = join(docsDir, ".gitignore");
	if (existsSync(path)) {
		return;
	}
	const template = readFileSync(join(packageRoot(), "templates", "site", "gitignore"), "utf8");
	writeIfChanged(
		path,
		[
			`${GENERATED_MARK}; created because it was missing, then yours: the`,
			"# build never rewrites an existing .gitignore.",
			template.trimEnd(),
			...(suppliesIndex
				? [
						"",
						"# the generated landing page (drop when you write your own index.md)",
						"index.md",
					]
				: []),
			"",
			"# this file; drop this line to commit it",
			".gitignore",
			"",
		].join("\n"),
	);
}

const MISSING_CHANGELOG_WARNING =
	"warning: [docs] changelog is enabled but CHANGELOG.md was not found";

/**
 * How a previous build's copy is recognized when the feature turns off, so a
 * hand-written changelog.md is never deleted.
 */
const CHANGELOG_HEADER = generatedFrontmatter("Changelog");

/**
 * `[docs] changelog`, defaulting to on when CHANGELOG.md exists. One predicate
 * for the page sync and the nav entry both.
 */
function changelogEnabled(context: BuildContext): { enabled: boolean; hasSource: boolean } {
	const hasSource = existsSync(join(context.root, "CHANGELOG.md"));
	return { enabled: context.config.docs.changelog !== false && hasSource, hasSource };
}

function syncChangelog(context: BuildContext, enabled: boolean, hasSource: boolean): string[] {
	const target = join(context.docsDir, "changelog.md");
	if (enabled) {
		writeIfChanged(
			target,
			`${CHANGELOG_HEADER}\n\n${readFileSync(join(context.root, "CHANGELOG.md"), "utf8")}`,
		);
		return [];
	}
	// disabled, or the source is gone: remove only a copy this tool wrote
	if (existsSync(target) && readFileSync(target, "utf8").startsWith(CHANGELOG_HEADER)) {
		rmSync(target);
	}
	return context.config.docs.changelog === true && !hasSource ? [MISSING_CHANGELOG_WARNING] : [];
}

/**
 * Files inside .vitepress/ that belong to VitePress itself, exempt from the
 * tool-owned sweep: its build output (dist/), its dev cache (cache/), and the
 * transient bundled-config files vite writes while loading config.mts.
 */
function isVitepressOwn(rel: string): boolean {
	return (
		rel === "dist" ||
		rel.startsWith("dist/") ||
		rel === "cache" ||
		rel.startsWith("cache/") ||
		rel.includes(".timestamp-")
	);
}

export interface SiteSyncOptions {
	guides: GuideItem[];
	/**
	 * The emitted API sidebar. `undefined` keeps the baked module as it is
	 * (error builds; init before the first build), falling back to an empty
	 * one so the config always resolves.
	 */
	apiSidebar: SidebarItem[] | undefined;
	/** The emitted API trails, arriving with `apiSidebar` and kept the same way. */
	apiTrails?: Map<string, TrailSegment[]>;
	/** Error builds delete nothing and skip the changelog rewrite. */
	hasErrors?: boolean;
}

/**
 * Everything the site needs around the emitted pages, in one call. Returns
 * warnings for the caller to report rather than printing them.
 */
export function syncSite(context: BuildContext, options: SiteSyncOptions): string[] {
	const { config, docsDir } = context;
	const warnings: string[] = [];
	const guideSidebar = guideSidebarItems(options.guides);
	const guideLink = firstGuidePage(options.guides);
	const changelog = changelogEnabled(context);
	// the API nav entry and hero button follow the emitted pages, not [source]
	// entries, which can be non-empty while nothing produced a page. A build
	// without a fresh emit (errors; init) trusts what is on disk.
	const hasApi =
		options.apiSidebar !== undefined
			? options.apiSidebar.length > 0
			: existsSync(context.apiDir);
	// the landing page, supplied only while the user has none: theirs the
	// moment the marker line is gone. Read before the .vitepress sync so the
	// readme-copy decision below can see what a user-owned page still includes.
	const indexPath = join(docsDir, "index.md");
	const existingIndex = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : undefined;
	const suppliesIndex = existingIndex === undefined || isGeneratedFile(existingIndex);
	// read once for the includeReadme copy and the landing page both, and only
	// when one of those two renders it: a project using neither has no links to
	// fix and nothing to warn about
	const readme = config.docs.includeReadme || suppliesIndex ? readmeInclude(context) : undefined;

	const files = new Map<string, string | Uint8Array>();
	files.set("config.mts", renderConfigMts(config, guideLink, hasApi, changelog.enabled));
	files.set("theme/index.ts", renderThemeEntry(existsSync(join(docsDir, "custom.css"))));
	for (const [name, content] of runtimeTemplates()) {
		files.set(`generated/${name}`, content);
	}
	// an error build keeps the previous navigation wholesale: the pages stay on
	// disk, and navigation shrinking to the broken model would orphan them
	const navData = (name: string, bake: () => string): string => {
		if (options.apiSidebar !== undefined) {
			return bake();
		}
		const previous = join(docsDir, ".vitepress", "generated", name);
		return existsSync(previous) ? readFileSync(previous, "utf8") : bake();
	};
	files.set(
		"generated/sidebar.ts",
		navData("sidebar.ts", () => sidebarModule(options.apiSidebar ?? [], guideSidebar)),
	);
	files.set(
		"generated/trails.ts",
		navData("trails.ts", () =>
			trailsModule(pageTrails(options.guides, options.apiTrails, changelog.enabled)),
		),
	);
	if (config.docs.includeReadme) {
		// the landing page pulls the README in through a VitePress @include of
		// this generated copy, so it refreshes every build
		if (readme !== undefined) {
			files.set(README_COPY, readme.text);
		} else {
			warnings.push(MISSING_README_WARNING);
		}
	} else if (!suppliesIndex && existingIndex!.includes(README_COPY)) {
		// the sweep is about to delete a file the user's landing page still
		// @includes, and VitePress's "Include file not found" names no cause
		warnings.push(
			`warning: index.md includes .vitepress/${README_COPY}, which only ` +
				"[docs] includeReadme = true keeps; re-enable it or drop the include",
		);
	}
	if (readme !== undefined && readme.unresolved.length > 0) {
		warnings.push(
			`warning: README.md links ${readme.unresolved.join(", ")}, which the generated ` +
				// with no [repo] the fix is to set one; with one already set the
				// target is outside the repository, and naming [repo] would misdirect
				(config.repo === undefined
					? "site does not serve; set [repo] to point them at the repository"
					: "site does not serve and [repo] cannot reach"),
		);
	}
	syncDir(join(docsDir, ".vitepress"), files, !options.hasErrors, isVitepressOwn);

	if (suppliesIndex) {
		writeIfChanged(indexPath, generatedIndex(context, guideLink, hasApi, readme?.text));
	}
	syncGitignore(docsDir, suppliesIndex);

	writeIfChanged(join(docsDir, "package.json"), docsPackageJson(config.title));
	if (!options.hasErrors) {
		warnings.push(...syncChangelog(context, changelog.enabled, changelog.hasSource));
	}
	return warnings;
}

/**
 * Generates the VitePress site scaffolding around the emitted API pages:
 * everything under `<docs>/.vitepress/`, the `<docs>/package.json` that anchors
 * the VitePress install, the generated changelog page, a default landing page
 * when the user has not written one, and `<docs>/.gitignore` when missing. Also
 * owns guide-page discovery, which `llms.txt` shares.
 *
 * `.vitepress/config.mts` is baked as a single string with `luaudocs.toml`
 * values inlined: no runtime config merge and no separate site-meta module.
 * Users customize through `luaudocs.toml` and an optional `custom.css` beside
 * their `index.md`.
 *
 * Only config-dependent modules are baked here. Runtime plugins and styles with
 * standalone behavior live in `templates/runtime/` and are synced verbatim.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
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
} from "./pages";
import type { TrailSegment } from "../templates/runtime/markup";
import { LANGUAGES } from "../templates/runtime/inline-highlight";

/*
 * ------------------------------------------------------------- guide discovery
 */

/** A guide sidebar node: a folder group carries `items`, while a leaf carries `page`. */
export interface GuideItem {
	text: string;
	link?: string;
	items?: GuideItem[];
	order: number;
	/** A group's configured initial state and whether it can be toggled; when
	 * unset, defaults depend on whether the group is a top-level section or nested. */
	collapsed?: boolean;
	collapsible?: boolean;
	page?: DocPage;
	/** A leaf's relative path under `guide/`, used as the key in the baked trail map. */
	file?: string;
}

/** One markdown page as indexed by `llms.txt`. */
export interface DocPage {
	title: string;
	/** Site-relative and extensionless, e.g., `"/guide/getting-started"`. */
	link: string;
	/** Absolute source file path on disk (linked by the repo-root `llms.txt`). */
	file: string;
	/** Raw markdown source, retained so `llms-full.txt` never re-reads disk. */
	text: string;
	/** Frontmatter `description`, or the page's first prose sentence. */
	description?: string;
}

/** The site landing page (`index.md`), which may be a VitePress `layout: home` hero or a prose page. */
export interface HomePage {
	/** `hero.tagline` when `index.md` uses `layout: home`. */
	tagline?: string;
	/** Present only when `index.md` is a prose page rather than a `layout: home` hero. */
	page?: DocPage;
	/** `true` when the build generated `index.md` (so a fresh checkout may not have it on disk). */
	generated: boolean;
}

/** Converts `"getting-started"` to `"Getting Started"` when frontmatter and headings are absent. */
function humanize(name: string): string {
	return name.replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

/** Finds the first `# ` heading outside fenced code so a `# install` shell
 * comment in an opening fence is never mistaken for the page title. */
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
 * Builds a `DocPage` metadata entry. Frontmatter `description` is used verbatim,
 * while a fallback summary is trimmed to the first prose sentence.
 */
function docPage(text: string, file: string, link: string): DocPage {
	const block = frontmatter(text);
	// Strip frontmatter before scanning for `# ` headings so YAML comments
	// (such as the generated-file marker) are not mistaken for an H1.
	const heading = firstHeading(stripFrontmatter(text));
	const name = basename(file, ".md");
	return {
		title:
			field(block, "sidebar_label|title") ??
			heading ??
			(name === "index" ? "Overview" : humanize(name)),
		link,
		file,
		text,
		description: field(block, "description") ?? summarize(text),
	};
}

/** Converts a docs-relative markdown path to its served route (`index.md` -> directory, `.md` stripped). */
function pageRoute(rel: string): string {
	return rel.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, "");
}

/** Pages without an explicit position sort last, breaking ties by title. */
const UNORDERED = Number.POSITIVE_INFINITY;

/** An `index.md` page leads its folder ahead of any sibling position. */
const LEADS = Number.NEGATIVE_INFINITY;

/** Docusaurus / Moonwave folder metadata sidecar filenames. */
export const CATEGORY_FILES = ["_category_.json", "_category_.yml", "_category_.yaml"];

/** Supported keys read from a `_category_` sidecar (any others are reported during Moonwave migration). */
export const CATEGORY_KEYS = ["label", "position", "collapsed", "collapsible"] as const;
type CategoryKey = (typeof CATEGORY_KEYS)[number];

/**
 * Parses top-level keys from a `_category_` sidecar file. YAML sidecars are
 * read as flat key-value maps through the frontmatter reader (so nested objects
 * like a Docusaurus category `link` yield `undefined`). Malformed JSON throws
 * with the file path rather than silently misordering the sidebar.
 */
export function parseCategory(file: string, text: string): Record<string, unknown> {
	if (!file.endsWith(".json")) {
		return Object.fromEntries(
			[...text.matchAll(/^([A-Za-z_][\w-]*):/gm)].map(([, key]) => [key!, field(text, key!)]),
		);
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
 * Parses a numeric sidebar position (including decimals like `2.5` from
 * Docusaurus). Non-numeric values return `UNORDERED` instead of `NaN`, which
 * would break array sorting.
 */
function declaredOrder(declared: string | undefined): number {
	return /^-?\d+(\.\d+)?$/.test(declared ?? "") ? Number(declared) : UNORDERED;
}

/** Case-insensitive boolean parser (Docusaurus YAML sidecars accept `True`/`False`). */
function flag(value: string | undefined): boolean | undefined {
	const lower = value?.toLowerCase();
	return lower === "true" ? true : lower === "false" ? false : undefined;
}

/** Reads a single guide page and its ordering key. */
function guideEntry(abs: string, rel: string): GuideItem {
	const text = readFileSync(abs, "utf8");
	const page = docPage(text, abs, "/guide/" + pageRoute(rel));
	// A folder's `index.md` always leads the group; its own `sidebar_position`
	// positions the folder among sibling folders/pages, not the index within the folder.
	const order =
		basename(abs) === "index.md"
			? LEADS
			: declaredOrder(field(frontmatter(text), "sidebar_position|order"));
	return { text: page.title, link: page.link, order, page, file: rel };
}

/**
 * Builds a subdirectory's sidebar group, configured by its `_category_` sidecar
 * or its `index.md` frontmatter (with the sidecar winning key by key). Only the
 * sidecar can set the group's `label`, because `index.md`'s title names the
 * overview page inside the group rather than the folder itself.
 */
function folderEntry(dir: string, name: string, items: GuideItem[]): GuideItem {
	const file = CATEGORY_FILES.map((base) => join(dir, base)).find((path) => existsSync(path));
	const sidecar = file === undefined ? {} : parseCategory(file, readFileSync(file, "utf8"));
	const scalar = (key: CategoryKey): string | undefined => {
		const value = sidecar[key];
		// Ignore object/null values (such as a Docusaurus category `link` table).
		return value !== undefined && typeof value !== "object" ? String(value) : undefined;
	};
	// Reuse the `index.md` frontmatter already loaded during the directory walk.
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
 * Glob patterns excluded from both the guide sidebar walk and VitePress's own
 * page routing/search indexing: any file or folder starting with `_` (the
 * Docusaurus/Moonwave convention for partials and drafts).
 */
const GUIDE_EXCLUDE = ["guide/**/_*.md", "guide/**/_*/**"];

/**
 * Recursively collects guide pages and folders, sorted at each level by
 * declared order and then by title.
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

/** Returns the guide tree under `docsDir` in sidebar display order. */
export function collectGuides(docsDir: string): GuideItem[] {
	const guideDir = join(docsDir, "guide");
	return existsSync(guideDir) ? guideItems(guideDir, "") : [];
}

/** Flattens a guide tree depth-first into reading order. */
export function flattenGuides(items: GuideItem[]): DocPage[] {
	return items.flatMap((item) =>
		item.items ? flattenGuides(item.items) : item.page ? [item.page] : [],
	);
}

/**
 * Returns the route of the first guide page (used by the "Guide" navbar link,
 * hero button, and Moonwave migration).
 */
export function firstGuidePage(guides: GuideItem[]): string | undefined {
	return flattenGuides(guides)[0]?.link;
}

/** Reads a standalone doc page outside `guide/` (such as `changelog.md`), if present. */
export function readDocPage(file: string, link: string): DocPage | undefined {
	return existsSync(file) ? docPage(readFileSync(file, "utf8"), file, link) : undefined;
}

/**
 * Reads `<docs>/index.md`. A `layout: home` page provides its `hero.tagline`
 * (used as the fallback summary in `llms.txt`), whereas a prose `index.md` is
 * indexed as a full `DocPage` at `/`.
 */
export function readHomePage(docsDir: string): HomePage | undefined {
	const file = join(docsDir, "index.md");
	if (!existsSync(file)) {
		return undefined;
	}
	const text = readFileSync(file, "utf8");
	const block = frontmatter(text);
	const generated = isGeneratedFile(text);
	if (field(block, "layout") === "home") {
		// Match `tagline` at two-space indentation under `hero:`.
		return { tagline: field(block, "tagline", "[ \\t]+"), generated };
	}
	return { page: docPage(text, file, "/"), generated };
}

/*
 * --------------------------------------------------------------- baked modules
 */

const GENERATED_NOTE = "// Generated by luaudocs; regenerated by every build. Do not edit.";

/** Serializes a value as tab-indented JSON at `depth` for splicing into generated TS. */
function inlined(value: unknown, depth: number): string {
	return JSON.stringify(value, null, "\t").replace(/\n/g, `\n${"\t".repeat(depth)}`);
}

/**
 * Builds the default navbar items when `[[site.nav]]` is not set. Also used by
 * the Moonwave converter, which prepends these default links before any custom
 * Moonwave navbar items.
 */
export function derivedNav(
	guideLink: string | undefined,
	hasApi: boolean,
	hasChangelog: boolean,
): NavItem[] {
	return [
		// Guide and API link to the first page of a multi-page section, so they
		// set `activeMatch` to stay highlighted across the whole section.
		...(guideLink ? [{ text: "Guide", link: guideLink, activeMatch: "^/guide/" }] : []),
		...(hasApi ? [{ text: "API", link: "/api/", activeMatch: "^/api/" }] : []),
		...(hasChangelog ? [{ text: "Changelog", link: "/changelog" }] : []),
	];
}

/**
 * Computes the VitePress `collapsed` property for a guide folder group. In
 * VitePress, omitting `collapsed` makes a group non-collapsible; top-level
 * section headings default to non-collapsible unless `collapsible` or `collapsed`
 * is explicitly set, whereas nested groups default to collapsible and open (`collapsed: false`).
 */
function collapsedKey(item: GuideItem, top: boolean): { collapsed?: boolean } {
	const collapsible = item.collapsible ?? (!top || item.collapsed !== undefined);
	return collapsible ? { collapsed: item.collapsed ?? false } : {};
}

/**
 * Converts `GuideItem` nodes into VitePress sidebar entries. Pages sit under a
 * single top-level `"Guide"` section unless `guide/` contains only folders, in
 * which case each folder becomes its own top-level section.
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
 * Builds the breadcrumb trail above each page, keyed by the docs-relative
 * markdown path VitePress renders it from.
 *
 * Combines guide folder trails and API access-path trails under `Home` (leaving
 * only the landing page without a trail). A folder's `index.md` drops its own
 * folder segment so a page never links to itself in its breadcrumb trail.
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
				// Link a folder segment to its `index.md` when present, or leave it as plain text.
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
	// The API index has an empty trail in the emitter's map, so prepending HOME
	// leaves `[Home]` above `api/index.md`.
	for (const [file, trail] of apiTrails ?? []) {
		trails[`${API_DIR}/${file}`] = [HOME, ...trail];
	}
	if (changelog) {
		trails["changelog.md"] = [HOME];
	}
	return trails;
}

/**
 * Filename of the generated module holding the API half of the navigation
 * (sidebar and breadcrumb trails). Kept separate from the guide navigation so
 * a build with extraction errors can preserve the last good API navigation on
 * disk while still rebaking guide navigation changes.
 */
const API_NAV = "api-nav.ts";

/** Renders `api-nav.ts` from the last successful extraction. */
function apiNavModule(
	apiSidebar: SidebarItem[],
	apiTrails: Record<string, TrailSegment[]>,
): string {
	return [
		GENERATED_NOTE,
		'import type { DefaultTheme } from "vitepress";',
		'import type { PageTrails } from "./markup.ts";',
		"",
		`export const apiSidebar: DefaultTheme.SidebarItem[] = ${inlined(apiSidebar, 0)};`,
		"",
		`export const apiTrails: PageTrails = ${inlined(apiTrails, 0)};`,
		"",
	].join("\n");
}

/** Renders `trails.ts`, merging the guide trails with `apiTrails` from `api-nav.ts`. */
function trailsModule(guideTrails: Record<string, TrailSegment[]>): string {
	return [
		GENERATED_NOTE,
		'import type { PageTrails } from "./markup.ts";',
		`import { apiTrails } from "./${API_NAV}";`,
		"",
		`const guideTrails: PageTrails = ${inlined(guideTrails, 0)};`,
		"",
		"export const pageTrails: PageTrails = { ...guideTrails, ...apiTrails };",
		"",
	].join("\n");
}

/** Renders `sidebar.ts`, exporting `guideSidebar` alongside `apiSidebar` from `api-nav.ts`. */
function sidebarModule(guideSidebar: SidebarItem[]): string {
	return [
		GENERATED_NOTE,
		'import type { DefaultTheme } from "vitepress";',
		"",
		`export { apiSidebar } from "./${API_NAV}";`,
		"",
		`export const guideSidebar: DefaultTheme.SidebarItem[] = ${inlined(guideSidebar, 0)};`,
		"",
	].join("\n");
}

/**
 * Extracts the pathname from `[docs] url` as the VitePress `base` (e.g.,
 * `"/repo/"` for a GitHub Pages project deploy), or `undefined` when deployed
 * at a domain root. Also used when rewriting raw HTML links in `README.md`.
 */
function siteBase(config: LuauDocsConfig): string | undefined {
	if (!config.docs.url) {
		return undefined;
	}
	const path = new URL(config.docs.url).pathname.replace(/\/?$/, "/");
	return path === "/" ? undefined : path;
}

/**
 * Prefixes a site-absolute path with `base` for places VitePress does not
 * prefix automatically (`<head>` tags and raw HTML `href` attributes in `README.md`).
 */
function withBase(base: string | undefined, path: string): string {
	return `${base ?? "/"}${path.replace(/^\//, "")}`;
}

/**
 * Renders `.vitepress/config.mts` with all `luaudocs.toml` values inlined.
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

	// Use the pathname of `[docs] url` as VitePress `base` for subpath deploys.
	const base = siteBase(config);
	// `<head>` asset links must include `base` explicitly, and `og:image` must
	// be a full URL for social crawlers when `[docs] url` is set.
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
	// Append `[[site.head]]` entries verbatim after derived `<meta>` tags.
	for (const entry of config.site.head ?? []) {
		const attrs = entry.attrs ?? {};
		head.push(
			entry.content === undefined ? [entry.tag, attrs] : [entry.tag, attrs, entry.content],
		);
	}

	// Use `[[site.nav]]` verbatim when set, or derive Guide/API/Changelog from the project.
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
		"\t\t// Pre-loaded for the synchronous inline highlighter, from the list that",
		"\t\t// also gates which `{lang}` inline annotations are honored.",
		`\t\tlanguages: [${LANGUAGES.map((lang) => JSON.stringify(lang)).join(", ")}],`,
		// Pass `base` explicitly: signature links are injected as raw HTML in Shiki's
		// HAST, which VitePress does not prefix with `base`.
		`\t\tcodeTransformers: [decodeLinks(), signatureLinks(${JSON.stringify(base ?? "/")})],`,
		"\t\tshikiSetup(shiki) {",
		"\t\t\thighlighter = shiki;",
		"\t\t},",
		"\t\tconfig(md) {",
		"\t\t\t// Run markup rewrites (`<Frame>`, `<Tabs>`, `:::note`) and prepend",
		"\t\t\t// page trails on the raw markdown source before block parsing;",
		"\t\t\t// fenced code blocks showing that syntax are left untouched.",
		"\t\t\tinstallMarkupRule(md, pageTrails);",
		"\t\t\tinlineHighlightPlugin(md, () => highlighter);",
		"\t\t\t// Preserve inline whitespace that Vue's template compiler would otherwise drop.",
		"\t\t\twhitespacePlugin(md);",
		"\t\t\t// Tab and title-bar icons, keyed off `data-title`; installed before",
		"\t\t\t// `relayLinks` so `luaudocs-links=[...]` is already base64-encoded",
		"\t\t\t// when `groupIconMdPlugin` scans fence info strings for `[title]`.",
		"\t\t\tmd.use(groupIconMdPlugin);",
		"\t\t\t// Installed last so `relayLinks` wraps the outermost fence renderer.",
		"\t\t\trelayLinks(md);",
		"\t\t},",
		"\t},",
		"\tthemeConfig: {",
		"\t\toutline: { level: [2, 3] },",
		'\t\tsearch: { provider: "local" },',
		// `false` is a valid value here (hides the navbar title next to a logo), so test `!== undefined`.
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
						`${repo.url}/edit/${repo.branch}/${config.docs.dir}/:path`,
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

/** Renders `.vitepress/theme/index.ts`, wiring in default styles, tab icons, and optional `custom.css`. */
function renderThemeEntry(hasCustomCss: boolean): string {
	return [
		GENERATED_NOTE,
		'import DefaultTheme from "vitepress/theme";',
		// Virtual stylesheet emitted by `vitepress-plugin-group-icons` for the
		// tab and fence titles used on this site.
		'import "virtual:group-icons.css";',
		'import "../generated/luaudocs.css";',
		...(hasCustomCss ? ['import "../../custom.css";'] : []),
		"",
		"export default DefaultTheme;",
		"",
	].join("\n");
}

/** Converts the project title into a package-name-safe slug for `<docs>/package.json`. */
function projectSlug(title: string): string {
	return (
		title
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "project"
	);
}

/**
 * Generates `<docs>/package.json` at the docs root (rather than inside
 * `.vitepress/`) because compiled markdown pages import `vue` and bare module
 * imports resolve only *upward*. Dependency versions come from LuauDocs's own
 * `package.json`, where `vitepress` is pinned to an exact version.
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
 * Reads and caches all files under `templates/runtime/` as raw `Buffer`s so
 * binary assets (`FiraCode-VF.woff2`) and source files alike copy byte-for-byte
 * without maintaining a separate manifest or file-extension list.
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
 * Path (under `.vitepress/`) of the build's rewritten `README.md` copy,
 * referenced by the sync step, the generated landing page's `@include`, and the
 * warning when a user-owned `index.md` still includes it after `includeReadme` is turned off.
 */
const README_COPY = "generated/readme.md";

/** Moonwave's README hide markers, honored when `[docs] includeReadme` is enabled. */
const HIDE_BEFORE = "<!--moonwave-hide-before-this-line-->";
const HIDE_AFTER = "<!--moonwave-hide-after-this-line-->";

/**
 * Splits a repository-relative link target into its normalized path and
 * untouched `#`/`?` suffix. Returns `undefined` for URLs with a scheme,
 * site-absolute paths, and bare `#`/`?` references. Paths that climb above the
 * repository root (`..`) still return a match so the caller can warn about them.
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
 * Reads `README.md`, trims it to any Moonwave hide markers, and rewrites
 * repository-relative links and image targets so they resolve on the docs site.
 * Any relative targets that neither the docs site nor `[repo]` can serve are
 * returned in `unresolved` so the caller can emit a warning.
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
	// `[docs] dir` with a trailing slash for matching repository-relative paths.
	const docsPrefix = `${context.config.docs.dir}/`;
	// Raw HTML `href` attributes are the only slot VitePress does not prefix
	// with `base` (markdown links are prefixed by VitePress, and images/`src`
	// attributes are resolved by Vite as asset imports).
	const base = siteBase(context.config);
	const rooted = (path: string, slot: TargetSlot) =>
		slot === "href" ? withBase(base, path) : path;
	const unresolved = new Set<string>();
	// Rewrite each repository-relative target to the matching site route,
	// `public/` asset, or `[repo]` GitHub/GitLab URL.
	const convert = (target: string, slot: TargetSlot): string => {
		const rel = repoRelativeTarget(target);
		if (rel === undefined) {
			return target;
		}
		// `luaudocs init` copies `.moonwave/static/` into `<docs>/public/`, so
		// rewrite `.moonwave/static/...` paths to `public/...` when that file exists.
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
			// Non-markdown files outside `public/` are not served by the docs site; fall through to `[repo]`.
		}
		// Paths without `..` segments resolve against `[repo]` (using raw URLs for images and `src` attributes).
		if (repo !== undefined && !rel.path.split("/").includes("..")) {
			const inline = slot === "image" || slot === "src";
			return `${repoFileUrl(repo, rel.path, inline)}${rel.suffix}`;
		}
		unresolved.add(target);
		return target;
	};
	// Collect reference-style image labels across the whole README before
	// rewriting individual prose segments.
	const imageLabels = imageReferenceLabels(trimmed);
	// Leave fenced code blocks and inline code spans untouched.
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

/** Builds the hero action buttons (`Get Started` for the first guide page, plus `API Reference`). */
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
 * Renders a VitePress `layout: home` landing page, shared by the generated
 * fallback landing page and Moonwave homepage conversion.
 */
export function homeLayoutPage(options: {
	/** Frontmatter comment lines (the generated marker); omit for user-owned pages. */
	marker?: string[];
	title: string;
	tagline?: string;
	image?: string;
	actions: Array<{ theme: string; text: string; link: string }>;
	features?: Array<{ title: string; details?: string; iconSrc?: string }>;
	/** Appends `<!--@include: ./.vitepress/generated/readme.md-->` below the frontmatter. */
	includeReadme?: boolean;
}): string {
	const lines = [
		"---",
		...(options.marker ?? []),
		// Generated landing pages are overwritten on every build, so suppress
		// "Edit this page" and "Last updated" on marked files.
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
 * Renders the default landing page when the user has not supplied their own
 * `index.md`: uses `README.md` (with Moonwave hide markers applied) when
 * present, or falls back to a `layout: home` hero.
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
 * Creates `<docs>/.gitignore` when none exists so a zero-config build does not
 * leave generated files untracked in `git status`. Never overwrites an existing
 * `.gitignore` (except when `luaudocs init` upgrades a still-marked copy).
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
 * Frontmatter header for the generated `changelog.md`, carrying `GENERATED_MARK`
 * so `isGeneratedFile` can distinguish it from a hand-written `changelog.md`.
 */
const CHANGELOG_HEADER = generatedFrontmatter("Changelog").replace(
	/^---\n/,
	`---\n${GENERATED_MARK}; copied from CHANGELOG.md by every build.\n`,
);

/** Legacy header from builds prior to `GENERATED_MARK`, still recognized as generated. */
const UNMARKED_CHANGELOG_HEADER = generatedFrontmatter("Changelog");

function isGeneratedChangelog(text: string): boolean {
	return (
		isGeneratedFile(text) || text.replace(/\r\n/g, "\n").startsWith(UNMARKED_CHANGELOG_HEADER)
	);
}

/**
 * Checks whether the changelog page is enabled (`[docs] changelog` defaults to
 * `true` when `CHANGELOG.md` exists at the project root).
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
	// When disabled or `CHANGELOG.md` is removed, delete `changelog.md` only if LuauDocs generated it.
	if (existsSync(target) && isGeneratedChangelog(readFileSync(target, "utf8"))) {
		rmSync(target);
	}
	return context.config.docs.changelog === true && !hasSource ? [MISSING_CHANGELOG_WARNING] : [];
}

/**
 * Files inside `.vitepress/` owned by VitePress itself and preserved across
 * directory syncs: build output (`dist/`), dev cache (`cache/`), and Vite's
 * temporary bundled config files (`.timestamp-*`).
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
	 * The emitted API sidebar. Pass `undefined` on error builds or during `init`
	 * to preserve any existing `api-nav.ts` on disk (falling back to an empty list).
	 */
	apiSidebar: SidebarItem[] | undefined;
	/** The emitted API trails, paired with `apiSidebar`. */
	apiTrails?: Map<string, TrailSegment[]>;
	/** When `true`, preserves existing generated files and skips the changelog sync. */
	hasErrors?: boolean;
}

/**
 * Syncs all generated site scaffolding around the emitted API pages and returns
 * any configuration or README link warnings.
 */
export function syncSite(context: BuildContext, options: SiteSyncOptions): string[] {
	const { config, docsDir } = context;
	const warnings: string[] = [];
	const guideSidebar = guideSidebarItems(options.guides);
	const guideLink = firstGuidePage(options.guides);
	const changelog = changelogEnabled(context);
	// Include the API navbar link and hero button only when API pages exist.
	// On error builds or `init` (`apiSidebar === undefined`), check `api/` on disk.
	const hasApi =
		options.apiSidebar !== undefined
			? options.apiSidebar.length > 0
			: existsSync(context.apiDir);
	// Supply `index.md` only while the user has not created or unmarked their own.
	const indexPath = join(docsDir, "index.md");
	const existingIndex = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : undefined;
	const suppliesIndex = existingIndex === undefined || isGeneratedFile(existingIndex);
	// Read `README.md` at most once, and only when `includeReadme` or the
	// generated landing page needs it.
	const readme = config.docs.includeReadme || suppliesIndex ? readmeInclude(context) : undefined;

	const files = new Map<string, string | Uint8Array>();
	files.set("config.mts", renderConfigMts(config, guideLink, hasApi, changelog.enabled));
	files.set("theme/index.ts", renderThemeEntry(existsSync(join(docsDir, "custom.css"))));
	for (const [name, content] of runtimeTemplates()) {
		files.set(`generated/${name}`, content);
	}
	// On error builds, keep the previous `api-nav.ts` so existing API pages on
	// disk stay listed in the sidebar; always rebake the guide navigation.
	const previousApiNav = join(docsDir, ".vitepress", "generated", API_NAV);
	files.set(
		`generated/${API_NAV}`,
		options.apiSidebar === undefined && existsSync(previousApiNav)
			? readFileSync(previousApiNav, "utf8")
			: apiNavModule(options.apiSidebar ?? [], pageTrails([], options.apiTrails, false)),
	);
	files.set("generated/sidebar.ts", sidebarModule(guideSidebar));
	files.set(
		"generated/trails.ts",
		trailsModule(pageTrails(options.guides, undefined, changelog.enabled)),
	);
	if (config.docs.includeReadme) {
		// Write `.vitepress/generated/readme.md` for `index.md` to `@include`.
		if (readme !== undefined) {
			files.set(README_COPY, readme.text);
		} else {
			warnings.push(MISSING_README_WARNING);
		}
	} else if (!suppliesIndex && existingIndex!.includes(README_COPY)) {
		// Warn before `syncDir` removes `generated/readme.md` if a user-owned
		// `index.md` still `@include`s it.
		warnings.push(
			`warning: index.md includes .vitepress/${README_COPY}, which only ` +
				"[docs] includeReadme = true keeps; re-enable it or drop the include",
		);
	}
	if (readme !== undefined && readme.unresolved.length > 0) {
		warnings.push(
			`warning: README.md links ${readme.unresolved.join(", ")}, which the generated ` +
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

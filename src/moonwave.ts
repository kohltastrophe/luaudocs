/**
 * Everything `init --from-moonwave` understands about a moonwave project: the
 * one-time moonwave.toml/moonwave.json -> luaudocs.toml conversion, and the
 * one-time port of the hand-written pages (docs/ -> guide/, pages/ -> the
 * docs root) out of Docusaurus's MDX dialect.
 *
 * The scope rule for both halves: what has a real equivalent is mapped, what
 * the generated site makes moot is consumed silently, and everything else is
 * named in the report rather than guessed at. Converted pages carry no
 * generated marker: they are the user's content from the moment they land.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { filesUnder } from "./build";
import { DEFAULT_BRANCH, DEFAULT_ENTRIES, probeEntries } from "./config";
import {
	CODE_SPAN,
	frontmatter,
	frontmatterBlock,
	frontmatterField as field,
	HTML_COMMENT_INLINE,
	mapOutsideCodeSpans,
	moonwaveStaticTarget,
	outsideCodeSpans,
	outsideFences,
	REWRITTEN_COMPONENTS,
	rewriteTargets,
	splitFences,
} from "./markdown";
import { derivedNav, heroActions, homeLayoutPage } from "./site";

/*
 * ------------------------------------------------------------------ the config
 */

/** A moonwave config parsed but not yet converted, so init can read the facts
 * the scaffold needs (and fail on junk) before it writes anything. */
export interface MoonwaveSource {
	raw: Record<string, unknown>;
	projectDir: string;
	title: string | undefined;
	description: string | undefined;
	/** Whether the conversion will produce a homepage index.md. */
	hasHomeBranding: boolean;
}

export interface MoonwaveConversion {
	configToml: string;
	/** A home-layout index.md carrying the moonwave homepage's branding, when
	 * it had any; user-owned from the start, like the converted pages. */
	homeIndexMd?: string;
	report: string[];
}

/** A parsed TOML/JSON table, or an empty one for junk: every read stays safe. */
function tableOf(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** The same for a scalar, so a field with a fallback reads as one `??`. */
function stringOf(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** The keys of `raw` that neither mapped nor may drop silently, as dotted
 * paths for the report. */
function unmapped(
	raw: Record<string, unknown>,
	path: string,
	handled: string[],
	silent: string[] = [],
): string[] {
	return Object.keys(raw)
		.filter((key) => !handled.includes(key) && !silent.includes(key))
		.map((key) => (path === "" ? key : `${path}.${key}`));
}

/** A static-dir path rooted for public/ (where the static copy lands); a full
 * URL passes through. Docusaurus spells these bare ("img/favicon.ico"). */
function rooted(path: string): string {
	return /^[a-z][a-z0-9+.-]*:/i.test(path) ? path : `/${path.replace(/^\/+/, "")}`;
}

/** `host` + `baseUrl` joined into one published URL, or undefined when the
 * parts cannot form one. */
function joinedUrl(host: string, baseUrl: unknown, defaultBase: string): string | undefined {
	try {
		return new URL(stringOf(baseUrl) ?? defaultBase, host).href;
	} catch {
		return undefined;
	}
}

/** The parsed moonwave.toml/moonwave.json; throws on junk it cannot parse. */
export function readMoonwave(moonwavePath: string): MoonwaveSource {
	const text = readFileSync(moonwavePath, "utf8");
	const raw = (moonwavePath.endsWith(".json") ? JSON.parse(text) : parseToml(text)) as Record<
		string,
		unknown
	>;
	const docusaurus = tableOf(raw.docusaurus);
	const home = tableOf(raw.home);
	return {
		raw,
		projectDir: dirname(moonwavePath),
		// title is required by the luaudocs config; moonwave allows omitting it
		title: stringOf(raw.title),
		description: stringOf(docusaurus.tagline),
		// the same presence test the conversion applies to banner and features
		hasHomeBranding:
			typeof home.bannerImage === "string" ||
			(Array.isArray(home.features) && home.features.length > 0),
	};
}

/**
 * One-time moonwave config -> luaudocs.toml conversion. Why each silent key
 * is moot: the scaffolded Pages workflow deploys from an action, so there is
 * no deployment branch to pick; dead links always fail a build here and the
 * error names each one, so there is no severity to set; URLs have one shape
 * under cleanUrls; the VitePress footer has one style; the generated landing
 * page replaces moonwave's homepage toggle.
 */
export function convertMoonwave(
	source: MoonwaveSource,
	options: {
		fallbackTitle?: string;
		/** An existing non-default `[docs] dir`; moonwave has no equivalent key. */
		docsDir?: string;
		/** The guide tree's first page (converted or scaffolded), for the
		 * rebuilt navbar and the homepage hero. */
		guideLink?: string;
		/** Overrides whether the homepage pulls the README in: set when the
		 * converted config is not the one that will govern the build. */
		homeReadme?: boolean;
	} = {},
): MoonwaveConversion {
	const { raw, projectDir, title, description } = source;
	const { docsDir, guideLink } = options;
	const config: Record<string, unknown> = {};
	const docusaurus = tableOf(raw.docusaurus);
	const navbar = tableOf(raw.navbar);
	const footer = tableOf(raw.footer);
	const home = tableOf(raw.home);

	const resolvedTitle = title ?? options.fallbackTitle ?? "Documentation";
	config.title = resolvedTitle;

	if (description) {
		config.description = description;
	}

	// moonwave's source roots are the --code CLI flag (default ["lib", "src"]),
	// never a config key, so probe for the module roots that exist, in
	// moonwave's order
	const probed = probeEntries(projectDir, ["lib", "src"], true);
	const entries = probed.length > 0 ? probed : DEFAULT_ENTRIES;
	config.source = { entries };

	// gitRepoUrl, else the docusaurus deploy coordinates: they name the same
	// GitHub repo, which is what moonwave's own deploy pushes to
	const org = stringOf(docusaurus.organizationName);
	const project = stringOf(docusaurus.projectName);
	const repoUrl =
		stringOf(raw.gitRepoUrl) ??
		(org && project ? `https://github.com/${org}/${project}` : undefined);
	if (repoUrl !== undefined) {
		config.repo = {
			url: repoUrl,
			branch: stringOf(raw.gitSourceBranch) ?? DEFAULT_BRANCH,
		};
	}

	const site: Record<string, unknown> = {};
	// the navbar's brand text, which VitePress calls siteTitle
	if (typeof navbar.title === "string") {
		site.siteTitle = navbar.title;
	}
	if (typeof docusaurus.favicon === "string") {
		site.favicon = rooted(docusaurus.favicon);
	}
	const logo = tableOf(navbar.logo);
	if (typeof logo.src === "string") {
		// `alt` drops silently with the rest of navbar.logo: the site config
		// carries no slot for it
		site.logo =
			typeof logo.srcDark === "string"
				? { light: rooted(logo.src), dark: rooted(logo.srcDark) }
				: rooted(logo.src);
	}
	if (typeof footer.copyright === "string") {
		site.footer = { copyright: footer.copyright };
	}

	const items = Array.isArray(navbar.items) ? navbar.items : [];
	const itemsReport: string[] = [];
	const nav: Array<{ text: string; link: string }> = [];
	items.forEach((item, index) => {
		const entry = tableOf(item);
		const link = stringOf(entry.href) ?? entry.to;
		if (typeof entry.label === "string" && typeof link === "string") {
			// `position` drops silently: the VitePress nav is one left-to-right
			// row, and the GitHub icon already sits right of it. An internal
			// `to` resolved against moonwave's baseUrl, so it is site-absolute
			// here, and it moves with the page it names.
			nav.push({ text: entry.label, link: convertTarget(rooted(link)) });
		} else {
			itemsReport.push(`navbar.items[${index}]`);
		}
	});
	if (nav.length > 0) {
		site.nav = [
			...derivedNav(
				guideLink,
				entries.length > 0,
				raw.changelog !== false && existsSync(join(projectDir, "CHANGELOG.md")),
			),
			...nav,
		];
	}
	if (Object.keys(site).length > 0) {
		config.site = site;
	}

	const docs: Record<string, unknown> = {};
	if (docsDir !== undefined) {
		// scaffold targets the dir the existing config names, so the converted
		// config must keep naming it or the site splits across two dirs
		docs.dir = docsDir;
	}
	// only `false` needs carrying: luaudocs auto-enables the changelog page
	// whenever CHANGELOG.md exists, which is moonwave's default too
	if (raw.changelog === false) {
		docs.changelog = false;
	}
	if (home.includeReadme === true) {
		docs.includeReadme = true;
	}
	if (typeof docusaurus.url === "string") {
		// url is the host, baseUrl the path; [docs] url carries both. A
		// project-pages site with the wrong base ships a blank page. On a junk
		// host the URL is kept as written; the config's url check surfaces it.
		docs.url = joinedUrl(docusaurus.url, docusaurus.baseUrl, "/") ?? docusaurus.url;
	} else if (org !== undefined) {
		// moonwave's own defaults when url is unset: the org's pages host,
		// based under the project's name (moonwave serves project pages from
		// /<repo>/). Junk coordinates drop the guess rather than crash.
		const url = joinedUrl(
			`https://${org}.github.io`,
			docusaurus.baseUrl,
			project !== undefined ? `/${project}/` : "/",
		);
		if (url !== undefined) {
			docs.url = url;
		}
	}
	if (Object.keys(docs).length > 0) {
		config.docs = docs;
	}

	// the homepage branding the generated landing cannot derive becomes a real
	// index.md; without either key the generated hero already covers it
	let homeIndexMd: string | undefined;
	const features = Array.isArray(home.features) ? home.features.map(tableOf) : [];
	const banner = typeof home.bannerImage === "string" ? rooted(home.bannerImage) : undefined;
	if (banner !== undefined || features.length > 0) {
		homeIndexMd = homeLayoutPage({
			title: resolvedTitle,
			tagline: description,
			image: banner,
			actions: heroActions(guideLink, entries.length > 0),
			features: features.map((card) => {
				const icon = stringOf(card.image);
				return {
					title: stringOf(card.title) ?? "",
					details: stringOf(card.description),
					iconSrc: icon === undefined ? undefined : rooted(icon),
				};
			}),
			includeReadme:
				(options.homeReadme ?? home.includeReadme === true) &&
				existsSync(join(projectDir, "README.md")),
		});
	}

	const paths = [
		...unmapped(raw, "", [
			"title",
			"gitRepoUrl",
			"gitSourceBranch",
			"changelog",
			"docusaurus",
			"navbar",
			"footer",
			"home",
		]),
		...unmapped(
			docusaurus,
			"docusaurus",
			["tagline", "url", "baseUrl", "favicon", "organizationName", "projectName"],
			["deploymentBranch", "onBrokenLinks", "onBrokenMarkdownLinks", "trailingSlash"],
		),
		...unmapped(navbar, "navbar", ["title", "items", "logo"]),
		...itemsReport,
		...unmapped(footer, "footer", ["copyright"], ["style"]),
		...unmapped(home, "home", ["includeReadme", "bannerImage", "features"], ["enabled"]),
	];
	const report: string[] = [];
	if (paths.length > 0) {
		report.push(`  no equivalent: ${paths.join(", ")}`);
	}
	if (site.nav !== undefined) {
		report.push(
			"  note: [[site.nav]] replaces the derived navbar, so its entries are baked ahead of yours; edit them in luaudocs.toml",
		);
	}

	return { configToml: stringifyToml(config) + "\n", homeIndexMd, report };
}

/*
 * ------------------------------------------------------------------- the pages
 */

export interface MoonwavePage {
	/** Destination, relative to the docs dir ("guide/intro.md"). */
	destRel: string;
	content: string | Buffer;
}

export interface MoonwavePages {
	files: MoonwavePage[];
	/** Report lines, same shape the config conversion emits. */
	report: string[];
}

const PAGE_EXTENSION = /\.mdx?$/;

/**
 * The hand-written half of a moonwave project, read and converted but not
 * written (init owns the write protocol). docs/ pages land under guide/,
 * where the sidebar walk reads the sidebar_position frontmatter they already
 * carry; pages/ markdown lands at the docs root, standalone at its old path;
 * anything else under either folder (co-located images) copies verbatim, and
 * .moonwave/custom.css arrives with the known Infima renames done. Draft and
 * unlisted pages stay behind (moonwave did not publish them); blog/, React
 * pages, and a pinned sidebars.js have nothing to convert to.
 */
export function collectMoonwavePages(projectDir: string): MoonwavePages {
	const files: MoonwavePage[] = [];
	const checkByHand: string[] = [];
	const categories: string[] = [];
	const reactPages: string[] = [];
	const apiPages: string[] = [];
	const drafts: string[] = [];

	const convert = (abs: string, srcRel: string, destRel: string): void => {
		const text = readFileSync(abs, "utf8");
		const block = frontmatter(text);
		// docusaurus kept draft and unlisted pages out of the published site;
		// converting one would publish it, so it stays behind, named
		if (field(block, "draft") === "true" || field(block, "unlisted") === "true") {
			drafts.push(srcRel);
			return;
		}
		const { content, components } = convertMdxPage(text);
		const dest = destRel.replace(PAGE_EXTENSION, ".md");
		files.push({ destRel: dest, content });
		// a slug or id moved the page's URL in docusaurus; here the file path
		// is the URL, so links aimed at the old address need a look
		if (field(block, "slug|id") !== undefined) {
			checkByHand.push(
				`  check by hand: ${dest} sets slug/id, but its URL follows the file path here`,
			);
		}
		if (components.length > 0) {
			checkByHand.push(
				`  check by hand: ${dest} still uses ${components
					.map((name) => `<${name}>`)
					.join(", ")}`,
			);
		}
	};

	for (const { abs, rel } of filesUnder(join(projectDir, "docs"))) {
		if (/^_category_\.(?:json|ya?ml)$/.test(basename(rel))) {
			categories.push(`docs/${rel}`);
		} else if (PAGE_EXTENSION.test(rel)) {
			convert(abs, `docs/${rel}`, `guide/${rel}`);
		} else {
			files.push({ destRel: `guide/${rel}`, content: readFileSync(abs) });
		}
	}

	for (const { abs, rel } of filesUnder(join(projectDir, "pages"))) {
		if (rel.startsWith("api/")) {
			// the build makes api/ contain exactly the emitted set; a page
			// converted into it would be deleted by the next build
			apiPages.push(`pages/${rel}`);
		} else if (PAGE_EXTENSION.test(rel)) {
			convert(abs, `pages/${rel}`, rel);
		} else if (/\.(?:[jt]sx?|html|css)$/.test(rel)) {
			reactPages.push(`pages/${rel}`);
		} else {
			files.push({ destRel: rel, content: readFileSync(abs) });
		}
	}

	// the custom stylesheet, with the mechanical Infima renames done; whatever
	// variable the rename table does not know survives as written, named below
	const customCss = join(projectDir, ".moonwave", "custom.css");
	if (existsSync(customCss)) {
		const { content, leftover } = convertInfimaCss(readFileSync(customCss, "utf8"));
		files.push({ destRel: "custom.css", content });
		if (leftover.length > 0) {
			checkByHand.push(`  check by hand: custom.css still uses ${leftover.join(", ")}`);
		}
	}

	const report: string[] = [];
	if (categories.length > 0) {
		report.push(
			`  no equivalent: ${categories.join(", ")} (groups take the folder name; pages order by sidebar_position)`,
		);
	}
	if (reactPages.length > 0) {
		report.push(`  no equivalent: ${reactPages.join(", ")} (only markdown pages convert)`);
	}
	if (apiPages.length > 0) {
		report.push(`  skipped: ${apiPages.join(", ")} (api/ belongs to the generated pages)`);
	}
	if (drafts.length > 0) {
		report.push(
			`  skipped: ${drafts.join(", ")} (draft/unlisted; moonwave did not publish them)`,
		);
	}
	// presence, not contents: the tree is never read, and it is the one folder
	// in a moonwave project that can be genuinely large
	const blogDir = join(projectDir, "blog");
	if (existsSync(blogDir) && readdirSync(blogDir).length > 0) {
		report.push("  no equivalent: blog/ (the generated site has no blog)");
	}
	if (existsSync(join(projectDir, ".moonwave", "sidebars.js"))) {
		report.push(
			"  no equivalent: .moonwave/sidebars.js (the guide sidebar is derived from the pages)",
		);
	}
	report.push(...checkByHand);

	return { files, report };
}

/*
 * ------------------------------------------------------------- the custom css
 */

/**
 * The Infima variables with a one-for-one VitePress spelling, longest name
 * first so a shared prefix cannot bite, each guarded against matching inside
 * a longer variable name. Docusaurus's dark-mode selector maps too: VitePress
 * marks dark mode with a `.dark` class on the root element.
 */
const INFIMA_RENAMES: Array<[RegExp, string]> = [
	[/--ifm-color-primary-darker(?![\w-])/g, "--vp-c-brand-3"],
	[/--ifm-color-primary-dark(?![\w-])/g, "--vp-c-brand-2"],
	[/--ifm-color-primary(?![\w-])/g, "--vp-c-brand-1"],
	[/--ifm-background-color(?![\w-])/g, "--vp-c-bg"],
	[/\[data-theme=["']dark["']\]/g, ".dark"],
];

/** `.moonwave/custom.css` with the mechanical renames done; `leftover` names
 * every `--ifm-*` variable the table does not know, left as written. */
export function convertInfimaCss(css: string): { content: string; leftover: string[] } {
	let content = css;
	for (const [pattern, replacement] of INFIMA_RENAMES) {
		content = content.replace(pattern, replacement);
	}
	const leftover = [...new Set([...content.matchAll(/--ifm-[\w-]+/g)].map((m) => m[0]))].sort();
	return { content, leftover };
}

/*
 * ----------------------------------------------------------- one page's markup
 */

/** Capitalized tags that render here: what the runtime rewrites at render
 * time, and VitePress's own global `<Badge>`. */
const KNOWN_COMPONENTS = new Set<string>([...REWRITTEN_COMPONENTS, "Badge"]);

export interface ConvertedMdx {
	content: string;
	/** Leftover capitalized JSX tags with no counterpart here, for the report. */
	components: string[];
}

/**
 * MDX parses a block whose first line starts with `import ` or `export ` as
 * ESM rather than prose, so under moonwave those lines fed theme components
 * and never rendered; here they would render as literal text. A block is
 * dropped through the blank line that ends it, and a blank line inside an
 * open bracket pair does not end it (MDX reads on while the statement is
 * unfinished). A mid-paragraph line starting with the word "import" stays: it
 * was prose there too.
 */
function stripEsm(segment: string): string {
	const brackets = (line: string): number =>
		(line.match(/[([{]/g)?.length ?? 0) - (line.match(/[)\]}]/g)?.length ?? 0);
	const kept: string[] = [];
	let atBlockStart = true;
	let dropping = false;
	let depth = 0;
	for (const line of segment.split(/(?<=\n)/)) {
		const blank = line.trim() === "";
		if (dropping && (!blank || depth > 0)) {
			depth += brackets(line);
			continue;
		}
		dropping = atBlockStart && !blank && /^(?:import|export)\s/.test(line);
		if (dropping) {
			depth = brackets(line);
		} else {
			kept.push(line);
		}
		atBlockStart = blank;
	}
	return kept.join("");
}

/** An MDX comment: a JS block comment in braces. VitePress would print it. */
const MDX_COMMENT = /\{\s*\/\*([\s\S]*?)\*\/\s*\}/g;

// comment-or-span, scanned left to right: a code span opening first keeps a
// comment mention verbatim, while a comment opening first consumes any
// backticks in its body, the way MDX reads both
const COMMENT_OR_SPAN = new RegExp(`${CODE_SPAN.source}|${MDX_COMMENT.source}`, "g");

/**
 * MDX comments become HTML comments before the code-span split, since a
 * comment body may hold backticks the span regex would cut it on. `--` pairs
 * in the body are spaced apart: a `-->` inside would end the HTML comment
 * early, and the text is invisible either way.
 */
function convertMdxComments(segment: string): string {
	return segment.replace(COMMENT_OR_SPAN, (match, _span: string | undefined, body?: string) =>
		body === undefined ? match : `<!--${body.replace(/--/g, "- -")}-->`,
	);
}

/**
 * One moonwave-era link target respelled for the generated site, wherever a
 * target appears (inline links and images, reference definitions, raw HTML
 * href/src, navbar items): a path reaching into .moonwave/static/ keeps only
 * the part below it (the static copy lands in public/, served from the site
 * root), absolute /docs/ paths move to /guide/ with the pages, and a .mdx
 * target follows the rename.
 */
function convertTarget(target: string): string {
	return (
		moonwaveStaticTarget(target) ??
		target.replace(/^\/docs(?=\/|$)/, "/guide").replace(/\.mdx(?=$|[#?])/, ".md")
	);
}

/**
 * A JSX expression holding only a whitespace string literal: Prettier inserts
 * `{" "}` when it wraps a JSX line, so the space survives the newline JSX
 * trims. MDX renders the space; VitePress would print the braces.
 */
const JSX_SPACE = /\{\s*(["'])[ \t]*\1\s*\}/g;

function convertProse(segment: string): string {
	return mapOutsideCodeSpans(convertMdxComments(stripEsm(segment)), (prose) =>
		rewriteTargets(prose.replace(JSX_SPACE, " "), convertTarget),
	);
}

/**
 * Docusaurus fence attributes respelled on the opener line only: `title="x"`
 * becomes VitePress's `[x]`, and `showLineNumbers` (optionally `={n}`) becomes
 * the `:line-numbers` suffix on the language. `{1,3-4}` line highlighting is
 * already the same syntax in both, and the fence body is never touched.
 */
function convertFence(fence: string): string {
	const newline = fence.indexOf("\n");
	const opener = newline === -1 ? fence : fence.slice(0, newline);
	let converted = opener.replace(
		/[ \t]+title=(["'])(.*?)\1/,
		(_match, _quote: string, title: string) => ` [${title}]`,
	);
	const numbers = converted.match(/[ \t]+showLineNumbers(?:=\{?(\d+)\}?)?/);
	if (numbers) {
		converted = converted
			.replace(numbers[0], "")
			.replace(
				/^([ \t]{0,3}(?:`{3,}|~{3,})[^ \t]*)/,
				`$1:line-numbers${numbers[1] !== undefined ? `=${numbers[1]}` : ""}`,
			);
	}
	return converted === opener ? fence : converted + (newline === -1 ? "" : fence.slice(newline));
}

/**
 * One page out of MDX: prose and fences each get their own rewrites, sharing
 * the fence split so an example that *shows* the syntax is never touched.
 * `:::note` and `<Tabs>` stay as written: the site rewrites those at render
 * time, in doc comments and guide pages alike.
 */
export function convertMdxPage(text: string): ConvertedMdx {
	// frontmatter is its own block to MDX, so the body after it starts a new
	// one; holding it aside also keeps its scalars out of every rewrite
	const block = frontmatterBlock(text) ?? "";
	const body = text.slice(block.length);
	const content =
		block +
		splitFences(body)
			.map((segment, index) =>
				index % 2 === 0 ? convertProse(segment) : convertFence(segment),
			)
			.join("");
	// leftover capitalized JSX is a docusaurus theme component that would
	// render as plain text; a tag inside an HTML comment (converted or
	// pre-existing) never renders, so it is not one
	const components = new Set<string>();
	for (const segment of outsideFences(content)) {
		for (const prose of outsideCodeSpans(segment.replace(HTML_COMMENT_INLINE, ""))) {
			for (const match of prose.matchAll(/<([A-Z][A-Za-z0-9]*)\b/g)) {
				if (!KNOWN_COMPONENTS.has(match[1]!)) {
					components.add(match[1]!);
				}
			}
		}
	}
	return { content, components: [...components].sort() };
}

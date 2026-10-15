/**
 * Implements `luaudocs init --from-moonwave`: converts `moonwave.toml` /
 * `moonwave.json` to `luaudocs.toml` and ports hand-written pages (`docs/` ->
 * `guide/`, `pages/` -> the docs root) out of Docusaurus MDX.
 *
 * Conversion rules: settings and syntax with a direct VitePress equivalent are
 * mapped, settings made moot by the generated site are dropped silently, and
 * everything else is listed in the console report rather than guessed at.
 * Converted pages carry no generated marker because they belong to the user
 * immediately after creation.
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
import {
	CATEGORY_FILES,
	CATEGORY_KEYS,
	derivedNav,
	heroActions,
	homeLayoutPage,
	parseCategory,
} from "./site";

/*
 * ------------------------------------------------------------------ the config
 */

/**
 * Parsed Moonwave config, read before `init` writes anything so invalid TOML/JSON
 * aborts cleanly on an untouched tree.
 */
export interface MoonwaveSource {
	raw: Record<string, unknown>;
	projectDir: string;
	title: string | undefined;
	description: string | undefined;
	/** True when `convertMoonwave` will emit a home-layout `index.md`. */
	hasHomeBranding: boolean;
}

export interface MoonwaveConversion {
	configToml: string;
	/**
	 * Home-layout `index.md` carrying Moonwave's homepage banner and feature cards
	 * when present (written without a generated marker so it belongs to the user).
	 */
	homeIndexMd?: string;
	report: string[];
}

/** Returns `value` as a record when it is a non-array object, or `{}` otherwise. */
function tableOf(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** Returns `value` when it is a string, or `undefined` otherwise. */
function stringOf(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/**
 * Returns dotted key paths for keys in `raw` that are neither in `handled` nor
 * in `silent`, for the unmapped-keys report.
 */
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

/**
 * Normalizes a Docusaurus `.moonwave/static/` asset path (`"img/favicon.ico"`)
 * to a root-relative `/...` path served from `public/`, leaving full URLs untouched.
 */
function rooted(path: string): string {
	return /^[a-z][a-z0-9+.-]*:/i.test(path) ? path : `/${path.replace(/^\/+/, "")}`;
}

/** Joins `host` and `baseUrl` into a single published URL, or returns `undefined` if invalid. */
function joinedUrl(host: string, baseUrl: unknown, defaultBase: string): string | undefined {
	try {
		return new URL(stringOf(baseUrl) ?? defaultBase, host).href;
	} catch {
		return undefined;
	}
}

/** Parses `moonwave.toml` or `moonwave.json`, throwing on malformed syntax. */
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
		// `title` is required in `luaudocs.toml`, whereas Moonwave allows omitting it.
		title: stringOf(raw.title),
		description: stringOf(docusaurus.tagline),
		// Matches the condition `convertMoonwave` uses to emit `homeIndexMd`.
		hasHomeBranding:
			typeof home.bannerImage === "string" ||
			(Array.isArray(home.features) && home.features.length > 0),
	};
}

/**
 * Converts a parsed Moonwave config into `luaudocs.toml`.
 *
 * Keys dropped silently because the generated VitePress site makes them moot:
 * - `docusaurus.deploymentBranch`: the scaffolded workflow deploys via `actions/deploy-pages`
 * - `docusaurus.onBrokenLinks` / `onBrokenMarkdownLinks`: VitePress always checks links on build
 * - `docusaurus.trailingSlash`: VitePress runs with `cleanUrls: true`
 * - `footer.style`: VitePress has a single footer style
 * - `home.enabled`: replaced by the generated or converted `index.md` landing page
 */
export function convertMoonwave(
	source: MoonwaveSource,
	options: {
		fallbackTitle?: string;
		/** Preserves an existing custom `[docs] dir`, which Moonwave has no key for. */
		docsDir?: string;
		/** Link to the first guide page on disk, used in the navbar and homepage hero. */
		guideLink?: string;
		/** Overrides `home.includeReadme` when an existing `luaudocs.toml` is kept without `--force`. */
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

	// Moonwave takes source roots via `--code` (defaulting to `["lib", "src"]`)
	// rather than a config key. Probe in Moonwave's order and fall back to
	// `DEFAULT_ENTRIES` so the converted site always has an API section.
	const probed = probeEntries(projectDir, ["lib", "src"], true);
	config.source = { entries: probed.length > 0 ? probed : DEFAULT_ENTRIES };

	// Prefer `gitRepoUrl`, falling back to `docusaurus.organizationName` + `projectName`.
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
	// `navbar.title` in Docusaurus corresponds to `siteTitle` in VitePress.
	if (typeof navbar.title === "string") {
		site.siteTitle = navbar.title;
	}
	if (typeof docusaurus.favicon === "string") {
		site.favicon = rooted(docusaurus.favicon);
	}
	const logo = tableOf(navbar.logo);
	if (typeof logo.src === "string") {
		// Drop `navbar.logo.alt` silently because `[site] logo` takes a path or `{ light, dark }`.
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
			// Drop `position` silently (VitePress renders a single navbar row
			// with the GitHub icon to its right), and rewrite internal `to`
			// paths (`docs/...` -> `/guide/...`).
			nav.push({ text: entry.label, link: convertTarget(rooted(link)) });
		} else {
			itemsReport.push(`navbar.items[${index}]`);
		}
	});
	if (nav.length > 0) {
		site.nav = [
			...derivedNav(
				guideLink,
				true,
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
		// Keep `[docs] dir` aligned with the existing directory `init` scaffolded into.
		docs.dir = docsDir;
	}
	// Only `changelog = false` needs to be written: LuauDocs enables the
	// changelog page automatically when `CHANGELOG.md` exists, matching Moonwave.
	if (raw.changelog === false) {
		docs.changelog = false;
	}
	if (home.includeReadme === true) {
		docs.includeReadme = true;
	}
	if (typeof docusaurus.url === "string") {
		// Combine Docusaurus's `url` (origin) and `baseUrl` (path) into `[docs] url`.
		// If `docusaurus.url` is malformed, keep it as written so config validation surfaces it.
		docs.url = joinedUrl(docusaurus.url, docusaurus.baseUrl, "/") ?? docusaurus.url;
	} else if (org !== undefined) {
		// When `docusaurus.url` is unset, use Moonwave's GitHub Pages default:
		// `https://<org>.github.io/<project>/`.
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

	// Emit a user-owned `index.md` when Moonwave configured a banner image or
	// feature cards; otherwise the build's generated hero already covers it.
	let homeIndexMd: string | undefined;
	const features = Array.isArray(home.features) ? home.features.map(tableOf) : [];
	const banner = typeof home.bannerImage === "string" ? rooted(home.bannerImage) : undefined;
	if (banner !== undefined || features.length > 0) {
		homeIndexMd = homeLayoutPage({
			title: resolvedTitle,
			tagline: description,
			image: banner,
			actions: heroActions(guideLink, true),
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
	/** Destination path relative to the docs directory (`"guide/intro.md"`). */
	destRel: string;
	content: string | Buffer;
}

export interface MoonwavePages {
	files: MoonwavePage[];
	/** Console report lines, in the same format as `convertMoonwave`. */
	report: string[];
}

const PAGE_EXTENSION = /\.mdx?$/;

/**
 * Reads and converts a Moonwave project's hand-written content without writing
 * to disk (`init` owns the file-writing protocol):
 * - `docs/` Markdown/MDX pages land under `guide/`, where the sidebar walk reads
 *   their existing `sidebar_position` frontmatter.
 * - `pages/` Markdown/MDX pages land at the docs root (except `pages/api/*`,
 *   which would be swept by the next build).
 * - Co-located assets and `_category_` sidecars copy verbatim.
 * - `.moonwave/custom.css` lands at `custom.css` with known Infima variables renamed.
 * - Draft/unlisted pages, `blog/`, React pages, and `.moonwave/sidebars.js` are
 *   skipped and listed in the report.
 */
export function collectMoonwavePages(projectDir: string): MoonwavePages {
	const files: MoonwavePage[] = [];
	const checkByHand: string[] = [];
	const reactPages: string[] = [];
	const apiPages: string[] = [];
	const drafts: string[] = [];

	const convert = (abs: string, srcRel: string, destRel: string): void => {
		const text = readFileSync(abs, "utf8");
		const block = frontmatter(text);
		// Skip `draft` and `unlisted` pages so unpublished Docusaurus drafts are
		// not accidentally published on the converted site.
		if (field(block, "draft") === "true" || field(block, "unlisted") === "true") {
			drafts.push(srcRel);
			return;
		}
		const { content, components } = convertMdxPage(text);
		const dest = destRel.replace(PAGE_EXTENSION, ".md");
		files.push({ destRel: dest, content });
		// Flag frontmatter `slug` or `id` overrides because VitePress routes
		// follow the file path directly.
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
		if (PAGE_EXTENSION.test(rel)) {
			convert(abs, `docs/${rel}`, `guide/${rel}`);
			continue;
		}
		const content = readFileSync(abs);
		files.push({ destRel: `guide/${rel}`, content });
		// Copy `_category_` sidecars and report any Docusaurus-only keys (`link`,
		// `className`, etc.) that LuauDocs does not read. Throws before any file
		// is written if the sidecar itself fails to parse.
		if (CATEGORY_FILES.includes(basename(rel))) {
			const extra = Object.keys(
				parseCategory(`docs/${rel}`, content.toString("utf8")),
			).filter((key) => !(CATEGORY_KEYS as readonly string[]).includes(key));
			if (extra.length > 0) {
				checkByHand.push(
					`  check by hand: guide/${rel} sets ${extra.join(", ")}, which the sidebar does not read`,
				);
			}
		}
	}

	for (const { abs, rel } of filesUnder(join(projectDir, "pages"))) {
		if (rel.startsWith("api/")) {
			// `<docs>/api/` is owned by the build and swept on every run.
			apiPages.push(`pages/${rel}`);
		} else if (PAGE_EXTENSION.test(rel)) {
			convert(abs, `pages/${rel}`, rel);
		} else if (/\.(?:[jt]sx?|html|css)$/.test(rel)) {
			reactPages.push(`pages/${rel}`);
		} else {
			files.push({ destRel: rel, content: readFileSync(abs) });
		}
	}

	// Copy `.moonwave/custom.css` with known Infima variable names mapped to
	// VitePress `--vp-*` variables, reporting any remaining `--ifm-*` names.
	const customCss = join(projectDir, ".moonwave", "custom.css");
	if (existsSync(customCss)) {
		const { content, leftover } = convertInfimaCss(readFileSync(customCss, "utf8"));
		files.push({ destRel: "custom.css", content });
		if (leftover.length > 0) {
			checkByHand.push(`  check by hand: custom.css still uses ${leftover.join(", ")}`);
		}
	}

	const report: string[] = [];
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
	// Check `blog/` presence without walking its contents.
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
 * Infima CSS custom properties that map one-for-one to VitePress variables,
 * ordered longest-first and guarded with `(?![\w-])` so prefixes cannot match
 * inside longer variable names. Also maps Docusaurus's `[data-theme="dark"]`
 * selector to VitePress's `.dark` class.
 */
const INFIMA_RENAMES: Array<[RegExp, string]> = [
	[/--ifm-color-primary-darker(?![\w-])/g, "--vp-c-brand-3"],
	[/--ifm-color-primary-dark(?![\w-])/g, "--vp-c-brand-2"],
	[/--ifm-color-primary(?![\w-])/g, "--vp-c-brand-1"],
	[/--ifm-background-color(?![\w-])/g, "--vp-c-bg"],
	[/\[data-theme=["']dark["']\]/g, ".dark"],
];

/**
 * Renames known Infima CSS variables in `.moonwave/custom.css` and returns any
 * remaining `--ifm-*` variable names in `leftover`.
 */
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

/** Capitalized component tags supported in LuauDocs pages (runtime-rewritten tags plus VitePress's global `<Badge>`). */
const KNOWN_COMPONENTS = new Set<string>([...REWRITTEN_COMPONENTS, "Badge"]);

export interface ConvertedMdx {
	content: string;
	/** Unrecognized PascalCase JSX tags remaining in the page, for the conversion report. */
	components: string[];
}

/**
 * Strips top-level MDX `import` and `export` blocks. Under Docusaurus MDX, a
 * paragraph starting with `import ` or `export ` is parsed as ESM rather than
 * prose; in VitePress it would render as literal text. Drops each ESM block
 * through the blank line that closes it (ignoring blank lines inside unclosed
 * brackets), while preserving mid-paragraph lines that happen to start with
 * `"import"` or `"export"`.
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

/** Matches an MDX `{/* ... * /}` comment, which VitePress would otherwise print as text. */
const MDX_COMMENT = /\{\s*\/\*([\s\S]*?)\*\/\s*\}/g;

// Scan inline code spans and MDX comments together from left to right: a code
// span opening first preserves `{/* ... */}` inside backticks, while an MDX
// comment opening first consumes any backticks inside the comment body.
const COMMENT_OR_SPAN = new RegExp(`${CODE_SPAN.source}|${MDX_COMMENT.source}`, "g");

/**
 * Converts MDX `{/* ... * /}` comments outside inline code spans to HTML
 * comments (`<!-- ... -->`), spacing out any `--` runs inside the comment body
 * so an embedded `-->` cannot close the HTML comment early.
 */
function convertMdxComments(segment: string): string {
	return segment.replace(COMMENT_OR_SPAN, (match, _span: string | undefined, body?: string) =>
		body === undefined ? match : `<!--${body.replace(/--/g, "- -")}-->`,
	);
}

/**
 * Rewrites a Moonwave link target for the generated VitePress site:
 * - `.moonwave/static/...` paths become `/...` (served from `public/`)
 * - `/docs/...` paths move to `/guide/...`
 * - `.mdx` extensions become `.md`
 */
function convertTarget(target: string): string {
	return (
		moonwaveStaticTarget(target) ??
		target.replace(/^\/docs(?=\/|$)/, "/guide").replace(/\.mdx(?=$|[#?])/, ".md")
	);
}

/**
 * Matches JSX whitespace expressions (`{" "}` or `{' '}`) that Prettier inserts
 * when wrapping JSX lines; MDX renders them as a space, whereas VitePress would
 * print the literal braces.
 */
const JSX_SPACE = /\{\s*(["'])[ \t]*\1\s*\}/g;

function convertProse(segment: string): string {
	return mapOutsideCodeSpans(convertMdxComments(stripEsm(segment)), (prose) =>
		rewriteTargets(prose.replace(JSX_SPACE, " "), convertTarget),
	);
}

/**
 * Converts Docusaurus code-fence attributes on the opening fence line to
 * VitePress syntax: `title="x"` becomes `[x]`, and `showLineNumbers` (with
 * optional `={n}`) becomes `:line-numbers` on the language tag. `{1,3-4}` line
 * highlights already share the same syntax, and the fence body is never touched.
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
 * Converts a single MDX page to VitePress Markdown, rewriting prose and fence
 * openers separately so code examples inside fences remain untouched. `:::note`
 * admonitions and `<Tabs>` / `<TabItem>` stay as written because the site
 * runtime rewrites them at render time in both guides and doc comments.
 */
export function convertMdxPage(text: string): ConvertedMdx {
	// Hold frontmatter aside so ESM stripping starts at the top of the Markdown
	// body and frontmatter scalars are never rewritten.
	const block = frontmatterBlock(text) ?? "";
	const body = text.slice(block.length);
	const content =
		block +
		splitFences(body)
			.map((segment, index) =>
				index % 2 === 0 ? convertProse(segment) : convertFence(segment),
			)
			.join("");
	// Collect any remaining unrecognized PascalCase JSX tags outside fences,
	// code spans, and HTML comments for the conversion report.
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

/**
 * luaudocs.toml: discovery (walk up from the start directory), parsing
 * (smol-toml), and a hand-rolled validator. Validation is strict about
 * unknown keys on purpose: silently stripping a misspelled key while its
 * default takes effect is the worst failure mode a config can have.
 *
 * The file itself is optional: when no config exists in the directory tree,
 * the loader synthesizes one (title from the folder name, entries probed by
 * convention), so `build` and `dev` work in a project with no LuauDocs
 * footprint at all. Strictness and defaults do not conflict: a key that is
 * present must be well-formed, while an omitted key falls back to its default.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { toPosix } from "./pages";

export interface NavItem {
	text: string;
	link?: string;
	/** Route pattern that marks the entry active across a section (`^/guide/` keeps Guide highlighted past its landing page). */
	activeMatch?: string;
	items?: NavItem[];
}

/** One `[[site.head]]` entry: a tag appended verbatim to every page's `<head>`. */
export interface HeadTag {
	tag: string;
	attrs?: Record<string, string>;
	content?: string;
}

/**
 * Target configuration for a runtime alias: `url` is the base URL its module
 * pages hang under (`@lute/fs` -> `<url>/fs`), and `model` is a doc model
 * published by the runtime's own LuauDocs site (`public/docmodel.json`, via URL
 * or local path) so types reached through the alias link to their exact
 * declaration. When both are omitted, the alias is recognized and mounts
 * cleanly without linking anywhere.
 */
export interface AliasConfig {
	url?: string;
	model?: string;
}

export interface LuauDocsConfig {
	title: string;
	description?: string;
	source: {
		/** `[]` means guide-only: the extractor never runs and no `/api/` pages are emitted. */
		entries: string[];
		include?: string[];
		exclude?: string[];
		projectFile?: string;
		/** Runtime-provided require aliases (lowercased, without `@`); see AliasConfig. */
		aliases: Record<string, AliasConfig>;
	};
	repo?: { url: string; branch: string };
	site: {
		/** Navbar brand text: defaults to `title`; `false` shows only the logo. */
		siteTitle?: string | false;
		logo?: string | { light: string; dark: string };
		favicon?: string;
		ogImage?: string;
		footer?: { message?: string; copyright?: string };
		nav?: NavItem[];
		head?: HeadTag[];
	};
	api: { includePrivate: boolean; linkRobloxTypes: boolean; reportUndocumented: boolean };
	docs: {
		dir: string;
		url?: string;
		changelog?: boolean;
		includeReadme: boolean;
		llms: boolean;
		/** Publish the doc model as `public/docmodel.json` for other sites that link to this one. */
		model: boolean;
	};
}

export const DEFAULT_ENTRIES = ["src"];
export const DEFAULT_BRANCH = "main";
export const DEFAULT_DOCS_DIR = ".luaudocs";
/**
 * Built-in aliases supplied by Luau runtimes rather than `.luaurc`. A require
 * through one is a real dependency that no project file can resolve, so the
 * extractor treats it as external instead of unresolved, and types imported
 * through it link to the module's page under this base URL (`@lute/fs` ->
 * `.../lute/fs`). `[source.aliases]` adds to or overrides these defaults;
 * `false` removes a built-in alias.
 */
export const DEFAULT_ALIASES: Record<string, AliasConfig> = {
	lute: { url: "https://lute.luau.org/lute" },
	std: { url: "https://lute.luau.org/std" },
	lune: { url: "https://lune-org.github.io/docs/api-reference" },
};

/**
 * Formats a repository file URL on its host for source links and rewritten
 * README links: `blob` renders the file view, while `raw` serves the raw bytes
 * needed by inline `<img>` tags. Uses GitHub's URL layout, which `[repo]`
 * targets.
 */
export function repoFileUrl(
	repo: NonNullable<LuauDocsConfig["repo"]>,
	path: string,
	inline = false,
): string {
	return `${repo.url}/${inline ? "raw" : "blob"}/${repo.branch}/${path}`;
}

class ConfigError extends Error {}

function fail(path: string, expected: string): never {
	throw new ConfigError(`luaudocs.toml: ${path}: expected ${expected}`);
}

function table(value: unknown, path: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		fail(path, "a table");
	}
	return value as Record<string, unknown>;
}

function str(value: unknown, path: string): string {
	if (typeof value !== "string") {
		fail(path, "a string");
	}
	return value;
}

function bool(value: unknown, path: string): boolean {
	if (typeof value !== "boolean") {
		fail(path, "a boolean");
	}
	return value;
}

function strArray(value: unknown, path: string): string[] {
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
		fail(path, "an array of strings");
	}
	return value as string[];
}

/**
 * `[source] aliases`, merged over the built-in runtimes. Names are lowercased
 * (Luau resolves aliases case-insensitively) and stripped of any leading `@`,
 * so `"@Lute"` and `lute` name the same alias. A URL string links the alias to
 * that base, a table sets `url` and `model` separately (`model` requires `url`),
 * `true` registers the alias without linking it, and `false` removes a built-in.
 */
function aliases(value: unknown, path: string): Record<string, AliasConfig> {
	const raw = table(value, path);
	const merged: Record<string, AliasConfig> = { ...DEFAULT_ALIASES };
	for (const [key, entry] of Object.entries(raw)) {
		const name = key.replace(/^@/, "").toLowerCase();
		const entryPath = keyPath(path, key);
		if (entry === false) {
			delete merged[name];
		} else if (entry === true) {
			merged[name] = {};
		} else if (typeof entry === "string") {
			merged[name] = { url: url(entry, entryPath) };
		} else if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
			const spec = entry as Record<string, unknown>;
			noUnknownKeys(spec, entryPath, ["url", "model"]);
			const alias = {
				url: opt(spec, entryPath, "url", url),
				model: opt(spec, entryPath, "model", str),
			};
			// a model's links resolve against the site it was published from
			if (alias.model !== undefined && alias.url === undefined) {
				fail(
					keyPath(entryPath, "url"),
					"a URL beside model, the site it was published from",
				);
			}
			merged[name] = alias;
		} else {
			fail(entryPath, "a URL, a table with url and model, true, or false");
		}
	}
	return merged;
}

/**
 * Shared URL normalizer for every URL config key and `build --url`: trims
 * trailing slashes (callers append their own) and returns `undefined` when the
 * input is not an `http(s)` URL. Checking the scheme catches bare hosts with
 * ports (`docs.example.com:8080` parses as scheme `docs.example.com:` with path
 * `8080`, which would bake `base: "/8080/"`) as well as `ssh://` remotes that
 * cannot open in a browser.
 */
function normalizeUrl(value: string): string | undefined {
	const text = value.replace(/\/+$/, "");
	try {
		const { protocol } = new URL(text);
		return protocol === "http:" || protocol === "https:" ? text : undefined;
	} catch {
		return undefined;
	}
}

function url(value: unknown, path: string): string {
	const text = normalizeUrl(str(value, path));
	if (text === undefined) {
		fail(path, "an http(s) URL");
	}
	return text;
}

function keyPath(path: string, key: string): string {
	return path === "" ? key : `${path}.${key}`;
}

function noUnknownKeys(raw: Record<string, unknown>, path: string, known: string[]) {
	for (const key of Object.keys(raw)) {
		if (!known.includes(key)) {
			throw new ConfigError(`luaudocs.toml: unknown key ${keyPath(path, key)}`);
		}
	}
}

/**
 * Validates an optional key with `coerce`, returning `undefined` when absent so
 * defaulted fields read as `opt(...) ?? default`. Deriving the error path here
 * prevents copy-pasted key names in diagnostics.
 */
function opt<T>(
	raw: Record<string, unknown>,
	path: string,
	key: string,
	coerce: (value: unknown, path: string) => T,
): T | undefined {
	const value = raw[key];
	return value === undefined ? undefined : coerce(value, keyPath(path, key));
}

/** Reads an optional root table, returning `{}` when absent so callers can
 * read its keys directly without a second `!== undefined` guard. */
function rootTable(raw: Record<string, unknown>, key: string): Record<string, unknown> {
	return raw[key] === undefined ? {} : table(raw[key], key);
}

function navItems(value: unknown, path: string): NavItem[] {
	if (!Array.isArray(value)) {
		fail(path, "an array of nav items");
	}
	return value.map((item, i) => {
		const itemPath = `${path}[${i}]`;
		const raw = table(item, itemPath);
		noUnknownKeys(raw, itemPath, ["text", "link", "activeMatch", "items"]);
		const nav: NavItem = { text: str(raw.text, `${itemPath}.text`) };
		const link = opt(raw, itemPath, "link", str);
		const activeMatch = opt(raw, itemPath, "activeMatch", str);
		const items = opt(raw, itemPath, "items", navItems);
		if (link !== undefined) nav.link = link;
		if (activeMatch !== undefined) nav.activeMatch = activeMatch;
		if (items !== undefined) nav.items = items;
		if (nav.link === undefined && nav.items === undefined) {
			fail(itemPath, "a nav item with a link or items");
		}
		return nav;
	});
}

function footer(value: unknown, path: string): NonNullable<LuauDocsConfig["site"]["footer"]> {
	const raw = table(value, path);
	noUnknownKeys(raw, path, ["message", "copyright"]);
	return {
		message: opt(raw, path, "message", str),
		copyright: opt(raw, path, "copyright", str),
	};
}

function headTags(value: unknown, path: string): HeadTag[] {
	if (!Array.isArray(value)) {
		fail(path, "an array of head entries");
	}
	return value.map((item, i) => {
		const itemPath = `${path}[${i}]`;
		const raw = table(item, itemPath);
		noUnknownKeys(raw, itemPath, ["tag", "attrs", "content"]);
		const entry: HeadTag = { tag: str(raw.tag, `${itemPath}.tag`) };
		const attrs = opt(raw, itemPath, "attrs", table);
		if (attrs !== undefined) {
			for (const [key, attr] of Object.entries(attrs)) {
				str(attr, `${itemPath}.attrs.${key}`);
			}
			entry.attrs = attrs as Record<string, string>;
		}
		const content = opt(raw, itemPath, "content", str);
		if (content !== undefined) entry.content = content;
		return entry;
	});
}

/**
 * Validates a parsed TOML document into a complete config with defaults filled.
 * `fallbackTitle` (the folder name supplied by the config loaders) makes
 * `title` optional on disk; calling `validateConfig` without one keeps `title`
 * required.
 */
export function validateConfig(data: unknown, fallbackTitle?: string): LuauDocsConfig {
	const raw = table(data, "(root)");
	noUnknownKeys(raw, "", ["title", "description", "source", "repo", "site", "api", "docs"]);
	if (raw.title === undefined && fallbackTitle === undefined) {
		throw new ConfigError("luaudocs.toml: title is required");
	}

	const rawSource = rootTable(raw, "source");
	noUnknownKeys(rawSource, "source", ["entries", "include", "exclude", "projectFile", "aliases"]);
	const source: LuauDocsConfig["source"] = {
		entries: opt(rawSource, "source", "entries", strArray) ?? DEFAULT_ENTRIES,
		include: opt(rawSource, "source", "include", strArray),
		exclude: opt(rawSource, "source", "exclude", strArray),
		projectFile: opt(rawSource, "source", "projectFile", str),
		aliases: opt(rawSource, "source", "aliases", aliases) ?? { ...DEFAULT_ALIASES },
	};

	// [repo] has a required `url` key, so it stays undefined when omitted
	let repo: LuauDocsConfig["repo"];
	if (raw.repo !== undefined) {
		const rawRepo = table(raw.repo, "repo");
		noUnknownKeys(rawRepo, "repo", ["url", "branch"]);
		repo = {
			url: url(rawRepo.url, "repo.url"),
			branch: opt(rawRepo, "repo", "branch", str) ?? DEFAULT_BRANCH,
		};
	}

	const rawSite = rootTable(raw, "site");
	noUnknownKeys(rawSite, "site", [
		"siteTitle",
		"logo",
		"favicon",
		"ogImage",
		"footer",
		"nav",
		"head",
	]);
	const site: LuauDocsConfig["site"] = {
		favicon: opt(rawSite, "site", "favicon", str),
		ogImage: opt(rawSite, "site", "ogImage", str),
		footer: opt(rawSite, "site", "footer", footer),
		nav: opt(rawSite, "site", "nav", navItems),
		head: opt(rawSite, "site", "head", headTags),
	};
	// union-typed keys validated inline rather than through a single-purpose coercer
	if (rawSite.siteTitle !== undefined) {
		if (typeof rawSite.siteTitle !== "string" && rawSite.siteTitle !== false) {
			fail("site.siteTitle", "a string or false");
		}
		site.siteTitle = rawSite.siteTitle;
	}
	if (rawSite.logo !== undefined) {
		if (typeof rawSite.logo === "string") {
			site.logo = rawSite.logo;
		} else {
			const logo = table(rawSite.logo, "site.logo");
			noUnknownKeys(logo, "site.logo", ["light", "dark"]);
			site.logo = {
				light: str(logo.light, "site.logo.light"),
				dark: str(logo.dark, "site.logo.dark"),
			};
		}
	}

	const rawApi = rootTable(raw, "api");
	noUnknownKeys(rawApi, "api", ["includePrivate", "linkRobloxTypes", "reportUndocumented"]);
	const api: LuauDocsConfig["api"] = {
		includePrivate: opt(rawApi, "api", "includePrivate", bool) ?? false,
		linkRobloxTypes: opt(rawApi, "api", "linkRobloxTypes", bool) ?? true,
		reportUndocumented: opt(rawApi, "api", "reportUndocumented", bool) ?? false,
	};

	const rawDocs = rootTable(raw, "docs");
	noUnknownKeys(rawDocs, "docs", ["dir", "url", "changelog", "includeReadme", "llms", "model"]);
	const docs: LuauDocsConfig["docs"] = {
		dir: opt(rawDocs, "docs", "dir", str) ?? DEFAULT_DOCS_DIR,
		url: opt(rawDocs, "docs", "url", url),
		changelog: opt(rawDocs, "docs", "changelog", bool),
		includeReadme: opt(rawDocs, "docs", "includeReadme", bool) ?? false,
		llms: opt(rawDocs, "docs", "llms", bool) ?? true,
		model: opt(rawDocs, "docs", "model", bool) ?? false,
	};

	return {
		// the guard above ensures fallbackTitle is defined whenever raw.title is absent
		title: raw.title === undefined ? fallbackTitle! : str(raw.title, "title"),
		description: opt(raw, "", "description", str),
		source,
		repo,
		site,
		api,
		docs,
	};
}

export function parseConfig(tomlText: string, fallbackTitle?: string): LuauDocsConfig {
	let data: unknown;
	try {
		data = parseToml(tomlText);
	} catch (error) {
		throw new ConfigError(
			`luaudocs.toml: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return validateConfig(data, fallbackTitle);
}

export function parseUrlFlag(value: string): string {
	const text = normalizeUrl(value);
	if (text === undefined) {
		throw new ConfigError(`--url: expected an http(s) URL, got ${JSON.stringify(value)}`);
	}
	return text;
}

export interface LoadedConfig {
	config: LuauDocsConfig;
	/** Base directory for relative paths: the folder containing `luaudocs.toml`, or the start directory when no config file exists. */
	root: string;
	/** Undefined when the project has no `luaudocs.toml` and runs on defaults. */
	configPath?: string;
}

function findConfig(startDir: string): string | undefined {
	let dir = resolve(startDir);
	for (;;) {
		const candidate = join(dir, "luaudocs.toml");
		try {
			readFileSync(candidate);
			return candidate;
		} catch {
			const parent = dirname(dir);
			if (parent === dir) {
				return undefined;
			}
			dir = parent;
		}
	}
}

/** Conventional entry directories probed in order when no config file exists (and by `init` when generating a starter config). */
export const PROBED_ENTRIES = ["src", "lib"];

/**
 * Probes conventional module roots in caller-specified order, shared by
 * config-less builds, `init`, and Moonwave conversion. When `requireInit` is
 * true, only directories containing an `init.luau` or `init.lua` match, so
 * `init` never writes an entry directory that would fail the first build;
 * config-less builds pass `false` so the extractor's own `entry-missing`
 * diagnostic reports a folder without an init file.
 */
export function probeEntries(root: string, order: string[], requireInit: boolean): string[] {
	return order.filter((dir) =>
		requireInit
			? ["init.luau", "init.lua"].some((init) => existsSync(join(root, dir, init)))
			: existsSync(join(root, dir)),
	);
}

/**
 * Synthesizes a default config for a project without `luaudocs.toml`, routed
 * through `validateConfig` so all defaults come from one place. Fails when no
 * conventional source directory exists rather than building an empty site.
 */
export function defaultConfig(root: string): LuauDocsConfig {
	const entries = probeEntries(root, PROBED_ENTRIES, false);
	if (entries.length === 0) {
		throw new ConfigError(
			`no luaudocs.toml found in ${root} or any parent directory, and no ${PROBED_ENTRIES.join(
				"/ or ",
			)}/ to document (run \`luaudocs init\` to create a config)`,
		);
	}
	return validateConfig({ source: { entries } }, basename(root) || "Documentation");
}

/**
 * Normalizes `[docs] dir` to a clean POSIX path relative to `root` (with no
 * leading `./` or trailing slash) so edit links, the Pages workflow's artifact
 * path, and re-templated configs all agree without leaking machine-local
 * absolute paths. Rejects the project root itself and any directory outside it:
 * the build owns `index.md`, `package.json`, and `.gitignore` in the docs root
 * and sweeps `.vitepress/` and `api/` beneath it.
 */
export function normalizeDocsDir(config: LuauDocsConfig, root: string): LuauDocsConfig {
	const rel = toPosix(relative(root, resolve(root, config.docs.dir)));
	if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
		fail(
			"docs.dir",
			`a directory inside the project, not its root or outside it (got ${JSON.stringify(config.docs.dir)})`,
		);
	}
	config.docs.dir = rel;
	return config;
}

export function loadConfig(startDir: string): LoadedConfig {
	const configPath = findConfig(startDir);
	if (configPath === undefined) {
		const root = resolve(startDir);
		return { config: defaultConfig(root), root };
	}
	const root = dirname(configPath);
	return {
		config: normalizeDocsDir(
			parseConfig(readFileSync(configPath, "utf8"), basename(root)),
			root,
		),
		root,
		configPath,
	};
}

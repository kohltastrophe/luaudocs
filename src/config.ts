/**
 * luaudocs.toml: discovery (walk up from the start directory), parsing
 * (smol-toml), and a hand-rolled validator. Validation is strict about
 * unknown keys on purpose: silently stripping a misspelled key while its
 * default takes effect is the worst failure mode a config can have.
 *
 * The file itself is optional: with no config anywhere above, the loader
 * synthesizes one (title from the folder name, entries probed from
 * convention), so `build` and `dev` run in a project with no luaudocs
 * footprint at all. Strictness and defaulting do not conflict: a key that is
 * PRESENT must be well-formed, while an absent one falls back.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";

export interface NavItem {
	text: string;
	link?: string;
	/** The route pattern that marks the entry current, when its link is one page
	 * of a section: `^/guide/` keeps Guide lit past its landing page. */
	activeMatch?: string;
	items?: NavItem[];
}

/** One `[[site.head]]` entry: a tag appended verbatim to every page's head. */
export interface HeadTag {
	tag: string;
	attrs?: Record<string, string>;
	content?: string;
}

export interface LuauDocsConfig {
	title: string;
	description?: string;
	source: {
		/** [] means guide-only: the extractor never runs and no /api/ pages exist. */
		entries: string[];
		include?: string[];
		exclude?: string[];
		projectFile?: string;
	};
	repo?: { url: string; branch: string };
	site: {
		/** The navbar's brand text: defaults to `title`, `false` shows only the logo. */
		siteTitle?: string | false;
		logo?: string | { light: string; dark: string };
		favicon?: string;
		ogImage?: string;
		footer?: { message?: string; copyright?: string };
		nav?: NavItem[];
		head?: HeadTag[];
	};
	api: { includePrivate: boolean; linkRobloxTypes: boolean };
	docs: { dir: string; url?: string; changelog?: boolean; includeReadme: boolean; llms: boolean };
}

export const DEFAULT_ENTRIES = ["src"];
export const DEFAULT_BRANCH = "main";
export const DEFAULT_DOCS_DIR = ".luaudocs";

/**
 * A repository file's URL on its forge, spelled once for every caller that
 * needs one (source links, a README's respelled targets): `blob` renders the
 * file in a page, `raw` serves the bytes an inline `<img>` needs. The path
 * shape is GitHub's, which is the host `[repo]` is documented against.
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
 * The one URL rule, shared by `[docs] url` and `build --url`: trailing slashes
 * trimmed (links append their own), undefined when the result is not a URL.
 * The callers phrase the failure their own way.
 */
function normalizeUrl(value: string): string | undefined {
	const text = value.replace(/\/+$/, "");
	try {
		new URL(text);
	} catch {
		return undefined;
	}
	return text;
}

function url(value: unknown, path: string): string {
	const text = normalizeUrl(str(value, path));
	if (text === undefined) {
		fail(path, "a URL");
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
 * An optional key through its coercer, `undefined` when absent, so a defaulted
 * field reads as one `?? default`. The path is derived rather than passed,
 * which is what stops a copy-pasted key from reporting its neighbour's name.
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

/** One of the root's optional tables, empty when absent so its keys read as
 * absent too and the block below it needs no second `!== undefined`. */
function rootTable(raw: Record<string, unknown>, key: string): Record<string, unknown> {
	return raw[key] === undefined ? {} : table(raw[key], key);
}

function navItems(value: unknown, path: string): NavItem[] {
	if (!Array.isArray(value)) {
		fail(path, "an array of nav items");
	}
	return value.map((item, i) => {
		const raw = table(item, `${path}[${i}]`);
		noUnknownKeys(raw, `${path}[${i}]`, ["text", "link", "activeMatch", "items"]);
		const nav: NavItem = { text: str(raw.text, `${path}[${i}].text`) };
		if (raw.link !== undefined) {
			nav.link = str(raw.link, `${path}[${i}].link`);
		}
		if (raw.activeMatch !== undefined) {
			nav.activeMatch = str(raw.activeMatch, `${path}[${i}].activeMatch`);
		}
		if (raw.items !== undefined) {
			nav.items = navItems(raw.items, `${path}[${i}].items`);
		}
		if (nav.link === undefined && nav.items === undefined) {
			fail(`${path}[${i}]`, "a nav item with a link or items");
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
		const raw = table(item, `${path}[${i}]`);
		noUnknownKeys(raw, `${path}[${i}]`, ["tag", "attrs", "content"]);
		const entry: HeadTag = { tag: str(raw.tag, `${path}[${i}].tag`) };
		if (raw.attrs !== undefined) {
			const attrs = table(raw.attrs, `${path}[${i}].attrs`);
			for (const [key, attr] of Object.entries(attrs)) {
				str(attr, `${path}[${i}].attrs.${key}`);
			}
			entry.attrs = attrs as Record<string, string>;
		}
		if (raw.content !== undefined) {
			entry.content = str(raw.content, `${path}[${i}].content`);
		}
		return entry;
	});
}

/**
 * Validates a parsed TOML document into a config with every default filled.
 * `fallbackTitle` (the folder name, supplied by the loaders) is what makes
 * `title` optional; a direct call without one keeps it required.
 */
export function validateConfig(data: unknown, fallbackTitle?: string): LuauDocsConfig {
	const raw = table(data, "(root)");
	noUnknownKeys(raw, "", ["title", "description", "source", "repo", "site", "api", "docs"]);
	if (raw.title === undefined && fallbackTitle === undefined) {
		throw new ConfigError("luaudocs.toml: title is required");
	}

	const rawSource = rootTable(raw, "source");
	noUnknownKeys(rawSource, "source", ["entries", "include", "exclude", "projectFile"]);
	const source: LuauDocsConfig["source"] = {
		entries: opt(rawSource, "source", "entries", strArray) ?? DEFAULT_ENTRIES,
		include: opt(rawSource, "source", "include", strArray),
		exclude: opt(rawSource, "source", "exclude", strArray),
		projectFile: opt(rawSource, "source", "projectFile", str),
	};

	// the one table with a required key, so its absence is not just defaults
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
	// the two union-typed keys, where the coercer would be the whole rule
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
	noUnknownKeys(rawApi, "api", ["includePrivate", "linkRobloxTypes"]);
	const api: LuauDocsConfig["api"] = {
		includePrivate: opt(rawApi, "api", "includePrivate", bool) ?? false,
		linkRobloxTypes: opt(rawApi, "api", "linkRobloxTypes", bool) ?? true,
	};

	const rawDocs = rootTable(raw, "docs");
	noUnknownKeys(rawDocs, "docs", ["dir", "url", "changelog", "includeReadme", "llms"]);
	const docs: LuauDocsConfig["docs"] = {
		dir: opt(rawDocs, "docs", "dir", str) ?? DEFAULT_DOCS_DIR,
		url: opt(rawDocs, "docs", "url", url),
		changelog: opt(rawDocs, "docs", "changelog", bool),
		includeReadme: opt(rawDocs, "docs", "includeReadme", bool) ?? false,
		llms: opt(rawDocs, "docs", "llms", bool) ?? true,
	};

	return {
		// the guard above proves the fallback exists whenever title is absent
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
		throw new ConfigError(`--url: expected a URL, got ${JSON.stringify(value)}`);
	}
	return text;
}

export interface LoadedConfig {
	config: LuauDocsConfig;
	/** The directory every relative path resolves against: the one holding
	 * luaudocs.toml, or the start directory when no config exists. */
	root: string;
	/** Absent when the project has no luaudocs.toml and defaults apply. */
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

/** Entry roots probed, in order, when no config exists to name any. */
const PROBED_ENTRIES = ["src", "lib"];

/**
 * The one probe for conventional module roots, shared with the moonwave
 * conversion so the two paths cannot drift apart on the criterion. Callers
 * pick the order. `requireInit` demands an init module inside: conversion
 * writes entries into a config, where a directory without one would fail the
 * first build, while the synthesized default prefers the extractor's own
 * "no init.luau" report over silently skipping the directory.
 */
export function probeEntries(root: string, order: string[], requireInit: boolean): string[] {
	return order.filter((dir) =>
		requireInit
			? ["init.luau", "init.lua"].some((init) => existsSync(join(root, dir, init)))
			: existsSync(join(root, dir)),
	);
}

/**
 * The config a project with no luaudocs.toml runs under. Built through the
 * validator so the defaults live in exactly one place. Failing when nothing
 * probes is deliberate: an empty site would only bury the real problem.
 */
function defaultConfig(root: string): LuauDocsConfig {
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

export function loadConfig(startDir: string): LoadedConfig {
	const configPath = findConfig(startDir);
	if (configPath === undefined) {
		const root = resolve(startDir);
		return { config: defaultConfig(root), root };
	}
	return {
		config: parseConfig(readFileSync(configPath, "utf8"), basename(dirname(configPath))),
		root: dirname(configPath),
		configPath,
	};
}

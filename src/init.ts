/**
 * `luaudocs init` command. Scaffolds `luaudocs.toml` plus the user-owned docs content,
 * and optionally converts an existing Moonwave project (both config and
 * hand-written pages, via `src/moonwave.ts`). Skips existing user files unless
 * `--force` is passed, and never touches them again after creation. Syncs the
 * `.vitepress/` machinery once at the end so the site resolves before the first
 * build.
 */
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import pc from "picocolors";
import pkg from "../package.json";
import { createContext } from "./build";
import {
	DEFAULT_BRANCH,
	DEFAULT_DOCS_DIR,
	DEFAULT_ENTRIES,
	type LuauDocsConfig,
	normalizeDocsDir,
	parseConfig,
	PROBED_ENTRIES,
	probeEntries,
} from "./config";
import { packageRoot } from "./extract";
import { frontmatterBlock } from "./markdown";
import {
	collectMoonwavePages,
	convertMoonwave,
	type MoonwavePages,
	type MoonwaveSource,
	readMoonwave,
} from "./moonwave";
import { filesUnder, isGeneratedFile } from "./pages";
import { printWarnings } from "./render";
import { collectGuides, firstGuidePage, syncSite } from "./site";

/** The Node major version from `engines.node`, installed by the scaffolded workflow. */
const NODE_MAJOR = /\d+/.exec(pkg.engines.node)![0];

export interface InitOptions {
	targetDir: string;
	force?: boolean;
	title?: string;
	description?: string;
	fromMoonwave?: boolean;
}

/*
 * -------------------------------------------------------------- the new config
 */

/**
 * Builds `luaudocs.toml` in code rather than shipping a template file because
 * `init` conditionally fills in probed source roots, a detected GitHub remote,
 * and any existing custom docs directory.
 */
function configToml(options: {
	title: string;
	description: string;
	entries: string[];
	repoUrl?: string;
	docsDir?: string;
}): string {
	// A detected GitHub remote enables `[repo]` (source links, edit links, and
	// the GitHub icon) instead of leaving the table commented out, while `branch`
	// stays commented because the config loader defaults it to `"main"`.
	const repo = options.repoUrl
		? `[repo]\nurl = ${JSON.stringify(options.repoUrl)}\n# branch = "main"`
		: '# [repo]\n# url = "https://github.com/user/repo"\n# branch = "main"';
	// When re-running against an existing custom docs directory, keep the
	// rewritten config pointing at the directory where content is scaffolded.
	const dir = options.docsDir
		? `dir = ${JSON.stringify(options.docsDir)}`
		: '# dir = ".luaudocs"';
	return `title = ${JSON.stringify(options.title)}
description = ${JSON.stringify(options.description)}

[source]
entries = [${options.entries.map((entry) => JSON.stringify(entry)).join(", ")}]

# Enables "View source" links on members, "Edit this page" links, and the
# GitHub icon in the site header. (init fills this in when it detects a
# GitHub remote.)
${repo}

# Branding baked into the generated site config (paths live in the site's
# public/ directory).
# [site]
# siteTitle = "Short Name"
# logo = "/logo.svg"
# favicon = "/favicon.ico"
# ogImage = "/og.png"
# footer = { copyright = "© ${options.title}" }

# Navbar entries. When unset, LuauDocs derives Guide, API, and Changelog entries.
# [[site.nav]]
# text = "Guide"
# link = "/guide/getting-started"
# activeMatch = "^/guide/"            # regex of routes that highlight this entry

# Extra head tags on every page (analytics, site verification).
# [[site.head]]
# tag = "script"
# attrs = { defer = "true", src = "https://plausible.io/js/script.js", "data-domain" = "docs.example.com" }

[api]
includePrivate = false
linkRobloxTypes = true

[docs]
# Where the site lives (authored content + the generated machinery under it).
${dir}
# Published site URL: enables sitemap.xml and, for project pages
# (user.github.io/repo/), derives the base path.
# url = "https://docs.example.com"
# Keep .vitepress/generated/readme.md, a copy of README.md (moonwave hide
# markers honored), fresh for an index.md that @includes it.
# includeReadme = true
# Emit llms.txt and llms-full.txt in public/ (guides, then API pages) so AI
# tools can read the docs without scraping HTML. Enabled by default.
# llms = false
`;
}

/**
 * Returns a git command's trimmed stdout, or `undefined` outside a repository
 * (or when git is unavailable). Every caller has a fallback, so failures are non-fatal.
 */
function git(args: string[], cwd: string): Promise<string | undefined> {
	return new Promise((done) => {
		execFile("git", args, { cwd, timeout: 5_000 }, (error, out) =>
			done(error ? undefined : out.trim()),
		);
	});
}

/** Normalizes `git remote get-url origin` to HTTPS, or returns `undefined`. */
async function detectRepoUrl(targetDir: string): Promise<string | undefined> {
	const remote = await git(["remote", "get-url", "origin"], targetDir);
	if (remote === undefined) {
		return undefined;
	}
	const https = remote.replace(/^git@github\.com:/, "https://github.com/").replace(/\.git$/, "");
	if (!https.startsWith("http")) {
		return undefined;
	}
	// Strip credentials so a clone URL containing a token never leaks into
	// `luaudocs.toml` or generated source links.
	if (!URL.canParse(https)) {
		return undefined;
	}
	const url = new URL(https);
	url.username = "";
	url.password = "";
	return url.href.replace(/\/$/, "");
}

/**
 * Detects the current branch for the Pages workflow trigger. Uses `symbolic-ref`
 * so a newly initialized repository with no commits yet still reports a branch.
 * Falls back to `DEFAULT_BRANCH` outside a repository or when the branch name
 * contains characters that cannot sit inside the template's quoted scalar.
 */
async function detectBranch(targetDir: string): Promise<string> {
	const branch = (await git(["symbolic-ref", "--short", "HEAD"], targetDir)) ?? "";
	return /^[^"\\]+$/.test(branch) ? branch : DEFAULT_BRANCH;
}

/**
 * Parses an existing `luaudocs.toml` for settings a re-run must preserve: the
 * custom `[docs] dir` target and (when `--force` is not set) whether the
 * surviving config sets `includeReadme`. Throws before writing anything if the
 * existing file is invalid, since treating a broken config as missing would
 * scaffold into `.luaudocs/` and pin the workflow to the wrong directory.
 */
function existingConfig(targetDir: string): LuauDocsConfig | undefined {
	const path = join(targetDir, "luaudocs.toml");
	if (!existsSync(path)) {
		return undefined;
	}
	return normalizeDocsDir(
		parseConfig(readFileSync(path, "utf8"), basename(targetDir)),
		targetDir,
	);
}

/*
 * ------------------------------------------------------------------ scaffolding
 */

type Put = (destRel: string, content: string | Buffer) => void;

/**
 * Creates the single file-writing helper for `init`. Skips user-owned files
 * (unless `--force` is set), replaces marker-carrying generated files with
 * editable templates, and tallies created/skipped counts for the summary line.
 * Reading an existing file as UTF-8 for the marker check is safe even when
 * writing a `Buffer`, because a binary file never starts with the marker.
 */
function makePut(targetDir: string, force: boolean | undefined) {
	const counts = { created: 0, skipped: 0 };
	const put: Put = (destRel, content) => {
		const dest = join(targetDir, destRel);
		// A file carrying the generated marker was written by a config-less build,
		// not by the user, so replace it with the editable template.
		const existing = existsSync(dest) ? readFileSync(dest, "utf8") : undefined;
		if (existing !== undefined && !force && !isGeneratedFile(existing)) {
			console.log(pc.dim(`  skipped (exists)  ${destRel}`));
			counts.skipped += 1;
			return;
		}
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, content);
		console.log(pc.green(`  created           ${destRel}`));
		counts.created += 1;
	};
	return { put, counts };
}

/**
 * Copies a packaged template tree through `put`, substituting `@TOKEN@`
 * placeholders. `templates/site` lands under the docs directory and
 * `templates/project` lands at the project root, and both belong to the user
 * once written.
 */
function copyTemplateTree(
	tree: "site" | "project",
	destPrefix: string,
	put: Put,
	tokens: Record<string, string>,
	/** Skips templates displaced by converted Moonwave content (by tree-relative path). */
	skip?: (rel: string) => boolean,
): void {
	// Placeholders use `@TITLE@` rather than `__TITLE__` because Markdown
	// formatters rewrite `__x__` to `**x**`. Unknown `@TOKEN@` strings are left
	// untouched so the placeholder test catches them.
	const escapeQuoted = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const substitute = (text: string, escape: boolean) =>
		text.replace(/@[A-Z_]+@/g, (token) => {
			const value = tokens[token];
			return value === undefined ? token : escape ? escapeQuoted(value) : value;
		});
	// Tokens inside `.md` frontmatter sit inside double-quoted YAML scalars, so
	// quotes and backslashes in the title must be escaped there.
	const apply = (text: string, destRel: string): string => {
		if (destRel.endsWith(".md")) {
			const block = frontmatterBlock(text);
			if (block !== undefined) {
				return substitute(block, true) + substitute(text.slice(block.length), false);
			}
		}
		return substitute(text, false);
	};

	for (const { abs, rel } of filesUnder(join(packageRoot(), "templates", tree))) {
		if (skip?.(rel)) {
			continue;
		}
		// Rename `gitignore` -> `.gitignore` (npm strips dotfiles from published tarballs).
		const destRel = join(destPrefix, rel.replace(/(^|\/)gitignore$/, "$1.gitignore"));
		put(destRel, apply(readFileSync(abs, "utf8"), destRel));
	}
}

async function scaffold(options: {
	targetDir: string;
	put: Put;
	title: string;
	description: string;
	/** Target docs directory, read by the caller before `scaffold` rewrites `luaudocs.toml`. */
	docsDir: string;
	skipTemplate?: (rel: string) => boolean;
}): Promise<void> {
	const { targetDir, put, title, description, docsDir } = options;

	// Run the same entry probe as a config-less build, requiring an `init`
	// module so `init` never writes an entry directory that would fail the
	// first build.
	const probed = probeEntries(targetDir, PROBED_ENTRIES, true);
	put(
		"luaudocs.toml",
		configToml({
			title,
			description,
			entries: probed.length > 0 ? probed : DEFAULT_ENTRIES,
			repoUrl: await detectRepoUrl(targetDir),
			docsDir: docsDir !== DEFAULT_DOCS_DIR ? docsDir : undefined,
		}),
	);

	copyTemplateTree(
		"site",
		docsDir,
		put,
		{
			"@TITLE@": title,
			"@DESCRIPTION@": description,
		},
		options.skipTemplate,
	);
}

function finalizeMoonwaveInit(
	options: InitOptions,
	source: MoonwaveSource,
	pages: MoonwavePages,
	put: Put,
	existing: LuauDocsConfig | undefined,
	hadConfig: boolean,
): void {
	const { targetDir, force } = options;
	const existingDocsDir = existing?.docs.dir;
	const docsDirName = existingDocsDir ?? DEFAULT_DOCS_DIR;
	// Convert after scaffolding so the navbar and hero can link to the
	// guide tree's actual first page on disk (whether converted or scaffolded).
	const guideLink = firstGuidePage(collectGuides(join(targetDir, docsDirName)));
	// When an existing `luaudocs.toml` is kept (no `--force`), the homepage
	// follows the surviving config's `includeReadme` setting rather than Moonwave's.
	const configWritten = !hadConfig || force === true;
	const conversion = convertMoonwave(source, {
		fallbackTitle: options.title ?? source.title ?? basename(targetDir),
		docsDir:
			existingDocsDir !== undefined && existingDocsDir !== DEFAULT_DOCS_DIR
				? existingDocsDir
				: undefined,
		guideLink,
		homeReadme: configWritten ? undefined : existing?.docs.includeReadme === true,
	});
	// Port Moonwave homepage branding to `index.md` unless `pages/index.md`
	// already claimed the homepage slot.
	if (
		conversion.homeIndexMd !== undefined &&
		!pages.files.some((page) => page.destRel === "index.md")
	) {
		put(join(docsDirName, "index.md"), conversion.homeIndexMd);
	}
	const report = [...conversion.report, ...pages.report];
	if (report.length > 0) {
		console.log(pc.bold("moonwave conversion:"));
		for (const line of report) {
			console.log(line);
		}
		console.log("");
	}

	// Write the converted config after `scaffold` so it overwrites the
	// starter `luaudocs.toml` when `--force` is set.
	if (!configWritten) {
		console.log(
			pc.yellow(
				"  skipped (exists)  luaudocs.toml; re-run with --force to apply the conversion",
			),
		);
	} else {
		writeFileSync(join(targetDir, "luaudocs.toml"), conversion.configToml);
		console.log(pc.green("  wrote converted   luaudocs.toml"));
	}
	const staticDir = join(targetDir, ".moonwave", "static");
	if (existsSync(staticDir)) {
		// `force: false` preserves any existing files in `public/` (including `CNAME`).
		cpSync(staticDir, join(targetDir, docsDirName, "public"), {
			recursive: true,
			force: false,
			errorOnExist: false,
		});
		console.log(pc.green(`  copied            .moonwave/static/* -> ${docsDirName}/public/`));
	}
}

function prepareMoonwaveInput(
	targetDir: string,
	docsDirName: string,
	put: Put,
): { source: MoonwaveSource; pages: MoonwavePages } {
	// Match Moonwave's config lookup order: `moonwave.toml`, then `moonwave.json`.
	const moonwavePath = ["moonwave.toml", "moonwave.json"]
		.map((name) => join(targetDir, name))
		.find(existsSync);
	if (!moonwavePath) {
		throw new Error(`--from-moonwave: no moonwave.toml or moonwave.json in ${targetDir}`);
	}
	// Parse everything before writing to disk so a malformed config aborts cleanly.
	const source = readMoonwave(moonwavePath);
	const pages = collectMoonwavePages(targetDir);
	for (const page of pages.files) {
		put(join(docsDirName, page.destRel), page.content);
	}
	return { source, pages };
}

function syncInitialVitepress(targetDir: string): void {
	// Sync `.vitepress/` once so the site resolves before the first build.
	// Passing `apiSidebar: undefined` preserves any existing baked API sidebar on
	// a re-run and writes an empty one in a fresh project.
	try {
		const context = createContext(targetDir);
		printWarnings(
			syncSite(context, { guides: collectGuides(context.docsDir), apiSidebar: undefined }),
		);
	} catch (error) {
		console.warn(
			pc.yellow(`could not generate the .vitepress/ machinery: ${(error as Error).message}`),
		);
		console.warn(pc.yellow("the next `luaudocs build` will retry"));
	}
}

/** Runs `luaudocs init` (optional Moonwave conversion followed by project scaffolding). */
export async function initProject(options: InitOptions): Promise<void> {
	const targetDir = options.targetDir;
	let title = options.title;
	let description = options.description;
	let source: MoonwaveSource | undefined;
	let pages: MoonwavePages | undefined;

	const hadConfig = existsSync(join(targetDir, "luaudocs.toml"));
	const { put, counts } = makePut(targetDir, options.force);
	// Read any existing config before `scaffold` rewrites it under `--force`.
	// A custom `[docs] dir` must carry over into the converted config, and
	// `includeReadme` determines whether the converted homepage includes the
	// README when an existing config is kept.
	const existing = existingConfig(targetDir);
	const docsDirName = existing?.docs.dir ?? DEFAULT_DOCS_DIR;

	if (options.fromMoonwave) {
		({ source, pages } = prepareMoonwaveInput(targetDir, docsDirName, put));
		title = title ?? source.title;
		description = description ?? source.description;
	}

	// Converted Moonwave content displaces matching starter templates even under
	// `--force`. Skip any template path claimed by a converted file, the homepage
	// when Moonwave home branding is present, and the sample guide + landing page
	// when real guides were converted (the build's generated hero serves until
	// the user writes an `index.md`).
	const claimed = new Set((pages?.files ?? []).map((page) => page.destRel));
	if (source?.hasHomeBranding) {
		claimed.add("index.md");
	}
	const hasGuides =
		pages?.files.some(
			(page) => page.destRel.startsWith("guide/") && page.destRel.endsWith(".md"),
		) ?? false;
	await scaffold({
		targetDir,
		put,
		title: title ?? basename(targetDir),
		description: description ?? "Documentation",
		docsDir: docsDirName,
		skipTemplate: (rel) =>
			claimed.has(rel) || (hasGuides && (rel === "index.md" || rel.startsWith("guide/"))),
	});

	if (source !== undefined && pages !== undefined) {
		finalizeMoonwaveInit(options, source, pages, put, existing, hadConfig);
	}

	// Scaffold the project-root tree (the GitHub Pages workflow) after the
	// config settles so `@DOCS_DIR@` reflects the final `[docs] dir`.
	copyTemplateTree("project", "", put, {
		"@DOCS_DIR@": docsDirName,
		"@BRANCH@": await detectBranch(targetDir),
		"@NODE_MAJOR@": NODE_MAJOR,
	});

	console.log("");
	console.log(`${pc.bold(String(counts.created))} files created, ${counts.skipped} skipped.`);
	syncInitialVitepress(targetDir);
	console.log(`Next: edit ${pc.cyan("luaudocs.toml")}, then run ${pc.cyan("luaudocs dev")}.`);
}

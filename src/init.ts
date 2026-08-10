/**
 * `luaudocs init`: scaffolds luaudocs.toml plus the user-owned docs content,
 * and optionally converts an existing moonwave project (the config and the
 * hand-written pages, via src/moonwave.ts). Existing files are skipped unless
 * --force, and the tool never touches them again after creation. The
 * .vitepress/ machinery is synced once at the end so the site resolves before
 * the first build, which regenerates it.
 */
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import pc from "picocolors";
import pkg from "../package.json";
import { createContext, filesUnder, printWarnings } from "./build";
import { DEFAULT_BRANCH, DEFAULT_DOCS_DIR, type LuauDocsConfig, parseConfig } from "./config";
import { packageRoot } from "./extract";
import { frontmatterBlock } from "./markdown";
import {
	collectMoonwavePages,
	convertMoonwave,
	type MoonwavePages,
	type MoonwaveSource,
	readMoonwave,
} from "./moonwave";
import { isGeneratedFile, toPosix } from "./pages";
import { collectGuides, firstGuidePage, syncSite } from "./site";

/** The Node major from `engines.node`, which the scaffolded workflow installs. */
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

/** A TOML basic string: JSON escapes are a subset of TOML's, so this is one. */
function tomlString(value: string): string {
	return JSON.stringify(value);
}

/**
 * Built here rather than shipped as a template: the two stanzas init fills in
 * when it knows better (a detected GitHub remote, an existing custom docs dir)
 * are plain conditionals.
 */
function configToml(options: {
	title: string;
	description: string;
	repoUrl?: string;
	docsDir?: string;
}): string {
	// a real remote enables [repo] (source/edit links, the GitHub icon) instead
	// of scaffolding it commented out; `branch` stays commented, the config
	// defaults it
	const repo = options.repoUrl
		? `[repo]\nurl = ${tomlString(options.repoUrl)}\n# branch = "main"`
		: '# [repo]\n# url = "https://github.com/user/repo"\n# branch = "main"';
	// a re-run against an existing custom docs dir keeps the rewritten config
	// pointing at the directory the content below is scaffolded into
	const dir = options.docsDir
		? `dir = ${tomlString(toPosix(options.docsDir))}`
		: '# dir = ".luaudocs"';
	return `title = ${tomlString(options.title)}
description = ${tomlString(options.description)}

[source]
entries = ["src"]

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

# Navbar entries. Unset: Guide, API, and Changelog entries as applicable.
# [[site.nav]]
# text = "Guide"
# link = "/guide/getting-started"
# activeMatch = "^/guide/"            # routes marking the entry current, past its link

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
# (user.github.io/repo/), the derived base path.
# url = "https://docs.example.com"
# Pull README.md into the landing page (moonwave hide markers honored).
# includeReadme = true
# llms.txt + llms-full.txt in public/ (guides, then API pages), so AI tooling
# reads the docs without scraping HTML. On by default.
# llms = false
`;
}

/** `git remote get-url origin`, normalized to https, or nothing to enable. */
async function detectRepoUrl(targetDir: string): Promise<string | undefined> {
	const stdout = await new Promise<string | undefined>((done) => {
		execFile(
			"git",
			["remote", "get-url", "origin"],
			{ cwd: targetDir, timeout: 5_000 },
			(error, out) => done(error ? undefined : out),
		);
	});
	if (stdout === undefined) {
		return undefined;
	}
	const https = stdout
		.trim()
		.replace(/^git@github\.com:/, "https://github.com/")
		.replace(/\.git$/, "");
	if (!https.startsWith("http")) {
		return undefined;
	}
	// a clone carrying a token in the remote would otherwise write it into
	// luaudocs.toml, which the user commits, and into every source link built
	// from it
	try {
		const url = new URL(https);
		url.username = "";
		url.password = "";
		return url.href.replace(/\/$/, "");
	} catch {
		return undefined;
	}
}

/**
 * The branch HEAD is on, for the Pages workflow's trigger. `symbolic-ref` so a
 * repository with no commit yet still reports one, which is when init usually
 * runs. Falls back to the default outside a repository, or for a name the
 * template's quoted scalar cannot hold.
 */
async function detectBranch(targetDir: string): Promise<string> {
	const stdout = await new Promise<string | undefined>((done) => {
		execFile(
			"git",
			["symbolic-ref", "--short", "HEAD"],
			{ cwd: targetDir, timeout: 5_000 },
			(error, out) => done(error ? undefined : out),
		);
	});
	const branch = stdout?.trim() ?? "";
	return /^[^"\\]+$/.test(branch) ? branch : DEFAULT_BRANCH;
}

/**
 * The parsed existing luaudocs.toml, for the facts a re-run must respect: the
 * docs directory the scaffold targets, and (when the conversion is skipped)
 * whether the surviving config pulls the README in.
 */
function existingConfig(targetDir: string): LuauDocsConfig | undefined {
	try {
		return parseConfig(
			readFileSync(join(targetDir, "luaudocs.toml"), "utf8"),
			basename(targetDir),
		);
	} catch {
		return undefined; // no config, or an unreadable one; the defaults apply
	}
}

/*
 * ------------------------------------------------------------------ scaffolding
 */

type Put = (destRel: string, content: string | Buffer) => void;

/**
 * The one scaffold write protocol: skip a user-owned file (unless --force),
 * replace a marker-carrying generated copy, and tally for the summary line.
 * Everything `init` writes goes through the returned `put`. The marker check
 * reads an existing file as text even when writing a Buffer: a binary cannot
 * carry the marker.
 */
function makePut(targetDir: string, force: boolean | undefined) {
	const counts = { created: 0, skipped: 0 };
	const put: Put = (destRel, content) => {
		const dest = join(targetDir, destRel);
		// a marker-carrying file was written by a config-less build, not the
		// user: the editable template replaces it rather than deferring to it
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
 * Copies one packaged template tree through `put`, resolving its placeholders.
 * `templates/site` lands under the docs dir and `templates/project` at the
 * project root; both are written once and belong to the user afterwards.
 */
function copyTemplateTree(
	tree: "site" | "project",
	destPrefix: string,
	put: Put,
	tokens: Record<string, string>,
	/** Templates the converted moonwave content displaces, by tree-relative path. */
	skip?: (rel: string) => boolean,
): void {
	// @TITLE@, not __TITLE__: markdown formatters rewrite __x__ to **x**,
	// destroying a placeholder in a template .md. The pattern is the shape
	// rather than the vocabulary, so an unknown token is left as written for
	// the placeholder test to catch.
	const escapeQuoted = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const substitute = (text: string, escape: boolean) =>
		text.replace(/@[A-Z_]+@/g, (token) => {
			const value = tokens[token];
			return value === undefined ? token : escape ? escapeQuoted(value) : value;
		});
	// tokens inside .md frontmatter sit in quoted YAML scalars: escape there so
	// a quote or backslash in the title cannot break the page
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
		// gitignore -> .gitignore (npm strips dotfiles from published packages)
		const destRel = join(destPrefix, rel.replace(/(^|\/)gitignore$/, "$1.gitignore"));
		put(destRel, apply(readFileSync(abs, "utf8"), destRel));
	}
}

async function scaffold(options: {
	targetDir: string;
	put: Put;
	title: string;
	description: string;
	/** Where the site lives; the caller owns the read, since the config it comes
	 * from is the one this is about to rewrite. */
	docsDir: string;
	skipTemplate?: (rel: string) => boolean;
}): Promise<void> {
	const { targetDir, put, title, description, docsDir } = options;

	put(
		"luaudocs.toml",
		configToml({
			title,
			description,
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

/** The whole `luaudocs init` behavior: optional moonwave conversion + scaffold. */
export async function initProject(options: InitOptions): Promise<void> {
	const targetDir = options.targetDir;
	let title = options.title;
	let description = options.description;
	let source: MoonwaveSource | undefined;
	let pages: MoonwavePages | undefined;

	const configPath = join(targetDir, "luaudocs.toml");
	const hadConfig = existsSync(configPath);
	const { put, counts } = makePut(targetDir, options.force);
	// read once, before scaffold rewrites it under --force: a custom [docs] dir
	// must survive into the converted config, which carries none of its own, and
	// includeReadme decides the converted homepage's include when the existing
	// config outlives the conversion. Every write below reproduces this dir
	// rather than moving it, so it stays the answer for the whole run.
	const existing = existingConfig(targetDir);
	const existingDocsDir = existing?.docs.dir;
	const docsDirName = existingDocsDir ?? DEFAULT_DOCS_DIR;

	if (options.fromMoonwave) {
		// moonwave's own config read order: moonwave.toml, then moonwave.json
		const moonwavePath = ["moonwave.toml", "moonwave.json"]
			.map((name) => join(targetDir, name))
			.find(existsSync);
		if (!moonwavePath) {
			throw new Error(`--from-moonwave: no moonwave.toml or moonwave.json in ${targetDir}`);
		}
		// parsed before anything lands on disk, so a malformed config aborts a
		// clean tree rather than leaving a half-converted one
		source = readMoonwave(moonwavePath);
		pages = collectMoonwavePages(targetDir);
		for (const page of pages.files) {
			put(join(docsDirName, page.destRel), page.content);
		}
		title = title ?? source.title;
		description = description ?? source.description;
	}

	// Converted content displaces the matching templates, so even --force
	// cannot scaffold over it: any template path a converted file claimed, the
	// homepage the conversion is about to write, and, when real guides came
	// over, the sample guide tree plus the landing page that links it (the
	// build's generated hero serves until the user writes an index.md).
	const claimed = new Set((pages?.files ?? []).map((page) => page.destRel));
	const pagesClaimIndex = claimed.has("index.md");
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
		// the conversion runs after the scaffold, so the navbar and the hero
		// can aim at the guide tree's real first page, converted or scaffolded,
		// read back from disk the way a build derives it
		const guideLink = firstGuidePage(collectGuides(join(targetDir, docsDirName)));
		// existing config + no --force: the conversion is skipped below, so the
		// homepage obeys the surviving config's includeReadme, not moonwave's
		const configWritten = !hadConfig || options.force === true;
		const conversion = convertMoonwave(source, {
			fallbackTitle: title ?? basename(targetDir),
			docsDir:
				existingDocsDir !== undefined && existingDocsDir !== DEFAULT_DOCS_DIR
					? existingDocsDir
					: undefined,
			guideLink,
			homeReadme: configWritten ? undefined : existing?.docs.includeReadme === true,
		});
		// the moonwave homepage's branding, ported as a real landing page; a
		// converted pages/index.md was the real homepage and keeps the slot
		if (conversion.homeIndexMd !== undefined && !pagesClaimIndex) {
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

		// written after the scaffold: with --force the scaffold rewrites the
		// built-in config, and the converted one must win
		if (!configWritten) {
			console.log(
				pc.yellow(
					"  skipped (exists)  luaudocs.toml; re-run with --force to apply the conversion",
				),
			);
		} else {
			writeFileSync(configPath, conversion.configToml);
			console.log(pc.green("  wrote converted   luaudocs.toml"));
		}
	}

	if (options.fromMoonwave) {
		const staticDir = join(targetDir, ".moonwave", "static");
		if (existsSync(staticDir)) {
			// force: false keeps anything already in public/ (a CNAME included)
			cpSync(staticDir, join(targetDir, docsDirName, "public"), {
				recursive: true,
				force: false,
				errorOnExist: false,
			});
			console.log(
				pc.green(`  copied            .moonwave/static/* -> ${docsDirName}/public/`),
			);
		}
	}

	// the project-root tree (the Pages workflow) is scaffolded like any other
	// user-owned file, but after the config settles: its [docs] dir is the
	// artifact path. An unreadable config falls back to the default.
	copyTemplateTree("project", "", put, {
		"@DOCS_DIR@": toPosix(docsDirName),
		"@BRANCH@": await detectBranch(targetDir),
		"@NODE_MAJOR@": NODE_MAJOR,
		// pinned, not floating: the workflow is scaffold-once and user-owned, so
		// a later breaking release cannot reach it to fix it, and a bare `npx
		// luaudocs` would pick that release up on the next unrelated push
		"@VERSION@": pkg.version,
	});

	console.log("");
	console.log(`${pc.bold(String(counts.created))} files created, ${counts.skipped} skipped.`);

	// the .vitepress/ machinery, synced once so the site resolves before the
	// first build. apiSidebar undefined keeps an existing baked sidebar on a
	// re-run and writes an empty one on a fresh project.
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

	console.log(`Next: edit ${pc.cyan("luaudocs.toml")}, then run ${pc.cyan("luaudocs dev")}.`);
}

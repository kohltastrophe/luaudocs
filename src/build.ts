/**
 * The build pipeline: load config, run the extractor, emit Markdown, sync
 * generated files to disk, and spawn the docs-local VitePress binary.
 *
 * Owns the write contract: `<docs>/api/` and `<docs>/.vitepress/` are synced to
 * contain the exact emitted file set, except on extractor errors, where all
 * deletions are withheld so a transient parse error never unpublishes a page.
 */
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import picomatch from "picomatch";
import pc from "picocolors";
import pkg from "../package.json";
import { loadConfig, parseUrlFlag, type LuauDocsConfig } from "./config";
import { formatDocModel, type DocModel } from "./docmodel";
import { runExtractor } from "./extract";
import { loadDependencies } from "./dependencies";
import { buildDependencyLinks, emitDocs, type EmitResult } from "./render";
import { API_DIR, apiPageFile, toPosix } from "./pages";
import { collectGuides, syncSite, type GuideItem } from "./site";
import { syncLlms } from "./llms";

export interface BuildContext {
	config: LuauDocsConfig;
	/**
	 * Base directory for all relative paths: the directory containing
	 * `luaudocs.toml`, or `startDir` when running with synthesized defaults.
	 */
	root: string;
	/** Absent when the project runs on synthesized defaults. */
	configPath?: string;
	docsDir: string;
	apiDir: string;
}

export function createContext(startDir: string, overrides?: { url?: string }): BuildContext {
	const { config, root, configPath } = loadConfig(startDir);
	// CI knows the real deploy URL (`build --url` receives it from
	// `actions/configure-pages`), so the CLI flag overrides `[docs] url`.
	if (overrides?.url !== undefined) {
		config.docs.url = parseUrlFlag(overrides.url);
	}
	const docsDir = resolve(root, config.docs.dir);
	return { config, root, configPath, docsDir, apiDir: join(docsDir, API_DIR) };
}

/*
 * ------------------------------------------------------------------- writing
 */

/**
 * Writes `absPath` only when its content differs, so file watchers (VitePress
 * HMR) only react to real changes. Compares raw bytes when given a `Uint8Array`
 * because the runtime templates include a `.woff2` font that a UTF-8 round-trip
 * would corrupt with `U+FFFD` replacement characters.
 */
export function writeIfChanged(absPath: string, content: string | Uint8Array): boolean {
	mkdirSync(dirname(absPath), { recursive: true });
	try {
		const unchanged =
			typeof content === "string"
				? readFileSync(absPath, "utf8") === content
				: readFileSync(absPath).equals(content);
		if (unchanged) {
			return false;
		}
	} catch {
		// Missing or unreadable file: fall through to write.
	}
	writeFileSync(absPath, content);
	return true;
}

/** Writes `content` when defined, or removes `absPath` if it exists. */
export function syncFile(absPath: string, content: string | undefined): void {
	if (content !== undefined) {
		writeIfChanged(absPath, content);
	} else if (existsSync(absPath)) {
		rmSync(absPath);
	}
}

/** Lists every file under `root`, POSIX-relative and sorted (`[]` if `root` is missing). */
export function filesUnder(root: string): Array<{ abs: string; rel: string }> {
	if (!existsSync(root)) {
		return [];
	}
	return readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => {
			const abs = join(entry.parentPath, entry.name);
			return { abs, rel: toPosix(relative(root, abs)) };
		})
		.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

/**
 * Every docs-relative path written by a build inside `docsDir`: the two
 * tool-owned trees (`api/` and `.vitepress/`) plus the root files it manages.
 * Exported as a single list so `dev` can ignore its own build output across
 * `build.ts`, `site.ts`, and `llms.ts`.
 */
export const GENERATED_PATHS = [
	API_DIR,
	".vitepress",
	"changelog.md",
	".gitignore",
	"index.md",
	"package.json",
	"public/llms.txt",
	"public/llms-full.txt",
	"public/docmodel.json",
] as const;

export interface SyncSummary {
	written: number;
	deleted: number;
	unchanged: number;
}

/**
 * Syncs `dir` to contain the exact `files` map. `deleteStale: false` skips the
 * stale-file sweep (on error builds); `keepForeign` exempts paths owned by
 * another process inside a tool-owned tree (such as VitePress's `dist/` and `cache/`).
 *
 * On case-insensitive, case-preserving filesystems (macOS and Windows), writing
 * a re-cased slug updates the existing file in place without changing its
 * directory-entry casing. Because slugs never collide case-insensitively within
 * a build, a lowercase match with no exact on-disk counterpart is renamed in
 * place to the new casing instead of being deleted.
 */
export function syncDir(
	dir: string,
	files: Map<string, string | Uint8Array>,
	deleteStale = true,
	keepForeign?: (rel: string) => boolean,
): SyncSummary {
	const summary: SyncSummary = { written: 0, deleted: 0, unchanged: 0 };
	// Nothing to write and nothing on disk: avoid creating an empty directory.
	if (files.size === 0 && !existsSync(dir)) {
		return summary;
	}
	const keep = new Set<string>();
	for (const [file, content] of files) {
		const abs = join(dir, file);
		// Normalize keys the same way the sweep derives relative paths so a
		// non-canonical key (`./Foo.md`) is not written and then swept.
		keep.add(toPosix(relative(dir, abs)));
		if (writeIfChanged(abs, content)) {
			summary.written += 1;
		} else {
			summary.unchanged += 1;
		}
	}
	if (!deleteStale || !existsSync(dir)) {
		return summary;
	}

	const onDisk: Array<{ abs: string; rel: string }> = [];
	const subdirs: string[] = [];
	for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
		const abs = join(entry.parentPath, entry.name);
		const rel = toPosix(relative(dir, abs));
		if (keepForeign?.(rel)) {
			continue;
		}
		if (entry.isDirectory()) {
			subdirs.push(abs);
		} else if (entry.isFile()) {
			onDisk.push({ abs, rel });
		}
	}
	const present = new Set(onDisk.map((file) => file.rel));
	const keepByLower = new Map([...keep].map((rel) => [rel.toLowerCase(), rel]));
	for (const { abs, rel } of onDisk) {
		if (keep.has(rel)) {
			continue;
		}
		const kept = keepByLower.get(rel.toLowerCase());
		if (kept !== undefined && !present.has(kept)) {
			renameSync(abs, join(dir, kept));
			continue;
		}
		rmSync(abs);
		summary.deleted += 1;
	}
	// Remove directories emptied by the sweep, deepest first; non-empty ones throw and stay.
	for (const emptied of subdirs.sort((a, b) => b.length - a.length)) {
		try {
			rmdirSync(emptied);
		} catch {
			// Directory still holds kept files.
		}
	}
	return summary;
}

/*
 * ----------------------------------------------------------------- reporting
 */

/** Prints warnings and returns the count for `--strict` checks. */
export function printWarnings(warnings: string[]): number {
	for (const warning of warnings) {
		console.warn(pc.yellow(warning));
	}
	return warnings.length;
}

function reportDiagnostics(
	model: DocModel,
	warnings: string[],
): { errors: number; warnings: number } {
	let errors = 0;
	let warningCount = 0;
	for (const diagnostic of model.diagnostics) {
		const location = diagnostic.file
			? `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}` : ""}`
			: "<project>";
		const line = `${location}: ${diagnostic.severity}[${diagnostic.code}]: ${diagnostic.message}`;
		if (diagnostic.severity === "error") {
			errors += 1;
			console.error(pc.red(line));
		} else if (diagnostic.severity === "warning") {
			warningCount += 1;
			console.warn(pc.yellow(line));
		} else {
			console.log(pc.dim(line));
		}
	}
	for (const warning of warnings) {
		warningCount += 1;
		console.warn(pc.yellow(`renderer: ${warning}`));
	}
	return { errors, warnings: warningCount };
}

/*
 * ----------------------------------------------------------------- the build
 */

/**
 * Applies `[source] include` and `exclude` globs to an extracted model in place.
 * Checks `include !== undefined` rather than `include.length > 0` so an explicit
 * `include = []` matches nothing. Sets `dot: true` so globs can match paths
 * under dot-directories, and normalizes paths with `toPosix` for Windows.
 */
export function filterModel(
	model: DocModel,
	include: string[] | undefined,
	exclude: string[] | undefined,
): DocModel {
	if (include === undefined && !exclude?.length) {
		return model;
	}
	const match = picomatch(include ?? ["**"], { ignore: exclude ?? [], dot: true });
	model.modules = model.modules.filter((module) => match(toPosix(module.id)));
	// Drop diagnostics located in filtered-out files (excluding a broken
	// generated module is the documented way to keep a build green), while
	// keeping project-level diagnostics (`file === undefined`).
	model.diagnostics = model.diagnostics.filter(
		(diagnostic) => diagnostic.file === undefined || match(toPosix(diagnostic.file)),
	);
	return model;
}

async function extractModel(context: BuildContext): Promise<DocModel> {
	const { config, root } = context;
	// `[source] entries = []` means a guide-only project with no Luau modules:
	// skip spawning the extractor and return an empty model.
	if (config.source.entries.length === 0) {
		return { schemaVersion: 1, project: { entryPoints: [] }, modules: [], diagnostics: [] };
	}
	const model = await runExtractor({
		root,
		entries: config.source.entries,
		projectFile: config.source.projectFile,
		aliases: config.source.aliases,
		reportUndocumented: config.api.reportUndocumented,
	});
	return filterModel(model, config.source.include, config.source.exclude);
}

/**
 * Cached extract-and-render output. Paired as a single value because rendering
 * is a pure function of the model and config, so reusing a cached model in
 * `dev` also reuses its rendered pages.
 */
export interface RenderedModel {
	model: DocModel;
	result: EmitResult;
}

async function renderModel(context: BuildContext): Promise<RenderedModel> {
	const model = await extractModel(context);
	// Guide-only projects have no signatures to link, so skip fetching dependency models.
	const dependencies =
		model.modules.length > 0
			? await loadDependencies(context.config, context.root)
			: { loaded: [], warnings: [] };
	const result = emitDocs(model, context.config, buildDependencyLinks(dependencies.loaded));
	result.warnings.unshift(...dependencies.warnings);
	return { model, result };
}

/**
 * Writes `public/docmodel.json` when `[docs] model = true` so dependent sites
 * can link into this one, and removes it when `[docs] model` is off so a stale
 * model cannot keep advertising removed entries. (By contrast, `[docs] llms = false`
 * leaves existing `llms.txt` files untouched in case the user maintains them by
 * hand.) Runs after syncing `api/` so every page the model describes is in place.
 */
function syncModel(context: BuildContext, model: DocModel): void {
	syncFile(
		join(context.docsDir, "public", "docmodel.json"),
		context.config.docs.model ? formatDocModel(model) : undefined,
	);
}

export interface RenderedProject extends RenderedModel {
	counts: { errors: number; warnings: number };
}

/**
 * Extracts, renders, and reports diagnostics without writing to disk. Shared by
 * `runBuild` and `luaudocs llms`. When `rendered` is passed (`dev`'s model
 * cache), re-reports its diagnostics without re-extracting.
 */
export async function renderProject(
	context: BuildContext,
	rendered?: RenderedModel,
): Promise<RenderedProject> {
	const { model, result } = rendered ?? (await renderModel(context));
	return { model, result, counts: reportDiagnostics(model, result.warnings) };
}

export interface BuildOutcome extends RenderedProject {
	/** Guide walk used by this build, cached by `dev` alongside the model. */
	guides: GuideItem[];
	/** Summary of the `api/` directory sync (`syncSite` writes are not counted here). */
	summary: SyncSummary;
}

/**
 * Runs a full build: extract, render, report diagnostics, and sync files to
 * disk. Diagnostics are printed before writing so the "keeping previously
 * generated pages" warning appears directly below the errors that triggered it.
 * `options` let `dev` skip the per-keystroke `llms` pass (`llms: false`) and
 * reuse whichever half (`rendered` or `guides`) did not change.
 */
export async function runBuild(
	context: BuildContext,
	options?: { llms?: boolean; rendered?: RenderedModel; guides?: GuideItem[] },
): Promise<BuildOutcome> {
	// Walk guides once and share the result between the sidebar and `llms.txt`
	// so page titles and ordering cannot disagree. Run this first so a malformed
	// `_category_` sidecar throws before spawning the extractor or writing files.
	const guides = options?.guides ?? collectGuides(context.docsDir);
	const { model, result, counts } = await renderProject(context, options?.rendered);

	// On extraction errors, update whatever pages did emit and withhold all deletions.
	const hasErrors = counts.errors > 0;
	if (hasErrors) {
		console.warn(
			pc.yellow("warning: extraction reported errors; keeping previously generated pages"),
		);
	}
	const apiFiles = new Map(result.pages);
	if (result.apiIndex !== undefined && !hasErrors) {
		apiFiles.set(apiPageFile("index"), result.apiIndex);
	}
	const summary = syncDir(context.apiDir, apiFiles, !hasErrors);

	const warnings = syncSite(context, {
		guides,
		apiSidebar: hasErrors ? undefined : result.sidebar,
		apiTrails: hasErrors ? undefined : result.trails,
		hasErrors,
	});
	// Run `syncLlms` after `syncSite` so `llms.txt` indexes the freshly synced docs directory.
	if (!hasErrors && options?.llms !== false) {
		syncLlms(context, guides, result);
	}
	if (!hasErrors) {
		syncModel(context, model);
	}
	counts.warnings += printWarnings(warnings);
	return { result, model, guides, counts, summary };
}

/*
 * ----------------------------------------------------------------- vitepress
 */

/**
 * Packages written into the generated docs `package.json` by `docsPackageJson`,
 * checked by `ensureVitepress` to detect missing dependencies in an existing install.
 */
export const SITE_DEPENDENCIES = ["vitepress", "vitepress-plugin-group-icons", "vue"] as const;

/**
 * Resolves `<name>/package.json` from `docsDir`, or returns `undefined`.
 * Using module resolution rather than probing `node_modules/` directly supports
 * hoisted and workspace installs.
 */
function resolveFromDocs(docsDir: string, name: string): string | undefined {
	try {
		return createRequire(join(docsDir, "package.json")).resolve(`${name}/package.json`);
	} catch {
		return undefined;
	}
}

/**
 * Runs `npm install` in `docsDir` when any dependency in the generated
 * `package.json` fails to resolve (a fresh checkout, a bumped VitePress pin,
 * or a newly added site dependency). Existing valid installs, including hoisted
 * and workspace-managed ones, are left alone.
 */
export async function ensureVitepress(docsDir: string): Promise<void> {
	const resolved = resolveFromDocs(docsDir, "vitepress");
	if (resolved !== undefined) {
		const { version } = JSON.parse(readFileSync(resolved, "utf8")) as { version: string };
		// VitePress is pinned to an exact version; the remaining dependencies
		// use caret ranges and only need to resolve.
		if (
			version === pkg.devDependencies.vitepress &&
			SITE_DEPENDENCIES.every((name) => resolveFromDocs(docsDir, name) !== undefined)
		) {
			return;
		}
	}
	// If the generated `package.json` is missing, `npm install` would walk up
	// and install into a parent project; return and let `vitepressBin` report
	// the missing install.
	if (!existsSync(join(docsDir, "package.json"))) {
		return;
	}
	console.log(pc.cyan(`installing the docs site dependencies (npm install in ${docsDir})`));
	await new Promise<void>((settle, reject) => {
		// Windows `.cmd` shims require `shell: true` to spawn; arguments are
		// static strings, so nothing is subject to shell expansion.
		const child = spawn("npm", ["install", "--no-fund", "--no-audit"], {
			cwd: docsDir,
			stdio: "inherit",
			shell: process.platform === "win32",
		});
		child.on("error", () =>
			reject(
				new Error(
					`could not run npm to install the docs site dependencies; run an install in ${docsDir} yourself`,
				),
			),
		);
		child.on("exit", (code) =>
			code === 0
				? settle()
				: reject(new Error(`npm install failed (exit ${code}) in ${docsDir}`)),
		);
	});
}

/**
 * Resolves the VitePress CLI entry script to run under `process.execPath`.
 * Spawning `node_modules/.bin/vitepress` directly fails on Windows (where the
 * extensionless `sh` shim cannot execute and Bun does not create `.cmd` shims).
 */
function vitepressBin(docsDir: string): string {
	const pkgPath = resolveFromDocs(docsDir, "vitepress");
	if (!pkgPath) {
		throw new Error(
			`vitepress is not installed in ${docsDir}; run \`npm install\` in that directory first`,
		);
	}
	const vitepressPkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
		bin?: string | Record<string, string>;
	};
	const bin =
		typeof vitepressPkg.bin === "string" ? vitepressPkg.bin : vitepressPkg.bin?.vitepress;
	return join(dirname(pkgPath), bin ?? "bin/vitepress.js");
}

export interface VitepressProcess {
	child: ChildProcess;
	/** Resolves on exit 0; rejects on a nonzero exit code or termination signal. */
	done: Promise<void>;
}

export function spawnVitepress(
	docsDir: string,
	command: "build" | "dev",
	args: string[] = [],
): VitepressProcess {
	const child = spawn(process.execPath, [vitepressBin(docsDir), command, ".", ...args], {
		cwd: docsDir,
		stdio: "inherit",
	});
	const done = new Promise<void>((settle, reject) => {
		child.on("error", reject);
		child.on("exit", (code, signal) => {
			if (code === 0) {
				settle();
			} else {
				reject(
					new Error(
						signal
							? `vitepress ${command} was killed by ${signal}`
							: `vitepress ${command} failed (exit ${code})`,
					),
				);
			}
		});
	});
	return { child, done };
}

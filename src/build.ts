/**
 * The build pipeline: load config, run the extractor, emit markdown, sync it
 * to disk, and spawn the docs-local VitePress. Owns the write contract:
 * <docs>/api/ and <docs>/.vitepress/ are made to contain exactly the emitted
 * set, except on extractor errors, where every destructive step is withheld
 * so a transient parse error cannot unpublish a page.
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
import type { DocModel } from "./docmodel";
import { runExtractor } from "./extract";
import { emitDocs, type EmitResult } from "./render";
import { API_DIR, apiPageFile, toPosix } from "./pages";
import { collectGuides, syncSite, type GuideItem } from "./site";
import { syncLlms } from "./llms";

export interface BuildContext {
	config: LuauDocsConfig;
	/** The directory every relative path resolves against: the one holding
	 * luaudocs.toml, or the start directory when no config exists. */
	root: string;
	/** Absent when the project runs on synthesized defaults. */
	configPath?: string;
	docsDir: string;
	apiDir: string;
}

export function createContext(startDir: string, overrides?: { url?: string }): BuildContext {
	const { config, root, configPath } = loadConfig(startDir);
	// CI knows the real deploy URL better than the config does (`build --url`
	// feeds it from configure-pages), so the flag wins over [docs] url
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
 * Content-compared write, so watchers (VitePress HMR) only see real changes.
 * Bytes rather than text when the caller has bytes: the runtime templates
 * include a font, and a utf8 round-trip would replace every invalid sequence
 * in it with U+FFFD and ship a corrupt file.
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
		// missing (or unreadable): fall through to the write
	}
	writeFileSync(absPath, content);
	return true;
}

/** Every file under root, posix-relative and sorted, [] for a missing root. */
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
 * Everything a build writes inside the docs dir, docs-relative: the two
 * tool-owned trees, and the docs-root files it overwrites. The write contract
 * as a value: `dev` has to skip its own output, and the writes themselves are
 * spread across this module, site.ts and llms.ts.
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
] as const;

export interface SyncSummary {
	written: number;
	deleted: number;
	unchanged: number;
}

/**
 * Makes `dir` contain exactly `files`. `deleteStale: false` skips the sweep
 * (error builds); `keepForeign` exempts paths another process owns inside a
 * tool-owned tree.
 *
 * The case-insensitive wrinkle: on a case-preserving filesystem
 * (macOS/Windows), writing a re-cased slug updates the old-cased file in
 * place, so readdir reports a name the emitted set lacks even though the file
 * IS the kept page. Slugs never collide case-insensitively within a build, so
 * a lowercase match with no exact on-disk counterpart can only be that page.
 */
export function syncDir(
	dir: string,
	files: Map<string, string | Uint8Array>,
	deleteStale = true,
	keepForeign?: (rel: string) => boolean,
): SyncSummary {
	const summary: SyncSummary = { written: 0, deleted: 0, unchanged: 0 };
	// nothing to write and nothing on disk: do not create an empty directory
	if (files.size === 0 && !existsSync(dir)) {
		return summary;
	}
	const keep = new Set<string>();
	for (const [file, content] of files) {
		const abs = join(dir, file);
		// normalized the way the sweep derives its paths, so a non-canonical
		// key (`./Foo.md`) is not written and then swept
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
	// directories the sweep emptied, deepest first; occupied ones refuse
	for (const emptied of subdirs.sort((a, b) => b.length - a.length)) {
		try {
			rmdirSync(emptied);
		} catch {
			// still holds kept files
		}
	}
	return summary;
}

/*
 * ----------------------------------------------------------------- reporting
 */

/** The one warning report; returns the count for --strict math. */
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

async function extractModel(context: BuildContext): Promise<DocModel> {
	const { config, root } = context;
	// `[source] entries = []` is a project with no modules, not a mode: the
	// extractor never runs, and downstream handles the empty model
	if (config.source.entries.length === 0) {
		return { schemaVersion: 1, project: { entryPoints: [] }, modules: [], diagnostics: [] };
	}
	const model = await runExtractor({
		root,
		entries: config.source.entries,
		projectFile: config.source.projectFile,
	});
	const { include, exclude } = config.source;
	if (include !== undefined || exclude?.length) {
		// presence, not length: an explicit `include = []` includes nothing
		// (picomatch of an empty list matches nothing). dot: true so a glob
		// naming a path under a dot directory can match; module ids are
		// project-relative posix paths
		const match = picomatch(include ?? ["**"], {
			ignore: exclude ?? [],
			dot: true,
		});
		model.modules = model.modules.filter((module) => match(toPosix(module.id)));
		// diagnostics located in a filtered-out file go with it (excluding a
		// broken generated module is the documented way to a green build);
		// project-level diagnostics stay
		model.diagnostics = model.diagnostics.filter(
			(diagnostic) => diagnostic.file === undefined || match(toPosix(diagnostic.file)),
		);
	}
	return model;
}

/**
 * The extract-and-render half of a build. Cached as one value rather than two:
 * the rendering is a pure function of the model and the config, so pairing them
 * keeps a reused model from being re-rendered.
 */
export interface RenderedModel {
	model: DocModel;
	result: EmitResult;
}

async function renderModel(context: BuildContext): Promise<RenderedModel> {
	const model = await extractModel(context);
	return { model, result: emitDocs(model, context.config) };
}

export interface BuildOutcome extends RenderedModel {
	/** the guide walk this build used, cacheable the same way as the model */
	guides: GuideItem[];
	counts: { errors: number; warnings: number };
	/** the api/ dir sync only; the site sync is content-compared noise */
	summary: SyncSummary;
}

/**
 * One build: extract, render, report, write. Reporting happens before anything
 * is written, because the keep-pages warning below refers to those lines.
 * The options exist for `dev`: `llms: false` skips a plainMarkdown pass over
 * every page per keystroke, and `rendered`/`guides` reuse the half an edit
 * cannot have changed.
 */
export async function runBuild(
	context: BuildContext,
	options?: { llms?: boolean; rendered?: RenderedModel; guides?: GuideItem[] },
): Promise<BuildOutcome> {
	const { model, result } = options?.rendered ?? (await renderModel(context));
	const counts = reportDiagnostics(model, result.warnings);

	// error builds refresh what did emit and withhold every destructive step
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

	// one guide walk shared by the sidebar and llms.txt, so a page's title and
	// order cannot disagree between them
	const guides = options?.guides ?? collectGuides(context.docsDir);
	const warnings = syncSite(context, {
		guides,
		apiSidebar: hasErrors ? undefined : result.sidebar,
		apiTrails: hasErrors ? undefined : result.trails,
		hasErrors,
	});
	// after syncSite by contract: llms indexes the docs dir as just synced
	if (!hasErrors && options?.llms !== false) {
		syncLlms(context, guides, result);
	}
	counts.warnings += printWarnings(warnings);
	return { result, model, guides, counts, summary };
}

/*
 * ----------------------------------------------------------------- vitepress
 */

/**
 * What a generated site installs, in the order docsPackageJson writes them.
 * Lives here because ensureVitepress is the half that has to notice one
 * missing from an already-installed site.
 */
export const SITE_DEPENDENCIES = ["vitepress", "vitepress-plugin-group-icons", "vue"] as const;

/**
 * A dependency's package.json as it resolves from the docs dir, or undefined.
 * Resolving (rather than probing node_modules/) honors workspace and hoisted
 * installs.
 */
function resolveFromDocs(docsDir: string, name: string): string | undefined {
	try {
		return createRequire(join(docsDir, "package.json")).resolve(`${name}/package.json`);
	} catch {
		return undefined;
	}
}

/**
 * Installs the docs dir's dependencies when anything the generated
 * package.json pins fails to resolve: a fresh checkout, a moved VitePress pin,
 * or a dependency added since the site last installed. A resolving install is
 * left alone, hoisted and workspace-managed ones included.
 */
export async function ensureVitepress(docsDir: string): Promise<void> {
	const resolved = resolveFromDocs(docsDir, "vitepress");
	if (resolved !== undefined) {
		const { version } = JSON.parse(readFileSync(resolved, "utf8")) as { version: string };
		// vitepress is pinned exactly, so its version is the test; the rest are
		// caret-ranged, where resolving at all is
		if (
			version === pkg.devDependencies.vitepress &&
			SITE_DEPENDENCIES.every((name) => resolveFromDocs(docsDir, name) !== undefined)
		) {
			return;
		}
	}
	// without the generated package.json npm would walk up and install some
	// OTHER project's dependencies; let vitepressBin report the real problem
	if (!existsSync(join(docsDir, "package.json"))) {
		return;
	}
	console.log(pc.cyan(`installing the docs site dependencies (npm install in ${docsDir})`));
	await new Promise<void>((settle, reject) => {
		// .cmd shims cannot spawn without a shell on Windows; the args are
		// static strings, so the shell sees nothing to interpret
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
 * Resolves the vitepress bin script, run with the current runtime. Spawning the
 * node_modules/.bin shim breaks on Windows: the extensionless sh-shebang file
 * cannot execute there, and bun does not even create it.
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
	/** settles with the process; rejects on a nonzero exit or a signal death */
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

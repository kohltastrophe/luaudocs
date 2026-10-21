/**
 * The build pipeline. Loads config, runs the extractor, emits Markdown, syncs
 * generated files to disk, and spawns the docs-local VitePress binary.
 *
 * Syncs `<docs>/api/` and `<docs>/.vitepress/` to contain the exact emitted
 * file set, except on extractor errors, where it withholds all deletions so a
 * transient parse error never unpublishes a page.
 */
import { existsSync, readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import pc from "picocolors";
import pkg from "../package.json";
import { loadConfig, parseUrlFlag } from "./config";
import { formatDocModel, type DocModel } from "./docmodel";
import { printWarnings, renderProject, type RenderedModel, type RenderedProject } from "./render";
import {
	API_DIR,
	apiPageFile,
	SITE_DEPENDENCIES,
	syncDir,
	syncFile,
	type BuildContext,
	type SyncSummary,
} from "./pages";
import { collectGuides, syncSite, type GuideItem } from "./site";
import { syncLlms } from "./llms";

export type { BuildContext, RenderedModel };

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

/**
 * Every docs-relative path written by a build inside `docsDir`, covering the two
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

/*
 * ----------------------------------------------------------------- the build
 */

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

export interface BuildOutcome extends RenderedProject {
	/** Guide walk used by this build, cached by `dev` alongside the model. */
	guides: GuideItem[];
	/** Summary of the `api/` directory sync (`syncSite` writes are not counted here). */
	summary: SyncSummary;
}

/**
 * Runs a full build, extracting, rendering, reporting diagnostics, and syncing
 * files to disk. Prints diagnostics before writing so the "keeping previously
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
 * Resolves `<name>/package.json` with `req`, or returns `undefined`.
 * Using module resolution rather than probing `node_modules/` directly supports
 * hoisted and workspace installs.
 */
function resolveFromDocs(req: NodeJS.Require, name: string): string | undefined {
	try {
		return req.resolve(`${name}/package.json`);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// `ERR_PACKAGE_PATH_NOT_EXPORTED` means Node located `<name>/package.json`
		// in `node_modules` and read its `exports` map (e.g. `vitepress-plugin-group-icons`).
		if (code === "ERR_PACKAGE_PATH_NOT_EXPORTED") {
			return name;
		}
		if (code === "MODULE_NOT_FOUND") {
			return undefined;
		}
		throw error;
	}
}

/**
 * Runs `npm install` in `docsDir` when any dependency in the generated
 * `package.json` fails to resolve (a fresh checkout, a bumped VitePress pin,
 * or a newly added site dependency). Leaves existing valid installs, including
 * hoisted and workspace-managed ones, untouched.
 */
export async function ensureVitepress(docsDir: string): Promise<void> {
	const req = createRequire(join(docsDir, "package.json"));
	const resolved = resolveFromDocs(req, "vitepress");
	if (resolved !== undefined) {
		const { version } = JSON.parse(readFileSync(resolved, "utf8")) as { version: string };
		// VitePress is pinned to an exact version; the remaining dependencies
		// use caret ranges and only need to resolve.
		if (
			version === pkg.devDependencies.vitepress &&
			SITE_DEPENDENCIES.every(
				(name) => name === "vitepress" || resolveFromDocs(req, name) !== undefined,
			)
		) {
			return;
		}
	}
	// If the generated `package.json` is missing, `npm install` would walk up
	// and install into a parent project. Return and let `vitepressBin` report
	// the missing install.
	if (!existsSync(join(docsDir, "package.json"))) {
		return;
	}
	console.log(pc.cyan(`installing the docs site dependencies (npm install in ${docsDir})`));
	await new Promise<void>((settle, reject) => {
		// Windows `.cmd` shims require `shell: true` to spawn. Arguments are
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
	const pkgPath = resolveFromDocs(createRequire(join(docsDir, "package.json")), "vitepress");
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
	/** Resolves on exit 0 and rejects on a nonzero exit code or termination signal. */
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

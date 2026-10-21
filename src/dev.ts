/**
 * `luaudocs dev` watcher. Watches source entries and the docs directory, re-running
 * `runBuild` alongside `vitepress dev`. Caches each half of the build against
 * edits to the other (editing a guide skips spawning the extractor and
 * re-rendering API pages, while editing a Luau source file skips walking the guides),
 * and compares file contents before writing so VitePress HMR only sees changed pages.
 *
 * Editing `luaudocs.toml` reloads the configuration in place and rebinds the
 * watchers to the current `[source] entries`. Rewriting `.vitepress/config.mts`
 * triggers VitePress to restart its own dev server. Only changing `[docs] dir`
 * ends the session, because the VitePress dev server stays bound to the
 * directory where it started.
 */
import { mkdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import pc from "picocolors";
import {
	createContext,
	ensureVitepress,
	GENERATED_PATHS,
	runBuild,
	spawnVitepress,
	type BuildContext,
	type RenderedModel,
	type VitepressProcess,
} from "./build";
import { LOCAL_LLMS_FILE } from "./llms";
import type { GuideItem } from "./site";

export interface DevOptions {
	startDir: string;
	vitepressArgs?: string[];
}

function under(path: string, dir: string): boolean {
	return path === dir || path.startsWith(dir + sep);
}

/**
 * Classifies file watcher events for `docsDir`. `ignored` drops build output
 * and VCS/node_modules caches, and `touchesModel` distinguishes extractor
 * inputs from guide/site-only edits.
 */
function createEventFilter(
	docsDir: string,
	getRoot: () => string,
): { ignored: (path: string) => boolean; touchesModel: (path: string) => boolean } {
	// Ignore everything a rebuild writes, plus caches, so the watcher never
	// loops on its own output. `index.md` is the one exception, since a user-owned
	// `index.md` needs live reload and a generated `index.md` costs at most
	// one coalesced follow-up pass when its content changes.
	const dropped = GENERATED_PATHS.filter((rel) => rel !== "index.md").map((rel) =>
		join(docsDir, rel),
	);
	// Also ignore the project-root `llms.txt` (`luaudocs llms` output). No
	// build reads it, and an unrecognized root file would otherwise trigger re-extraction.
	const ignored = (path: string): boolean =>
		path.split(sep).some((part) => part === "node_modules" || part === ".git") ||
		dropped.some((prefix) => under(path, prefix)) ||
		path === join(getRoot(), LOCAL_LLMS_FILE);

	// Classifies which half of the pipeline a file event affects. Anything under
	// a source root or an unrecognized root-level file (such as `default.project.json`
	// or `.luaurc`) is an extractor input. Edits inside `docsDir` or to root
	// `README.md` / `CHANGELOG.md` only affect site syncing and skip the extractor.
	const touchesModel = (path: string): boolean => {
		if (under(path, docsDir)) {
			return false;
		}
		const name = basename(path);
		return name !== "README.md" && name !== "CHANGELOG.md";
	};
	return { ignored, touchesModel };
}

/**
 * Reloads `luaudocs.toml` when it changes. If the edited config fails to parse
 * (for example, when an editor saves a half-typed line) or if the config file
 * disappears during a stash or branch switch, keeps the previous config and
 * caches alive so the dev session survives.
 */
function reloadDevContext(
	startDir: string,
	current: BuildContext,
	docsDir: string,
	shutdown: (code?: number) => void,
): BuildContext | undefined {
	let next: BuildContext;
	try {
		next = createContext(startDir);
	} catch (error) {
		// Prefix with the config error so it does not look like a build failure.
		console.error(pc.red(`${(error as Error).message} (keeping the previous config)`));
		return undefined;
	}
	if (next.configPath === undefined && current.configPath !== undefined) {
		console.error(pc.red(`${current.configPath} removed (keeping the previous config)`));
		return undefined;
	}
	if (next.docsDir !== docsDir) {
		console.log(pc.yellow("[docs] dir moved; restart `dev` to serve the new directory"));
		shutdown(0);
		return undefined;
	}
	return next;
}

/** Resolves each `[source] entries` item to its watched directory root. */
function collectSourceRoots(context: BuildContext, roots: Set<string>): void {
	// When an entry points at a file (`src/init.luau`), watch its parent
	// directory so sibling modules it requires are covered.
	roots.clear();
	for (const entry of context.config.source.entries) {
		const abs = resolve(context.root, entry);
		try {
			roots.add(statSync(abs).isDirectory() ? abs : dirname(abs));
		} catch {
			// Missing entries are reported as extractor diagnostics during the build.
		}
	}
}

interface DevCache {
	configDirty: boolean;
	modelDirty: boolean;
	lastRendered?: RenderedModel;
	guidesDirty: boolean;
	lastGuides?: GuideItem[];
}

async function runRebuildPass(
	label: string,
	state: DevCache,
	getContext: () => BuildContext,
	applyConfig: () => boolean,
): Promise<void> {
	const startedAt = Date.now();
	// Reload the config before reading either cache, since config changes
	// affect both halves. Set `label` here so coalesced events still log as
	// a config reload whenever `luaudocs.toml` was part of the batch.
	if (state.configDirty) {
		state.configDirty = false;
		if (applyConfig()) {
			label = "config reload";
		}
	}
	// Snapshot and clear the dirty flags before `runBuild` starts so any
	// file event arriving mid-build re-dirties the flag for the next pass.
	const cached = state.modelDirty ? undefined : state.lastRendered;
	state.modelDirty = false;
	const cachedGuides = state.guidesDirty ? undefined : state.lastGuides;
	state.guidesDirty = false;
	try {
		const { model, result, guides, summary } = await runBuild(getContext(), {
			llms: false,
			rendered: cached,
			guides: cachedGuides,
		});
		state.lastRendered = { model, result };
		state.lastGuides = guides;
		console.log(
			pc.dim(
				`${label}: ${summary.written} written, ${summary.deleted} deleted, ${summary.unchanged} unchanged (${Date.now() - startedAt}ms)`,
			),
		);
	} catch (error) {
		// Restore dirty flags for any uncached work when a build fails.
		if (cached === undefined) {
			state.modelDirty = true;
		}
		if (cachedGuides === undefined) {
			state.guidesDirty = true;
		}
		console.error(pc.red(`${label} failed: ${(error as Error).message}`));
	}
}

function bindWatchers(
	watchers: FSWatcher[],
	context: BuildContext,
	docsDir: string,
	roots: Set<string>,
	onEvent: (path: string) => void,
): void {
	for (const watcher of watchers) {
		watcher.close();
	}
	watchers.length = 0;
	const listen = (dir: string, recursive: boolean): void => {
		try {
			watchers.push(
				watch(dir, { recursive }, (_event, filename) => onEvent(join(dir, filename ?? ""))),
			);
		} catch {
			// Directory disappeared. The next config reload will rebind remaining roots.
		}
	};
	collectSourceRoots(context, roots);
	for (const dir of roots) {
		listen(dir, true);
	}
	// Watch the project root non-recursively for `luaudocs.toml`,
	// `CHANGELOG.md`, `README.md`, the Rojo project file, and `.luaurc`.
	listen(context.root, false);
	mkdirSync(docsDir, { recursive: true });
	listen(docsDir, true);
}

export async function runDev(options: DevOptions): Promise<void> {
	let context = createContext(options.startDir);
	// Pinned for the session (moving `[docs] dir` requires restarting `dev`).
	const { docsDir } = context;
	const roots = new Set<string>();
	const { ignored, touchesModel } = createEventFilter(docsDir, () => context.root);
	const state: DevCache = { configDirty: false, modelDirty: true, guidesDirty: true };

	let pending = false;
	let running = false;
	let stopping = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let server: VitepressProcess | undefined;
	const watchers: FSWatcher[] = [];

	const onSignal = (): void => shutdown();
	const shutdown = (code?: number): void => {
		stopping = true;
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		clearTimeout(timer);
		for (const watcher of watchers) {
			watcher.close();
		}
		server?.child.kill("SIGINT");
		if (code !== undefined) {
			process.exit(code);
		}
	};

	const schedule = (): void => {
		pending = true;
		if (!running) {
			clearTimeout(timer);
			timer = setTimeout(() => void drain(), 150);
		}
	};

	const onEvent = (path: string): void => {
		if (stopping || ignored(path)) {
			return;
		}
		if (basename(path) === "luaudocs.toml") {
			state.configDirty = true;
		} else if (touchesModel(path)) {
			state.modelDirty = true;
		} else if (under(path, docsDir)) {
			state.guidesDirty = true;
		}
		schedule();
	};

	const applyConfig = (): boolean => {
		const next = reloadDevContext(options.startDir, context, docsDir, shutdown);
		if (!next) {
			return false;
		}
		context = next;
		state.modelDirty = true;
		state.guidesDirty = true;
		bindWatchers(watchers, context, docsDir, roots, onEvent);
		return true;
	};

	const drain = async (label = "rebuild"): Promise<void> => {
		running = true;
		try {
			while (pending && !stopping) {
				pending = false;
				await runRebuildPass(label, state, () => context, applyConfig);
				label = "rebuild";
			}
		} finally {
			running = false;
		}
	};

	bindWatchers(watchers, context, docsDir, roots, onEvent);
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	pending = true;
	await drain("initial build");
	if (stopping) {
		return;
	}
	console.log(pc.dim(`watching ${[...roots, context.root, docsDir].join(", ")}`));

	await ensureVitepress(docsDir);
	if (stopping) {
		return;
	}
	server = spawnVitepress(docsDir, "dev", options.vitepressArgs ?? []);
	try {
		await server.done;
	} catch {
		// VitePress exiting (for example on Ctrl+C) ends the session.
	}
	shutdown();
}

/**
 * `luaudocs dev`: watches source entries and the docs directory, re-running
 * `runBuild` alongside `vitepress dev`. Each half of the build is cached
 * against edits to the other (editing a guide skips spawning the extractor and
 * re-rendering API pages; editing a Luau source file skips walking the guides),
 * and file writes are content-compared so VitePress HMR only sees changed pages.
 *
 * Editing `luaudocs.toml` reloads the configuration in place and rebinds the
 * watchers to the current `[source] entries`; rewriting `.vitepress/config.mts`
 * triggers VitePress to restart its own dev server. Only changing `[docs] dir`
 * ends the session, because the VitePress dev server is bound to the directory
 * it was started in.
 */
import { statSync, watch, type FSWatcher } from "node:fs";
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

export async function runDev(options: DevOptions): Promise<void> {
	let context = createContext(options.startDir);
	// Pinned for the session; moving `[docs] dir` requires restarting `dev`.
	const { docsDir } = context;

	const under = (path: string, dir: string): boolean =>
		path === dir || path.startsWith(dir + sep);

	// Ignore everything a rebuild writes, plus caches, so the watcher never
	// loops on its own output. `index.md` is the one exception: a user-owned
	// `index.md` needs live reload, and a generated `index.md` costs at most
	// one coalesced follow-up pass when its content changes.
	const dropped = GENERATED_PATHS.filter((rel) => rel !== "index.md").map((rel) =>
		join(docsDir, rel),
	);
	// Also ignore the project-root `llms.txt` (`luaudocs llms` output): no
	// build reads it, and an unrecognized root file would otherwise trigger re-extraction.
	const ignored = (path: string): boolean =>
		path.split(sep).some((part) => part === "node_modules" || part === ".git") ||
		dropped.some((prefix) => under(path, prefix)) ||
		path === join(context.root, LOCAL_LLMS_FILE);

	// Directories for each `[source] entries` item, populated by `listenAll`.
	const roots = new Set<string>();

	// Classifies which half of the pipeline a file event affects: anything under
	// a source root or an unrecognized root-level file (such as `default.project.json`
	// or `.luaurc`) is an extractor input. Edits inside `docsDir` or to root
	// `README.md` / `CHANGELOG.md` only affect site syncing and skip the extractor.
	const touchesModel = (path: string): boolean => {
		for (const dir of roots) {
			if (under(path, dir)) {
				return true;
			}
		}
		if (under(path, docsDir)) {
			return false;
		}
		const name = basename(path);
		return name !== "README.md" && name !== "CHANGELOG.md";
	};

	let pending = false;
	let configDirty = false;
	let modelDirty = true;
	let lastRendered: RenderedModel | undefined;
	let guidesDirty = true;
	let lastGuides: GuideItem[] | undefined;
	let running = false;
	let stopping = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let server: VitepressProcess | undefined;

	const rebuild = async (label: string): Promise<void> => {
		const startedAt = Date.now();
		// Reload the config before reading either cache, since config changes
		// affect both halves. Set `label` here so coalesced events still log as
		// a config reload whenever `luaudocs.toml` was part of the batch.
		if (configDirty) {
			configDirty = false;
			if (applyConfig()) {
				label = "config reload";
			}
		}
		// Snapshot and clear the dirty flags before `runBuild` starts so any
		// file event arriving mid-build re-dirties the flag for the next pass.
		const cached = modelDirty ? undefined : lastRendered;
		modelDirty = false;
		const cachedGuides = guidesDirty ? undefined : lastGuides;
		guidesDirty = false;
		try {
			const { model, result, guides, summary } = await runBuild(context, {
				llms: false,
				rendered: cached,
				guides: cachedGuides,
			});
			lastRendered = { model, result };
			lastGuides = guides;
			console.log(
				pc.dim(
					`${label}: ${summary.written} written, ${summary.deleted} deleted, ${summary.unchanged} unchanged (${Date.now() - startedAt}ms)`,
				),
			);
		} catch (error) {
			// Restore dirty flags for any uncached work when a build fails.
			if (cached === undefined) {
				modelDirty = true;
			}
			if (cachedGuides === undefined) {
				guidesDirty = true;
			}
			console.error(pc.red(`${label} failed: ${(error as Error).message}`));
		}
	};

	// Single-flight queue: changes arriving mid-rebuild coalesce into a single
	// follow-up pass instead of racing a second extraction against the active one.
	const drain = async (label = "rebuild"): Promise<void> => {
		running = true;
		try {
			// Stop draining on shutdown so a queued pass cannot rebind closed watchers.
			while (pending && !stopping) {
				pending = false;
				await rebuild(label);
				label = "rebuild";
			}
		} finally {
			running = false;
		}
	};

	const shutdown = (code?: number): void => {
		stopping = true;
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
		if (running) {
			return;
		}
		clearTimeout(timer);
		timer = setTimeout(() => void drain(), 150);
	};

	/**
	 * Reloads `luaudocs.toml`, invalidating both caches and rebinding watchers
	 * in case `[source] entries` changed. If the edited config fails to parse
	 * (for example, when an editor saves a half-typed line) or if the config
	 * file disappears during a stash or branch switch, keeps the previous
	 * config and caches alive so the dev session survives.
	 */
	const applyConfig = (): boolean => {
		let next: BuildContext;
		try {
			next = createContext(options.startDir);
		} catch (error) {
			// Prefix with the config error so it does not look like a build failure.
			console.error(pc.red(`${(error as Error).message} (keeping the previous config)`));
			return false;
		}
		if (next.configPath === undefined && context.configPath !== undefined) {
			console.error(pc.red(`${context.configPath} removed (keeping the previous config)`));
			return false;
		}
		if (next.docsDir !== docsDir) {
			console.log(pc.yellow("[docs] dir moved; restart `dev` to serve the new directory"));
			shutdown(0);
			return false;
		}
		context = next;
		modelDirty = true;
		guidesDirty = true;
		listenAll();
		return true;
	};

	const onEvent = (path: string): void => {
		if (stopping || ignored(path)) {
			return;
		}
		// Watch for any `luaudocs.toml`, not just the initially loaded path, so
		// creating a nearer config in a subdirectory takes effect. Reloads share
		// the debounce timer so multi-event editor saves settle before reading.
		if (basename(path) === "luaudocs.toml") {
			configDirty = true;
			schedule();
			return;
		}
		if (touchesModel(path)) {
			modelDirty = true;
		} else if (under(path, docsDir)) {
			guidesDirty = true;
		}
		schedule();
	};

	const watchers: FSWatcher[] = [];
	const listen = (dir: string, recursive: boolean): void => {
		try {
			watchers.push(
				watch(dir, { recursive }, (_event, filename) => onEvent(join(dir, filename ?? ""))),
			);
		} catch {
			// Directory disappeared; the next config reload will rebind remaining roots.
		}
	};
	/** Binds (or rebinds after a config reload) all file watchers. */
	const listenAll = (): void => {
		for (const watcher of watchers) {
			watcher.close();
		}
		watchers.length = 0;
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
		for (const dir of roots) {
			listen(dir, true);
		}
		// Watch the project root non-recursively for `luaudocs.toml`,
		// `CHANGELOG.md`, `README.md`, the Rojo project file, and `.luaurc`.
		listen(context.root, false);
		listen(docsDir, true);
	};
	listenAll();

	process.on("SIGINT", () => shutdown());
	process.on("SIGTERM", () => shutdown());

	// Run the initial build through `drain` because watchers are already active;
	// any file event arriving during the initial build coalesces into a follow-up
	// pass rather than racing a second build.
	pending = true;
	await drain("initial build");
	if (stopping) {
		return;
	}
	console.log(pc.dim(`watching ${[...roots, context.root, docsDir].join(", ")}`));

	// Install VitePress after the initial build writes `<docs>/package.json`.
	await ensureVitepress(docsDir);
	// If a signal arrived during `ensureVitepress`, watchers are already closed;
	// do not spawn a dev server that would outlive the session.
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

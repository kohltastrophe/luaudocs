/**
 * `luaudocs dev`: watch the sources and the docs dir, rerunning the shared
 * runBuild alongside `vitepress dev`. Each half of a rebuild is cached against
 * edits to the other (a docs-dir edit skips the extractor spawn and the page
 * render it feeds, a source edit skips the guide walk), and writes are
 * content-compared, so VitePress HMR only sees genuinely changed pages.
 *
 * A luaudocs.toml edit reloads in place, watchers rebound to whatever [source]
 * entries now name: the rewritten .vitepress/config.mts is what the vitepress
 * server watches, so it restarts itself. Only a moved docs dir still ends the
 * session, since the server is bound to the directory it was spawned on.
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
import type { GuideItem } from "./site";

export interface DevOptions {
	startDir: string;
	vitepressArgs?: string[];
}

export async function runDev(options: DevOptions): Promise<void> {
	let context = createContext(options.startDir);
	// pinned for the session, which is why a config moving it restarts instead
	const { docsDir } = context;

	const under = (path: string, dir: string): boolean =>
		path === dir || path.startsWith(dir + sep);

	// everything a rebuild writes itself, plus caches: reacting to any of these
	// would loop the watcher on its own output. index.md is the one exception
	// the build writes and this does not drop: a user-owned copy deserves live
	// reload, and the generated copy costs at most one coalesced follow-up pass.
	const dropped = GENERATED_PATHS.filter((rel) => rel !== "index.md").map((rel) =>
		join(docsDir, rel),
	);
	const ignored = (path: string): boolean =>
		path.split(sep).some((part) => part === "node_modules" || part === ".git") ||
		dropped.some((prefix) => under(path, prefix));

	// each source entry's root, bound by listenAll below
	const roots = new Set<string>();

	// which half of the pipeline a change feeds: anything under a source root,
	// or an unrecognized root-level file (the rojo project, .luaurc), is an
	// extractor input. Docs-dir content and the root README/CHANGELOG only
	// re-render the site, so those rebuilds skip the extractor spawn.
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
		// the config feeds both halves, so it is adopted before either cache is
		// read. The label names what the pass turned out to be: events
		// coalesce, so the last one to arrive does not get to decide.
		if (configDirty) {
			configDirty = false;
			if (applyConfig()) {
				label = "config reload";
			}
		}
		// consumed before the build starts: a source event landing mid-build
		// re-dirties, and the drain's next pass re-extracts; the guide cache
		// works the same way for the docs-dir half
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
			// a failed pass proved nothing: re-dirty whatever it consumed
			if (cached === undefined) {
				modelDirty = true;
			}
			if (cachedGuides === undefined) {
				guidesDirty = true;
			}
			console.error(pc.red(`${label} failed: ${(error as Error).message}`));
		}
	};

	// single-flight with a drain: a change arriving mid-rebuild coalesces into
	// one follow-up pass instead of racing a second extract against the one in
	// flight
	const drain = async (label = "rebuild"): Promise<void> => {
		running = true;
		try {
			// a pass queued behind shutdown would rebind watchers nothing closes
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
	 * Adopt the config as it now reads, both caches dropped and the watchers
	 * rebound because [source] entries may name other directories. A config
	 * that does not parse keeps the previous one, caches included: editors
	 * save half-typed edits, and the session has to survive them. So does one
	 * that is gone: a stash or a branch switch takes the file away, and
	 * createContext would otherwise hand back defaults as if that were a
	 * successful reload.
	 */
	const applyConfig = (): boolean => {
		let next: BuildContext;
		try {
			next = createContext(options.startDir);
		} catch (error) {
			// named for the file, so it cannot read as the build below failing
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
		// any luaudocs.toml, not just the loaded one: a nearer config created
		// after a parent was adopted is the one that applies from now on. The
		// reload rides the same debounce, so a save is read once it has settled
		// however many events the editor emitted.
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
			// a root that vanished; the next config edit re-binds what is left
		}
	};
	/** Bind the whole watch set, and rebind it after a config reload. */
	const listenAll = (): void => {
		for (const watcher of watchers) {
			watcher.close();
		}
		watchers.length = 0;
		// an entry pointing at a file (src/init.luau) watches the directory
		// around it, where the modules it requires live
		roots.clear();
		for (const entry of context.config.source.entries) {
			const abs = resolve(context.root, entry);
			try {
				roots.add(statSync(abs).isDirectory() ? abs : dirname(abs));
			} catch {
				// a missing entry is the extractor's diagnostic to report, not ours
			}
		}
		for (const dir of roots) {
			listen(dir, true);
		}
		// the project root, non-recursively: luaudocs.toml, CHANGELOG.md,
		// README.md, the rojo project file and .luaurc all sit at the top level
		listen(context.root, false);
		listen(docsDir, true);
	};
	listenAll();

	process.on("SIGINT", () => shutdown());
	process.on("SIGTERM", () => shutdown());

	// through the drain like every rebuild: the watchers are already live, so
	// an event landing mid-initial-build must coalesce into the follow-up pass
	// rather than race a second build against this one
	pending = true;
	await drain("initial build");
	if (stopping) {
		return;
	}
	console.log(pc.dim(`watching ${[...roots, context.root, docsDir].join(", ")}`));

	// after the initial build, which wrote the package.json the install
	// resolves against
	await ensureVitepress(docsDir);
	server = spawnVitepress(docsDir, "dev", options.vitepressArgs ?? []);
	try {
		await server.done;
	} catch {
		// vitepress exiting (ctrl-c) ends the session; its own output already said why
	}
	shutdown();
}

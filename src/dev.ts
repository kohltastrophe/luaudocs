/**
 * `luaudocs dev`: watch the sources and the docs dir, rerunning the shared
 * runBuild alongside `vitepress dev`. Each half of a rebuild is cached against
 * edits to the other (a docs-dir edit skips the extractor spawn and the page
 * render it feeds, a source edit skips the guide walk), and writes are
 * content-compared, so VitePress HMR only sees genuinely changed pages.
 *
 * A config edit ends the session rather than reloading in place: the vitepress
 * server is already bound to a docs dir and a resolved config.
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
	type RenderedModel,
	type VitepressProcess,
} from "./build";
import type { GuideItem } from "./site";

export interface DevOptions {
	startDir: string;
	vitepressArgs?: string[];
}

export async function runDev(options: DevOptions): Promise<void> {
	const context = createContext(options.startDir);
	const { config, root, docsDir } = context;

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

	// each source entry's root; an entry pointing at a file (src/init.luau)
	// watches the directory around it, where the modules it requires live
	const roots = new Set<string>();
	for (const entry of config.source.entries) {
		const abs = resolve(root, entry);
		try {
			roots.add(statSync(abs).isDirectory() ? abs : dirname(abs));
		} catch {
			// a missing entry is the extractor's diagnostic to report, not ours
		}
	}

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
			while (pending) {
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

	const onEvent = (path: string): void => {
		if (stopping || ignored(path)) {
			return;
		}
		// any luaudocs.toml, not just the loaded one: a nearer config created
		// after a parent was adopted is still worth restarting for
		if (basename(path) === "luaudocs.toml") {
			console.log(
				pc.yellow("luaudocs.toml changed; restart `dev` to pick up the new config"),
			);
			shutdown(0);
			return;
		}
		pending = true;
		if (touchesModel(path)) {
			modelDirty = true;
		} else if (under(path, docsDir)) {
			guidesDirty = true;
		}
		if (running) {
			return;
		}
		clearTimeout(timer);
		timer = setTimeout(() => void drain(), 150);
	};

	const watchers: FSWatcher[] = [];
	const listen = (dir: string, recursive: boolean): void => {
		try {
			watchers.push(
				watch(dir, { recursive }, (_event, filename) => onEvent(join(dir, filename ?? ""))),
			);
		} catch {
			// a root that vanished; the next config edit restarts the session
		}
	};
	for (const dir of roots) {
		listen(dir, true);
	}
	// the project root, non-recursively: luaudocs.toml, CHANGELOG.md, README.md,
	// the rojo project file and .luaurc all sit at the top level
	listen(root, false);
	listen(docsDir, true);

	process.on("SIGINT", () => shutdown());
	process.on("SIGTERM", () => shutdown());

	// through the drain like every rebuild: the watchers are already live, so
	// an event landing mid-initial-build must coalesce into the follow-up pass
	// rather than race a second build against this one
	pending = true;
	await drain("initial build");
	console.log(pc.dim(`watching ${[...roots, root, docsDir].join(", ")}`));

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

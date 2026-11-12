/**
 * `luaudocs dev`'s session lifecycle, watcher filtering, source-root deduplication,
 * config reload recovery, `[docs] dir` move shutdown, and server crash propagation
 * (`src/dev.ts`).
 */
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDev } from "../src/dev";
import { makeTempDirFactory, modelJson, seed } from "./helpers";

interface FakeWatcher extends EventEmitter {
	dir: string;
	recursive: boolean;
	closed: boolean;
	close: () => void;
	trigger: (relPath: string) => void;
}

const mocks = vi.hoisted(() => ({
	duringInstall: (): void => {},
	watchers: [] as FakeWatcher[],
	runBuildSpy: vi.fn(),
	spawnVitepress: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		watch: (
			dir: string,
			opts: { recursive?: boolean } | undefined,
			listener?: (event: string, filename: string | null) => void,
		): FSWatcher => {
			const emitter = new EventEmitter() as FakeWatcher;
			emitter.dir = String(dir);
			emitter.recursive = Boolean(opts?.recursive);
			emitter.closed = false;
			emitter.close = () => {
				emitter.closed = true;
			};
			emitter.trigger = (relPath: string) => {
				listener?.("change", relPath);
			};
			mocks.watchers.push(emitter);
			return emitter as unknown as FSWatcher;
		},
	};
});

vi.mock("../src/extract", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/extract")>()),
	runExtractor: async () => JSON.parse(modelJson([])),
}));

vi.mock("../src/build", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/build")>();
	return {
		...actual,
		runBuild: async (
			context: Parameters<typeof actual.runBuild>[0],
			options?: Parameters<typeof actual.runBuild>[1],
		) => {
			mocks.runBuildSpy(context, options);
			return actual.runBuild(context, options);
		},
		ensureVitepress: async () => mocks.duringInstall(),
		spawnVitepress: (...args: unknown[]) => mocks.spawnVitepress(...args),
	};
});

const tempDir = makeTempDirFactory("luaudocs-dev-");

describe("runDev", () => {
	const signals = ["SIGINT", "SIGTERM"] as const;
	let before: Map<string, Set<unknown>>;

	beforeEach(() => {
		mocks.duringInstall = () => {};
		mocks.watchers.length = 0;
		mocks.runBuildSpy.mockClear();
		mocks.spawnVitepress.mockReset();
		mocks.spawnVitepress.mockImplementation(() => ({
			child: { kill: vi.fn() },
			done: Promise.resolve(),
		}));
		before = new Map(signals.map((signal) => [signal, new Set(process.listeners(signal))]));
	});

	afterEach(() => {
		for (const signal of signals) {
			for (const listener of process.listeners(signal)) {
				if (!before.get(signal)!.has(listener)) {
					process.off(signal, listener);
				}
			}
		}
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("starts no server when a signal lands during the install", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "luaudocs.toml"), "[source]\nentries = []\n");
		mocks.duringInstall = () => {
			for (const listener of process.listeners("SIGTERM")) {
				if (!before.get("SIGTERM")!.has(listener)) {
					(listener as () => void)();
				}
			}
		};
		vi.spyOn(console, "log").mockImplementation(() => {});

		await runDev({ startDir: dir });
		expect(mocks.spawnVitepress).not.toHaveBeenCalled();
		expect(mocks.watchers.every((w) => w.closed)).toBe(true);
	});

	it("deduplicates nested source roots, ignores generated paths, caches halves, and rebinds newly created entries", async () => {
		vi.useFakeTimers();
		const dir = tempDir();
		// `entries = []` on disk avoids spawning Lute while we also test nested/file/missing entries via config reload.
		seed(dir, {
			"luaudocs.toml": 'title = "Demo"\n[source]\nentries = []\n',
			".luaudocs/guide/intro.md": "# Intro\n",
		});

		let resolveServer!: () => void;
		const killSpy = vi.fn(() => resolveServer());
		mocks.spawnVitepress.mockImplementation(() => ({
			child: { kill: killSpy },
			done: new Promise<void>((r) => {
				resolveServer = r;
			}),
		}));
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		const session = runDev({ startDir: dir });
		await vi.advanceTimersByTimeAsync(10);
		expect(mocks.runBuildSpy).toHaveBeenCalledTimes(1);

		const activeWatchers = () => mocks.watchers.filter((w) => !w.closed);
		const rootWatcher = () => activeWatchers().find((w) => w.dir === dir && !w.recursive)!;
		const docsWatcher = () => activeWatchers().find((w) => w.dir === join(dir, ".luaudocs"))!;

		// Emitting an async OS watcher error must be swallowed without throwing.
		expect(() => rootWatcher().emit("error", new Error("EPERM"))).not.toThrow();

		// Generated and VCS paths are ignored (zero rebuilds scheduled).
		rootWatcher().trigger("llms.txt");
		rootWatcher().trigger(".git/HEAD");
		docsWatcher().trigger("api/Page.md");
		docsWatcher().trigger("node_modules/pkg/index.js");
		await vi.advanceTimersByTimeAsync(200);
		expect(mocks.runBuildSpy).toHaveBeenCalledTimes(1);

		// Guide edit reuses cached `rendered` model (`rendered` defined, `guides` undefined).
		writeFileSync(join(dir, ".luaudocs/guide/intro.md"), "# Updated Intro\n");
		docsWatcher().trigger("guide/intro.md");
		await vi.advanceTimersByTimeAsync(200);
		expect(mocks.runBuildSpy).toHaveBeenCalledTimes(2);
		expect(mocks.runBuildSpy.mock.calls[1]![1]).toMatchObject({
			llms: false,
			guides: undefined,
		});
		expect(mocks.runBuildSpy.mock.calls[1]![1]?.rendered).toBeDefined();

		// README edit skips extractor (`rendered` defined) while touching site sync (`guides` defined).
		writeFileSync(join(dir, "README.md"), "# Readme\n");
		rootWatcher().trigger("README.md");
		await vi.advanceTimersByTimeAsync(200);
		expect(mocks.runBuildSpy).toHaveBeenCalledTimes(3);
		expect(mocks.runBuildSpy.mock.calls[2]![1]?.rendered).toBeDefined();
		expect(mocks.runBuildSpy.mock.calls[2]![1]?.guides).toBeDefined();

		// Shutdown cleanly via `[docs] dir` move in `luaudocs.toml` (also tests nested dir dedup before shutdown).
		mkdirSync(join(dir, "src", "nested"), { recursive: true });
		writeFileSync(join(dir, "luaudocs.toml"), 'title = "Demo"\n[docs]\ndir = "moved-docs"\n');
		rootWatcher().trigger("luaudocs.toml");
		await vi.advanceTimersByTimeAsync(200);
		await session;
		expect(killSpy).toHaveBeenCalledWith("SIGINT");
		expect(mocks.watchers.every((w) => w.closed)).toBe(true);
	});

	it("keeps previous config on invalid or deleted luaudocs.toml and rethrows unexpected server crashes", async () => {
		vi.useFakeTimers();
		const dir = tempDir();
		// Exercise `resolveSourceRoots` deduplicating `src` + `src/sub` + file entry + missing entry!
		mkdirSync(join(dir, "src", "sub"), { recursive: true });
		writeFileSync(join(dir, "src", "init.luau"), "return {}\n");
		writeFileSync(
			join(dir, "luaudocs.toml"),
			'title = "Demo"\n[source]\nentries = ["src/sub", "src", "src/init.luau", "later"]\n',
		);

		let rejectServer!: (err: Error) => void;
		mocks.spawnVitepress.mockImplementation(() => ({
			child: { kill: vi.fn() },
			done: new Promise<void>((_resolve, reject) => {
				rejectServer = reject;
			}),
		}));
		const errors: string[] = [];
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(
			(...args: unknown[]) => void errors.push(args.map(String).join(" ")),
		);

		const session = runDev({ startDir: dir });
		// Attach rejection handler immediately so Vitest never sees an unhandled rejection.
		const outcome = session.then(
			() => null,
			(err: Error) => err,
		);
		await vi.advanceTimersByTimeAsync(10);

		const activeDirs = () =>
			mocks.watchers.filter((w) => !w.closed && w.recursive).map((w) => w.dir);
		// `src/sub` and `src/init.luau` collapse into `src`; `later` is not created yet.
		expect(activeDirs()).toContain(join(dir, "src"));
		expect(activeDirs()).not.toContain(join(dir, "src", "sub"));
		expect(activeDirs()).not.toContain(join(dir, "later"));

		const rootWatcher = () =>
			mocks.watchers.find((w) => !w.closed && w.dir === dir && !w.recursive)!;

		// Creating `later/` mid-session rebinds watchers automatically.
		mkdirSync(join(dir, "later"));
		rootWatcher().trigger("later");
		await vi.advanceTimersByTimeAsync(200);
		expect(activeDirs()).toContain(join(dir, "later"));

		// Invalid TOML keeps the previous config alive.
		writeFileSync(join(dir, "luaudocs.toml"), "title = \n");
		rootWatcher().trigger("luaudocs.toml");
		await vi.advanceTimersByTimeAsync(200);
		expect(errors.join("\n")).toContain("(keeping the previous config)");

		// Deleting `luaudocs.toml` keeps the previous config alive.
		rmSync(join(dir, "luaudocs.toml"));
		rootWatcher().trigger("luaudocs.toml");
		await vi.advanceTimersByTimeAsync(200);
		expect(errors.join("\n")).toContain("removed (keeping the previous config)");

		// Unexpected VitePress server crash propagates out of `runDev` and still closes watchers.
		rejectServer(new Error("vitepress dev crashed"));
		const crashed = await outcome;
		expect(crashed?.message).toBe("vitepress dev crashed");
		expect(mocks.watchers.every((w) => w.closed)).toBe(true);
	});
});

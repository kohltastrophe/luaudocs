/**
 * `luaudocs dev`'s session lifecycle, with the two process boundaries (the
 * docs-site install and the VitePress server) mocked out and everything else
 * real: a guide-only project needs no Lute, so the initial build runs as is.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDev } from "../src/dev";
import { makeTempDirFactory } from "./helpers";

const mocks = vi.hoisted(() => ({
	/** what happens while the install runs */
	duringInstall: (): void => {},
	spawnVitepress: vi.fn(() => ({ child: { kill: () => {} }, done: Promise.resolve() })),
}));

vi.mock("../src/build", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/build")>()),
	ensureVitepress: async () => mocks.duringInstall(),
	spawnVitepress: mocks.spawnVitepress,
}));

const tempDir = makeTempDirFactory("luaudocs-dev-");

describe("runDev", () => {
	const signals = ["SIGINT", "SIGTERM"] as const;
	let before: Map<string, Set<unknown>>;
	afterEach(() => {
		// the session's own handlers, so they cannot outlive the test
		for (const signal of signals) {
			for (const listener of process.listeners(signal)) {
				if (!before.get(signal)!.has(listener)) {
					process.off(signal, listener);
				}
			}
		}
		vi.restoreAllMocks();
	});

	// the install can take minutes on a fresh site; a ctrl-c or SIGTERM during
	// it closed the watchers, and the session then started a server anyway
	it("starts no server when a signal lands during the install", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "luaudocs.toml"), "[source]\nentries = []\n");
		before = new Map(signals.map((signal) => [signal, new Set(process.listeners(signal))]));
		// called directly rather than emitted, so the test runner's own
		// handlers never see a signal
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
	});
});

/**
 * Unit tests for CLI argument parsing, `--` option-terminator rules, `-h`/`--help`,
 * `--version`, `--model` parent-directory creation, and exit codes (`src/cli.ts`).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import pkg from "../package.json";
import type { DocModel } from "../src/docmodel";
import { makeTempDirFactory, modelJson, seed } from "./helpers";

const tempDir = makeTempDirFactory("luaudocs-cli-");

const SAMPLE_MODEL: DocModel = JSON.parse(modelJson([{ id: "src/init.luau", name: "Sample" }]));

const mocks = vi.hoisted(() => ({
	runBuild: vi.fn(),
	ensureVitepress: vi.fn(async () => {}),
	unshallowGit: vi.fn(async () => {}),
	spawnVitepress: vi.fn(() => ({ child: { kill: () => {} }, done: Promise.resolve() })),
	runDev: vi.fn(async () => {}),
	initProject: vi.fn(async () => {}),
	runLocalLlms: vi.fn(),
}));

vi.mock("../src/build", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/build")>()),
	runBuild: mocks.runBuild,
	ensureVitepress: mocks.ensureVitepress,
	unshallowGit: mocks.unshallowGit,
	spawnVitepress: mocks.spawnVitepress,
}));

vi.mock("../src/dev", () => ({
	runDev: mocks.runDev,
}));

vi.mock("../src/init", () => ({
	initProject: mocks.initProject,
}));

vi.mock("../src/llms", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/llms")>()),
	runLocalLlms: mocks.runLocalLlms,
}));

interface CliRun {
	exitCode: number;
	logs: string;
	errors: string;
}

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

async function invokeCli(...args: string[]): Promise<CliRun> {
	const prevArgv = process.argv;
	const prevExitCode = process.exitCode;
	process.argv = ["node", "luaudocs", ...args];
	process.exitCode = undefined;

	const logs: string[] = [];
	const errors: string[] = [];
	let exited: number | undefined;

	const logSpy = vi
		.spyOn(console, "log")
		.mockImplementation((...parts: unknown[]) => void logs.push(parts.map(String).join(" ")));
	const errSpy = vi
		.spyOn(console, "error")
		.mockImplementation((...parts: unknown[]) => void errors.push(parts.map(String).join(" ")));
	const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
		code?: number | string | null,
	) => {
		const numeric = typeof code === "number" ? code : Number(code ?? 0);
		exited ??= numeric;
		if (new Error().stack?.includes("at usage")) {
			throw new Error("__CLI_USAGE_EXIT__");
		}
		return undefined as never;
	}) as never);

	try {
		vi.resetModules();
		await import("../src/cli");
		await new Promise((resolve) => setImmediate(resolve));
		const code = exited ?? (typeof process.exitCode === "number" ? process.exitCode : 0);
		return {
			exitCode: code,
			logs: stripAnsi(logs.join("\n")),
			errors: stripAnsi(errors.join("\n")),
		};
	} finally {
		process.argv = prevArgv;
		process.exitCode = prevExitCode;
		logSpy.mockRestore();
		errSpy.mockRestore();
		exitSpy.mockRestore();
	}
}

describe("cli", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("prints help and version on top-level and subcommand -h/--help/-v/--version", async () => {
		for (const args of [
			[],
			["-h"],
			["--help"],
			["init", "-h"],
			["build", "--help"],
			["dev", "-h"],
			["llms", "--help"],
		]) {
			const res = await invokeCli(...args);
			expect(res.exitCode, args.join(" ")).toBe(0);
			expect(res.logs).toContain("Usage:");
		}

		for (const flag of ["-v", "--version"]) {
			const res = await invokeCli(flag);
			expect(res.exitCode).toBe(0);
			expect(res.logs.trim()).toBe(pkg.version);
		}
	});

	it("enforces `--` option-terminator rules, unknown commands, and extra positionals", async () => {
		const missingBefore = await invokeCli("--", "build");
		expect(missingBefore.exitCode).toBe(2);
		expect(missingBefore.errors).toContain("missing command before `--`");

		const nonDevPassthrough = await invokeCli("build", "--", "--strict");
		expect(nonDevPassthrough.exitCode).toBe(2);
		expect(nonDevPassthrough.errors).toContain("build takes no arguments after `--`: --strict");

		const unknownCmd = await invokeCli("ship");
		expect(unknownCmd.exitCode).toBe(2);
		expect(unknownCmd.errors).toContain("unknown command: ship");

		const extraPos = await invokeCli("init", "one", "two");
		expect(extraPos.exitCode).toBe(2);
		expect(extraPos.errors).toContain("unexpected argument: two");

		const badFlag = await invokeCli("build", "--not-a-flag");
		expect(badFlag.exitCode).toBe(2);
		expect(badFlag.errors).toContain("error:");

		const dir = tempDir();
		const devOk = await invokeCli("dev", dir, "--", "--port", "4173");
		expect(devOk.exitCode).toBe(0);
		expect(mocks.runDev).toHaveBeenCalledWith({
			startDir: dir,
			vitepressArgs: ["--port", "4173"],
		});
	});

	it("creates parent directories for build --model and maps build/strict/vitepress failures to exit 1", async () => {
		const dir = tempDir();
		seed(dir, { "luaudocs.toml": 'title = "Demo"\n[source]\nentries = []\n' });
		const modelOut = join(tempDir(), "nested", "sub", "docmodel.json");

		mocks.runBuild.mockResolvedValueOnce({
			model: SAMPLE_MODEL,
			result: { pages: new Map([["Sample.md", "# Sample\n"]]) },
			counts: { errors: 0, warnings: 0 },
			summary: { written: 1, deleted: 0, unchanged: 0 },
		});
		const ok = await invokeCli("build", dir, "--emit-only", "--model", modelOut);
		expect(ok.exitCode).toBe(0);
		expect(existsSync(modelOut)).toBe(true);
		expect(JSON.parse(readFileSync(modelOut, "utf8")).schemaVersion).toBe(1);
		expect(mocks.spawnVitepress).not.toHaveBeenCalled();

		// `--strict` with warnings fails with exit 1 and skips VitePress.
		mocks.runBuild.mockResolvedValueOnce({
			model: SAMPLE_MODEL,
			result: { pages: new Map() },
			counts: { errors: 0, warnings: 2 },
			summary: { written: 0, deleted: 0, unchanged: 0 },
		});
		const strictFail = await invokeCli("build", dir, "--strict");
		expect(strictFail.exitCode).toBe(1);
		expect(strictFail.errors).toContain("2 warning(s) with --strict; VitePress build skipped");

		// VitePress build failure sets exit 1 rather than exit 2.
		mocks.runBuild.mockResolvedValueOnce({
			model: SAMPLE_MODEL,
			result: { pages: new Map() },
			counts: { errors: 0, warnings: 0 },
			summary: { written: 0, deleted: 0, unchanged: 0 },
		});
		mocks.spawnVitepress.mockImplementationOnce(() => ({
			child: { kill: () => {} },
			done: Promise.reject(new Error("dead link")),
		}));
		const vpFail = await invokeCli("build", dir);
		expect(vpFail.exitCode).toBe(1);
		expect(vpFail.errors).toContain("error: dead link");
	});

	it("dispatches init and llms outcomes with accurate status messages and exit codes", async () => {
		const dir = tempDir();
		seed(dir, { "luaudocs.toml": 'title = "Demo"\n[source]\nentries = []\n' });

		const initRes = await invokeCli(
			"init",
			dir,
			"--force",
			"--from-moonwave",
			"--title",
			"T",
			"--description",
			"D",
		);
		expect(initRes.exitCode).toBe(0);
		expect(mocks.initProject).toHaveBeenCalledWith({
			targetDir: dir,
			force: true,
			fromMoonwave: true,
			title: "T",
			description: "D",
		});

		for (const [outcome, check, expectedCode, marker] of [
			[{ status: "written" }, false, 0, "wrote"],
			[{ status: "unchanged" }, true, 0, "up to date"],
			[{ status: "missing" }, true, 1, "is missing"],
			[{ status: "stale" }, true, 1, "is out of date"],
			[{ status: "failed", errors: 1 }, false, 1, "1 extraction error(s)"],
		] as const) {
			mocks.runLocalLlms.mockResolvedValueOnce(outcome);
			const res = await invokeCli("llms", dir, ...(check ? ["--check"] : []));
			expect(res.exitCode, JSON.stringify(outcome)).toBe(expectedCode);
			expect(`${res.logs}\n${res.errors}`).toContain(marker);
		}
	});
});

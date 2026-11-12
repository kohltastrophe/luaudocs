/**
 * Unit tests for `packageRoot`, `extractorJson`, and `runExtractor` (`src/extract.ts`)
 * using a mocked `execFile` seam so Windows, macOS, and Linux CI legs exercise
 * identical exit, signal, timeout, maxBuffer, and spawn-failure paths.
 */
import type { ExecFileException } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempDirFactory, modelJson } from "./helpers";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execFile: execFileMock };
});

import { extractorJson, packageRoot, runExtractor } from "../src/extract";

const tempDir = makeTempDirFactory("luaudocs-extract-");

function stubOutcome(error: Partial<ExecFileException> | null, stdout = "", stderr = ""): void {
	execFileMock.mockImplementationOnce(
		(
			_file: string,
			_args: readonly string[],
			_options: unknown,
			callback: (err: ExecFileException | null, stdout: string, stderr: string) => void,
		) => {
			const err =
				error === null
					? null
					: Object.assign(new Error(error.message ?? "spawn failed"), error);
			callback(err as ExecFileException | null, stdout, stderr);
		},
	);
}

describe("extract", () => {
	let lutePath: string;

	beforeEach(() => {
		lutePath = join(tempDir(), "lute-stub");
		writeFileSync(lutePath, "");
		vi.stubEnv("LUAUDOCS_LUTE", lutePath);
		execFileMock.mockReset();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("locates packageRoot and passes deterministic CLI flags to the extractor", async () => {
		expect(existsSync(join(packageRoot(), "package.json"))).toBe(true);

		const validJson = modelJson([{ id: "src/init.luau", name: "Sample" }]);
		stubOutcome(null, `${validJson}\r\n`);

		const model = await runExtractor({
			root: "/proj",
			entries: ["src", "lib"],
			projectFile: "default.project.json",
			aliases: {
				zeta: { url: "https://zeta.example/docs" },
				alpha: {},
			},
			reportUndocumented: true,
			pretty: true,
		});
		expect(model.modules[0]?.name).toBe("Sample");

		expect(execFileMock).toHaveBeenCalledTimes(1);
		const [cmd, recorded] = execFileMock.mock.calls[0] as [string, string[]];
		expect(cmd).toBe(lutePath);
		expect(recorded[0]).toBe("run");
		expect(recorded[1]).toBe(join(packageRoot(), "extractor", "main.luau"));
		expect(recorded.slice(2)).toEqual([
			"--",
			"--root",
			"/proj",
			"--entry",
			"src",
			"--entry",
			"lib",
			"--project-file",
			"default.project.json",
			"--alias",
			"alpha",
			"--alias",
			"zeta=https://zeta.example/docs",
			"--report-undocumented",
			"--pretty",
		]);
	});

	it("translates exit-2 usage errors, crash output, signals, timeouts, maxBuffer, and spawn errors", async () => {
		// Exit code 2 strips leading `error: ` without doubling the prefix.
		stubOutcome({ code: 2 }, "", "error: entry path does not exist\n");
		const exit2 = await extractorJson({ root: "/proj", entries: ["src"] }).catch(
			(e: Error) => e,
		);
		expect(exit2).toBeInstanceOf(Error);
		expect((exit2 as Error).message).toBe("entry path does not exist");

		// Unexpected non-zero exit combines stderr and stdout (or omits detail when silent).
		stubOutcome({ code: 1 }, "partial out\n", "trace line\n");
		await expect(extractorJson({ root: "/proj", entries: ["src"] })).rejects.toThrow(
			"extractor failed (exit 1)\ntrace line\npartial out",
		);

		stubOutcome({ code: 3 });
		await expect(extractorJson({ root: "/proj", entries: ["src"] })).rejects.toThrow(
			/^extractor failed \(exit 3\)$/,
		);

		// Output exceeding MAX_BUFFER surfaces the 256 MB overrun hint.
		stubOutcome({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
		await expect(extractorJson({ root: "/proj", entries: ["src"] })).rejects.toThrow(
			/doc model exceeded the 256 MB output limit; narrow the entry points/,
		);

		// External signal termination reports the signal name.
		stubOutcome({ signal: "SIGTERM", killed: false });
		await expect(extractorJson({ root: "/proj", entries: ["src"] })).rejects.toThrow(
			/extractor was killed by SIGTERM/,
		);

		// Wall-clock timeout surfaces the narrow-entries hint.
		stubOutcome({ killed: true, signal: "SIGTERM" });
		await expect(
			extractorJson({ root: "/proj", entries: ["src"], timeoutMs: 50 }),
		).rejects.toThrow(/extractor timed out after 0\.05s; narrow the entry points/);

		// Spawn failure with no numeric exit code surfaces `lute.hint`.
		stubOutcome({ code: "EACCES" });
		await expect(extractorJson({ root: "/proj", entries: ["src"] })).rejects.toThrow(
			new RegExp(
				`could not run the Lute LUAUDOCS_LUTE points at \\(${lutePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`,
			),
		);
	});
});

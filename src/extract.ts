/**
 * Spawns the Lute extractor and validates its output. Also home to
 * packageRoot(): the extractor entry, the packaged templates, and the CLI's
 * --version all resolve through it, wherever the package is installed.
 */
import { execFile, type ExecFileException } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocModel, type DocModel } from "./docmodel";
import { resolveLute } from "./lute";

/**
 * Walks up to the nearest package.json, which absorbs whether the caller is the
 * built bundle (dist/) or a source run. Deliberately not derived from the
 * extractor's path: a guide-only project never runs the extractor, but still
 * reaches the packaged templates/ through here.
 */
export function packageRoot(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [join(here, ".."), join(here, "../..")];
	for (const candidate of candidates) {
		if (existsSync(join(candidate, "package.json"))) {
			return candidate;
		}
	}
	throw new Error(
		`could not locate the luaudocs package root (looked at ${candidates.join(", ")})`,
	);
}

/** Absolute path to extractor/main.luau, run on the Lute `src/lute.ts` pins. */
function extractorEntry(): string {
	const entry = join(packageRoot(), "extractor", "main.luau");
	if (!existsSync(entry)) {
		throw new Error(`could not locate the packaged extractor (looked at ${entry})`);
	}
	return entry;
}

export interface ExtractRequest {
	root: string;
	entries: string[];
	projectFile?: string;
	/** Indented JSON, for the checked-in captures that diff line by line. */
	pretty?: boolean;
	/** Wall-clock budget, `0` for none (the capture script, with no one waiting). */
	timeoutMs?: number;
}

// large doc models blow past node's 1 MB default
const MAX_BUFFER = 1024 * 1024 * 256;

// phrased in terms of the request rather than `[source] entries`: the capture
// script reaches these too and never reads a luaudocs.toml
const OVERRUN_HINT = "narrow the entry points, or exclude generated files from them";

interface SpawnOutcome {
	error: ExecFileException | null;
	stdout: string;
	stderr: string;
}

/**
 * Split out from `runExtractor` so the capture script spawns through the same
 * CLI contract the build does, rather than a second copy that could drift.
 */
export async function extractorJson(request: ExtractRequest): Promise<string> {
	const args = ["run", extractorEntry(), "--", "--root", request.root];
	for (const entry of request.entries) {
		args.push("--entry", entry);
	}
	if (request.projectFile) {
		args.push("--project-file", request.projectFile);
	}
	if (request.pretty) {
		args.push("--pretty");
	}

	const timeout = request.timeoutMs ?? 300_000;
	const lute = await resolveLute();
	const { error, stdout, stderr } = await new Promise<SpawnOutcome>((done) => {
		// node reads timeout 0 as "none", matching the request contract
		execFile(
			lute.command,
			args,
			{ timeout, maxBuffer: MAX_BUFFER },
			// the one trailing newline is print()'s own, not the model's, and
			// the capture script pins these bytes exactly
			(err, out, errOut) =>
				done({ error: err, stdout: out.replace(/\r?\n$/, ""), stderr: errOut }),
		);
	});
	if (error === null) {
		return stdout;
	}
	if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
		throw new Error(
			`extractor failed: doc model exceeded the 256 MB output limit; ${OVERRUN_HINT}`,
		);
	}
	// `killed` means node ended the child itself, which past the maxBuffer check
	// above can only be the timeout; any other signal arrived from outside
	if (error.killed && timeout > 0) {
		throw new Error(`extractor timed out after ${timeout / 1000}s; ${OVERRUN_HINT}`);
	}
	if (error.signal) {
		throw new Error(`extractor was killed by ${error.signal} (out of memory?)`);
	}
	if (typeof error.code === "number") {
		throw new Error(
			`extractor failed (exit ${error.code})\n${stderr.trim() || stdout.trim().slice(0, 2000)}`,
		);
	}
	// no exit code, signal, or timeout: the spawn itself failed, so the binary
	// resolveLute handed back could not be executed
	throw new Error(lute.hint);
}

export async function runExtractor(request: ExtractRequest): Promise<DocModel> {
	return parseDocModel(await extractorJson(request));
}

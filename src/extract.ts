/**
 * Spawns the Lute extractor and validates its JSON output. Also provides
 * `packageRoot()`, which resolves the packaged extractor entry, templates, and
 * `package.json` regardless of whether LuauDocs runs from `src/` or `dist/`.
 */
import { execFile, type ExecFileException } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocModel, type DocModel } from "./docmodel";
import { resolveLute } from "./lute";

/**
 * Walks up to the nearest `package.json` so path resolution works identically
 * from the built bundle (`dist/`) and from source (`src/`). Kept independent of
 * the extractor path because a guide-only project never runs the extractor but
 * still needs `templates/`.
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

/** Returns the absolute path to `extractor/main.luau`, run on the Lute version pinned in `src/lute.ts`. */
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
	/** Runtime-provided aliases (`[source] aliases`), mapping alias name to its docs URL. */
	aliases?: Record<string, { url?: string }>;
	/** `[api] reportUndocumented`: warn on every undocumented public member, class, and type. */
	reportUndocumented?: boolean;
	/** Emit indented JSON for checked-in fixture captures so changes diff line by line. */
	pretty?: boolean;
	/** Wall-clock timeout in milliseconds, or `0` for no timeout (used by the capture script). */
	timeoutMs?: number;
}

// Large doc models easily exceed Node's 1 MB `execFile` default buffer.
const MAX_BUFFER = 1024 * 1024 * 256;

// Phrased without naming `[source] entries` because the capture script also
// calls `extractorJson` without a `luaudocs.toml`.
const OVERRUN_HINT = "narrow the entry points, or exclude generated files from them";

interface SpawnOutcome {
	error: ExecFileException | null;
	stdout: string;
	stderr: string;
}

/**
 * Spawns the extractor and returns its raw JSON stdout. Factored out of
 * `runExtractor` so `scripts/regen-docmodels.ts` shares the exact same CLI
 * invocation contract as a build.
 */
export async function extractorJson(request: ExtractRequest): Promise<string> {
	const args = ["run", extractorEntry(), "--", "--root", request.root];
	for (const entry of request.entries) {
		args.push("--entry", entry);
	}
	if (request.projectFile) {
		args.push("--project-file", request.projectFile);
	}
	// Sort aliases so the extractor receives a deterministic argument order
	// regardless of JS object key order.
	const aliases = Object.entries(request.aliases ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
	for (const [name, { url }] of aliases) {
		args.push("--alias", url === undefined ? name : `${name}=${url}`);
	}
	if (request.reportUndocumented) {
		args.push("--report-undocumented");
	}
	if (request.pretty) {
		args.push("--pretty");
	}

	const timeout = request.timeoutMs ?? 300_000;
	const lute = await resolveLute();
	const { error, stdout, stderr } = await new Promise<SpawnOutcome>((done) => {
		// Node treats `timeout: 0` as no timeout, matching `ExtractRequest.timeoutMs`.
		execFile(
			lute.command,
			args,
			{ timeout, maxBuffer: MAX_BUFFER },
			// Strip the trailing newline added by Luau's `print()`.
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
	// Once `MAXBUFFER` is ruled out above, `error.killed` means Node terminated
	// the child on its own timeout; any other signal came from outside.
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
	// No exit code, signal, or timeout: the spawn itself failed because the
	// binary returned by `resolveLute` could not be executed.
	throw new Error(lute.hint);
}

export async function runExtractor(request: ExtractRequest): Promise<DocModel> {
	return parseDocModel(await extractorJson(request));
}

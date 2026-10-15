/**
 * Runs the pinned Lute binary with the given arguments, downloading it on first
 * use just like `luaudocs build`. Ensures extractor tests and ad-hoc `lute run`
 * commands use the exact same binary that `src/extract.ts` spawns:
 *
 *   bun run lute -- run extractor/main.luau -- --root <dir> --entry src --pretty
 */
import { spawnSync } from "node:child_process";
import { resolveLute } from "../src/lute";

const lute = await resolveLute();
const { status, error } = spawnSync(lute.command, process.argv.slice(2), { stdio: "inherit" });
if (error) {
	console.error(lute.hint);
	process.exit(2);
}
process.exit(status ?? 1);

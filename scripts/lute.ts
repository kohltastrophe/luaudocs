/**
 * Runs the pinned Lute with whatever arguments follow, installing it on first
 * use exactly as a build would. This is how the extractor specs and any ad-hoc
 * `lute run` reach the same binary `src/extract.ts` spawns, so a contributor
 * never has a second Lute to keep in sync:
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

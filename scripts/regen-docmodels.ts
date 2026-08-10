/**
 * Regenerates the checked-in doc-model fixtures: real extractor output over
 * test/fixtures/*-project/, captured so `bun run test` can drive the renderer
 * without a lute install. Edit anything under those projects and re-run this,
 * or CI's --check will fail on the stale capture.
 *
 *   bun run regen:docmodels           # rewrite the fixtures
 *   bun run regen:docmodels --check   # verify they are up to date (CI)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractorJson } from "../src/extract";

/** Each captured project, and the fixture its extractor output is pinned in. */
const captures = [
	{ project: "sample-project", capture: "docmodel-sample.json" },
	{ project: "tags-project", capture: "docmodel-tags.json" },
];

const fixtures = fileURLToPath(new URL("../test/fixtures/", import.meta.url));
const check = process.argv.includes("--check");
let stale = 0;

// the captures are independent Lute subprocesses, so they run together and both
// this script and CI's --check wait on the slower one rather than their sum
const outputs = await Promise.all(
	captures.map(async ({ project }) => {
		// pretty: emit.luau sorts keys either way, so output stays byte-stable
		// and a model change reads as a diff, not one rewritten 30 KB line
		try {
			return await extractorJson({
				root: join(fixtures, project),
				entries: ["src/init.luau"],
				pretty: true,
				// no one is waiting on a capture: a slow fixture should finish,
				// not trip the interactive timeout the build path wants
				timeoutMs: 0,
			});
		} catch (error) {
			console.error(`${project}: ${(error as Error).message}`);
			process.exit(1);
		}
	}),
);

for (const [index, { capture }] of captures.entries()) {
	const stdout = outputs[index]!;
	const path = join(fixtures, capture);
	const next = `${stdout.replaceAll("\r\n", "\n")}\n`;
	if (check) {
		const current = readFileSync(path, "utf8").replaceAll("\r\n", "\n");
		if (current !== next) {
			const a = current.split("\n");
			const b = next.split("\n");
			let at = 0;
			while (at < a.length && at < b.length && a[at] === b[at]) at += 1;
			console.error(`test/fixtures/${capture} is stale; run \`bun run regen:docmodels\``);
			console.error(`  first difference at line ${at + 1}:`);
			console.error(`    checked in: ${JSON.stringify(a[at] ?? "<end of file>")}`);
			console.error(`    extractor:  ${JSON.stringify(b[at] ?? "<end of file>")}`);
			stale += 1;
		}
	} else {
		writeFileSync(path, next);
		console.log(`wrote test/fixtures/${capture}`);
	}
}

if (stale > 0) {
	process.exit(1);
}

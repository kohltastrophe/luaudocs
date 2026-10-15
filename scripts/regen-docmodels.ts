/**
 * Regenerates the checked-in doc-model fixtures (`test/fixtures/docmodel-*.json`)
 * by running the extractor over `test/fixtures/*-project/`. These captured JSON
 * fixtures allow `bun run test` to exercise the TypeScript renderer without
 * requiring a Lute binary. Re-run this script after editing those fixture
 * projects or changing extractor output, or CI's `--check` step will fail:
 *
 *   bun run regen:docmodels           # rewrite the fixtures
 *   bun run regen:docmodels --check   # verify they are up to date (CI)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractorJson } from "../src/extract";

/** Fixture projects and their corresponding checked-in doc-model JSON files. */
const captures = [
	{ project: "sample-project", capture: "docmodel-sample.json" },
	{ project: "tags-project", capture: "docmodel-tags.json" },
];

const fixtures = fileURLToPath(new URL("../test/fixtures/", import.meta.url));
const check = process.argv.includes("--check");
let stale = 0;

// Run the independent Lute subprocesses in parallel.
const outputs = await Promise.all(
	captures.map(async ({ project }) => {
		// `pretty: true` (with `emit.luau`'s sorted keys) produces deterministic,
		// line-diffable JSON fixtures.
		try {
			return await extractorJson({
				root: join(fixtures, project),
				entries: ["src/init.luau"],
				pretty: true,
				// Disable the interactive build timeout when capturing fixtures.
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

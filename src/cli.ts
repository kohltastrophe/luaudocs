#!/usr/bin/env node
/**
 * luaudocs CLI: init / build / dev. Exit codes: 0 ok, 1 build or validation
 * failure (extraction errors, --strict warnings), 2 usage and environment
 * errors (bad flags, nothing to document, unreachable Lute or vitepress).
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import pc from "picocolors";
import pkg from "../package.json";
import { createContext, ensureVitepress, runBuild, spawnVitepress } from "./build";
import { formatDocModel } from "./docmodel";
import { runDev } from "./dev";
import { initProject } from "./init";

const HELP = `luaudocs: documentation generator for Luau

Usage:
  luaudocs init [dir] [--force] [--from-moonwave] [--title <t>] [--description <d>]
      scaffold luaudocs.toml + a user-owned docs site
  luaudocs build [dir] [--emit-only] [--strict] [--url <url>] [--model <file>]
      extract -> emit the API pages -> vitepress build (--url overrides [docs] url,
      --model also writes the doc-model JSON this build rendered)
  luaudocs dev [dir] [-- <vitepress args>]
      watch sources, regenerate pages, run vitepress dev with HMR
  luaudocs --version | --help
`;

// vitepress's own flags ride behind `--`; split off before parseArgs, which
// would otherwise bind the first token after it to the [dir] positional
const separator = process.argv.indexOf("--");
const argv = (separator === -1 ? process.argv : process.argv.slice(0, separator)).slice(2);
const passthrough = separator === -1 ? [] : process.argv.slice(separator + 1);

function usage(message: string): never {
	console.error(pc.red(`error: ${message}`));
	console.error(HELP);
	process.exit(2);
}

/** The one optional positional every command takes. */
function dirArg(positionals: string[]): string {
	if (positionals.length > 1) {
		usage(`unexpected argument: ${positionals[1]}`);
	}
	return resolve(positionals[0] ?? ".");
}

async function build(args: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			"emit-only": { type: "boolean" },
			strict: { type: "boolean" },
			url: { type: "string" },
			model: { type: "string" },
		},
	});
	const context = createContext(dirArg(positionals), { url: values.url });
	const { result, model, counts, summary } = await runBuild(context);
	if (values.model !== undefined) {
		// [source] include/exclude are already applied. Written before the error
		// gate below: the diagnostics that failed the build are in the model,
		// and a caller reading them is the point.
		const target = resolve(values.model);
		writeFileSync(target, formatDocModel(model));
		console.log(`${pc.green("wrote")} ${values.model}`);
	}
	console.log(
		`${pc.green("emitted")} ${result.pages.size} pages (${summary.written} written, ${summary.deleted} deleted, ${summary.unchanged} unchanged)`,
	);
	// a broken extraction never ships a site
	const reason =
		counts.errors > 0
			? `${counts.errors} extraction error(s)`
			: values.strict && counts.warnings > 0
				? `${counts.warnings} warning(s) with --strict`
				: undefined;
	if (reason !== undefined) {
		console.error(pc.red(`${reason}; VitePress build skipped`));
		process.exitCode = 1;
		return;
	}
	if (!values["emit-only"]) {
		await ensureVitepress(context.docsDir);
		await spawnVitepress(context.docsDir, "build").done;
	}
}

async function main(): Promise<void> {
	const command = argv[0];
	if (command === undefined || command === "--help" || command === "-h") {
		console.log(HELP);
		return;
	}
	if (command === "--version" || command === "-v") {
		console.log(pkg.version);
		return;
	}
	const rest = argv.slice(1);
	// `--help` reads as a request for help wherever it sits, not as a flag the
	// command happens not to declare
	if (rest.includes("--help") || rest.includes("-h")) {
		console.log(HELP);
		return;
	}
	// only `dev` forwards anything, so for the others a `--` tail is a flag the
	// user meant to pass: dropping it silently disables gates like --strict
	if (passthrough.length > 0 && command !== "dev") {
		usage(`${command} takes no arguments after \`--\`: ${passthrough.join(" ")}`);
	}
	switch (command) {
		case "init": {
			const { values, positionals } = parseArgs({
				args: rest,
				allowPositionals: true,
				options: {
					force: { type: "boolean" },
					"from-moonwave": { type: "boolean" },
					title: { type: "string" },
					description: { type: "string" },
				},
			});
			await initProject({
				targetDir: dirArg(positionals),
				force: values.force,
				title: values.title,
				description: values.description,
				fromMoonwave: values["from-moonwave"],
			});
			return;
		}
		case "build":
			await build(rest);
			return;
		case "dev": {
			const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
			await runDev({ startDir: dirArg(positionals), vitepressArgs: passthrough });
			return;
		}
		default:
			usage(`unknown command: ${command}`);
	}
}

main().catch((error: unknown) => {
	// bad flags and thrown build errors alike: usage/environment, exit 2
	console.error(pc.red(`error: ${error instanceof Error ? error.message : String(error)}`));
	process.exit(2);
});

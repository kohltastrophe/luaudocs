#!/usr/bin/env node
/**
 * luaudocs CLI: init / build / dev / llms.
 *
 * Exit codes:
 * - 0: success
 * - 1: build or validation failure (extraction errors, `--strict` warnings, a
 *   failed VitePress build, or a stale `llms.txt` under `--check`)
 * - 2: usage and environment errors (bad flags, an invalid config, nothing to
 *   document, an unreachable Lute or VitePress binary, or a user-owned `llms.txt`)
 */
import { writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import pc from "picocolors";
import pkg from "../package.json";
import { createContext, ensureVitepress, runBuild, spawnVitepress } from "./build";
import { formatDocModel } from "./docmodel";
import { runDev } from "./dev";
import { initProject } from "./init";
import { LOCAL_LLMS_FILE, runLocalLlms } from "./llms";

const HELP = `luaudocs: documentation generator for Luau

Usage:
  luaudocs init [dir] [--force] [--from-moonwave] [--title <t>] [--description <d>]
      scaffold luaudocs.toml and a user-owned docs site
  luaudocs build [dir] [--emit-only] [--strict] [--url <url>] [--model <file>]
      extract -> emit API pages -> vitepress build (--url overrides [docs] url;
      --model writes the doc-model JSON rendered by this build)
  luaudocs dev [dir] [-- <vitepress args>]
      watch sources, regenerate pages, and run vitepress dev with HMR
  luaudocs llms [dir] [--out <file>] [--check]
      write llms.txt at the project root for coding agents: guides and public API
      linked to local files (--out writes elsewhere; --check fails on a stale copy)
  luaudocs --version | --help
`;

// VitePress flags ride behind `--`. Split them off before `parseArgs`, which
// would otherwise bind the first token after `--` to the `[dir]` positional.
const separator = process.argv.indexOf("--");
const argv = (separator === -1 ? process.argv : process.argv.slice(0, separator)).slice(2);
const passthrough = separator === -1 ? [] : process.argv.slice(separator + 1);

function usage(message: string): never {
	console.error(pc.red(`error: ${message}`));
	console.error(HELP);
	process.exit(2);
}

/** Resolves the single optional directory positional every command accepts. */
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
		// `[source] include` and `exclude` are already applied. Write the model
		// before the error gate below so callers can inspect the diagnostics
		// that failed the build.
		const target = resolve(values.model);
		writeFileSync(target, formatDocModel(model));
		console.log(`${pc.green("wrote")} ${values.model}`);
	}
	console.log(
		`${pc.green("emitted")} ${result.pages.size} pages (${summary.written} written, ${summary.deleted} deleted, ${summary.unchanged} unchanged)`,
	);
	// Never ship a site from a broken extraction.
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
		const vitepress = spawnVitepress(context.docsDir, "build");
		try {
			await vitepress.done;
		} catch (error) {
			// VitePress ran and rejected the site (a dead link or template error).
			// Treat this as a build failure (exit 1) rather than a usage or
			// environment error; VitePress already printed the cause.
			console.error(pc.red(`error: ${(error as Error).message}`));
			process.exitCode = 1;
		}
	}
}

async function llms(args: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			out: { type: "string" },
			check: { type: "boolean" },
		},
	});
	const context = createContext(dirArg(positionals));
	const target =
		values.out === undefined ? join(context.root, LOCAL_LLMS_FILE) : resolve(values.out);
	const shown = relative(process.cwd(), target) || target;
	const outcome = await runLocalLlms(context, { target, check: values.check });
	switch (outcome.status) {
		case "failed":
			console.error(pc.red(`${outcome.errors} extraction error(s); ${shown} left as it is`));
			process.exitCode = 1;
			return;
		case "missing":
		case "stale":
			console.error(
				pc.red(
					`${shown} is ${outcome.status === "missing" ? "missing" : "out of date"}; run the same command without --check to write it`,
				),
			);
			process.exitCode = 1;
			return;
		case "written":
			console.log(`${pc.green("wrote")} ${shown}`);
			return;
		case "unchanged":
			console.log(`${values.check ? pc.green("up to date") : pc.dim("unchanged")} ${shown}`);
			return;
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
	// Honor `--help` anywhere in the argument list instead of rejecting it as an
	// undeclared subcommand flag.
	if (rest.includes("--help") || rest.includes("-h")) {
		console.log(HELP);
		return;
	}
	// Only `dev` forwards arguments after `--`. Rejecting `--` on other commands
	// prevents a misplaced `--` from silently dropping flags like `--strict`.
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
		case "llms":
			await llms(rest);
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
	// Bad flags and thrown setup/environment errors exit 2.
	console.error(pc.red(`error: ${error instanceof Error ? error.message : String(error)}`));
	process.exit(2);
});

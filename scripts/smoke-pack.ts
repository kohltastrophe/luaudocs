/**
 * Packaged tarball smoke test (`bun run test:pack`).
 *
 * E2E tests run `dist/cli.js` inside the repository checkout, where devDependencies
 * and untracked files are still reachable and could mask missing `"files"` entries
 * or unbundled runtime imports in `package.json`. This script packs the real npm
 * tarball, installs production dependencies only in an isolated temp directory,
 * and exercises `luaudocs init` and `luaudocs build --emit-only` end-to-end.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IS_WINDOWS } from "../src/config";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd: string, args: string[], cwd: string, capture = false): string {
	const useShell = cmd === "npm" && IS_WINDOWS;
	const result = spawnSync(cmd, args, {
		cwd,
		encoding: "utf8",
		stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
		shell: useShell,
	});
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		const detail = capture ? `\n${result.stderr ?? ""}${result.stdout ?? ""}`.trimEnd() : "";
		const reason = result.signal ? `killed by ${result.signal}` : `exit ${result.status}`;
		throw new Error(`${cmd} ${args.join(" ")} failed (${reason})${detail}`);
	}
	return result.stdout ?? "";
}

const temp = mkdtempSync(join(tmpdir(), "luaudocs-pack-"));
let tgzPath: string | undefined;

try {
	const packStdout = run("npm", ["pack", "--ignore-scripts"], repoRoot, true);
	const tgzName = packStdout
		.trim()
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.at(-1);
	if (!tgzName) {
		throw new Error("npm pack produced no tarball filename");
	}
	tgzPath = join(repoRoot, tgzName);

	// Stage the archive inside `temp` so `tar -xzf` receives a plain relative
	// filename without Windows drive-letter colons (which GNU tar treats as a host).
	const localArchive = join(temp, "package.tgz");
	copyFileSync(tgzPath, localArchive);
	run("tar", ["-xzf", "package.tgz"], temp);

	const pkgDir = join(temp, "package");
	const prefixArg = IS_WINDOWS ? `"${pkgDir}"` : pkgDir;
	run(
		"npm",
		[
			"install",
			"--omit=dev",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--prefix",
			prefixArg,
		],
		temp,
	);

	const projectDir = join(temp, "project");
	cpSync(join(repoRoot, "test", "fixtures", "sample-project"), projectDir, { recursive: true });

	const cliPath = join(pkgDir, "dist", "cli.js");
	run("node", [cliPath, "init", ".", "--title", "Smoke", "--force"], projectDir);
	run("node", [cliPath, "build", ".", "--emit-only"], projectDir);

	const apiDir = join(projectDir, ".luaudocs", "api");
	const apiPages = existsSync(apiDir)
		? readdirSync(apiDir).filter((name) => name.endsWith(".md"))
		: [];
	if (apiPages.length === 0) {
		throw new Error(`expected at least one .md page in ${apiDir}`);
	}

	const workflowPath = join(projectDir, ".github", "workflows", "docs.yml");
	if (!existsSync(workflowPath)) {
		throw new Error(`expected scaffolded workflow at ${workflowPath}`);
	}

	console.log(`smoke-pack passed (${apiPages.length} API pages emitted)`);
} finally {
	if (tgzPath !== undefined) {
		rmSync(tgzPath, { force: true });
	}
	rmSync(temp, { recursive: true, force: true });
}

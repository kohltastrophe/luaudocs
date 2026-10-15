/**
 * End-to-end: init + build on a copy of the sample-project fixture, through the
 * BUILT CLI (node dist/cli.js). Run with: bun run test:e2e (build dist first).
 */
import { execFile } from "node:child_process";
import {
	appendFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { filesUnder, fixturePath, makeTempDirFactory } from "../helpers";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliPath = join(repoRoot, "dist", "cli.js");
const fixture = fixturePath("sample-project");

const tempDir = makeTempDirFactory("luaudocs-e2e-");

/** A pristine copy of the fixture, removed when the file finishes. */
function freshProject(): string {
	if (!existsSync(cliPath)) {
		throw new Error("dist/cli.js missing; run `bun run build` before the e2e suite");
	}
	const dir = tempDir();
	cpSync(fixture, dir, { recursive: true });
	return dir;
}

interface CliResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** The built CLI, never rejecting: exit codes are what the tests assert on. */
function cli(args: string[], cwd: string): Promise<CliResult> {
	return new Promise((done) => {
		execFile(
			"node",
			[cliPath, ...args],
			{ cwd, env: { ...process.env, NO_COLOR: "1" }, maxBuffer: 64 * 1024 * 1024 },
			(error, stdout, stderr) => {
				// an error with no numeric code is a signal death or a spawn
				// failure, which must read as a failure, never as exit 0
				const code = error ? (error as { code?: unknown }).code : 0;
				done({ exitCode: typeof code === "number" ? code : error ? 1 : 0, stdout, stderr });
			},
		);
	});
}

/**
 * A built page's own content, between the doc container and the prev/next
 * footer: the sidebar and the pager link every page from every page, so a
 * page-wide search for a link or a name proves nothing about the page.
 */
function docContent(html: string): string {
	const start = html.indexOf('class="vp-doc');
	expect(start, "no vp-doc container in the page").toBeGreaterThan(-1);
	const end = html.indexOf('class="VPDocFooter', start);
	return html.slice(start, end === -1 ? undefined : end);
}

/** Every built page, for the sweeps that must hold anywhere in the site. */
function distHtml(dist: string): Array<[string, string]> {
	return filesUnder(dist)
		.filter((abs) => abs.endsWith(".html"))
		.map((abs) => [abs.slice(dist.length + 1), readFileSync(abs, "utf8")]);
}

describe("luaudocs e2e on the sample project", () => {
	let projectDir: string;

	beforeAll(() => {
		projectDir = freshProject();
	});

	it("init runs from the built CLI", async () => {
		const result = await cli(
			["init", ".", "--title", "Sample", "--description", "Reactive state"],
			projectDir,
		);
		expect(result.exitCode, result.stderr).toBe(0);
		// only the built bundle takes this branch of packageRoot (dist/ ->
		// <pkg>), so nothing but e2e proves the packaged templates resolve
		expect(
			readFileSync(
				join(projectDir, ".luaudocs", ".vitepress", "generated", "signature-links.ts"),
				"utf8",
			),
		).toContain("luaudocs-links=");
		// the fixture is not a git repo, so [repo] stays off; source links and
		// the edit link below are exactly what this stanza turns on
		appendFileSync(
			join(projectDir, "luaudocs.toml"),
			'\n[repo]\nurl = "https://github.com/example/sample"\n',
		);
	});

	it("build produces the static site", async () => {
		// --emit-only never needs VitePress, so it must not install anything
		const emitted = await cli(["build", ".", "--emit-only"], projectDir);
		expect(emitted.exitCode, emitted.stderr).toBe(0);
		expect(existsSync(join(projectDir, ".luaudocs", "node_modules"))).toBe(false);

		// --model is the doc model as a consumable artifact: written where it was
		// asked for, parsing as the schema this build declares, and carrying the
		// same surface the pages were rendered from
		const modelPath = join(projectDir, "model.json");
		const withModel = await cli(
			["build", ".", "--emit-only", "--model", "model.json"],
			projectDir,
		);
		expect(withModel.exitCode, withModel.stderr).toBe(0);
		expect(withModel.stdout).toContain("wrote model.json");
		const model = JSON.parse(readFileSync(modelPath, "utf8")) as {
			schemaVersion: number;
			modules: { name: string }[];
			diagnostics: unknown[];
		};
		expect(model.schemaVersion).toBe(1);
		expect(model.modules.map((m) => m.name)).toContain("State");
		expect(Array.isArray(model.diagnostics)).toBe(true);

		// the full build installs the generated site's dependencies itself
		const result = await cli(["build", "."], projectDir);
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain("installing the docs site dependencies");

		const dist = join(projectDir, ".luaudocs", ".vitepress", "dist");
		for (const pageName of ["Sample", "State", "Color", "Interpolate", "Query", "Type"]) {
			expect(existsSync(join(dist, "api", `${pageName}.html`)), `${pageName}.html`).toBe(
				true,
			);
		}

		// the `State` prop and `state()` function slugify the same: the prop
		// renders first and takes `state`, the function `state-1`. Pinned
		// end-to-end because a wrong guess is silent (VitePress strips the
		// fragment before its dead-link check).
		const sampleHtml = readFileSync(join(dist, "api", "Sample.html"), "utf8");
		expect(sampleHtml).toContain('id="state"');
		expect(sampleHtml).toContain('id="state-1"');
		expect(docContent(sampleHtml)).toContain('href="/api/State');

		const stateHtml = readFileSync(join(dist, "api", "State.html"), "utf8");
		expect(docContent(stateHtml)).toContain("Connect");
		// scoped to the fence block on purpose: the same url is linked from the
		// return-type list below it, so a page-wide search would pass even with
		// every signature link dropped
		const block = stateHtml.slice(stateHtml.indexOf('class="language-luau'));
		expect(block).toMatch(/<a\b[^>]*href="\/api\/Type#function"[^>]*class="sig-link"/);
		expect(block).toContain("--shiki-light");
		// the member headings carry their source links as empty anchors
		expect(stateHtml).toMatch(
			/<a class="source-link ignore-header" href="https:\/\/github\.com\/example\/sample\/blob\/main\/src\/State\.luau#L\d+/,
		);
		// [repo] on GitHub also turns on the edit link, on user-owned pages
		// only: the generated API pages pin `editLink: false` in frontmatter
		const guideHtml = readFileSync(join(dist, "guide", "getting-started.html"), "utf8");
		expect(guideHtml).toContain("Edit this page on GitHub");
		expect(guideHtml).toContain(
			"https://github.com/example/sample/edit/main/.luaudocs/guide/getting-started.md",
		);
		expect(stateHtml).not.toContain("Edit this page on GitHub");
		// the generated sidebar shipped as data and rendered
		expect(stateHtml).toContain("VPSidebarItem");
		expect(stateHtml).toContain('href="/api/State"');

		// the baked trail map reached the render-time rule: both kinds of page
		// head with links, and the markdown inside the wrapper really parsed
		expect(stateHtml).toContain(
			'<div class="luaudocs-trail"><p><a href="/">Home</a> › ' +
				'<a href="/api/">Overview</a> › <a href="/api/Sample">Sample</a></p></div>',
		);
		expect(guideHtml).toContain(
			'<div class="luaudocs-trail"><p><a href="/">Home</a></p></div>',
		);
		// above the first heading, which is what keeps it out of the search index
		expect(stateHtml.indexOf("luaudocs-trail")).toBeLessThan(stateHtml.indexOf("<h1"));

		// the fence link tables are markup for the build, never for a reader:
		// no page anywhere may leak the raw token
		for (const [file, html] of distHtml(dist)) {
			expect(html, file).not.toContain("luaudocs-links");
		}

		// llms.txt landed in public/ and ships with the site
		const llms = readFileSync(join(dist, "llms.txt"), "utf8");
		expect(llms.startsWith("# Sample\n")).toBe(true);
		expect(llms).toContain("## API Reference");

		// the scaffolded home page renders with the values init was given
		const indexHtml = readFileSync(join(dist, "index.html"), "utf8");
		expect(indexHtml).toContain("Reactive state");
		expect(indexHtml).toContain("Get Started");
		// no [[site.nav]] configured, so the derived Guide/API navbar rendered
		// (VPNavBarMenuLink appears only when the navbar has entries)
		expect(indexHtml).toContain("VPNavBarMenuLink");
		expect(indexHtml).toContain(">Guide<");
		expect(indexHtml).toContain(">API<");
	}, 300_000);

	// the pages emitted fine and VitePress then failed the site: a build
	// failure (1), not the usage or environment error (2) it used to exit with
	it("exits 1 when VitePress fails the site", async () => {
		const guide = join(projectDir, ".luaudocs", "guide", "broken.md");
		writeFileSync(guide, "# Broken\n\n[nowhere](./does-not-exist)\n");
		try {
			const result = await cli(["build", "."], projectDir);
			expect(result.exitCode, result.stderr).toBe(1);
			expect(result.stderr).toContain("vitepress build failed");
		} finally {
			rmSync(guide);
		}
	}, 300_000);
});

// its own copy: no init, no luaudocs.toml; the synthesized defaults carry it
describe("config-less build", () => {
	it("emits a full site from nothing but the sources", async () => {
		const projectDir = freshProject();
		const result = await cli(["build", ".", "--emit-only"], projectDir);
		expect(result.exitCode, result.stderr).toBe(0);

		const docsDir = join(projectDir, ".luaudocs");
		expect(existsSync(join(docsDir, "api", "State.md"))).toBe(true);
		// the title fell back to the folder name
		expect(readFileSync(join(docsDir, ".vitepress", "config.mts"), "utf8")).toContain(
			`title: ${JSON.stringify(basename(projectDir))}`,
		);
		// the landing page is generated (no README in the fixture, so the hero)
		const index = readFileSync(join(docsDir, "index.md"), "utf8");
		expect(index).toContain("# Generated by luaudocs");
		expect(index).toContain("layout: home");
		// and the docs dir keeps all of itself out of git
		const ignore = readFileSync(join(docsDir, ".gitignore"), "utf8");
		expect(ignore).toContain("index.md");
		expect(ignore).toContain(".gitignore");
	}, 120_000);
});

// its own copy: these mutate the project and must not reach the suite above
describe("emit owns the generated api directory", () => {
	let projectDir: string;

	beforeAll(async () => {
		projectDir = freshProject();
		const init = await cli(["init", ".", "--title", "Sample"], projectDir);
		expect(init.exitCode, init.stderr).toBe(0);
		const emit = await cli(["build", ".", "--emit-only"], projectDir);
		expect(emit.exitCode, emit.stderr).toBe(0);
	}, 120_000);

	it("deletes stale pages when a module disappears", async () => {
		// the page must exist before the mutation, or the absence assertion
		// below would pass vacuously if emit never produced it at all
		expect(existsSync(join(projectDir, ".luaudocs", "api", "Color.md"))).toBe(true);
		rmSync(join(projectDir, "src", "Color.luau"));
		// drop the re-export so the module is unreachable
		const initPath = join(projectDir, "src", "init.luau");
		const init = readFileSync(initPath, "utf8")
			.replace("local Color = require(script.Color)\n", "")
			.replace("\tColor = Color,\n", "");
		// a fixture reformat would make both replacements silent no-ops
		expect(init).not.toContain("script.Color");
		expect(init).not.toContain("Color = Color");
		writeFileSync(initPath, init);

		const result = await cli(["build", ".", "--emit-only"], projectDir);
		expect(result.exitCode, result.stderr).toBe(0);
		expect(existsSync(join(projectDir, ".luaudocs", "api", "Color.md"))).toBe(false);
		expect(existsSync(join(projectDir, ".luaudocs", "api", "State.md"))).toBe(true);
	}, 120_000);

	// api/ is wholly tool-owned: anything a build did not emit is swept, while
	// the user's content outside it is never touched
	it("sweeps hand-planted files out of api/, never guide content", async () => {
		const handWritten = join(projectDir, ".luaudocs", "api", "hand-written.md");
		writeFileSync(handWritten, "# Mine\n");
		const guidePage = join(projectDir, ".luaudocs", "guide", "mine.md");
		mkdirSync(join(projectDir, ".luaudocs", "guide"), { recursive: true });
		writeFileSync(guidePage, "# Hands off\n");
		const starter = join(projectDir, ".luaudocs", "guide", "getting-started.md");
		const starterBefore = readFileSync(starter, "utf8");

		const result = await cli(["build", ".", "--emit-only"], projectDir);
		expect(result.exitCode, result.stderr).toBe(0);
		expect(existsSync(handWritten)).toBe(false);
		expect(readFileSync(guidePage, "utf8")).toBe("# Hands off\n");
		expect(readFileSync(starter, "utf8")).toBe(starterBefore);
	}, 120_000);

	// last: it breaks the sources for good
	it("keeps previously generated pages when extraction reports errors", async () => {
		expect(existsSync(join(projectDir, ".luaudocs", "api", "State.md"))).toBe(true);
		const llmsPath = join(projectDir, ".luaudocs", "public", "llms.txt");
		const generated = join(projectDir, ".luaudocs", ".vitepress", "generated");
		const apiNavPath = join(generated, "api-nav.ts");
		const llmsBefore = readFileSync(llmsPath, "utf8");
		const apiNavBefore = readFileSync(apiNavPath, "utf8");
		expect(apiNavBefore).toContain('"/api/State"');
		appendFileSync(join(projectDir, "src", "State.luau"), "\nlocal = (\n");
		// a guide written while the error persists is not the model's to
		// withhold: it reaches the navigation anyway
		writeFileSync(join(projectDir, ".luaudocs", "guide", "later.md"), "# Later\n");

		const result = await cli(["build", ".", "--emit-only"], projectDir);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/error\[parse-error\]/);
		expect(result.stderr).toMatch(/keeping previously generated pages/);
		// the broken module's page survives the error build, so a transient
		// typo cannot unpublish it
		expect(existsSync(join(projectDir, ".luaudocs", "api", "State.md"))).toBe(true);
		// the other half of the invariant: the kept pages stay LISTED, so the
		// API navigation and llms index are not rewritten to the broken model
		expect(readFileSync(llmsPath, "utf8")).toBe(llmsBefore);
		expect(readFileSync(apiNavPath, "utf8")).toBe(apiNavBefore);
		expect(readFileSync(join(generated, "sidebar.ts"), "utf8")).toContain('"/guide/later"');
		expect(readFileSync(join(generated, "trails.ts"), "utf8")).toContain('"guide/later.md"');
	}, 120_000);
});

// its own copy, config-less: `llms` writes into the project root and edits a
// source, and it has to work where nothing was ever initialized or built
describe("llms", () => {
	it("writes the checkout index, holds it to the sources, and never takes a user's file", async () => {
		const projectDir = freshProject();
		const target = join(projectDir, "llms.txt");

		const missing = await cli(["llms", "--check"], projectDir);
		expect(missing.exitCode).toBe(1);
		expect(missing.stderr).toContain("llms.txt is missing");
		expect(existsSync(target)).toBe(false);

		const written = await cli(["llms"], projectDir);
		expect(written.exitCode, written.stderr).toBe(0);
		expect(written.stdout).toContain("wrote llms.txt");
		const index = readFileSync(target, "utf8");
		expect(index.startsWith("<!-- Generated by luaudocs")).toBe(true);
		expect(index).toContain(`\n# ${basename(projectDir)}\n`);
		expect(index).toContain("\n## Sample.State\n");
		expect(index).toMatch(
			/- \[`State:Connect\(callback: Type\.Function\): Type\.Function`\]\(src\/State\.luau#L\d+-L\d+\): Adds a hook/,
		);
		// the extraction was all it needed: no docs dir came into being
		expect(existsSync(join(projectDir, ".luaudocs"))).toBe(false);

		const current = await cli(["llms", ".", "--check"], projectDir);
		expect(current.exitCode, current.stderr).toBe(0);
		expect(current.stdout).toContain("up to date llms.txt");

		// a doc comment edit is a change the index has to follow
		const statePath = join(projectDir, "src", "State.luau");
		const source = readFileSync(statePath, "utf8");
		const edited = source.replace(
			"--- Adds a hook to run whenever the value changes",
			"--- Registers a hook to run whenever the value changes",
		);
		expect(edited).not.toBe(source);
		writeFileSync(statePath, edited);
		const stale = await cli(["llms", "--check"], projectDir);
		expect(stale.exitCode).toBe(1);
		expect(stale.stderr).toContain("llms.txt is out of date");
		expect(readFileSync(target, "utf8")).toBe(index);
		const refreshed = await cli(["llms"], projectDir);
		expect(refreshed.exitCode, refreshed.stderr).toBe(0);
		expect(readFileSync(target, "utf8")).toContain("): Registers a hook");

		// a file the user wrote is theirs: refused, untouched, and --out is the way around
		writeFileSync(target, "# Mine\n");
		const refused = await cli(["llms"], projectDir);
		expect(refused.exitCode).toBe(2);
		expect(refused.stderr).toContain("was not written by luaudocs");
		expect(readFileSync(target, "utf8")).toBe("# Mine\n");
		const elsewhere = await cli(["llms", "--out", "agents/api.txt"], projectDir);
		expect(elsewhere.exitCode, elsewhere.stderr).toBe(0);
		expect(readFileSync(join(projectDir, "agents", "api.txt"), "utf8")).toContain(
			"](../src/State.luau#L",
		);
	}, 120_000);
});

// exit codes are the CI contract (src/cli.ts): 1 is a failed validation,
// 2 usage or environment; nothing else asserts them off the built CLI
describe("exit codes", () => {
	it("gates warnings behind --strict, and rejects unknown commands with 2", async () => {
		const projectDir = freshProject();
		const init = await cli(["init", ".", "--title", "Sample"], projectDir);
		expect(init.exitCode, init.stderr).toBe(0);
		// the fixture has no README.md, so this setting warns on every build
		// (the append lands inside [docs], the config's last table)
		appendFileSync(join(projectDir, "luaudocs.toml"), "includeReadme = true\n");

		const plain = await cli(["build", ".", "--emit-only"], projectDir);
		expect(plain.exitCode, plain.stderr).toBe(0);
		expect(plain.stderr).toContain("includeReadme is enabled but README.md was not found");

		const strict = await cli(["build", ".", "--emit-only", "--strict"], projectDir);
		expect(strict.exitCode).toBe(1);
		expect(strict.stderr).toContain("--strict");

		const unknown = await cli(["frobnicate"], projectDir);
		expect(unknown.exitCode).toBe(2);
	}, 120_000);
});

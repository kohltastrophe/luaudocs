/**
 * This repository's own site (`.luaudocs/`) against the files it quotes.
 *
 * A guide that prints a file the tool writes is holding a copy, and a copy
 * drifts silently: nothing else compares the two, and the page reads fine
 * either way. Everything here re-derives the original and asserts the page
 * still shows it, so a template edit fails until the guide follows.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import pkg from "../package.json";
import { packageRoot } from "../src/extract";
import { LOCAL_LLMS_FILE } from "../src/llms";
import { isGeneratedFile } from "../src/pages";

const root = packageRoot();
const deployingPage = join(root, ".luaudocs", "guide", "deploying.md");
const agentsPage = join(root, ".luaudocs", "guide", "coding-agents.md");
const rootLlms = join(root, LOCAL_LLMS_FILE);

/** What `init` substitutes into `templates/project/**` for a project shaped
 * like this one: this repository's docs dir, branch, and Node major version
 * (see the Pages-workflow tests in `scaffold.test.ts`). */
const SUBSTITUTIONS: Record<string, string> = {
	"@DOCS_DIR@": ".luaudocs",
	"@BRANCH@": "main",
	"@NODE_MAJOR@": /\d+/.exec(pkg.engines.node)![0],
};

/**
 * A YAML block reduced to what the two copies must agree on. Comment-only
 * lines go, because the page trims the template's header rather than reprint
 * advice its own prose gives, and so do VitePress's `[!code]` markers, which
 * are page decoration rather than YAML.
 */
function comparable(yaml: string): string {
	return yaml
		.split("\n")
		.map((line) => line.replace(/\s*#\s*\[!code[^\]]*\]\s*$/, ""))
		.filter((line) => !/^\s*#/.test(line))
		.join("\n")
		.trim();
}

describe("the site quotes its sources verbatim", () => {
	// the failure this exists for: an action bumped or a step added in the
	// template alone
	it("shows the Pages workflow `init` actually writes", () => {
		let template = readFileSync(
			join(root, "templates", "project", ".github", "workflows", "docs.yml"),
			"utf8",
		);
		for (const [token, value] of Object.entries(SUBSTITUTIONS)) {
			template = template.replaceAll(token, value);
		}

		const page = readFileSync(deployingPage, "utf8");
		const fence = /```yaml \[\.github\/workflows\/docs\.yml\]\n([\s\S]*?)```/.exec(page);
		expect(fence, "deploying.md no longer carries a docs.yml fence to check").not.toBeNull();

		expect(comparable(fence![1]!)).toBe(comparable(template));
	});

	// every `npx luaudocs` command across the guides and the root llms.txt must
	// pass `@latest` so npx does not run a cached older release
	it.each([
		["deploying.md, in the workflow and on Cloudflare", deployingPage, 2],
		["coding-agents.md, in the agent notes and the CI step", agentsPage, 4],
		["the root llms.txt, in its regeneration command", rootLlms, 1],
	])("uses @latest in %s", (_where, file, least) => {
		const text = readFileSync(file, "utf8");
		const tags = [...text.matchAll(/npx luaudocs(?:@([^\s`]+))?(?=[\s`])/g)].map(
			(match) => match[1],
		);
		expect(tags.length).toBeGreaterThanOrEqual(least);
		expect(tags).toEqual(tags.map(() => "latest"));
	});

	// the guide shows the file the command wrote for this repository; a pasted
	// copy would be exactly the drift this suite exists to catch
	it("shows the llms.txt `luaudocs llms` actually writes", () => {
		const page = readFileSync(agentsPage, "utf8");
		expect(page).toMatch(/^<<< \.\.\/\.\.\/llms\.txt\{md\}$/m);
		const llms = readFileSync(rootLlms, "utf8");
		expect(isGeneratedFile(llms), "the root llms.txt lost its generated marker").toBe(true);
		expect(llms).toContain("\n## Flux.Util.Queue\n");
	});

	it("keeps package.json and CHANGELOG.md in valid semver release order", () => {
		const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
		const headings = [...changelog.matchAll(/^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})$/gm)].map(
			(m) => m[1]!,
		);
		expect(headings[0]).toBe(pkg.version);
		expect(changelog).toContain(
			`[${pkg.version}]: https://github.com/kohltastrophe/luaudocs/releases/tag/v${pkg.version}`,
		);
	});
});

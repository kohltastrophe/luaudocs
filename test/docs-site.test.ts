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
 * like this one: this repository's docs dir and branch, and the two pins the
 * scaffold bakes (see the Pages-workflow tests in `scaffold.test.ts`). */
const SUBSTITUTIONS: Record<string, string> = {
	"@DOCS_DIR@": ".luaudocs",
	"@BRANCH@": "main",
	"@NODE_MAJOR@": /\d+/.exec(pkg.engines.node)![0],
	"@VERSION@": pkg.version,
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
	// the failure this exists for: an action bumped, a step added, or the
	// version pin moved by a release, in the template alone
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

	// the Cloudflare build command pins the version too, but in a table rather
	// than a copy of any file, so the check above never sees it go stale; so do
	// the agent notes, and the root llms.txt itself, which a release has to
	// regenerate (CI's `llms --check` holds the rest of that file)
	it.each([
		["deploying.md, in the workflow and on Cloudflare", deployingPage, 2],
		["coding-agents.md, in the agent notes and the CI step", agentsPage, 3],
		["the root llms.txt, in its regeneration command", rootLlms, 1],
	])("pins the current version in %s", (_where, file, least) => {
		const text = readFileSync(file, "utf8");
		const pins = [...text.matchAll(/npx luaudocs@([^\s`]+)/g)].map((match) => match[1]);
		expect(pins.length).toBeGreaterThanOrEqual(least);
		expect(pins).toEqual(pins.map(() => pkg.version));
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
});

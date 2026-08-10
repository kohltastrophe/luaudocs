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

const root = packageRoot();

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

		const page = readFileSync(join(root, ".luaudocs", "guide", "deploying.md"), "utf8");
		const fence = /```yaml \[\.github\/workflows\/docs\.yml\]\n([\s\S]*?)```/.exec(page);
		expect(fence, "deploying.md no longer carries a docs.yml fence to check").not.toBeNull();

		expect(comparable(fence![1]!)).toBe(comparable(template));
	});
});

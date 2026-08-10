/**
 * llms.txt / llms-full.txt, driven over real projects on disk through the same
 * calls `runBuild` makes (site sync, then llms sync), minus the extractor.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createContext } from "../src/build";
import { syncLlms } from "../src/llms";
import { emitDocsFromJson, type EmitResult } from "../src/render";
import { collectGuides, syncSite } from "../src/site";
import { makeProjectFactory, modelJson, readFixture, testConfig } from "./helpers";

const TOML = [
	'title = "Demo"',
	"",
	"[source]",
	"entries = []",
	"",
	"[docs]",
	'dir = "docs"',
	// trailing slash: the emitted links must not double it
	'url = "https://demo.example/"',
].join("\n");

const HERO = [
	"---",
	"layout: home",
	"hero:",
	'  name: "Demo"',
	'  tagline: "A demo site, for the tests."',
	"features:",
	"  - title: Fast",
	"---",
	"",
].join("\n");

const GETTING_STARTED = [
	"---",
	"title: Getting Started",
	"description: Install it, point it at a module, ship the site.",
	"sidebar_position: 1",
	"---",
	"",
	"# Getting Started",
	"",
	"Body prose, which the frontmatter description outranks.",
	"",
].join("\n");

// no description and no H1: the summary is derived, the title is not
const ADVANCED = [
	"---",
	"title: Advanced",
	"sidebar_position: 2",
	"---",
	"",
	"## Setup",
	"",
	"```luau",
	"local x = 1",
	"```",
	"",
	"Tune the extractor when the defaults miss. A second sentence.",
	"",
].join("\n");

const NESTED = [
	"---",
	"title: Errors",
	"sidebar_position: 3",
	"---",
	"",
	"# Errors",
	"",
	"What the extractor reports, and why.",
	"",
].join("\n");

/** A project on disk; luaudocs.toml is implicit but overridable. */
const project = makeProjectFactory("luaudocs-llms-", TOML);

/** The sync the build runs after emitting: site (changelog page) then llms. */
function sync(dir: string, result?: EmitResult): void {
	const context = createContext(dir);
	const emitted = result ?? emitDocsFromJson(modelJson([]), context.config);
	const guides = collectGuides(context.docsDir);
	syncSite(context, { guides, apiSidebar: emitted.sidebar });
	syncLlms(context, guides, emitted);
}

function published(dir: string): { index: string; full: string } {
	const publicDir = join(dir, "docs", "public");
	return {
		index: readFileSync(join(publicDir, "llms.txt"), "utf8"),
		full: readFileSync(join(publicDir, "llms-full.txt"), "utf8"),
	};
}

/** The guide-only path: no extractor, no /api/. */
function buildGuideSite(files: Record<string, string>): { index: string; full: string } {
	const dir = project(files);
	sync(dir);
	return published(dir);
}

const entries = (index: string): string[] =>
	index.split("\n").filter((line) => line.startsWith("- ["));

describe("llms.txt", () => {
	it("lists guides in sidebar order, flattening nested groups", () => {
		const { index } = buildGuideSite({
			"docs/index.md": HERO,
			"docs/guide/getting-started.md": GETTING_STARTED,
			"docs/guide/advanced.md": ADVANCED,
			"docs/guide/reference/errors.md": NESTED,
		});

		expect(index.startsWith("# Demo\n")).toBe(true);
		expect(index).toContain("## Guides");
		expect(entries(index)).toEqual([
			"- [Getting Started](https://demo.example/guide/getting-started): Install it, point it at a module, ship the site.",
			"- [Advanced](https://demo.example/guide/advanced): Tune the extractor when the defaults miss.",
			"- [Errors](https://demo.example/guide/reference/errors): What the extractor reports, and why.",
		]);
		// a guide-only site has no API half to announce
		expect(index).not.toContain("## API Reference");
	});

	it("summarizes with the hero tagline, and never lists the hero itself", () => {
		const { index, full } = buildGuideSite({
			"docs/index.md": HERO,
			"docs/guide/getting-started.md": GETTING_STARTED,
		});

		expect(index).toContain("> A demo site, for the tests.");
		expect(index).not.toContain("](https://demo.example/)");
		expect(full).not.toContain("layout: home");
		expect(full).not.toContain("A demo site, for the tests.");
	});

	it("prefers the configured description over the tagline", () => {
		const { index } = buildGuideSite({
			"luaudocs.toml": `description = "Configured, and authoritative."\n${TOML}`,
			"docs/index.md": HERO,
			"docs/guide/getting-started.md": GETTING_STARTED,
		});

		expect(index).toContain("> Configured, and authoritative.");
		expect(index).not.toContain("> A demo site, for the tests.");
	});

	it("lists an ordinary index.md at the site root", () => {
		const { index, full } = buildGuideSite({
			"docs/index.md": "# Demo\n\nThe landing page, written as prose.\n",
			"docs/guide/getting-started.md": GETTING_STARTED,
		});

		expect(entries(index)[0]).toBe(
			"- [Demo](https://demo.example/): The landing page, written as prose.",
		);
		expect(full).toContain("The landing page, written as prose.");
	});

	it("titles the generated README landing page from the README, not its marker", () => {
		// no docs/index.md: syncSite writes the generated landing page (the
		// README behind the marker frontmatter, whose `#` comment lines must
		// not read as headings), and llms indexes it as just synced
		const { index, full } = buildGuideSite({
			"README.md": "# Demo\n\nThe README, standing in as the landing page.\n",
			"docs/guide/getting-started.md": GETTING_STARTED,
		});

		expect(entries(index)[0]).toBe(
			"- [Demo](https://demo.example/): The README, standing in as the landing page.",
		);
		expect(index).not.toContain("Generated by luaudocs");
		expect(full).toContain("The README, standing in as the landing page.");
	});

	it("titles a page that has no heading of its own", () => {
		const { full } = buildGuideSite({
			"docs/guide/advanced.md": ADVANCED,
		});

		expect(full.startsWith("# Advanced\n")).toBe(true);
		expect(full).toContain("## Setup");
	});

	it("puts the changelog under Optional, out of the full text", () => {
		const { index, full } = buildGuideSite({
			"CHANGELOG.md":
				"# Changelog\n\nAll notable changes to Demo.\n\n## 1.0.0\n\n- first release\n",
			"docs/guide/getting-started.md": GETTING_STARTED,
		});

		expect(index).toContain("## Optional");
		expect(index).toContain(
			"- [Changelog](https://demo.example/changelog): All notable changes to Demo.",
		);
		expect(full).not.toContain("first release");
	});

	it("strips generated chrome but leaves fenced examples alone", () => {
		const { full } = buildGuideSite({
			"docs/guide/components.md": [
				"---",
				"title: Components",
				"---",
				"",
				'# Components <a class="source-link ignore-header" href="https://example.test/blob/main/init.luau#L1" target="_blank" rel="noopener noreferrer" aria-label="View source"></a>',
				"",
				"Before.",
				'<a class="source-link ignore-header" href="https://example.test/blob/main/init.luau#L9"></a>',
				"After.",
				"",
				"<!-- #region components -->",
				"Inside the region.",
				"<!-- #endregion components -->",
				"",
				"Call `state(0)`{luau} to begin.",
				"",
				'<Badge type="info" text="Server" />',
				"",
				"```luau",
				'-- `x`{luau} and <a class="source-link"></a> are the documented syntax',
				"```",
				"",
			].join("\n"),
		});

		expect(full).toContain("# Components\n");
		expect(full).not.toContain("source-link ignore-header");
		// HTML comments are invisible in rendered output, so they all come off
		expect(full).toContain("Inside the region.");
		expect(full).not.toContain("#region");
		// a tag alone on its line takes the whole line, leaving no blank gap
		expect(full).toContain("Before.\nAfter.");
		expect(full).toContain("Call `state(0)` to begin.");
		// the fence is the only surviving annotation and anchor, verbatim
		expect(full).toContain(
			'-- `x`{luau} and <a class="source-link"></a> are the documented syntax',
		);
		// badge text is API semantics, not chrome
		expect(full).toContain('<Badge type="info" text="Server" />');
	});

	it("puts guides ahead of the API pages when both exist", () => {
		const dir = project({
			"docs/index.md": HERO,
			"docs/guide/getting-started.md": GETTING_STARTED,
		});
		const result = emitDocsFromJson(
			readFixture("docmodel-sample.json"),
			testConfig({ repo: { url: "https://github.com/example/Sample" } }),
		);
		sync(dir, result);
		const { index, full } = published(dir);

		expect(index.indexOf("## Guides")).toBeLessThan(index.indexOf("## API Reference"));
		expect(index).toContain("](https://demo.example/api/State)");
		expect(entries(index)[0]).toContain("/guide/getting-started");
		expect(full).toContain("# Getting Started");
		expect(full.indexOf("# Getting Started")).toBeLessThan(full.indexOf("# State"));
		// the API pages arrive as plain markdown: fences stay, their link
		// tables, the heading source links, and every HTML comment (the
		// generated-by note, the region markers) come off
		expect(full).toContain("```luau");
		expect(full).not.toContain("luaudocs-links=");
		expect(full).not.toContain('<a class="source-link');
		expect(full).not.toContain("<!--");
	});

	it("leaves existing files alone when [docs] llms is false", () => {
		const dir = project({
			"luaudocs.toml": `${TOML}\nllms = false`,
			"docs/guide/getting-started.md": GETTING_STARTED,
			// a pair left by an earlier build with llms on: opting out hands
			// them back to the user rather than deleting them
			"docs/public/llms.txt": "mine now\n",
			"docs/public/llms-full.txt": "mine too\n",
		});
		sync(dir);

		const publicDir = join(dir, "docs", "public");
		expect(readFileSync(join(publicDir, "llms.txt"), "utf8")).toBe("mine now\n");
		expect(readFileSync(join(publicDir, "llms-full.txt"), "utf8")).toBe("mine too\n");
	});

	it("removes both files when there is nothing to say", () => {
		// a site that lost its guides and sources must not keep serving the
		// previous index of pages that no longer exist
		const dir = project({
			"docs/public/llms.txt": "# stale\n",
			"docs/public/llms-full.txt": "stale body\n",
		});
		sync(dir);

		const publicDir = join(dir, "docs", "public");
		expect(existsSync(join(publicDir, "llms.txt"))).toBe(false);
		expect(existsSync(join(publicDir, "llms-full.txt"))).toBe(false);
	});
});

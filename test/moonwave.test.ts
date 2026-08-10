/**
 * The pure one-file conversions: `convertMdxPage` (each rewrite as its own
 * narrow rule, plus the fence masking that keeps examples of the syntax
 * verbatim) and `convertInfimaCss`. The whole-project flow (folders, report,
 * scaffold interplay) lives in scaffold.test.ts.
 */
import { describe, expect, it } from "vitest";
import { convertInfimaCss, convertMdxPage } from "../src/moonwave";

describe("convertMdxPage", () => {
	it("drops ESM blocks through the blank line that ends them", () => {
		const { content } = convertMdxPage(
			[
				'import Tabs from "@theme/Tabs";',
				'import TabItem from "@theme/TabItem";',
				"",
				"export const answer = {",
				"\tvalue: 42,",
				"};",
				"",
				"Prose stays.",
				"",
			].join("\n"),
		);
		expect(content).not.toContain("import");
		expect(content).not.toContain("export");
		expect(content).toContain("Prose stays.");
	});

	// MDX reads only a block's FIRST line as possible ESM: mid-paragraph lines
	// were prose under moonwave and must stay prose here
	it("keeps a paragraph whose later line starts with the word import", () => {
		const text = "The tool can\nimport settings from disk.\n";
		expect(convertMdxPage(text).content).toBe(text);
	});

	it("leaves a fenced example that shows an import verbatim", () => {
		const text = ["```js", 'import Tabs from "@theme/Tabs";', "```", ""].join("\n");
		expect(convertMdxPage(text).content).toBe(text);
	});

	it("rewrites MDX comments to HTML comments", () => {
		expect(convertMdxPage("a {/* hidden note */} b\n").content).toBe(
			"a <!-- hidden note --> b\n",
		);
	});

	// a comment's body is JS to MDX, so backticks inside it are plain text and
	// must not cut the comment in half
	it("converts a comment whose body holds a code span", () => {
		expect(convertMdxPage("a {/* use `foo` here */} b\n").content).toBe(
			"a <!-- use `foo` here --> b\n",
		);
	});

	it("spaces out -- pairs so a comment cannot end itself early", () => {
		expect(convertMdxPage("{/* A --> B */}\n").content).toBe("<!-- A - -> B -->\n");
	});

	// Prettier wraps long JSX lines as `...clicking{" "}` + newline so the
	// space survives the trimmed newline; MDX renders it as a space
	it("rewrites JSX whitespace expressions to spaces", () => {
		expect(convertMdxPage('clicking{" "}\n[here](/docs/setup).\n').content).toBe(
			"clicking \n[here](/guide/setup).\n",
		);
	});

	it("keeps a whitespace expression inside a code span", () => {
		const text = 'use `{" "}` for a space\n';
		expect(convertMdxPage(text).content).toBe(text);
	});

	// frontmatter is its own block to MDX, so an import on the very next line
	// was ESM there and must not surface as prose here
	it("drops an import directly after the frontmatter close", () => {
		const { content } = convertMdxPage(
			[
				"---",
				"sidebar_position: 1",
				"---",
				'import Tabs from "@theme/Tabs";',
				"",
				"# Title",
				"",
			].join("\n"),
		);
		expect(content).not.toContain("import");
		expect(content).toContain("sidebar_position: 1");
		expect(content).toContain("# Title");
	});

	// MDX reads an unfinished statement past blank lines, so the whole block
	// was ESM there, internal blank line included
	it("drops an export whose brackets span a blank line", () => {
		const { content } = convertMdxPage(
			[
				"export const cards = [",
				"\t{ position: 1 },",
				"",
				"\t{ position: 2 },",
				"];",
				"",
				"Prose.",
				"",
			].join("\n"),
		);
		expect(content).not.toContain("position: 2");
		expect(content).not.toContain("];");
		expect(content).toContain("Prose.");
	});

	it("moves /docs/ links to /guide/ and follows the .mdx rename", () => {
		const { content } = convertMdxPage(
			[
				"Inline [setup](/docs/setup) and [next](./advanced.mdx#top).",
				"",
				"[ref]: /docs/deep/page",
				"[sibling]: other.mdx",
				"",
			].join("\n"),
		);
		expect(content).toContain("[setup](/guide/setup)");
		expect(content).toContain("[next](./advanced.md#top)");
		expect(content).toContain("[ref]: /guide/deep/page");
		expect(content).toContain("[sibling]: other.md");
	});

	it("renames a .mdx link that carries a title", () => {
		const { content } = convertMdxPage('See [setup](./setup.mdx "Setup guide").\n');
		expect(content).toContain('[setup](./setup.md "Setup guide")');
	});

	// VitePress's dead-link check never scans raw HTML, so these move or 404
	it("moves raw HTML href and src attributes with the pages", () => {
		const { content } = convertMdxPage(
			'<a href="/docs/intro">intro</a> and <img src="/docs/assets/x.png">\n',
		);
		expect(content).toContain('href="/guide/intro"');
		expect(content).toContain('src="/guide/assets/x.png"');
	});

	// the static copy lands in public/, served from the site root, so any
	// climb into .moonwave/static/ keeps only the part below it; the rewrite
	// is scoped to link targets, so prose naming the folder stays prose
	it("re-roots references into .moonwave/static/", () => {
		const { content } = convertMdxPage(
			[
				"![banner](../.moonwave/static/img/banner.png)",
				'<img src="../../.moonwave/static/logo.png">',
				"A `.moonwave/static/` mention stays.",
				"Everything in .moonwave/static/ is copied.",
				"",
			].join("\n"),
		);
		expect(content).toContain("![banner](/img/banner.png)");
		expect(content).toContain('src="/logo.png"');
		expect(content).toContain("`.moonwave/static/` mention");
		expect(content).toContain("Everything in .moonwave/static/ is copied.");
	});

	it("leaves /docs/ links inside fences verbatim", () => {
		const text = ["```md", "[setup](/docs/setup)", "```", ""].join("\n");
		expect(convertMdxPage(text).content).toBe(text);
	});

	it("respells docusaurus fence attributes on the opener line only", () => {
		const { content } = convertMdxPage(
			[
				'```lua title="init.lua" showLineNumbers {2}',
				'title="x" showLineNumbers',
				"```",
				"",
			].join("\n"),
		);
		expect(content).toContain("```lua:line-numbers [init.lua] {2}");
		// the body is code, not attributes
		expect(content).toContain('title="x" showLineNumbers\n');
	});

	it("carries a showLineNumbers start line across", () => {
		const { content } = convertMdxPage(
			["```lua showLineNumbers={3}", "x", "```", ""].join("\n"),
		);
		expect(content).toContain("```lua:line-numbers=3");
	});

	// Tabs/TabItem/Frame rewrite at render time and Badge is VitePress's own;
	// anything else capitalized is a theme component that would render as text,
	// unless it sits in a comment, where it renders as nothing
	it("names leftover components, ignoring known ones, fences, spans, and comments", () => {
		const { components } = convertMdxPage(
			[
				"<Tabs>",
				'<TabItem value="a">',
				"<TOCInline toc={toc} />",
				"</TabItem>",
				"</Tabs>",
				"",
				"A `<BrowserWindow>` span and a <details> tag.",
				"",
				"{/* <Hidden /> was too noisy */}",
				"",
				"```jsx",
				'<Highlight color="red" />',
				"```",
				"",
				"<Columns><TOCInline /></Columns>",
				"",
			].join("\n"),
		);
		expect(components).toEqual(["Columns", "TOCInline"]);
	});
});

describe("convertInfimaCss", () => {
	it("renames the known Infima variables and names the rest", () => {
		const { content, leftover } = convertInfimaCss(
			[
				":root {",
				"\t--ifm-color-primary: #123;",
				"\t--ifm-color-primary-dark: #234;",
				"\t--ifm-color-primary-darker: #345;",
				"\t--ifm-color-primary-lightest: #456;",
				"\t--ifm-background-color: #fff;",
				"}",
				"",
				'html[data-theme="dark"] .banner {',
				"\tcolor: red;",
				"}",
				"",
			].join("\n"),
		);
		expect(content).toContain("--vp-c-brand-1: #123;");
		expect(content).toContain("--vp-c-brand-2: #234;");
		expect(content).toContain("--vp-c-brand-3: #345;");
		expect(content).toContain("--vp-c-bg: #fff;");
		expect(content).toContain("html.dark .banner {");
		// the unknown variable survives as written, and the report names it
		expect(content).toContain("--ifm-color-primary-lightest: #456;");
		expect(leftover).toEqual(["--ifm-color-primary-lightest"]);
	});
});

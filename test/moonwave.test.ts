/**
 * Unit tests for `convertMdxPage` and `convertInfimaCss` (`src/moonwave.ts`).
 */
import { describe, expect, it } from "vitest";
import { convertInfimaCss, convertMdxPage } from "../src/moonwave";

describe("convertMdxPage", () => {
	it.each([
		[
			"drops ESM import/export blocks",
			'import Tabs from "@theme/Tabs";\n\nexport const a = {\n\tv: 1,\n};\n\nProse stays.\n',
			"\n\nProse stays.\n",
		],
		[
			"keeps mid-paragraph line starting with import",
			"The tool can\nimport settings from disk.\n",
			"The tool can\nimport settings from disk.\n",
		],
		[
			"leaves fenced import verbatim",
			'```js\nimport Tabs from "@theme/Tabs";\n```\n',
			'```js\nimport Tabs from "@theme/Tabs";\n```\n',
		],
		[
			"drops import immediately after frontmatter",
			'---\nsidebar_position: 1\n---\nimport Tabs from "@theme/Tabs";\n\n# Title\n',
			"---\nsidebar_position: 1\n---\n\n# Title\n",
		],
		[
			"drops multi-line export spanning a blank line",
			"export const cards = [\n\t{ position: 1 },\n\n\t{ position: 2 },\n];\n\nProse.\n",
			"\nProse.\n",
		],
		[
			"rewrites MDX comments (including code spans and -- pairs)",
			"a {/* hidden `foo` */} b\n{/* A --> B */}\n",
			"a <!-- hidden `foo` --> b\n<!-- A - -> B -->\n",
		],
		[
			"rewrites JSX whitespace expressions outside code spans",
			'clicking{" "}\n[here](/docs/setup) or `{" "}`.\n',
			'clicking \n[here](/guide/setup) or `{" "}`.\n',
		],
		[
			"moves /docs/ links to /guide/ and renames .mdx targets",
			[
				'Inline [setup](/docs/setup), [next](./advanced.mdx#top), and [t](./s.mdx "Title").',
				'<a href="/docs/intro">intro</a> <img src="/docs/assets/x.png">',
				"",
				"[ref]: /docs/deep/page",
				"[sibling]: other.mdx",
				"",
			].join("\n"),
			[
				'Inline [setup](/guide/setup), [next](./advanced.md#top), and [t](./s.md "Title").',
				'<a href="/guide/intro">intro</a> <img src="/guide/assets/x.png">',
				"",
				"[ref]: /guide/deep/page",
				"[sibling]: other.md",
				"",
			].join("\n"),
		],
		[
			"re-roots .moonwave/static/ targets while leaving prose and code mentions intact",
			[
				"![banner](../.moonwave/static/img/banner.png)",
				'<img src="../../.moonwave/static/logo.png">',
				"A `.moonwave/static/` mention stays in .moonwave/static/.",
				"",
			].join("\n"),
			[
				"![banner](/img/banner.png)",
				'<img src="/logo.png">',
				"A `.moonwave/static/` mention stays in .moonwave/static/.",
				"",
			].join("\n"),
		],
		[
			"leaves /docs/ links inside fences verbatim",
			"```md\n[setup](/docs/setup)\n```\n",
			"```md\n[setup](/docs/setup)\n```\n",
		],
		[
			"respells Docusaurus fence attributes on opener lines only",
			'```lua title="init.lua" showLineNumbers {2}\ntitle="x" showLineNumbers\n```\n```lua showLineNumbers={3}\nx\n```\n',
			'```lua:line-numbers [init.lua] {2}\ntitle="x" showLineNumbers\n```\n```lua:line-numbers=3\nx\n```\n',
		],
	])("%s", (_label, input, expected) => {
		expect(convertMdxPage(input).content).toBe(expected);
	});

	it("reports leftover JSX components while ignoring known tags, fences, spans, and comments", () => {
		const { components } = convertMdxPage(
			[
				'<Tabs><TabItem value="a"><TOCInline toc={toc} /></TabItem></Tabs>',
				"A `<BrowserWindow>` span and a <details> tag.",
				"{/* <Hidden /> */}",
				'```jsx\n<Highlight color="red" />\n```',
				"<Columns><TOCInline /></Columns>",
				"",
			].join("\n"),
		);
		expect(components).toEqual(["Columns", "TOCInline"]);
	});
});

describe("convertInfimaCss", () => {
	it("renames known Infima variables and reports unknown ones", () => {
		const { content, leftover } = convertInfimaCss(
			[
				":root {",
				"\t--ifm-color-primary: #123;",
				"\t--ifm-color-primary-dark: #234;",
				"\t--ifm-color-primary-darker: #345;",
				"\t--ifm-color-primary-lightest: #456;",
				"\t--ifm-background-color: #fff;",
				"}",
				'html[data-theme="dark"] .banner { color: red; }',
			].join("\n"),
		);
		expect(content).toContain("--vp-c-brand-1: #123;");
		expect(content).toContain("--vp-c-brand-2: #234;");
		expect(content).toContain("--vp-c-brand-3: #345;");
		expect(content).toContain("--vp-c-bg: #fff;");
		expect(content).toContain("html.dark .banner { color: red; }");
		expect(content).toContain("--ifm-color-primary-lightest: #456;");
		expect(leftover).toEqual(["--ifm-color-primary-lightest"]);
	});
});

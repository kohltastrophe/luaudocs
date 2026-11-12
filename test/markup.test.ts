/**
 * The render-time markup rewrites (templates/runtime/markup.ts): docusaurus
 * compatibility, luaudocs's own `<Frame>`, and the navigation trail the same
 * rule prepends. The markdown-it rule a generated site installs runs these over
 * every page's raw source, so these tests drive them the same way: whole pages
 * in, whole pages out. The emitter ships the markup through untouched (the
 * tag-torture describe in test/emit.test.ts holds that side), and where a
 * trail's segments come from is test/site.test.ts's.
 */
import { createMarkdownRenderer } from "vitepress";
import { beforeAll, describe, expect, it } from "vitest";
import {
	codeSpan,
	installMarkupRule,
	isSafeHref,
	prependTrail,
	rewriteMarkup,
	splitFences,
	stripFrames,
	type TrailSegment,
} from "../templates/runtime/markup";
import { makeTempDirFactory } from "./helpers";

const tempDir = makeTempDirFactory("luaudocs-markup-");
let renderFrame: (source: string) => { html: string; links: string[] };
beforeAll(async () => {
	const md = await createMarkdownRenderer(tempDir(), {}, "/");
	installMarkupRule(md, {});
	renderFrame = (source) => {
		const env: { links?: string[]; path: string; relativePath: string; cleanUrls: boolean } = {
			path: "/guide/page.md",
			relativePath: "guide/page.md",
			cleanUrls: true,
		};
		const html = md.render(source, env);
		return { html, links: env.links ?? [] };
	};
});

describe("tab groups", () => {
	// one group per shape: all-code (every panel a bare fence), one mixing prose
	// and code tabs, and one inside a fence, documenting the syntax
	const allCode = [
		"<Tabs>",
		'<TabItem value="wally" label="Wally">',
		"",
		'```toml\nmini = "user/mini@1.0.0"\n```',
		"",
		"</TabItem>",
		'<TabItem value="npm">',
		"",
		"```bash\nnpm i mini\n```",
		"",
		"</TabItem>",
		"</Tabs>",
	].join("\n");
	const mixed = [
		"<Tabs>",
		'<TabItem label="Studio">Use the **plugin**.</TabItem>',
		'<TabItem label="CLI">',
		"",
		"```bash\nmini build\n```",
		"",
		"</TabItem>",
		"</Tabs>",
	].join("\n");
	const shown = '````md\n<Tabs>\n<TabItem label="Shown">not rewritten</TabItem>\n</Tabs>\n````';

	it("renders a lone-fence tab as a bare fence panel, not a .vp-block", () => {
		const group = rewriteMarkup(allCode);
		expect(group).toContain('```toml active\nmini = "user/mini@1.0.0"\n```');
		expect(group).toContain("```bash\nnpm i mini\n```");
		expect(group).toContain(">Wally</label>");
		expect(group).toContain(">npm</label>");
		expect(group).not.toContain("vp-block");
	});

	it("writes the markup the code-group container itself produces", () => {
		const group = rewriteMarkup(mixed);
		// two tabs, not three: the fence inside the CLI panel is not a tab
		expect(group.match(/<label /g)).toHaveLength(2);
		expect(group).toContain('<label data-title="Studio" for="tabs-0-0">Studio</label>');
		expect(group).toContain('<label data-title="CLI" for="tabs-0-1">CLI</label>');
		// the first tab is the one on top, in both the strip and the panels
		expect(group.match(/\bchecked\b/g)).toHaveLength(1);
		expect(group.match(/\bactive\b/g)).toHaveLength(1);
		expect(group).toContain('<div class="vp-block active">\n\nUse the **plugin**.\n\n</div>');
		// blank-line separated, so the panel bodies stay markdown
		expect(group).toContain("</div>\n\n```bash\nmini build\n```\n\n</div></div>");
	});

	// a titled fence would otherwise reach the icon plugin's fence rule, which
	// wraps it in a title bar; that bar, not the block, becomes the panel the
	// group shows and hides, so every tab renders at once
	it("drops a lone-fence tab's `[title]`, which the tab strip already carries, while preserving `luaudocs-links=[[...]]`", () => {
		const group = rewriteMarkup(
			allCode.replace("```toml", "```toml [wally.toml]").replace("```bash", "```bash [npm]"),
		);
		expect(group).toContain('```toml active\nmini = "user/mini@1.0.0"\n```');
		expect(group).toContain("```bash\nnpm i mini\n```");
		expect(group).not.toContain("[wally.toml]");
		expect(group).not.toContain("[npm]");

		const withLinks = [
			"<Tabs>",
			'<TabItem label="Signature">',
			"",
			'```luau luaudocs-links=[[0,4,"/api/Mini"]]\nMini.run()\n```',
			"",
			"</TabItem>",
			"</Tabs>",
		].join("\n");
		expect(rewriteMarkup(withLinks)).toContain(
			'```luau luaudocs-links=[[0,4,"/api/Mini"]] active\nMini.run()\n```',
		);
	});

	// inside a prose panel the fence is content, not the panel itself, so its
	// title bar renders where it was written
	it("keeps a `[title]` on a fence sitting beside prose", () => {
		const page = [
			"<Tabs>",
			'<TabItem label="Wally">',
			"",
			"Add it to your manifest:",
			"",
			'```toml [wally.toml]\nmini = "user/mini@1.0.0"\n```',
			"",
			"</TabItem>",
			'<TabItem label="Manual">Copy the files in.</TabItem>',
			"</Tabs>",
		].join("\n");
		expect(rewriteMarkup(page)).toContain(
			'```toml [wally.toml]\nmini = "user/mini@1.0.0"\n```',
		);
	});

	it("puts the `default` tab on top", () => {
		const group = rewriteMarkup(
			mixed.replace('<TabItem label="CLI">', '<TabItem label="CLI" default>'),
		);
		expect(group).toContain('-1" checked');
		expect(group).toContain('<div class="vp-block">\n\nUse the **plugin**.\n\n</div>');
		expect(group).toContain("```bash active\nmini build\n```");
		expect(group.match(/\bactive\b/g)).toHaveLength(1);
		expect(group.match(/\bchecked\b/g)).toHaveLength(1);
	});

	it("puts a later `default` fence panel on top", () => {
		const group = rewriteMarkup(
			allCode.replace('<TabItem value="npm">', '<TabItem value="npm" default>'),
		);
		expect(group).toContain('-1" checked');
		expect(group).toContain("```bash active\n");
		expect(group).toContain('```toml\nmini = "user/mini@1.0.0"');
	});

	it("reads a quoted `default` as a label, not the flag", () => {
		const group = rewriteMarkup(
			mixed.replace('<TabItem label="CLI">', '<TabItem label="default">'),
		);
		expect(group).toContain('-0" checked');
	});

	it("names each group's radios uniquely, and deterministically", () => {
		const two = `${mixed}\n\n${mixed.replace("Studio", "Editor")}`;
		const names = new Set([...rewriteMarkup(two).matchAll(/name="([^"]+)"/g)].map((m) => m[1]));
		expect(names.size).toBe(2);
		expect(rewriteMarkup(two)).toBe(rewriteMarkup(two));
	});

	it("leaves a group inside a fence spelling the syntax it documents", () => {
		expect(rewriteMarkup(`${mixed}\n\n${shown}`)).toContain(
			'<TabItem label="Shown">not rewritten</TabItem>',
		);
	});

	it("leaves a group with no items alone", () => {
		const empty = "<Tabs>\nprose only\n</Tabs>";
		expect(rewriteMarkup(empty)).toBe(empty);
	});

	it("rewrites a group opening on the line right after a fence", () => {
		const page = '```lua\nx = 1\n```\n<Tabs>\n<TabItem label="A">Prose.</TabItem>\n</Tabs>';
		expect(rewriteMarkup(page)).toContain('<div class="vp-code-group">');
		expect(rewriteMarkup(page)).not.toContain("<TabItem");
	});
});

describe("admonitions", () => {
	it("maps docusaurus kinds onto VitePress containers, normalizing spacing", () => {
		expect(rewriteMarkup(":::note\nBody.\n:::")).toBe("::: info\nBody.\n:::");
		expect(rewriteMarkup(":::caution Title\nBody.\n:::")).toBe("::: warning Title\nBody.\n:::");
	});

	it("unwraps a bracket title", () => {
		expect(rewriteMarkup(":::tip[Worth knowing]\nBody.\n:::")).toBe(
			"::: tip Worth knowing\nBody.\n:::",
		);
	});

	it("passes unknown kinds and VitePress's own spelling through", () => {
		expect(rewriteMarkup(":::mystery\nBody.\n:::")).toBe(":::mystery\nBody.\n:::");
		const native = "::: details Click\nBody.\n:::";
		expect(rewriteMarkup(native)).toBe(native);
	});

	it("leaves an admonition inside a fence alone", () => {
		const page = ":::note\nreal\n:::\n\n```md\n:::note\nshown\n:::\n```";
		expect(rewriteMarkup(page)).toBe("::: info\nreal\n:::\n\n```md\n:::note\nshown\n:::\n```");
	});

	// masking a fence must not consume the newline that ends it: both rewrites
	// are line-anchored, so an opener hard against the fence above would sit
	// mid-line in the masked text and pass through unrewritten, shipping a
	// literal `:::note` (VitePress has no `note` container)
	it("rewrites an admonition opening on the line right after a fence", () => {
		expect(rewriteMarkup("```lua\nx = 1\n```\n:::note\nBody.\n:::\n")).toBe(
			"```lua\nx = 1\n```\n::: info\nBody.\n:::\n",
		);
	});

	it("rewrites an admonition inside a prose tab panel", () => {
		const page =
			'<Tabs>\n<TabItem label="A">\n\n:::caution\nBody.\n:::\n\n</TabItem>\n<TabItem label="B">Prose.</TabItem>\n</Tabs>';
		expect(rewriteMarkup(page)).toContain("::: warning");
	});
});

describe("frames", () => {
	// a markdown link, not a raw `<a href>`: VitePress bases and dead-link
	// checks only the former, so a raw href 404s on a project-pages deploy
	it("labels the frame and links the label when both attributes are given", () => {
		const page =
			'<Frame label="Generated reference" link="/api/Flux#state-1">\n\nBody.\n\n</Frame>';
		expect(rewriteMarkup(page)).toBe(
			'<div class="luaudocs-frame">\n' +
				'<div class="luaudocs-frame-label">\n\n' +
				"[Generated reference" +
				'<span class="luaudocs-frame-arrow">&#8594;</span>](/api/Flux#state-1)' +
				"\n\n</div>\n" +
				"\nBody.\n\n</div>",
		);
	});

	// the label is what a link decorates, so a frame without one renders bare
	// rather than growing an anchor with no text to click
	it("renders bare without a label, link or not", () => {
		const bare = '<div class="luaudocs-frame">\n\nBody.\n\n</div>';
		expect(rewriteMarkup("<Frame>\n\nBody.\n\n</Frame>")).toBe(bare);
		expect(rewriteMarkup('<Frame link="/api/Flux">\n\nBody.\n\n</Frame>')).toBe(bare);
	});

	it("escapes both attributes", () => {
		const page = '<Frame label="A & [B]" link="/api/X (old)?a=1&b=2">\n\nBody.\n\n</Frame>';
		const out = rewriteMarkup(page);
		// the label is link text, the link a destination that may not hold a
		// raw space and needs brackets around its parentheses
		expect(out).toContain("[A \\& \\[B\\]<span");
		expect(out).toContain("](</api/X%20(old)?a=1&b=2>)");
		// unlinked, the label is element text
		expect(rewriteMarkup('<Frame label="A & B">\n\nBody.\n\n</Frame>')).toContain(
			">A &amp; B<",
		);
	});

	// blank lines around the body are what keep it markdown rather than raw HTML
	it("keeps one blank line around a body ending in a fence", () => {
		const page = '<Frame label="Out">\n\n```lua\nx = 1\n```\n\n</Frame>';
		expect(rewriteMarkup(page)).toBe(
			'<div class="luaudocs-frame">\n<div class="luaudocs-frame-label">Out</div>\n' +
				"\n```lua\nx = 1\n```\n</div>",
		);
	});

	// a frame quotes another page's content, so its headings are not this page's
	// structure. `installFrameHeadingRule` converts framed `heading_open` /
	// `heading_close` tokens into id-less `<hN>` tags before `anchor`, keeping
	// them out of the outline while preserving VitePress inline rendering,
	// `validateLink`, and dead-link recording
	it("renders a frame's headings as id-less elements, keeping them out of the outline", () => {
		const { html } = renderFrame(
			'<Frame label="Out">\n\n# Flux\n\n## Properties\n\n### state <Badge text="new" />\n\n</Frame>',
		);
		expect(html).toContain("<h1>Flux</h1>");
		expect(html).toContain("<h2>Properties</h2>");
		expect(html).toContain('<h3>state <Badge text="new" /></h3>');
		expect(html).not.toMatch(/<h[1-6][^>]*\sid=/);
	});

	it("renders a framed heading's code span through VitePress's inline pipeline", () => {
		const { html } = renderFrame(
			'<Frame label="Out">\n\n### `state` <Badge text="new" />\n\n</Frame>',
		);
		expect(html).toContain('<h3><code>state</code> <Badge text="new" /></h3>');
	});

	it("renders a framed heading's escaped characters as themselves", () => {
		const { html } = renderFrame('<Frame label="Out">\n\n## \\_Inner\\_ \\<T\\>\n\n</Frame>');
		expect(html).toContain("<h2>_Inner_ &lt;T&gt;</h2>");
	});

	it("renders a framed heading's badge link and records it for VitePress dead-link checks", () => {
		const { html, links } = renderFrame(
			'<Frame label="Out" link="/api/Flux">\n\n### `Queue` [<Badge text="Module" />](/api/Queue){.badge-link .ignore-header}\n\n</Frame>',
		);
		expect(html).toContain(
			'<h3><code>Queue</code> <a href="/api/Queue" class="badge-link ignore-header"><Badge text="Module" /></a></h3>',
		);
		expect(links).toEqual(expect.arrayContaining(["/api/Flux", "/api/Queue"]));
	});

	it("blocks javascript: URLs on both the frame link attribute and links inside framed headings", () => {
		expect(
			rewriteMarkup('<Frame label="Unsafe" link="javascript:alert(1)">\n\nBody.\n\n</Frame>'),
		).toContain('<div class="luaudocs-frame-label">Unsafe</div>');

		const { html } = renderFrame(
			'<Frame label="Out">\n\n### [Click](javascript:alert(1))\n\n</Frame>',
		);
		expect(html).not.toContain("<a ");
		expect(html).toContain("<h3>[Click](javascript:alert(1))</h3>");
	});

	it("drops the trailing hashes of a closed ATX heading", () => {
		const { html } = renderFrame('<Frame label="Out">\n\n## Properties ##\n\n</Frame>');
		expect(html).toContain("<h2>Properties</h2>");
	});

	it("leaves a heading inside a fenced example in the body alone", () => {
		const { html } = renderFrame(
			'<Frame label="Out">\n\n```md\n## Not a heading\n```\n\n</Frame>',
		);
		expect(html).toContain("## Not a heading");
		expect(html).not.toContain("<h2>");
	});

	it("strips frames outside fenced code blocks in stripFrames", () => {
		const page =
			"Before.\n\n<Frame>\n\n## Hidden\n\n</Frame>\n\n```md\n<Frame>\n\n## Shown\n\n</Frame>\n```\n";
		const stripped = stripFrames(page);
		expect(stripped).not.toContain("## Hidden");
		expect(stripped).toContain("## Shown");
	});

	it("leaves a frame shown inside a fence alone", () => {
		const page = '```mdx\n<Frame label="Out">\n\nBody.\n\n</Frame>\n```\n';
		expect(rewriteMarkup(page)).toBe(page);
	});

	it("rewrites a frame holding a tab group", () => {
		const page =
			'<Frame label="Out">\n\n<Tabs>\n<TabItem label="A">Prose.</TabItem>\n</Tabs>\n\n</Frame>';
		const out = rewriteMarkup(page);
		expect(out).toContain('class="luaudocs-frame"');
		expect(out).toContain('class="vp-code-group"');
	});
});

it("returns text carrying no construct untouched", () => {
	const page = "# Title\n\nProse with `:::` inline and a <TabsLike> word.\n";
	expect(rewriteMarkup(page)).toBe(page);
});

describe("CommonMark fences, codeSpan, and isSafeHref", () => {
	it("splits fences using CommonMark 0-3 space indent, info-string backtick, and closer rules", () => {
		// 4 spaces is an indented code block, not a fence opener
		expect(splitFences("    ```md\n:::note\n:::\n    ```\n")).toEqual([
			"    ```md\n:::note\n:::\n    ```\n",
		]);
		// backticks in a backtick fence's info string reject the opener (` ```a` `)
		expect(splitFences("```luau `inline`\nbody\n```\n")).toEqual([
			"```luau `inline`\nbody\n",
			"```\n",
		]);
		// closing fence must use at least as many characters and carry no trailing text
		const parts = splitFences("````md\n```\n``` trailing\n````\nafter\n");
		expect(parts).toEqual(["", "````md\n```\n``` trailing\n````\n", "after\n"]);
	});

	it("wraps embedded backticks and outer spaces in CommonMark-safe codeSpan fences", () => {
		expect(codeSpan("plain")).toBe("`plain`");
		expect(codeSpan("a`b")).toBe("``a`b``");
		expect(codeSpan("`edge`")).toBe("`` `edge` ``");
		expect(codeSpan(" padded ")).toBe("`  padded  `");
		expect(codeSpan("   ")).toBe("`   `");
	});

	it("rejects executable and data URL schemes in isSafeHref even with control whitespace", () => {
		expect(isSafeHref("javascript:alert(1)")).toBe(false);
		expect(isSafeHref(" \tJaVaScRiPt\n:alert(1)")).toBe(false);
		expect(isSafeHref("vbscript:msgbox(1)")).toBe(false);
		expect(isSafeHref("data:text/html,<script>alert(1)</script>")).toBe(false);
		expect(isSafeHref("https://example.com/docs")).toBe(true);
		expect(isSafeHref("/api/Sample#run")).toBe(true);
	});
});

describe("page trails", () => {
	const home: TrailSegment = { text: "Home", link: "/" };

	it("heads a page with its <nav> trail above the title and escapes labels and links", () => {
		const out = prependTrail("# Queue\n\nProse.\n", [
			home,
			{ text: "Over_view", link: "/api/" },
			{ text: "Flux [v2]", link: "/api/Flux (v2)" },
			{ text: "Unsafe", link: "javascript:alert(1)" },
		]);
		// blank lines around the links: markdown-it parses an HTML block's
		// contents as markdown only when they stand apart from the tags
		expect(out).toBe(
			'<nav class="luaudocs-trail" aria-label="Breadcrumb">\n\n' +
				"[Home](/) › [Over\\_view](/api/) › [Flux \\[v2\\]](</api/Flux%20(v2)>) › Unsafe\n\n" +
				"</nav>\n\n# Queue\n\nProse.\n",
		);
	});

	it("renders a segment with no page of its own as plain text", () => {
		const out = prependTrail("# Tags\n", [home, { text: "Reference" }]);
		expect(out).toContain("[Home](/) › Reference\n");
		expect(out).not.toContain("[Reference]");
	});

	it("leaves a page with no trail alone", () => {
		const page = "# Home\n";
		expect(prependTrail(page, undefined)).toBe(page);
		expect(prependTrail(page, [])).toBe(page);
	});
});

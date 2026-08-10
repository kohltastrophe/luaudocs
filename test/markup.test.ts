/**
 * The render-time markup rewrites (templates/runtime/markup.ts): docusaurus
 * compatibility, luaudocs's own `<Frame>`, and the navigation trail the same
 * rule prepends. The markdown-it rule a generated site installs runs these over
 * every page's raw source, so these tests drive them the same way: whole pages
 * in, whole pages out. The emitter ships the markup through untouched (the
 * tag-torture describe in test/emit.test.ts holds that side), and where a
 * trail's segments come from is test/site.test.ts's.
 */
import { describe, expect, it } from "vitest";
import { prependTrail, rewriteMarkup, type TrailSegment } from "../templates/runtime/markup";

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
	it("drops a lone-fence tab's `[title]`, which the tab strip already carries", () => {
		const group = rewriteMarkup(
			allCode.replace("```toml", "```toml [wally.toml]").replace("```bash", "```bash [npm]"),
		);
		expect(group).toContain('```toml active\nmini = "user/mini@1.0.0"\n```');
		expect(group).toContain("```bash\nnpm i mini\n```");
		expect(group).not.toContain("[wally.toml]");
		expect(group).not.toContain("[npm]");
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
	it("labels the frame and links the label when both attributes are given", () => {
		const page =
			'<Frame label="Generated reference" link="/api/Flux#state-1">\n\nBody.\n\n</Frame>';
		expect(rewriteMarkup(page)).toBe(
			'<div class="luaudocs-frame">\n' +
				'<div class="luaudocs-frame-label">' +
				'<a href="/api/Flux#state-1">Generated reference' +
				'<span class="luaudocs-frame-arrow">&#8594;</span></a></div>\n' +
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
		const page = '<Frame label="A & B" link="/api/X?a=1&b=2">\n\nBody.\n\n</Frame>';
		const out = rewriteMarkup(page);
		expect(out).toContain('href="/api/X?a=1&amp;b=2"');
		expect(out).toContain(">A &amp; B<");
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
	// structure. Writing the element directly is what keeps them out of the
	// outline: no anchor plugin, so no id, and VitePress drops id-less headings
	// before building its tree
	it("writes a frame's headings as id-less elements, keeping them out of the outline", () => {
		const out = rewriteMarkup(
			'<Frame label="Out">\n\n# Flux\n\n## Properties\n\n### state <Badge text="new" />\n\n</Frame>',
		);
		expect(out).toContain("<h1>Flux</h1>");
		expect(out).toContain("<h2>Properties</h2>");
		expect(out).toContain('<h3>state <Badge text="new" /></h3>');
		expect(out).not.toContain("ignore-header");
		expect(out).not.toContain("# Flux");
	});

	// the element's body is raw HTML to markdown-it, so the code span a member
	// heading is written as has to be written out as the element it renders as
	it("writes a framed heading's code span as the <code> it would have rendered", () => {
		const out = rewriteMarkup(
			'<Frame label="Out">\n\n### `state` <Badge text="new" />\n\n</Frame>',
		);
		expect(out).toContain('<h3><code>state</code> <Badge text="new" /></h3>');
	});

	it("drops the trailing hashes of a closed ATX heading", () => {
		const out = rewriteMarkup('<Frame label="Out">\n\n## Properties ##\n\n</Frame>');
		expect(out).toContain("<h2>Properties</h2>");
	});

	it("leaves a heading inside a fenced example in the body alone", () => {
		const out = rewriteMarkup(
			'<Frame label="Out">\n\n```md\n## Not a heading\n```\n\n</Frame>',
		);
		expect(out).toContain("```md\n## Not a heading\n```");
		expect(out).not.toContain("<h2>");
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

describe("page trails", () => {
	const home: TrailSegment = { text: "Home", link: "/" };

	it("heads a page with its trail, above the title", () => {
		const out = prependTrail("# Queue\n\nProse.\n", [
			home,
			{ text: "Overview", link: "/api/" },
			{ text: "Flux", link: "/api/Flux" },
		]);
		// blank lines around the links: markdown-it parses an HTML block's
		// contents as markdown only when they stand apart from the tags
		expect(out).toBe(
			'<div class="luaudocs-trail">\n\n' +
				"[Home](/) › [Overview](/api/) › [Flux](/api/Flux)\n\n" +
				"</div>\n\n# Queue\n\nProse.\n",
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

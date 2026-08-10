/**
 * The whitespace fidelity tweak (templates/runtime/whitespace.ts): newlines
 * separating inline content must reach Vue as literal spaces, since its
 * template compiler drops a whitespace-only text node containing a newline
 * where an HTML parser reads a space. Driven through a real markdown-it, the
 * way the generated config installs the plugin.
 */
import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { whitespacePlugin } from "../templates/runtime/whitespace";

function renderer(): MarkdownIt {
	const md = new MarkdownIt({ html: true });
	whitespacePlugin(md);
	return md;
}

describe("whitespacePlugin", () => {
	it("joins the lines of a raw HTML block with spaces", () => {
		const html = renderer().render(
			'<div align="center">\n\t<a href="/a"><img src="/a.svg"></a>\n\t<a href="/b"><img src="/b.svg"></a>\n</div>\n',
		);
		expect(html).toBe(
			'<div align="center"> <a href="/a"><img src="/a.svg"></a> <a href="/b"><img src="/b.svg"></a> </div>\n',
		);
	});

	it("keeps the newlines of a block holding a <pre>", () => {
		const source = "<pre>\n  spaced\n</pre>\n";
		expect(renderer().render(source)).toBe(source);
	});

	// opened mid-paragraph the tag is html_inline, so the block rule never sees
	// it and only the softbreak rule can keep the newline
	it("keeps the newlines of a <pre> opened inside a paragraph", () => {
		const html = renderer().render("text <pre>line one\nline two</pre> after\n");
		expect(html).toContain("<pre>line one\nline two</pre>");
	});

	it("renders a softbreak as a space", () => {
		const html = renderer().render("[a](/a)\n[b](/b)\n");
		expect(html).toContain('</a> <a href="/b">');
		expect(html).not.toContain("\n<a");
	});

	// VitePress strips its include markers per line, so joining one onto the
	// line above would leak the marker into the page
	it("keeps an @include marker on its own line", () => {
		const source = "<div>one\ntwo</div>\n<!-- @include-end -->\n";
		expect(renderer().render(source)).toContain("\n<!-- @include-end -->");
	});

	// the wrapped rules read token.content, so the rewrite has to go through the
	// token; it must not stay there, or a second render compounds it
	it("leaves the token stream as it found it", () => {
		const md = new MarkdownIt({ html: true });
		whitespacePlugin(md);
		const tokens = md.parse("<div>one\ntwo</div>\n", {});
		expect(md.renderer.render(tokens, md.options, {})).toBe(
			md.renderer.render(tokens, md.options, {}),
		);
		expect(tokens.find((token) => token.type === "html_block")?.content).toContain("one\ntwo");
	});

	it("leaves the softbreak alone when breaks turns it into a <br>", () => {
		const md = new MarkdownIt({ html: true, breaks: true });
		whitespacePlugin(md);
		expect(md.render("a\nb\n")).toContain("<br>");
	});
});

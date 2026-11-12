/**
 * Emitted and authored markdown through the REAL VitePress renderer, with the
 * runtime plugins installed the way the baked config.mts installs them, then
 * compiled as the Vue template VitePress turns every page into. What only
 * that pipeline shows: Vue reads `{{ }}` in rendered HTML as interpolation,
 * and only VitePress's own link rule applies the site base.
 */
import MarkdownIt from "markdown-it";
import { createHighlighter } from "shiki";
import { createMarkdownRenderer } from "vitepress";
import { compileTemplate } from "vue/compiler-sfc";
import { beforeAll, describe, expect, it } from "vitest";
import { emitDocsFromJson } from "../src/render";
import { stripFrontmatter } from "../src/markdown";
import { codeIcons } from "../templates/runtime/icons";
import { inlineHighlightPlugin } from "../templates/runtime/inline-highlight";
import { installMarkupRule } from "../templates/runtime/markup";
import { rewriteSearchIndexCache, searchIndexCachePlugin } from "../templates/runtime/search-cache";
import { relayLinks } from "../templates/runtime/signature-links";
import { whitespacePlugin } from "../templates/runtime/whitespace";
import { makeTempDirFactory, modelJson, testConfig, testFn, testMod } from "./helpers";

const tempDir = makeTempDirFactory("luaudocs-vue-");

/** A page's HTML, and the internal links VitePress recorded for its dead-link check. */
let render: (content: string) => Promise<{ html: string; links: string[] }>;

// The renderer a generated site builds, its markdown config reproduced, under
// the base a project-pages deploy has. One per file: VitePress keeps a single
// renderer per process and hands it back on every later call.
beforeAll(async () => {
	const md = await createMarkdownRenderer(tempDir(), {}, "/repo/");
	installMarkupRule(md, {});
	// no highlighter: the fallback path is the one every unannotated span takes
	inlineHighlightPlugin(md, () => undefined);
	whitespacePlugin(md);
	relayLinks(md);
	render = async (content) => {
		const env: { links?: string[] } & Record<string, unknown> = {
			path: "/api/Mini.md",
			relativePath: "api/Mini.md",
			cleanUrls: true,
		};
		// async, so fences are highlighted (and given their v-pre) as in a build
		const html = await md.renderAsync(stripFrontmatter(content), env);
		return { html, links: env.links ?? [] };
	};
});

/** Vue's verdict on a page's HTML: its compile errors, and what it renders. */
function compile(html: string): { errors: string[]; code: string } {
	const result = compileTemplate({
		source: `<div>${html}</div>`,
		filename: "Mini.md",
		id: "mini",
	});
	return { errors: result.errors.map(String), code: result.code };
}

const miniJson = (extra: Record<string, unknown>) =>
	modelJson([testMod("src/init.luau", "Mini", extra)]);

describe("inline code under Vue", () => {
	// a Luau table type spells `{{` routinely; in a return list or an Errors
	// cell it is inline code, which VitePress leaves to Vue's interpolation
	it("compiles a page whose inline code spells `{{`", async () => {
		const page = emitDocsFromJson(
			miniJson({
				doc: "Authored too: `{{ bar }}`.",
				members: [
					testFn("src/init.luau#fn.Mini.get", "get", "Mini.get", ["(): {{string}}"], {
						errors: [{ type: "{{[string]: number}}", doc: "bad" }],
						signature: {
							callee: "Mini.get",
							segs: ["(): {{string}}"],
							params: [],
							returns: [{ type: ["{{string}}"], doc: "the thing" }],
						},
					}),
				],
			}),
			testConfig(),
		).pages.get("Mini.md")!;
		const { html } = await render(page);
		expect(html).toContain('<code v-pre="">{{string}}</code>');
		const { errors, code } = compile(html);
		expect(errors).toEqual([]);
		// rendered as text, not compiled into an expression
		expect(code).toContain("{{string}}");
		expect(code).toContain("{{[string]: number}}");
		expect(code).toContain("{{ bar }}");
	});

	it("leaves authored interpolation in prose to Vue", async () => {
		expect((await render("Count: {{ 1 + 1 }}")).html).not.toContain("v-pre");
	});
});

// a project-pages deploy serves the site under `/<repo>/`; a link that skips
// the base 404s there, and a raw href also escapes the dead-link check
describe("links under a site base", () => {
	it("bases a re-export badge link, keeping it out of the slug and the outline", async () => {
		const emitted = emitDocsFromJson(
			modelJson([
				testMod("src/init.luau", "Mini", {
					reexports: [
						{
							id: "src/init.luau#reexport.Util",
							name: "Util",
							targetModule: "src/util.luau",
						},
					],
				}),
				testMod("src/util.luau", "Util", {
					instancePath: ["Mini", "Util"],
					doc: "Helpers.",
				}),
			]),
			testConfig(),
		);
		const { html, links } = await render(emitted.pages.get("Mini.md")!);
		expect(html).toContain(
			'<h3 id="util" tabindex="-1"><code v-pre="">Util</code> ' +
				'<a href="/repo/api/Util" class="badge-link ignore-header">' +
				'<Badge type="info" text="Module" /></a>',
		);
		expect(emitted.pageModels[0]!.anchors["src/init.luau#reexport.Util"]).toBe("util");
		expect(links).toContain("/api/Util");
	});

	it("bases a frame's caption link and framed badge links", async () => {
		const { html, links } = await render(
			'<Frame label="Generated reference" link="/api/Mini#util">\n\n' +
				'### `Util` [<Badge type="info" text="Module" />](/api/Util){.badge-link .ignore-header}\n\n' +
				"Body.\n\n</Frame>\n",
		);
		expect(html).toContain('<a href="/repo/api/Mini#util">Generated reference');
		expect(html).toContain(
			'<h3><code v-pre="">Util</code> <a href="/repo/api/Util" class="badge-link ignore-header">',
		);
		expect(links).toEqual(expect.arrayContaining(["/api/Mini#util", "/api/Util"]));
	});

	it("rewrites dev search-index version stamps and exposes custom code icons", () => {
		const plugin = searchIndexCachePlugin();
		expect(plugin.name).toBe("luaudocs:search-index-cache");
		expect(
			rewriteSearchIndexCache('import "/@localSearchIndexroot?v=1";', "@localSearchIndex"),
		).toBe('import "/@localSearchIndexroot?rev=1";');
		expect(
			rewriteSearchIndexCache('import "/@localSearchIndexroot?v=2";', "/@localSearchIndex"),
		).toBe('import "/@localSearchIndexroot?rev=2";');
		expect(
			rewriteSearchIndexCache('import "/@localSearchIndexroot?v=1";', "/other/module.ts"),
		).toBeUndefined();
		expect(codeIcons[".luau"]).toBe("vscode-icons:file-type-luau");
		expect(codeIcons[".lua"]).toBe("vscode-icons:file-type-lua");
		expect(codeIcons.github.light).toContain("<svg");
		expect(codeIcons.github.dark).toContain("<svg");
	});
});

describe("inlineHighlightPlugin with Shiki", () => {
	let md: MarkdownIt;
	let brokenMd: MarkdownIt;

	beforeAll(async () => {
		const hl = await createHighlighter({
			themes: ["github-light", "github-dark"],
			langs: ["luau"],
		});
		md = new MarkdownIt();
		// Exercise the default `code_inline` fallback when no prior rule is set.
		delete md.renderer.rules.code_inline;
		md.core.ruler.after("inline", "test_seed_attrs", (state) => {
			for (const block of state.tokens) {
				for (const tok of block.children ?? []) {
					if (tok.type === "code_inline" && tok.content.includes("styled")) {
						tok.attrPush(["class", "vp-code"]);
						tok.attrPush(["data-id", "span-1"]);
					}
				}
			}
			return true;
		});
		inlineHighlightPlugin(md, () => hl);

		brokenMd = new MarkdownIt();
		inlineHighlightPlugin(brokenMd, () => ({
			...hl,
			getLoadedLanguages: () => ["luau"],
			codeToHtml: () => {
				throw new Error("boom");
			},
		}));
	});

	it("highlights {luau} spans, falls back on unloaded {lua} or unannotated spans, and preserves token attrs", () => {
		const luauHtml = md.render("Call `local x = 1`{luau} now.");
		expect(luauHtml).toContain('<code class="shiki-inline" v-pre>');
		expect(luauHtml).toContain("--shiki-light:");
		expect(luauHtml).toContain(" now.");
		expect(luauHtml).not.toContain("{luau}");

		// `lua` is in `LANGUAGES`, so `{lua}` is consumed, but `hl` only loaded `luau` -> clean fallback.
		const unloadedHtml = md.render("Legacy `local y = 2`{lua} here.");
		expect(unloadedHtml).toContain('<code v-pre="">local y = 2</code> here.');

		// Unannotated and non-Luau `{...}` suffixes fall back without consuming `{.cls}` / `{py}`.
		const fallbackHtml = md.render("Plain `a < b` and `z`{.cls}.");
		expect(fallbackHtml).toContain('<code v-pre="">a &lt; b</code>');
		expect(fallbackHtml).toContain('<code v-pre="">z</code>{.cls}.');

		// Existing attributes on the token are merged with `shiki-inline` and `v-pre`.
		const styledHtml = md.render("Keep `local styled = true`{luau} attrs.");
		expect(styledHtml).toContain('<code v-pre class="vp-code shiki-inline" data-id="span-1">');

		// Highlighter runtime failure falls back gracefully to escaped inline code.
		expect(brokenMd.render("Safe `local x = 1`{luau}.")).toContain(
			'<code v-pre="">local x = 1</code>.',
		);
	});
});

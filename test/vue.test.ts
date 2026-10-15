/**
 * Emitted and authored markdown through the REAL VitePress renderer, with the
 * runtime plugins installed the way the baked config.mts installs them, then
 * compiled as the Vue template VitePress turns every page into. What only
 * that pipeline shows: Vue reads `{{ }}` in rendered HTML as interpolation,
 * and only VitePress's own link rule applies the site base.
 */
import { createMarkdownRenderer } from "vitepress";
import { compileTemplate } from "vue/compiler-sfc";
import { beforeAll, describe, expect, it } from "vitest";
import { emitDocsFromJson } from "../src/render";
import { stripFrontmatter } from "../src/markdown";
import { inlineHighlightPlugin } from "../templates/runtime/inline-highlight";
import { installMarkupRule } from "../templates/runtime/markup";
import { relayLinks } from "../templates/runtime/signature-links";
import { whitespacePlugin } from "../templates/runtime/whitespace";
import { makeTempDirFactory, modelJson, testConfig } from "./helpers";

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

const miniJson = (extra: object) =>
	modelJson([
		{
			id: "src/init.luau",
			instancePath: ["Mini"],
			name: "Mini",
			source: { file: "src/init.luau", line: 1 },
			...extra,
		},
	]);

describe("inline code under Vue", () => {
	// a Luau table type spells `{{` routinely; in a return list or an Errors
	// cell it is inline code, which VitePress leaves to Vue's interpolation
	it("compiles a page whose inline code spells `{{`", async () => {
		const page = emitDocsFromJson(
			miniJson({
				doc: "Authored too: `{{ bar }}`.",
				members: [
					{
						id: "src/init.luau#fn.Mini.get",
						name: "get",
						kind: "function",
						visibility: "public",
						tags: { custom: [] },
						errors: [{ type: "{{[string]: number}}", doc: "bad" }],
						signature: {
							callee: "Mini.get",
							segs: ["(): {{string}}"],
							params: [],
							returns: [{ type: ["{{string}}"], doc: "the thing" }],
						},
						source: { file: "src/init.luau", line: 5 },
					},
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
				{
					id: "src/init.luau",
					instancePath: ["Mini"],
					name: "Mini",
					source: { file: "src/init.luau", line: 1 },
					reexports: [
						{
							id: "src/init.luau#reexport.Util",
							name: "Util",
							targetModule: "src/util.luau",
						},
					],
				},
				{
					id: "src/util.luau",
					instancePath: ["Mini", "Util"],
					name: "Util",
					doc: "Helpers.",
					source: { file: "src/util.luau", line: 1 },
				},
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

	it("bases a frame's caption link", async () => {
		const { html, links } = await render(
			'<Frame label="Generated reference" link="/api/Mini#util">\n\nBody.\n\n</Frame>\n',
		);
		expect(html).toContain('<a href="/repo/api/Mini#util">Generated reference');
		expect(links).toContain("/api/Mini#util");
	});
});

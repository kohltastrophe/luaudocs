/**
 * Anchor round-trip through the real VitePress markdown renderer.
 * Every anchor recorded by `mintAnchors` must exist on its rendered page, and
 * every emitted `#fragment` link must resolve to a minted heading ID.
 */
import { createMarkdownRenderer } from "vitepress";
import { beforeAll, describe, expect, it } from "vitest";
import { apiPageFile } from "../src/pages";
import { emitDocsFromJson } from "../src/render";
import { stripFrontmatter } from "../src/markdown";
import { rewriteMarkup } from "../templates/runtime/markup";
import { makeTempDirFactory, modelJson, readFixture, testConfig } from "./helpers";

const captures = ["docmodel-sample.json", "docmodel-tags.json"];
const results = new Map(
	captures.map((fixture) => [fixture, emitDocsFromJson(readFixture(fixture), testConfig())]),
);

const tempDir = makeTempDirFactory("luaudocs-anchors-");

let render: (content: string, path: string) => string;
beforeAll(async () => {
	const md = await createMarkdownRenderer(tempDir(), {}, "/");
	md.core.ruler.before("block", "luaudocs_docusaurus", (state) => {
		state.src = rewriteMarkup(state.src);
		return true;
	});
	render = (content, path) =>
		md.render(stripFrontmatter(content), {
			path,
			relativePath: path.slice(1),
			cleanUrls: true,
		});
});

const mintedIds = (html: string): string[] =>
	[...html.matchAll(/<h[1-6][^>]*\sid="([^"]*)"/g)].map((match) => match[1]!);

describe.each(captures)("minted anchors: %s", (fixture) => {
	const result = results.get(fixture)!;
	let minted: Map<string, Set<string>>;

	beforeAll(() => {
		minted = new Map(
			result.pageModels.map((page) => [
				page.slug,
				new Set(
					mintedIds(
						render(result.pages.get(apiPageFile(page.slug))!, `/api/${page.slug}.md`),
					),
				),
			]),
		);
	});

	it("records only anchors the renderer mints and emits only resolving fragments", () => {
		let checkedAnchors = 0;
		for (const page of result.pageModels) {
			for (const [id, anchor] of Object.entries(page.anchors)) {
				expect(minted.get(page.slug), `${page.slug}: ${id} -> #${anchor}`).toContain(
					anchor,
				);
				checkedAnchors += 1;
			}
		}
		expect(checkedAnchors).toBeGreaterThan(0);

		let checkedLinks = 0;
		const documents: Array<[string, string]> = [...result.pages];
		if (result.apiIndex !== undefined) {
			documents.push(["index.md", result.apiIndex]);
		}
		for (const [file, markdown] of documents) {
			for (const [, slug, fragment] of markdown.matchAll(/\/api\/([\w.-]+)#([\w.-]+)/g)) {
				expect(minted.get(slug!), `${file} -> /api/${slug}#${fragment}`).toContain(
					fragment!,
				);
				checkedLinks += 1;
			}
		}
		expect(checkedLinks).toBeGreaterThan(0);
	});
});

describe("anchor collision and prediction rules", () => {
	it("uniquifies case collisions in render order (types before props before functions)", () => {
		const sample = results
			.get("docmodel-sample.json")!
			.pageModels.find((page) => page.slug === "Sample")!;
		const anchorOf = (suffix: string) =>
			Object.entries(sample.anchors).find(([id]) => id.endsWith(suffix))?.[1];
		expect(anchorOf("#type.Action")).toBe("action");
		expect(anchorOf("#fn.Sample.action")).toBe("action-1");
		expect(anchorOf("#reexport.State")).toBe("state");
		expect(anchorOf("#fn.Sample.state")).toBe("state-1");
	});

	const miniModel = (doc: string, fnName = "Connect") =>
		modelJson([
			{
				id: "src/init.luau",
				instancePath: ["Mini"],
				name: "Mini",
				doc,
				source: { file: "src/init.luau", line: 1 },
				members: [
					{
						id: `src/init.luau#fn.Mini.${fnName}`,
						name: fnName,
						kind: "function",
						visibility: "public",
						tags: { custom: [] },
						errors: [],
						signature: {
							callee: `Mini.${fnName}`,
							segs: ["()"],
							params: [],
							returns: [],
						},
						source: { file: "src/init.luau", line: 5 },
					},
				],
			},
		]);

	const memberId = (html: string): string | undefined =>
		/<h3 id="([^"]*)"[^>]*><code[^>]*>Connect<\/code>/.exec(html)?.[1];

	it.each([
		["ATX heading in prose", "## Connect\n\nProse.", "connect-1"],
		["setext === heading in prose", "Connect\n========\n\nProse.", "connect-1"],
		["setext --- heading in prose", "Connect\n--------\n\nProse.", "connect-1"],
		["blockquote ATX heading", "> ## Connect\n>\n> Quoted prose.", "connect-1"],
		["quoted setext heading", "> Connect\n> ---", "connect-1"],
		["thematic break", "---\n\nProse.", "connect"],
		["list item above thematic break", "- Connect\n---\n\nProse.", "connect"],
		["lazy quoted line over thematic break", "> Connect\n---", "connect"],
		["heading ending in inline html", "## Connect <br>", "connect-1"],
		[
			"heading carrying a component badge",
			'## Connect <Badge type="tip" text="new" />',
			"connect-1",
		],
		["heading ending in an emoji shortcode", "## Connect :tada:", "connect-1"],
		[
			"heading written as a reference link",
			"## [Connect][c]\n\n[c]: https://example.com",
			"connect-1",
		],
		["heading given the member's explicit id", "## Something {#connect}", "connect-1"],
		["heading given another explicit id", "## Connect {#other}", "connect"],
		[
			"ATX heading after inline html paragraph",
			"<b>Note</b> something\n## Connect",
			"connect-1",
		],
		["ATX heading after self-closing component", '<Badge text="x" />\n## Connect', "connect-1"],
		["heading in bullet list item", "- ## Connect", "connect-1"],
		["heading in ordered list item", "1. ## Connect", "connect-1"],
		["heading swallowed by inline tag html block", "<b>\n## Connect\n\nx", "connect"],
		[
			"heading swallowed by component html block",
			"<Widget>\n## Connect\n\n</Widget>",
			"connect",
		],
	])("predicts %s", (_case, prose, expected) => {
		const page = emitDocsFromJson(miniModel(`Intro.\n\n${prose}\n`), testConfig());
		expect(page.pageModels[0]!.anchors["src/init.luau#fn.Mini.Connect"]).toBe(expected);
		expect(memberId(render(page.pages.get("Mini.md")!, "/api/Mini.md"))).toBe(expected);
	});

	it("yields to headings inside a member's doc or deprecation notice", () => {
		const fn = (name: string, extra: object = {}) => ({
			id: `src/init.luau#fn.Mini.${name}`,
			name,
			kind: "function",
			visibility: "public",
			tags: { custom: [] },
			errors: [],
			signature: { callee: `Mini.${name}`, segs: ["()"], params: [], returns: [] },
			source: { file: "src/init.luau", line: 5 },
			...extra,
		});
		const emitted = emitDocsFromJson(
			modelJson([
				{
					id: "src/init.luau",
					instancePath: ["Mini"],
					name: "Mini",
					source: { file: "src/init.luau", line: 1 },
					members: [
						fn("alpha", { doc: "Body.\n\n## Details\n\nMore." }),
						fn("beta", {
							tags: { custom: [], deprecated: { note: "## Migrate\n\nUse alpha." } },
						}),
						fn("details"),
						fn("migrate"),
					],
				},
			]),
			testConfig(),
		);
		const anchors = emitted.pageModels[0]!.anchors;
		const ids = mintedIds(render(emitted.pages.get("Mini.md")!, "/api/Mini.md"));
		expect(anchors["src/init.luau#fn.Mini.details"]).toBe("details-1");
		expect(anchors["src/init.luau#fn.Mini.migrate"]).toBe("migrate-1");
		expect(ids).toEqual(
			expect.arrayContaining(["details", "details-1", "migrate", "migrate-1"]),
		);
	});
});

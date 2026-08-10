/**
 * Anchor round-trip through the REAL VitePress renderer, in stock configuration.
 *
 * The emitter writes no explicit `{#id}`: VitePress mints every heading id, and
 * `mintAnchors` predicts what it will mint. That prediction fails *silently* in
 * production, since VitePress strips `[?#].*$` from a link before its dead-link
 * check. Hence the two sweeps below: every anchor the emitter recorded must
 * exist on its rendered page, and every fragment it wrote must resolve.
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

// vitepress wants a srcDir on disk. Nothing is written to it, but it is removed
// with the suite rather than left behind in the system temp dir.
const tempDir = makeTempDirFactory("luaudocs-anchors-");

// no `anchor.slugify` override: the point is to drive the stock configuration
// a generated site has
let render: (content: string, path: string) => string;
beforeAll(async () => {
	const md = await createMarkdownRenderer(tempDir(), {}, "/");
	// the one core rule the generated site adds to its renderer
	md.core.ruler.before("block", "luaudocs_docusaurus", (state) => {
		state.src = rewriteMarkup(state.src);
		return true;
	});
	render = (content, path) => {
		// frontmatter is handled outside markdown-it in a real build
		const body = stripFrontmatter(content);
		return md.render(body, { path, relativePath: path.slice(1), cleanUrls: true });
	};
});

/** Every heading id the renderer minted, in document order. */
const mintedIds = (html: string): string[] =>
	[...html.matchAll(/<h[1-6][^>]*\sid="([^"]*)"/g)].map((match) => match[1]!);

describe.each(captures)("minted anchors: %s", (fixture) => {
	const result = results.get(fixture)!;

	/** slug -> the ids VitePress actually minted on that page. */
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

	it("records only anchors the renderer mints", () => {
		let checked = 0;
		for (const page of result.pageModels) {
			for (const [id, anchor] of Object.entries(page.anchors)) {
				expect(minted.get(page.slug), page.slug).toBeDefined();
				expect(minted.get(page.slug)!, `${page.slug}: ${id} -> #${anchor}`).toContain(
					anchor,
				);
				checked += 1;
			}
		}
		// the sweep is worthless if the fixture stopped recording anchors: an
		// empty anchors map on every page is the silent regression itself
		expect(checked).toBeGreaterThan(0);
	});

	it("emits no fragment that does not resolve", () => {
		let checked = 0;
		const documents: Array<[string, string]> = [...result.pages];
		if (result.apiIndex !== undefined) {
			documents.push(["index.md", result.apiIndex]);
		}
		for (const [file, markdown] of documents) {
			for (const [, slug, fragment] of markdown.matchAll(/\/api\/([\w.-]+)#([\w.-]+)/g)) {
				const targets = minted.get(slug!);
				expect(targets, `${file} links to unknown page /api/${slug}`).toBeDefined();
				expect(targets!, `${file} -> /api/${slug}#${fragment}`).toContain(fragment!);
				checked += 1;
			}
		}
		// the sweep is worthless if the fixture stopped producing cross-page links
		expect(checked).toBeGreaterThan(0);
	});
});

describe("render-order uniquifying", () => {
	it("uniquifies a case collision in render order, types first", () => {
		// Sample has both a `State` re-export prop and a `state()` function, and
		// both an `Action` type and an `action()` function. Anchors are
		// case-insensitive, so one of each pair takes the `-1` suffix, and
		// render order decides which: `## Types` precedes the member lists, and
		// props precede functions.
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
});

describe("collisions with headings the page mints itself", () => {
	const miniModel = (doc: string, fnName: string) =>
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

	const anchorFor = (
		emitted: ReturnType<typeof emitDocsFromJson>,
		fnName: string,
	): string | undefined => emitted.pageModels[0]!.anchors[`src/init.luau#fn.Mini.${fnName}`];

	it("yields to a heading written in the module's own prose", () => {
		// the prose `## Connect` renders before the member lists, so it takes
		// `#connect` and the member is pushed to `#connect-1`
		const collide = emitDocsFromJson(
			miniModel("Intro.\n\n## Connect\n\nProse.", "Connect"),
			testConfig(),
		);
		expect(anchorFor(collide, "Connect")).toBe("connect-1");
		expect(mintedIds(render(collide.pages.get("Mini.md")!, "/api/Mini.md"))).toContain(
			"connect-1",
		);
	});

	// markdown-it-anchor keys off `heading_open`, not the `#` spelling, so these
	// mint ids too. Each assertion is two-sided: the member must be pushed to
	// `-1`, AND the renderer must really have minted that id.
	it("yields to a setext heading in the module's own prose", () => {
		for (const underline of ["========", "--------"]) {
			const collide = emitDocsFromJson(
				miniModel(`Intro.\n\nConnect\n${underline}\n\nProse.`, "Connect"),
				testConfig(),
			);
			expect(anchorFor(collide, "Connect"), underline).toBe("connect-1");
			expect(mintedIds(render(collide.pages.get("Mini.md")!, "/api/Mini.md"))).toContain(
				"connect-1",
			);
		}
	});

	it("yields to a heading nested in a blockquote", () => {
		const collide = emitDocsFromJson(
			miniModel("Intro.\n\n> ## Connect\n>\n> Quoted prose.", "Connect"),
			testConfig(),
		);
		expect(anchorFor(collide, "Connect")).toBe("connect-1");
		expect(mintedIds(render(collide.pages.get("Mini.md")!, "/api/Mini.md"))).toContain(
			"connect-1",
		);
	});

	// the over-prediction side: `---` that is a thematic break or a list marker
	// mints nothing, so the member must keep the unsuffixed anchor
	it("does not yield to a thematic break or a list above one", () => {
		for (const doc of ["Intro.\n\n---\n\nProse.", "Intro.\n\n- Connect\n---\n\nProse."]) {
			const page = emitDocsFromJson(miniModel(doc, "Connect"), testConfig());
			expect(anchorFor(page, "Connect"), doc).toBe("connect");
			expect(mintedIds(render(page.pages.get("Mini.md")!, "/api/Mini.md"))).toContain(
				"connect",
			);
		}
	});
});

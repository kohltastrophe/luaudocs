/**
 * The renderer over the two captured doc-models, plus inline models for the
 * rules the fixtures cannot isolate. The page snapshots own the output in
 * full; every marker-table row below is a substring of the snapshot beside it,
 * named so a blind `vitest run -u` cannot silently drop a feature.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { parseDocModel } from "../src/docmodel";
import { apiSidebar, apiTrails, buildAccessTree, type SidebarItem } from "../src/nav";
import type { PageModel } from "../src/pages";
import { emitDocsFromJson } from "../src/render";
import {
	decodeLinks,
	LINKS_TOKEN,
	parseLinks,
	relayLinks,
	signatureLinks as linksTransformer,
} from "../templates/runtime/signature-links";
import {
	has,
	memberBlock,
	modelJson,
	outline,
	readFixture,
	signatureLinks,
	signatureSpans,
	testConfig,
} from "./helpers";

const sampleJson = readFixture("docmodel-sample.json");

const SAMPLE_CONFIG = testConfig({
	repo: { url: "https://github.com/example/Sample", branch: "main" },
});

const result = emitDocsFromJson(sampleJson, SAMPLE_CONFIG);
const sample = result.pages.get("Sample.md")!;
const state = result.pages.get("State.md")!;
const type = result.pages.get("Type.md")!;

describe("emitDocs on the Sample fixture", () => {
	it("produces one page per module plus the separate index", () => {
		// seven modules, six pages: src/Tween.luau is reached only through
		// require-locals, so it contributes types but earns no page
		expect([...result.pages.keys()].sort()).toEqual([
			"Color.md",
			"Interpolate.md",
			"Query.md",
			"Sample.md",
			"State.md",
			"Type.md",
		]);
		expect(result.apiIndex).toBeDefined();
	});

	it("matches the Sample page snapshot", async () => {
		await expect(sample).toMatchFileSnapshot("__snapshots__/sample/Sample.md");
	});

	it("matches the State page snapshot", async () => {
		await expect(state).toMatchFileSnapshot("__snapshots__/sample/State.md");
	});

	it("matches the Color page snapshot (nested sections)", async () => {
		await expect(result.pages.get("Color.md")).toMatchFileSnapshot(
			"__snapshots__/sample/Color.md",
		);
	});

	it("matches the Type page snapshot (types only)", async () => {
		await expect(type).toMatchFileSnapshot("__snapshots__/sample/Type.md");
	});

	it("matches the Query page snapshot (plain --[[ ]] doc comments)", async () => {
		await expect(result.pages.get("Query.md")).toMatchFileSnapshot(
			"__snapshots__/sample/Query.md",
		);
	});

	it("matches the Interpolate page snapshot (callable module, no members)", async () => {
		await expect(result.pages.get("Interpolate.md")).toMatchFileSnapshot(
			"__snapshots__/sample/Interpolate.md",
		);
	});

	it("matches the API index snapshot", async () => {
		await expect(result.apiIndex).toMatchFileSnapshot("__snapshots__/sample/index.md");
	});

	// no sidebar snapshot anywhere: grouping is pinned as data by outline() in
	// the nav suites below, and compiled for real by the e2e build in CI

	it.each([
		// Type.luau is the only fixture module naming Roblox classes, so these
		// two rows are the whole end-to-end cover for linkRobloxTypes: a
		// string-literal class name and a plain identifier
		[
			"a Roblox class named as a string literal linked to the engine docs",
			signatureLinks(type).join("\n"),
			"https://create.roblox.com/docs/reference/engine/classes/Frame",
		],
		[
			"a Roblox class named as an identifier linked to the engine docs",
			signatureLinks(type).join("\n"),
			"https://create.roblox.com/docs/reference/engine/classes/Instance",
		],
		// `#state-1`, not `#state`: the State page's H1 mints `state` first, and
		// the type heading below it takes the uniquified spelling
		[
			"a State type cross-linked from a Sample signature",
			signatureLinks(sample).join("\n"),
			"/api/State#state-1",
		],
		// the badge is self-closing and the source link an empty anchor, so
		// neither contributes text to the id VitePress mints. A plain typealias
		// is a "type"; only an interface declaration makes an interface.
		[
			"a member heading carrying its source link",
			state,
			/### `Connect` <a class="source-link ignore-header" href="[^"]+"[^>]*><\/a>\n/,
		],
		[
			"a plain typealias badged `type` rather than `interface`",
			state,
			/### `StateData` <Badge type="info" text="type" \/> <a class="source-link ignore-header" href="[^"]+"/,
		],
		// the block is a plain fence carrying its links as offsets; the site's
		// Shiki transformer turns them into anchors (rendered for real by the
		// e2e build)
		["signatures as luau fences carrying a link table", state, "```luau luaudocs-links=[["],
		[
			"a cross-module type linked inside a signature",
			signatureLinks(state).join("\n"),
			"/api/Type#function",
		],
		[
			"a method signature spelled with its colon callee",
			state,
			"State:Connect(callback: Type.Function): Type.Function",
		],
		// the link wraps the badge rather than filling its slot: slot text would
		// join the minted heading id (`state-module` instead of `state`)
		[
			"a module re-export inlined as a badged property linking to its page",
			sample,
			/### `State` <a href="\/api\/State" class="badge-link ignore-header"><Badge type="info" text="Module" \/><\/a>/,
		],
		[
			"that property's type linked to the re-exported module's page",
			signatureLinks(sample).join("\n"),
			"/api/State",
		],
		["the re-exported module under the consumer's name", sample, "Sample.State: State"],
		[
			"a member re-export badged with where it came from",
			sample,
			/### `raw` <a href="\/api\/State#raw" class="badge-link ignore-header"><Badge type="info" text="from State" \/><\/a>/,
		],
		[
			"a re-exported member under the consumer's name",
			sample,
			"Sample.isState(object: any): boolean",
		],
		// `Action` carries no `export`, but `Sample.action` returns it; the rule
		// itself is covered in "unexported types on the public surface" below
		["an unexported type the public surface names", sample, /### `Action`/],
	])("keeps %s", (_feature, haystack, marker) => has(haystack, marker));

	it.each([
		["pre-baked highlight spans, which belong to the site", state, "--shiki-light"],
		["private members", state, "_updateDependence"],
		["types as field tables", state, "| Field | Type | Description |"],
		["a Re-exports section", sample, "## Re-exports"],
		// the trail is injected at render time from the baked map, never written
		// into the page (templates/runtime/markup.ts)
		["a navigation trail", state, "luaudocs-trail"],
	])("never emits %s", (_feature, haystack, marker) => expect(haystack).not.toContain(marker));

	it("links /api/ pages that exist, and only those", () => {
		const slugs = new Set([...result.pages.keys()].map((file) => file.replace(/\.md$/, "")));
		let checked = 0;
		const documents = [...result.pages.values(), result.apiIndex!];
		for (const markdown of documents) {
			for (const [, slug] of markdown.matchAll(/\]\(\/api\/([\w.-]+)/g)) {
				expect(slugs, `prose link to /api/${slug}`).toContain(slug!);
				checked += 1;
			}
		}
		for (const markdown of documents) {
			for (const span of signatureSpans(markdown)) {
				const slug = span.url.match(/^\/api\/([\w.-]+)/)?.[1];
				if (slug !== undefined) {
					expect(slugs, `signature link to ${span.url}`).toContain(slug);
					checked += 1;
				}
			}
		}
		expect(checked).toBeGreaterThan(0);
	});

	it("sorts Types ahead of Properties", () => {
		expect(state.indexOf("## Types")).toBeGreaterThan(-1);
		expect(state.indexOf("## Types")).toBeLessThan(state.indexOf("## Properties"));
	});

	it("includes private members when asked", () => {
		const withPrivate = emitDocsFromJson(
			sampleJson,
			testConfig({ api: { includePrivate: true } }),
		);
		expect(withPrivate.pages.get("State.md")).toContain("_updateDependence");
	});

	it("leaves the re-export badge unlinked when the target resolves nowhere", () => {
		const model = JSON.parse(sampleJson) as { modules: Array<{ name: string }> };
		// drop the target module: nothing left for State#raw to point at
		model.modules = model.modules.filter((module) => module.name !== "State");
		const orphaned = emitDocsFromJson(JSON.stringify(model), SAMPLE_CONFIG).pages.get(
			"Sample.md",
		)!;
		expect(orphaned).toMatch(/### `raw` <Badge type="info" text="Re-export" \/>/);
		expect(orphaned).not.toContain("(/api/State");
	});

	it("emits nothing for a model with no modules", () => {
		const empty = emitDocsFromJson(modelJson([]), testConfig());
		expect(empty.pages.size).toBe(0);
		// an API index of nothing, linked from a nav entry, is worse than none
		expect(empty.apiIndex).toBeUndefined();
		expect(empty.sidebar).toEqual([]);
	});
});

const tagsResult = emitDocsFromJson(
	readFixture("docmodel-tags.json"),
	testConfig({
		title: "Tagged",
		repo: { url: "https://github.com/example/tagged", branch: "main" },
	}),
);
const tagged = tagsResult.pages.get("Tagged.md")!;
const widget = tagsResult.pages.get("Widget.md")!;

describe("emitDocs on the tag-torture fixture", () => {
	it("produces the Tagged and Widget pages plus the separate index", () => {
		expect([...tagsResult.pages.keys()].sort()).toEqual(["Tagged.md", "Widget.md"]);
		expect(tagsResult.apiIndex).toBeDefined();
	});

	it("matches the Tagged page snapshot (badges, errors, deprecation, factory class)", async () => {
		await expect(tagged).toMatchFileSnapshot("__snapshots__/tags/Tagged.md");
	});

	it("matches the Widget page snapshot (@within relocation, interface, externals)", async () => {
		await expect(widget).toMatchFileSnapshot("__snapshots__/tags/Widget.md");
	});

	it("matches the API index snapshot", async () => {
		await expect(tagsResult.apiIndex).toMatchFileSnapshot("__snapshots__/tags/index.md");
	});

	it.each([
		["the deprecation badge", tagged, '<Badge type="danger" text="Deprecated since v2" />'],
		["the unreleased badge", tagged, '<Badge type="warning" text="Unreleased" />'],
		["the yields badge", tagged, '<Badge type="warning" text="Yields" />'],
		[
			"the server realm badge",
			tagged,
			'<Badge type="info" text="Server" class="luaudocs-server" />',
		],
		[
			"the client realm badge",
			widget,
			'<Badge type="info" text="Client" class="luaudocs-client" />',
		],
		[
			"the plugin realm badge",
			tagged,
			'<Badge type="info" text="Plugin" class="luaudocs-plugin" />',
		],
		["the class-level custom-tag badge", widget, '<Badge type="info" text="ui" />'],
		["the since badge", tagged, '<Badge type="tip" text="since v0.9.0" />'],
		["the custom-tag badge", tagged, '<Badge type="info" text="constructor" />'],
		["the read-only badge", widget, '<Badge type="info" text="Read Only" />'],
		// code-signal detection: badges on members whose doc blocks carry no tag
		[
			"a Yields badge detected from the body",
			tagged,
			'### `flush` <Badge type="warning" text="Yields" />',
		],
		[
			"a realm badge detected from the body",
			widget,
			'### `activate` <Badge type="info" text="Client" class="luaudocs-client" />',
		],
		[
			"a tagged realm beating the detected one",
			tagged,
			'### `mirror` <Badge type="info" text="Server" class="luaudocs-server" />',
		],
		[
			"a Read Only badge from a frozen container",
			tagged,
			'### `maxWidgets` <Badge type="info" text="Read Only" />',
		],
		[
			"a param doc read from its trailing comment",
			widget,
			"- `scale`: multiplier against the base size",
		],
		[
			"an @param beating the trailing comment",
			widget,
			"- `skin`: the tag wins over the trailing comment",
		],
		["the deprecation notice", tagged, "::: warning DEPRECATED"],
		["prose refs resolved inside that notice", tagged, "[`Tagged.create`](/api/Tagged#create)"],
		["the Errors table", tagged, "| `string` | when the datastore is unavailable |"],
		[
			"an @external name linked in prose",
			tagged,
			"[`Promise`](https://eryn.io/roblox-lua-promise/lib/)",
		],
		[
			"an @external name linked in a signature",
			signatureLinks(widget).join("\n"),
			"https://eryn.io/roblox-lua-promise/lib/",
		],
		// docusaurus markup ships through untouched: the synced VitePress runtime
		// rewrites it when the site renders, in guides and doc comments alike
		["docusaurus admonitions for the render-time rewrite", widget, ":::caution"],
		["docusaurus tab markup for the render-time rewrite", widget, '<TabItem value="named"'],
		// the only fenced code in either fixture, so this row also proves a code
		// block survives doc-comment segmentation at all
		["a fenced example inside a tab", widget, '```luau\nlocal widget = Widget.new("panel")'],
		// inferred types: neither prop declares one, so the row proves the
		// extractor supplied it and that it survives to the page
		["a prop typed from what its callee returns", tagged, "Tagged.blank: Widget"],
		["that inferred type linked to the callee's own module", tagged, '"/api/Widget#widget-1"'],
		["a floating @prop type outranking the inferred one", widget, "Widget.slots: { string }"],
		[
			"a conditional mount badging its realm and typing itself optional",
			tagged,
			'### `storage` <Badge type="info" text="Server" class="luaudocs-server" />',
		],
		["that mount's optional type", tagged, "Tagged.storage: Instance?"],
		["a prop aliasing a container linked to its section", tagged, '"/api/Tagged#limits"'],
		["a cross-module @prop relocated by @within", widget, "### `theme`"],
		["a cross-module @function relocated by @within", widget, "### `describe`"],
		["a cross-module @method relocated by @within", widget, "### `refresh`"],
		["a floating @type's declared alias", widget, "### `ThemeName`"],
		// `persist` arrives twice: init.luau declares it in tags alone, then
		// extra.luau's real function claims the same name on Widget. The badge
		// proves the stub's tags merged in, the signature that the code side
		// kept the slot.
		[
			"a tag stub's badge merged onto the code member that displaced it",
			widget,
			'### `persist` <Badge type="info" text="storage" />',
		],
		[
			"that member's signature read off the code, not the stub",
			widget,
			"Widget.persist(widget: any): boolean",
		],
		// the heading and the param list carry the same names, so this asserts
		// the reconstructed body itself: no declaration behind it, no match
		[
			"the @interface declaration rebuilt from its fields",
			widget,
			"type WidgetOptions = {\n    -- display name\n    name: string,",
		],
		["an @field doc injected at the extractor's display line", widget, "-- reject empty names"],
		// fields of an intersection operand, which a table walk cannot line up
		[
			"the `frozen` @field doc injected into an intersection display",
			widget,
			"-- no further updates",
		],
		[
			"the `at` @field doc injected into an intersection display",
			widget,
			"-- capture timestamp",
		],
		// a nested class renders its short heading but calls members by the
		// dotted container the extractor baked into their callees
		[
			"a dotted @class name kept whole in its member callees",
			widget,
			"Widget.Skin.border: number",
		],
	])("keeps %s", (_feature, haystack, marker) => has(haystack, marker));

	it.each([
		["@private members", tagged, "internalReset"],
		["@ignore members", tagged, "debugDump"],
		["@ignore types", widget, "### `Internal`"],
		["@within tags leaking into the page", widget, "@within"],
		// categories are gone: a custom tag renders as a badge on its member,
		// never as a heading that would reorder the outline
		["category headings", tagged, "### constructor\n"],
	])("never emits %s", (_feature, haystack, marker) => expect(haystack).not.toContain(marker));

	// the tag-documented field gains a comment; the source-documented ones keep
	// theirs without repeating the doc
	it("never repeats a field doc the display already carries", () => {
		expect(widget.match(/Fired when the rename lands/g)).toHaveLength(1);
		expect(widget.match(/-- skip events/g)).toHaveLength(1);
	});

	it("nests the mounted Widget page under the Tagged entry", () => {
		expect(outline(tagsResult.sidebar)).toEqual(["Overview", "Tagged > Widget"]);
	});
});

describe("verbatim signatures and param/return docs", () => {
	const json = modelJson([
		{
			id: "Mini",
			instancePath: ["Mini"],
			name: "Mini",
			types: [
				{
					id: "Mini#type.Options",
					name: "Options",
					exported: true,
					kind: "alias",
					generics: [],
					// the author's own layout, line by line; nothing reformats it
					definition: [["{"], ["\tname: string,"], ["\tretries: number,"], ["}"]],
					fields: [
						{ name: "name", type: ["string"], doc: "Display name.", line: 2 },
						{ name: "retries", type: ["number"], line: 3 },
						// no line: the definition spells no slot for it, so the doc
						// renders as a prose field list instead of a guessed splice
						{ name: "timeout", type: ["number"], doc: "Overall deadline." },
					],
					tags: { custom: [] },
					visibility: "public",
					source: { file: "src/init.luau", line: 30 },
				},
				{
					id: "Mini#type.Manual",
					name: "Manual",
					exported: true,
					// a tag-declared type: no typealias behind it, so no definition
					kind: "interface",
					generics: [],
					fields: [
						{ name: "id", type: ["number"], doc: "Unique id." },
						{ name: "label", type: ["string"] },
					],
					tags: { custom: [] },
					visibility: "public",
					source: { file: "src/init.luau", line: 40 },
				},
			],
			reexports: [
				{
					id: "Mini#reexport.helper",
					name: "helper",
					targetModule: "Helper",
					doc: "The **helper** module.",
				},
			],
			source: { file: "src/init.luau", line: 1 },
			members: [
				{
					id: "Mini#fn.configure",
					name: "configure",
					kind: "function",
					tags: { custom: [] },
					visibility: "public",
					signature: {
						callee: "Mini.configure",
						segs: [
							"(applicationName: string, retryPolicyDescription: string, maximumAttemptCount: number): boolean",
						],
						params: [
							{
								name: "applicationName",
								type: ["string"],
								doc: "Name of the application.",
							},
							{ name: "retryPolicyDescription", type: ["string"] },
							{
								name: "maximumAttemptCount",
								type: ["number"],
								doc: "Upper bound of attempts.",
							},
						],
						returns: [{ type: ["boolean"], doc: "Whether it worked." }],
					},
					errors: [],
					source: { file: "src/init.luau", line: 10, endLine: 20 },
				},
			],
		},
		{
			id: "Helper",
			instancePath: ["Helper"],
			name: "Helper",
			doc: "A helper.",
			source: { file: "src/Helper.luau", line: 1 },
		},
	]);
	let page: string;
	beforeAll(() => {
		page = emitDocsFromJson(json, testConfig()).pages.get("Mini.md")!;
	});

	// signatures are emitted as the extractor sliced them, however long: every
	// link is placed by character offset into this exact string, so a formatter
	// here would move them. Long lines wrap in the browser.
	it("emits a long signature verbatim rather than reformatting it", () => {
		expect(page).toContain(
			"Mini.configure(applicationName: string, retryPolicyDescription: string, maximumAttemptCount: number): boolean",
		);
	});

	it("lists only documented parameters and returns", () => {
		expect(page).toContain(
			"**Parameters**\n\n- `applicationName`: Name of the application.\n- `maximumAttemptCount`: Upper bound of attempts.",
		);
		expect(page).toContain("**Returns**\n\n- `boolean`: Whether it worked.");
		expect(page).not.toContain("retryPolicyDescription`:");
	});

	it("injects field docs as comments into the type code block", () => {
		// the definition's own indentation, kept: the display is the author's
		// spelling and nothing reformats it
		expect(page).toContain(
			"type Options = {\n\t-- Display name.\n\tname: string,\n\tretries: number,\n}",
		);
	});

	it("lists a documented field the definition spells no line for as prose", () => {
		expect(memberBlock(page, "Options")).toContain(
			"**Fields**\n\n- `timeout`: Overall deadline.",
		);
		// and never as a guessed comment inside the code
		expect(page).not.toContain("-- Overall deadline.");
	});

	it("rebuilds synthetic interface declarations from their fields", () => {
		expect(page).toContain(
			"type Manual = {\n    -- Unique id.\n    id: number,\n    label: string,\n}",
		);
	});

	it("inlines documented re-exports with their doc prose", () => {
		expect(page).toContain("Mini.helper: Helper");
		expect(page).toContain("The **helper** module.");
		expect(page).not.toContain("## Re-exports");
	});
});

// only type positions may link. Each member below carries a resolvable ref
// whose name its head also spells, so a link boundary landing inside the head
// would show up as an extra span.
describe("type declaration link boundaries", () => {
	const decl = (name: string, extra: object) => ({
		id: `Mini#type.${name}`,
		name,
		exported: true,
		generics: [],
		tags: { custom: [] },
		visibility: "public",
		source: { file: "src/init.luau", line: 1 },
		...extra,
	});
	const json = modelJson([
		{
			id: "Mini",
			instancePath: ["Mini"],
			name: "Mini",
			source: { file: "src/init.luau", line: 1 },
			types: [
				decl("Fallback", { kind: "alias", definition: [["string"]] }),
				// Fallback is spelled twice: as the generic default (head) and inside
				// the definition, and both are ref segments the renderer must link
				decl("Registry", {
					kind: "alias",
					generics: [
						{
							name: "T",
							isPack: false,
							default: [{ text: "Fallback", id: "Mini#type.Fallback" }],
						},
					],
					definition: [
						[
							"{ items: { T }, last: ",
							{ text: "Fallback", id: "Mini#type.Fallback" },
							" }",
						],
					],
				}),
				// typeFence stops at the head, so the self-naming ref gives it a
				// target it would link if any of the head were linkable
				decl("Widen", {
					kind: "typefunction",
					generics: [{ name: "T", isPack: false }],
					definition: [[{ text: "Widen", id: "Mini#type.Widen" }]],
				}),
				decl("Slot", { kind: "alias", definition: [["number"]] }),
				// Slot is spelled twice: as a field key and as its neighbour's
				// type. Only the second is a ref segment.
				decl("Keyed", {
					kind: "alias",
					definition: [
						["{ Slot: string, active: ", { text: "Slot", id: "Mini#type.Slot" }, " }"],
					],
				}),
				// the same collision through the rebuilt-from-fields path, where
				// the renderer counts the offsets itself
				decl("Built", {
					kind: "interface",
					fields: [
						{ name: "Slot", type: ["string"] },
						{ name: "active", type: [{ text: "Slot", id: "Mini#type.Slot" }] },
					],
				}),
			],
		},
	]);
	let page: string;
	beforeAll(() => {
		page = emitDocsFromJson(json, testConfig()).pages.get("Mini.md")!;
	});

	it("links a generic default in the head like any other type position", () => {
		expect(page).toContain("type Registry<T = Fallback> = { items: { T }, last: Fallback }");
		// two spans: the head's default and the definition's Fallback
		const spans = signatureSpans(page).filter((span) => span.url === "/api/Mini#fallback");
		expect(spans).toHaveLength(2);
		// the first sits in the generics head, the second in the definition,
		// either side of the `> = ` that separates them
		const definitionAt = spans[0]!.code.indexOf("> = ");
		expect(spans[0]!.start).toBeLessThan(definitionAt);
		expect(spans[1]!.start).toBeGreaterThan(definitionAt);
	});

	it("links nothing in a type function signature", () => {
		expect(page).toContain("type function Widen<T>");
		expect(signatureLinks(page)).not.toContain("/api/Mini#widen");
	});

	// one span, sitting after `active`: the type, not the key of the same name
	// earlier in the display. A count alone would pass with the link on the key.
	const linksOnce = (block: string) => {
		const spans = signatureSpans(block).filter((span) => span.url === "/api/Mini#slot");
		expect(spans).toHaveLength(1);
		expect(spans[0]!.text).toBe("Slot");
		expect(spans[0]!.start).toBeGreaterThan(spans[0]!.code.indexOf("active"));
	};

	it("links a field's type but never a key spelled like it", () => {
		const block = memberBlock(page, "Keyed");
		expect(block).toContain("type Keyed = { Slot: string, active: Slot }");
		linksOnce(block);
	});

	it("places links the same way in a table rebuilt from fields", () => {
		const block = memberBlock(page, "Built");
		expect(block).toContain("type Built = {\n    Slot: string,\n    active: Slot,\n}");
		linksOnce(block);
	});
});

// the collapsed/link shape of a nested group is the nav suite's job below; what
// only the full pipeline can show is that re-exports reach the nav as access edges
describe("access-graph grouping end to end", () => {
	let regrouped: ReturnType<typeof emitDocsFromJson>;
	beforeAll(() => {
		const model = JSON.parse(sampleJson) as {
			modules: Array<{
				id: string;
				reexports: Array<{ id: string; name: string; targetModule: string }>;
			}>;
		};
		const byId = (id: string) => model.modules.find((module) => module.id === id)!;
		// re-home Query: reached as Sample.State.Query instead of Sample.Query;
		// Interpolate is no longer exposed by the root value at all, so it falls
		// back to its place in the rojo tree (a sibling under Sample)
		byId("src/init.luau").reexports = byId("src/init.luau").reexports.filter(
			(reexport) => reexport.name !== "Query" && reexport.name !== "Interpolate",
		);
		byId("src/State.luau").reexports.push({
			id: "src/State.luau#reexport.Query",
			name: "Query",
			targetModule: "src/Query.luau",
		});
		regrouped = emitDocsFromJson(JSON.stringify(model), SAMPLE_CONFIG);
	});

	it("nests pages under the module that re-exports them, all inside the entry's section", () => {
		expect(outline(regrouped.sidebar)).toEqual([
			"Overview",
			"Sample > Color",
			"Sample > Interpolate",
			"Sample > State > Query",
			"Sample > Type",
		]);
	});

	it("renders the API index as the access tree", () => {
		const index = regrouped.apiIndex!;
		expect(index).toContain("- [Sample](/api/Sample)");
		expect(index).toContain("    - [State](/api/State)\n        - [Query](/api/Query)");
		// the wrapper the tree lines are drawn from, inside the region so a
		// guide including the tree gets them too
		expect(index).toMatch(/#region reference -->\n\n<div class="luaudocs-tree">/);
	});
});

describe("unexported types on the public surface", () => {
	const decl = (name: string, exported: boolean, definition: unknown[]) => ({
		id: `src/init.luau#type.${name}`,
		name,
		exported,
		kind: "alias",
		generics: [],
		definition: [definition],
		tags: { custom: [] },
		visibility: "public",
		source: { file: "src/init.luau", line: 1 },
	});
	const json = modelJson([
		{
			id: "src/init.luau",
			instancePath: ["Mini"],
			name: "Mini",
			source: { file: "src/init.luau", line: 1 },
			types: [
				decl("Named", false, [{ text: "Inner", id: "src/init.luau#type.Inner" }]),
				decl("Inner", false, ["string"]),
				decl("Unreachable", false, ["string"]),
				decl("Exported", true, ["string"]),
			],
			members: [
				{
					id: "src/init.luau#fn.Mini.make",
					name: "make",
					kind: "function",
					errors: [],
					tags: { custom: [] },
					visibility: "public",
					source: { file: "src/init.luau", line: 10 },
					signature: {
						callee: "Mini.make",
						segs: ["(): ", { text: "Named", id: "src/init.luau#type.Named" }],
						params: [],
						returns: [{ type: [{ text: "Named", id: "src/init.luau#type.Named" }] }],
					},
				},
			],
		},
	]);
	let page: string;
	beforeAll(() => {
		page = emitDocsFromJson(json, testConfig()).pages.get("Mini.md")!;
	});

	it("lists a type a public signature names", () => {
		expect(page).toMatch(/### `Named`/);
	});

	it("follows a listed type's own definition", () => {
		expect(page).toMatch(/### `Inner`/);
	});

	it("still lists exported types nothing names", () => {
		expect(page).toMatch(/### `Exported`/);
	});

	it("leaves an unexported type the surface never names off the page", () => {
		expect(page).not.toContain("Unreachable");
	});

	it("keeps the page in module order, not discovery order", () => {
		expect(page.indexOf("### `Named`")).toBeLessThan(page.indexOf("### `Inner`"));
	});
});

// `return require(X)` emits a module with aliasOf: it owns no page, and every
// route to it (re-export targets, entry exports) lands on X's page instead
describe("passthrough modules (aliasOf)", () => {
	const result = emitDocsFromJson(
		modelJson([
			{
				id: "src/init.luau",
				instancePath: ["Sample"],
				name: "Sample",
				entry: true,
				source: { file: "src/init.luau", line: 1 },
				reexports: [
					{
						id: "src/init.luau#reexport.Util",
						name: "Util",
						targetModule: "src/alias.luau",
					},
				],
			},
			{
				id: "src/alias.luau",
				instancePath: ["Sample", "Util"],
				name: "Util",
				aliasOf: "src/real.luau",
				source: { file: "src/alias.luau", line: 1 },
			},
			{
				id: "src/real.luau",
				// outside Sample's subtree, so nav placement can only come from
				// the export edge, never the instance-tree fallback
				instancePath: ["Vendor", "Real"],
				name: "Real",
				// a docless, memberless module earns no page at all
				doc: "The implementation behind the passthrough.",
				source: { file: "src/real.luau", line: 1 },
			},
		]),
		testConfig(),
	);

	it("emits no page for the passthrough itself", () => {
		expect([...result.pages.keys()].sort()).toEqual(["Real.md", "Sample.md"]);
	});

	it("sends the re-export badge to the aliased module's page", () => {
		const sample = result.pages.get("Sample.md")!;
		expect(sample).toContain('### `Util` <a href="/api/Real"');
		expect(sample).not.toContain("/api/Util");
	});

	// the sidebar flattens the entry root's children, so a direct entry mount
	// only shows its nesting in the API index
	it("nests the aliased module under the entry in the API index", () => {
		expect(result.apiIndex).toContain("- [Sample](/api/Sample)\n    - [Real](/api/Real)");
	});

	// the exposer sits below the entry root on purpose: the sidebar flattens the
	// entry's own children, so only a second hop can show the edge; Real's
	// instance path sits outside Sample so the instance-tree fallback cannot
	// produce the nesting either
	it("nests the aliased module's page under the module that mounts it", () => {
		const nested = emitDocsFromJson(
			modelJson([
				{
					id: "src/init.luau",
					instancePath: ["Sample"],
					name: "Sample",
					entry: true,
					source: { file: "src/init.luau", line: 1 },
					reexports: [
						{
							id: "src/init.luau#reexport.Middle",
							name: "Middle",
							targetModule: "src/middle.luau",
						},
					],
				},
				{
					id: "src/middle.luau",
					instancePath: ["Sample", "Middle"],
					name: "Middle",
					source: { file: "src/middle.luau", line: 1 },
					reexports: [
						{
							id: "src/middle.luau#reexport.Util",
							name: "Util",
							targetModule: "src/alias.luau",
						},
					],
				},
				{
					id: "src/alias.luau",
					instancePath: ["Sample", "Middle", "Util"],
					name: "Util",
					aliasOf: "src/real.luau",
					source: { file: "src/alias.luau", line: 1 },
				},
				{
					id: "src/real.luau",
					instancePath: ["Vendor", "Real"],
					name: "Real",
					doc: "The implementation behind the passthrough.",
					source: { file: "src/real.luau", line: 1 },
				},
			]),
			testConfig(),
		);
		expect(outline(nested.sidebar)).toEqual(["Overview", "Sample > Middle > Real"]);
	});
});

/*
 * One spelling, two targets: prose refs resolve by name, so a name owned by two
 * pages links neither (a coin flip would be a wrong link half the time), and
 * the build says which name it dropped.
 */
describe("ambiguous reference names", () => {
	const module = (id: string, name: string, doc?: string) => ({
		id,
		instancePath: [name],
		name,
		doc,
		source: { file: id, line: 1 },
		types: [
			{
				id: `${id}#type.Config`,
				name: "Config",
				exported: true,
				kind: "alias",
				generics: [],
				definition: [["string"]],
				tags: { custom: [] },
				visibility: "public",
				source: { file: id, line: 3 },
			},
		],
	});
	const result = emitDocsFromJson(
		modelJson([module("src/a.luau", "Alpha", "See [Config]."), module("src/b.luau", "Beta")]),
		testConfig(),
	);

	it("drops the name from the link table, and says which targets collided", () => {
		expect(result.warnings).toContain(
			"ambiguous reference name dropped from link table: Config (/api/Alpha#config vs /api/Beta#config)",
		);
		const alpha = result.pages.get("Alpha.md")!;
		expect(alpha).not.toContain("](/api/Alpha#config");
		expect(alpha).not.toContain("](/api/Beta#config");
	});
});

/*
 * The tiers above ambiguity: the value surface (pages, sections, members) owns
 * a spelling its same-named type would otherwise contest, and a pure
 * re-spelling alias cedes its bare name to the origin declaration, so only
 * equal-standing collisions drop a name.
 */
describe("reference name tiers", () => {
	const pureAlias = (id: string, line: number) => ({
		id: `${id}#type.Log`,
		name: "Log",
		exported: true,
		kind: "alias",
		generics: [],
		definition: [[{ text: "Signal.Log", id: "src/Signal.luau#type.Log" }]],
		tags: { custom: [] },
		visibility: "public",
		source: { file: id, line },
	});
	const result = emitDocsFromJson(
		modelJson([
			{
				id: "src/init.luau",
				instancePath: ["Root"],
				name: "Root",
				doc: "See [Signal], [Log], and [Root.Logger].",
				source: { file: "src/init.luau", line: 1 },
				members: [
					{
						id: "src/init.luau#prop.Root.Logger",
						name: "Logger",
						kind: "prop",
						tags: { custom: [] },
						visibility: "public",
						source: { file: "src/init.luau", line: 4 },
					},
				],
				types: [
					{
						id: "src/init.luau#type.Signal",
						name: "Signal",
						exported: true,
						kind: "alias",
						generics: [],
						definition: [["number"]],
						tags: { custom: [] },
						visibility: "public",
						source: { file: "src/init.luau", line: 3 },
					},
					{
						id: "src/init.luau#type.Logger",
						name: "Logger",
						exported: true,
						kind: "alias",
						generics: [],
						definition: [["string"]],
						tags: { custom: [] },
						visibility: "public",
						source: { file: "src/init.luau", line: 6 },
					},
					pureAlias("src/init.luau", 5),
				],
			},
			{
				id: "src/Mid.luau",
				instancePath: ["Root", "Mid"],
				name: "Mid",
				source: { file: "src/Mid.luau", line: 1 },
				types: [pureAlias("src/Mid.luau", 2)],
			},
			{
				id: "src/Signal.luau",
				instancePath: ["Root", "Signal"],
				name: "Signal",
				source: { file: "src/Signal.luau", line: 1 },
				types: [
					{
						id: "src/Signal.luau#type.Log",
						name: "Log",
						exported: true,
						kind: "alias",
						generics: [],
						definition: [["string"]],
						tags: { custom: [] },
						visibility: "public",
						source: { file: "src/Signal.luau", line: 2 },
					},
				],
			},
		]),
		testConfig(),
	);

	it("nothing here is ambiguous", () => {
		expect(result.warnings).toEqual([]);
	});

	it("a page holds its spelling against a same-named exported type", () => {
		expect(result.pages.get("Root.md")!).toContain("[`Signal`](/api/Signal)");
	});

	it("a member holds a qualified spelling against a same-named type", () => {
		expect(result.pages.get("Root.md")!).toContain("[`Root.Logger`](/api/Root#logger-1)");
	});

	it("pure aliases cede the bare spelling to the origin declaration", () => {
		expect(result.pages.get("Root.md")!).toContain("[`Log`](/api/Signal#log)");
	});
});

describe("non-identifier member names", () => {
	it("spells bracket access in the prop fence", () => {
		const result = emitDocsFromJson(
			modelJson([
				{
					id: "src/Fonts.luau",
					instancePath: ["Fonts"],
					name: "Fonts",
					source: { file: "src/Fonts.luau", line: 1 },
					members: [
						{
							id: "src/Fonts.luau#prop.Fonts.12187368317",
							name: "12187368317",
							kind: "prop",
							type: ["string"],
							tags: { custom: [] },
							visibility: "public",
							source: { file: "src/Fonts.luau", line: 2 },
						},
					],
				},
			]),
			testConfig(),
		);
		expect(result.pages.get("Fonts.md")!).toContain('Fonts["12187368317"]: string');
	});
});

describe("module mounts without a page", () => {
	it("drops the Module badge rather than render it linkless", () => {
		const result = emitDocsFromJson(
			modelJson([
				{
					id: "src/init.luau",
					instancePath: ["Root"],
					name: "Root",
					doc: "Mounts an opaque module.",
					source: { file: "src/init.luau", line: 1 },
					reexports: [
						{
							id: "src/init.luau#reexport.popup",
							name: "popup",
							targetModule: "src/Popup.luau",
						},
					],
				},
				{
					id: "src/Popup.luau",
					instancePath: ["Root", "popup"],
					name: "Popup",
					source: { file: "src/Popup.luau", line: 1 },
				},
			]),
			testConfig(),
		);
		const root = result.pages.get("Root.md")!;
		expect(root).toContain("### `popup`");
		expect(root).not.toContain('text="Module"');
	});
});

describe("page name collisions", () => {
	it("uniquifies the second module's slug, and warns with the id that lost", () => {
		const result = emitDocsFromJson(
			modelJson([
				{
					id: "src/Widget.luau",
					instancePath: ["Widget"],
					name: "Widget",
					doc: "The first claimant keeps the bare slug.",
					source: { file: "src/Widget.luau", line: 1 },
				},
				{
					id: "src/other/Widget.luau",
					instancePath: ["Other", "Widget"],
					name: "Widget",
					doc: "The second is uniquified.",
					source: { file: "src/other/Widget.luau", line: 1 },
				},
			]),
			testConfig(),
		);
		expect([...result.pages.keys()].sort()).toEqual(["Widget-2.md", "Widget.md"]);
		expect(
			result.warnings.some((warning) =>
				warning.includes("page name collision: Widget (src/other/Widget.luau)"),
			),
			result.warnings.join("\n"),
		).toBe(true);
		// the loser's tab/search title carries its parent segment; H1 stays bare
		expect(result.pages.get("Widget-2.md")!).toContain('title: "Widget (Other)"');
		expect(result.pages.get("Widget-2.md")!).toContain("\n# Widget\n");
		expect(result.pages.get("Widget.md")!).toContain('title: "Widget"');
	});
});

// a member re-export names its target by id, so visibility is the target's:
// re-exporting a private member must not launder it onto the public surface,
// while a public prop lands under the consumer's name like a function does
describe("member re-exports across modules", () => {
	const json = modelJson([
		{
			id: "src/init.luau",
			instancePath: ["Sample"],
			name: "Sample",
			// keeps the page alive when the one re-export is filtered out
			doc: "The public surface.",
			source: { file: "src/init.luau", line: 1 },
			reexports: [
				{
					id: "src/init.luau#reexport.secret",
					name: "secret",
					targetModule: "src/util.luau",
					targetId: "src/util.luau#fn.Util.secret",
					targetMember: "secret",
				},
				{
					id: "src/init.luau#reexport.level",
					name: "level",
					targetModule: "src/util.luau",
					targetId: "src/util.luau#prop.Util.level",
					targetMember: "level",
				},
			],
		},
		{
			id: "src/util.luau",
			instancePath: ["Util"],
			name: "Util",
			source: { file: "src/util.luau", line: 1 },
			members: [
				{
					id: "src/util.luau#fn.Util.secret",
					name: "secret",
					kind: "function",
					visibility: "private",
					tags: { custom: [] },
					errors: [],
					signature: { callee: "Util.secret", segs: ["(): ()"], params: [], returns: [] },
					source: { file: "src/util.luau", line: 5 },
				},
				{
					id: "src/util.luau#prop.Util.level",
					name: "level",
					kind: "prop",
					type: ["number"],
					tags: { custom: [] },
					visibility: "public",
					readonly: false,
					source: { file: "src/util.luau", line: 8 },
				},
			],
		},
	]);

	it("keeps the private target off the consumer's page", () => {
		expect(emitDocsFromJson(json, testConfig()).pages.get("Sample.md")!).not.toContain(
			"### `secret`",
		);
	});

	it("renders it when includePrivate asks for the private surface", () => {
		expect(
			emitDocsFromJson(json, testConfig({ api: { includePrivate: true } })).pages.get(
				"Sample.md",
			)!,
		).toContain("### `secret`");
	});

	it("inlines a re-exported prop under the consumer's name", () => {
		const page = emitDocsFromJson(json, testConfig()).pages.get("Sample.md")!;
		expect(page).toMatch(/### `level` .*text="from Util"/);
		expect(page).toContain("Sample.level: number");
	});
});

// a nested class's heading is its short name, but its members are called by the
// qualified one. Deriving the container from the heading rendered functions as
// `Outer.Inner.fn` and properties as `Inner.prop` on the same page, with prose
// links resolving for only one of the two spellings.
describe("members of a nested class", () => {
	const page = emitDocsFromJson(
		modelJson([
			{
				id: "src/init.luau",
				instancePath: ["Outer"],
				name: "Outer",
				doc: "See [Outer.Inner.build] and [Outer.Inner.size].",
				source: { file: "src/init.luau", line: 1 },
				classes: [
					{
						id: "src/init.luau#class.Outer.Inner",
						name: "Inner",
						within: "Outer",
						tags: { custom: [] },
						constructors: [],
						source: { file: "src/init.luau", line: 3 },
						members: [
							{
								id: "src/init.luau#prop.Outer.Inner.size",
								name: "size",
								kind: "prop",
								type: ["number"],
								tags: { custom: [] },
								visibility: "public",
								readonly: false,
								source: { file: "src/init.luau", line: 4 },
							},
							{
								id: "src/init.luau#fn.Outer.Inner.build",
								name: "build",
								kind: "function",
								visibility: "public",
								tags: { custom: [] },
								errors: [],
								signature: {
									callee: "Outer.Inner.build",
									segs: ["(): number"],
									params: [],
									returns: [],
								},
								source: { file: "src/init.luau", line: 5 },
							},
						],
					},
				],
			},
		]),
		testConfig(),
	).pages.get("Outer.md")!;

	it("spells a property the way the extractor spells the function beside it", () => {
		expect(page).toContain("Outer.Inner.build(): number");
		expect(page).toContain("Outer.Inner.size: number");
	});

	it("still heads the section with its short name", () => {
		expect(page).toContain("## Inner");
	});

	// three segments, which the prose-link pattern has to allow: registering
	// members under a name prose cannot spell would make every nested-class
	// reference in a doc comment silently render as literal text
	it("resolves prose links written with the qualified name", () => {
		expect(page).toContain("[`Outer.Inner.build`](/api/Outer#build)");
		expect(page).toContain("[`Outer.Inner.size`](/api/Outer#size)");
	});
});

/*
 * The nav tree from hand-built page models: the placement rules the fixtures
 * cannot isolate.
 */
describe("nav placement", () => {
	const navPage = (path: string, options: Partial<PageModel> = {}): PageModel => {
		const name =
			options.title ??
			path
				.replace(/(\/init)?\.luau$/, "")
				.split("/")
				.pop()!;
		return {
			moduleId: path,
			title: name,
			slug: name,
			// the folder layout, as the extractor derives it for a project
			// without a rojo tree
			instancePath: path.replace(/(\/init)?\.luau$/, "").split("/"),
			entry: false,
			exports: [],
			sections: [],
			types: [],
			source: { file: path, line: 1 },
			anchors: {},
			...options,
		};
	};

	// the canonical small layout: an entry exposing a leaf and a nested subtree
	const samplePages = [
		navPage("src/init.luau", {
			title: "Sample",
			entry: true,
			exports: ["src/Color.luau", "src/State/init.luau"],
		}),
		navPage("src/Color.luau"),
		navPage("src/State/init.luau", { exports: ["src/State/Query.luau"] }),
		navPage("src/State/Query.luau"),
	];

	it("heads a section with the entry root and nests pages under the module exposing them", () => {
		expect(outline(apiSidebar(samplePages))).toEqual([
			"Overview",
			"Sample > Color",
			"Sample > State > Query",
		]);
	});

	it("trails each page with the index and the modules above it", () => {
		// Query's folder puts it under State, and its access path agrees; Color's
		// does not (src/Color.luau is a sibling of the entry), so the trail naming
		// Sample is the access path and could be nothing else
		const trails = apiTrails(buildAccessTree(samplePages));
		expect(trails.get("Query.md")).toEqual([
			{ text: "Overview", link: "/api/" },
			{ text: "Sample", link: "/api/Sample" },
			{ text: "State", link: "/api/State" },
		]);
		expect(trails.get("Color.md")!.map((step) => step.text)).toEqual(["Overview", "Sample"]);
		// the entry module sits directly under the index, with nothing between
		expect(trails.get("Sample.md")!.map((step) => step.text)).toEqual(["Overview"]);
		// the index page is the API's own root: in the map, with nothing above it
		expect(trails.get("index.md")).toEqual([]);
	});

	it("links the entry's section and a nested group to their own pages", () => {
		const section = apiSidebar(samplePages).find((item) => item.text === "Sample")!;
		// the section title carries the root's link, and stays a static heading:
		// its subtree is the sidebar, not something to collapse away
		expect(section.link).toBe("/api/Sample");
		expect(section.collapsed).toBeUndefined();
		const stateGroup = section.items!.find((item) => item.text === "State")!;
		expect(stateGroup.link).toBe("/api/State");
		expect(stateGroup.collapsed).toBe(true);
	});

	it("places a module on its shortest access path", () => {
		const pages = [
			navPage("src/init.luau", {
				title: "Root",
				entry: true,
				exports: ["src/A.luau", "src/Shared.luau"],
			}),
			navPage("src/A.luau", { exports: ["src/Shared.luau"] }),
			navPage("src/Shared.luau"),
		];
		expect(outline(apiSidebar(pages))).toEqual(["Overview", "Root > A", "Root > Shared"]);
	});

	it("survives modules that re-export each other", () => {
		const pages = [
			navPage("src/init.luau", { title: "Root", entry: true, exports: ["src/A.luau"] }),
			navPage("src/A.luau", { exports: ["src/B.luau"] }),
			navPage("src/B.luau", { exports: ["src/A.luau"] }),
		];
		expect(outline(apiSidebar(pages))).toEqual(["Overview", "Root > A > B"]);
	});

	it("attaches never-exported modules to the nearest instance above them", () => {
		const pages = [
			navPage("src/init.luau", {
				title: "Lib",
				entry: true,
				instancePath: ["example-game", "Lib"],
				exports: ["submodules/Vendor/src/init.luau"],
			}),
			navPage("submodules/Vendor/src/init.luau", {
				title: "Vendor",
				instancePath: ["example-game", "Lib", "Vendor"],
				exports: ["submodules/Vendor/src/Bind.luau"],
			}),
			navPage("submodules/Vendor/src/Bind.luau", {
				title: "Bind",
				instancePath: ["example-game", "Lib", "Vendor", "Bind"],
			}),
			// an internal module: documented, but never re-exported
			navPage("submodules/Vendor/src/Async.luau", {
				title: "Async",
				instancePath: ["example-game", "Lib", "Vendor", "Async"],
			}),
		];
		expect(outline(apiSidebar(pages))).toEqual([
			"Overview",
			"Lib > Vendor > Async",
			"Lib > Vendor > Bind",
		]);
	});

	it("lands a page directly under the root when nothing else encloses it", () => {
		const pages = [
			navPage("src/init.luau", { title: "Root", entry: true, exports: [] }),
			navPage("src/Shared/Type.luau"),
		];
		expect(outline(apiSidebar(pages))).toEqual(["Overview", "Root > Type"]);
	});

	it("lists whatever heads no section under Reference", () => {
		const pages = [
			// an entry exposing nothing has no subtree to head
			navPage("src/init.luau", { title: "Solo", entry: true, exports: [] }),
			// and a module no entry reaches, enclosed by nothing either
			navPage("vendor/Detached.luau"),
		];
		expect(outline(apiSidebar(pages))).toEqual([
			"Overview",
			"Reference > Solo",
			"Reference > Detached",
		]);
	});

	it("places re-exported, internal, orphaned and cyclic pages alike, exactly once", () => {
		const links = (items: SidebarItem[]): string[] =>
			items.flatMap((item) => [
				...(item.link ? [item.link] : []),
				...links(item.items ?? []),
			]);
		const pages = [
			navPage("src/init.luau", {
				title: "Root",
				entry: true,
				exports: ["src/A/init.luau", "src/Loop.luau"],
			}),
			navPage("src/A/init.luau", { title: "A", exports: ["src/A/Leaf.luau"] }),
			navPage("src/A/Leaf.luau"),
			navPage("src/A/Internal.luau"), // never re-exported
			navPage("src/Loop.luau", { exports: ["src/init.luau"] }), // points back at the root
			navPage("src/Stray/Deep/Thing.luau"), // nothing encloses it
		];
		const found = links(apiSidebar(pages)).filter((link) => link !== "/api/");
		expect(found.sort()).toEqual(pages.map((page) => `/api/${page.slug}`).sort());
	});
});

/*
 * The extractor -> renderer contract, in the one direction nothing else covers:
 * every renderer test already proves the captured doc-models parse, so what is
 * left is what a caller sees when the JSON is wrong.
 */
describe("doc-model parse failures", () => {
	it("rejects invalid payloads with a readable error", () => {
		expect(() => parseDocModel("not json")).toThrow(/valid JSON/);
		// a model from another version is a version error, not a field dump
		expect(() => parseDocModel('{"schemaVersion": 2}')).toThrow(
			/schemaVersion is 2, expected 1/,
		);
		// some other JSON entirely: the likeliest mistake
		expect(() => parseDocModel('{"name": "package"}')).toThrow(
			/schemaVersion is undefined, expected 1/,
		);
		expect(() => parseDocModel("null")).toThrow(/not a JSON object/);
		expect(() => parseDocModel("[1]")).toThrow(/not a JSON object/);
	});
});

/*
 * The runtime half of the signature contract. Shiki THROWS on overlapping or
 * out-of-range decorations, so sanitizing is what keeps a bad span costing one
 * link rather than the build.
 */
describe("signature-links runtime transformer", () => {
	it("parses the well-formed token off a fence info string", () => {
		expect(parseLinks(`luau ${LINKS_TOKEN}[[0,4,"/api/X"]]`)).toEqual([[0, 4, "/api/X"]]);
		// the JSON carries no whitespace, so it ends at the next space
		expect(parseLinks(`luau ${LINKS_TOKEN}[[0,4,"/api/X"]] more`)).toEqual([[0, 4, "/api/X"]]);
	});

	it("ignores fences without the token, and malformed JSON", () => {
		expect(parseLinks(undefined)).toBeUndefined();
		expect(parseLinks("luau")).toBeUndefined();
		expect(parseLinks(`luau ${LINKS_TOKEN}[[0,4`)).toBeUndefined();
		expect(parseLinks(`luau ${LINKS_TOKEN}{"not":"an array"}`)).toBeUndefined();
	});

	/** What the transformer hands Shiki, reduced to the fields the tests read. */
	interface DecoratedOptions {
		decorations?: Array<{ start: number; end: number; properties: { href: string } }>;
	}
	type Preprocess = (
		this: { options: { meta?: { __raw?: string } } },
		code: string,
		options: DecoratedOptions,
	) => void;

	/** The decorations the transformer records for `code` under `table`. */
	const spansOf = (code: string, table: string): Array<[number, number, string]> => {
		const transformer = linksTransformer();
		const options: DecoratedOptions = {};
		(transformer.preprocess as unknown as Preprocess).call(
			{ options: { meta: { __raw: `luau ${LINKS_TOKEN}${table}` } } },
			code,
			options,
		);
		return (options.decorations ?? []).map((d) => [d.start, d.end, d.properties.href]);
	};

	it("decorates well-formed spans in sorted order", () => {
		expect(spansOf("abcdefghij", '[[5,7,"/b"],[0,3,"/a"]]')).toEqual([
			[0, 3, "/a"],
			[5, 7, "/b"],
		]);
	});

	it("drops overlapping, out-of-range, empty and malformed spans", () => {
		expect(
			spansOf(
				"abcdefghij",
				'[[0,3,"/a"],[2,5,"/overlap"],[4,20,"/past-end"],[5,5,"/empty"],[6,8,7],"junk",[6,8,"/e"]]',
			),
		).toEqual([
			[0, 3, "/a"],
			[6, 8, "/e"],
		]);
	});

	it("records nothing for a fence whose table cannot parse", () => {
		expect(spansOf("abc", "[[0,2")).toEqual([]);
	});

	// VitePress reads `[...]` in a fence info string as a code-group title and
	// strips it before highlighting, so the token crosses its fence renderer
	// re-encoded. The property that keeps it safe is bracket-free; the contract
	// is that the decode restores the info string byte for byte.
	it("relays the table across the fence renderer bracket-free, and losslessly", () => {
		const info = `luau ${LINKS_TOKEN}[[0,4,"/api/X"]] {1}`;
		const md = {
			renderer: {
				rules: {
					fence: (tokens: Array<{ info: string }>, idx: number) => tokens[idx]!.info,
				},
			},
		};
		relayLinks(md as never);
		const relayed = (
			md.renderer.rules.fence as unknown as (
				tokens: Array<{ info: string }>,
				idx: number,
			) => string
		)([{ info }], 0);
		expect(relayed).toContain("luaudocs-links-b64=");
		expect(relayed).not.toContain("[");
		expect(relayed.endsWith(" {1}")).toBe(true);

		const meta = { __raw: relayed };
		(decodeLinks().preprocess as (this: unknown) => void).call({ options: { meta } });
		expect(meta.__raw).toBe(info);
		expect(parseLinks(meta.__raw)).toEqual([[0, 4, "/api/X"]]);
	});
});

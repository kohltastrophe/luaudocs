/**
 * Renderer, symbol-table, page-organization, and navigation tests (`src/render.ts`,
 * `src/pages.ts`, `src/nav.ts`, `templates/runtime/signature-links.ts`).
 */
import { describe, expect, it } from "vitest";
import { parseDocModel } from "../src/docmodel";
import { apiSidebar, apiTrails, buildAccessTree, type TreeNode } from "../src/nav";
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

const src = (file = "src/init.luau", line = 1) => ({ file, line });
const mod = (id: string, name: string, extra: object = {}) => ({
	id,
	instancePath: [name],
	name,
	source: src(id),
	...extra,
});
const prop = (id: string, name: string, propType?: unknown[], extra: object = {}) => ({
	id,
	name,
	kind: "prop",
	type: propType,
	tags: { custom: [] },
	visibility: "public",
	readonly: false,
	source: src(),
	...extra,
});
const fn = (
	id: string,
	name: string,
	callee: string,
	segs: unknown[] = ["()"],
	extra: object = {},
) => ({
	id,
	name,
	kind: "function",
	visibility: "public",
	tags: { custom: [] },
	errors: [],
	signature: { callee, segs, params: [], returns: [] },
	source: src("src/init.luau", 5),
	...extra,
});
const cls = (id: string, name: string, extra: object = {}) => ({
	id,
	name,
	tags: { custom: [] },
	constructors: [],
	members: [],
	source: src(),
	...extra,
});
const ty = (id: string, name: string, definition?: unknown[][], extra: object = {}) => ({
	id,
	name,
	exported: true,
	kind: "alias",
	generics: [],
	definition,
	tags: { custom: [] },
	visibility: "public",
	source: src(),
	...extra,
});
const reex = (id: string, name: string, targetModule: string, extra: object = {}) => ({
	id,
	name,
	targetModule,
	...extra,
});
const miniFn = (name: string, extra: object = {}) =>
	fn(`src/init.luau#fn.Mini.${name}`, name, `Mini.${name}`, ["()"], extra);
const miniPage = (extra: object, config = testConfig()) =>
	emitDocsFromJson(modelJson([mod("src/init.luau", "Mini", extra)]), config);

describe("emitDocs on the Sample fixture", () => {
	it("produces one page per module plus the separate index and matches snapshots", async () => {
		expect([...result.pages.keys()].sort()).toEqual([
			"Color.md",
			"Interpolate.md",
			"Query.md",
			"Sample.md",
			"State.md",
			"Type.md",
		]);
		for (const [content, snap] of [
			[sample, "__snapshots__/sample/Sample.md"],
			[state, "__snapshots__/sample/State.md"],
			[result.pages.get("Color.md"), "__snapshots__/sample/Color.md"],
			[type, "__snapshots__/sample/Type.md"],
			[result.pages.get("Query.md"), "__snapshots__/sample/Query.md"],
			[result.pages.get("Interpolate.md"), "__snapshots__/sample/Interpolate.md"],
			[result.apiIndex, "__snapshots__/sample/index.md"],
		] as const) {
			await expect(content).toMatchFileSnapshot(snap);
		}
	});

	it("preserves expected markers, omits forbidden markup, and validates links and options", () => {
		for (const marker of [
			"https://create.roblox.com/docs/reference/engine/classes/Frame",
			"https://create.roblox.com/docs/reference/engine/classes/Instance",
		]) {
			has(signatureLinks(type).join("\n"), marker);
		}
		for (const marker of ["/api/State#state-1", "/api/State"]) {
			has(signatureLinks(sample).join("\n"), marker);
		}
		has(signatureLinks(state).join("\n"), "/api/Type#function");

		for (const marker of [
			/### `Connect` <a class="source-link ignore-header" href="[^"]+"[^>]*><\/a>\n/,
			/### `StateData` <Badge type="info" text="type" \/> <a class="source-link ignore-header" href="[^"]+"/,
			"```luau luaudocs-links=[[",
			"State:Connect(callback: Type.Function): Type.Function",
		]) {
			has(state, marker);
		}
		for (const marker of [
			'### `State` [<Badge type="info" text="Module" />](/api/State){.badge-link .ignore-header}',
			"Sample.State: State",
			'### `raw` [<Badge type="info" text="from State" />](/api/State#raw){.badge-link .ignore-header}',
			"Sample.isState(object: any): boolean",
			/### `Action`/,
		]) {
			has(sample, marker);
		}
		for (const forbidden of [
			"--shiki-light",
			"_updateDependence",
			"| Field | Type | Description |",
			"luaudocs-trail",
		]) {
			expect(state).not.toContain(forbidden);
		}
		expect(sample).not.toContain("## Re-exports");

		const slugs = new Set([...result.pages.keys()].map((file) => file.replace(/\.md$/, "")));
		let checked = 0;
		for (const markdown of [...result.pages.values(), result.apiIndex!]) {
			for (const [, slug] of markdown.matchAll(/\]\(\/api\/([\w.-]+)/g)) {
				expect(slugs).toContain(slug!);
				checked += 1;
			}
			for (const span of signatureSpans(markdown)) {
				const slug = span.url.match(/^\/api\/([\w.-]+)/)?.[1];
				if (slug !== undefined) {
					expect(slugs).toContain(slug);
					checked += 1;
				}
			}
		}
		expect(checked).toBeGreaterThan(0);
		expect(state.indexOf("## Types")).toBeGreaterThan(-1);
		expect(state.indexOf("## Types")).toBeLessThan(state.indexOf("## Properties"));
		expect(
			emitDocsFromJson(sampleJson, testConfig({ api: { includePrivate: true } })).pages.get(
				"State.md",
			),
		).toContain("_updateDependence");

		const model = JSON.parse(sampleJson) as { modules: Array<{ name: string }> };
		model.modules = model.modules.filter((m) => m.name !== "State");
		const orphaned = emitDocsFromJson(JSON.stringify(model), SAMPLE_CONFIG).pages.get(
			"Sample.md",
		)!;
		expect(orphaned).toMatch(/### `raw` <Badge type="info" text="Re-export" \/>/);
		expect(orphaned).not.toContain("(/api/State");

		const empty = emitDocsFromJson(modelJson([]), testConfig());
		expect(empty.pages.size).toBe(0);
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
	it("produces the Tagged and Widget pages, snapshots, markers, and nested sidebar", async () => {
		expect([...tagsResult.pages.keys()].sort()).toEqual(["Tagged.md", "Widget.md"]);
		await expect(tagged).toMatchFileSnapshot("__snapshots__/tags/Tagged.md");
		await expect(widget).toMatchFileSnapshot("__snapshots__/tags/Widget.md");
		await expect(tagsResult.apiIndex).toMatchFileSnapshot("__snapshots__/tags/index.md");
		expect(widget.match(/Fired when the rename lands/g)).toHaveLength(1);
		expect(widget.match(/-- skip events/g)).toHaveLength(1);
		expect(outline(tagsResult.sidebar)).toEqual(["Overview", "Tagged > Widget"]);

		for (const marker of [
			'<Badge type="danger" text="Deprecated since v2" />',
			'<Badge type="warning" text="Unreleased" />',
			'### `save` <Badge type="warning" text="Yields" />',
			'<Badge type="info" text="Plugin" class="luaudocs-plugin" />',
			'<Badge type="tip" text="since v0.9.0" />',
			'<Badge type="info" text="constructor" />',
			'### `flush` <Badge type="warning" text="Yields" />',
			'### `mirror` <Badge type="info" text="Server" class="luaudocs-server" />',
			'### `maxWidgets` <Badge type="info" text="Read Only" />',
			"::: warning DEPRECATED",
			"[`Tagged.create`](/api/Tagged#create)",
			"| `string` | when the datastore is unavailable |",
			"[`Promise`](https://eryn.io/roblox-lua-promise/lib/)",
			"Tagged.blank: Widget",
			'### `storage` <Badge type="info" text="Server" class="luaudocs-server" />',
			"Tagged.storage: Instance?",
			'"/api/Tagged#limits"',
		]) {
			has(tagged, marker);
		}
		for (const marker of [
			'<Badge type="info" text="Client" class="luaudocs-client" />',
			'<Badge type="info" text="ui" />',
			'<Badge type="info" text="Read Only" />',
			'### `activate` <Badge type="info" text="Client" class="luaudocs-client" />',
			"- `scale`: multiplier against the base size",
			"- `skin`: the tag wins over the trailing comment",
			":::caution",
			'<TabItem value="named"',
			'```luau\nlocal widget = Widget.new("panel")',
			"Widget.slots: { string }",
			"### `theme`",
			"### `describe`",
			"### `refresh`",
			"### `ThemeName`",
			'### `persist` <Badge type="info" text="storage" />',
			"Widget.persist(widget: any): boolean",
			"type WidgetOptions = {\n    -- display name\n    name: string,",
			"-- reject empty names",
			"-- no further updates",
			"-- capture timestamp",
			"Widget.Skin.border: number",
		]) {
			has(widget, marker);
		}
		has(signatureLinks(widget).join("\n"), "https://eryn.io/roblox-lua-promise/lib/");
		has(signatureLinks(memberBlock(tagged, "blank")).join("\n"), "/api/Widget#widget-1");

		for (const forbidden of ["internalReset", "debugDump", "### constructor\n"]) {
			expect(tagged).not.toContain(forbidden);
		}
		for (const forbidden of ["### `Internal`", "@within"]) {
			expect(widget).not.toContain(forbidden);
		}
	});
});

describe("types, signatures, and link boundaries", () => {
	const decl = (name: string, extra: object = {}) =>
		ty(`Mini#type.${name}`, name, undefined, extra);

	it("renders verbatim signatures, field docs, synthetic interfaces, and exact link spans", () => {
		const fallbackRef = { text: "Fallback", id: "Mini#type.Fallback" };
		const slotRef = { text: "Slot", id: "Mini#type.Slot" };
		const longSig =
			"(applicationName: string, retryPolicyDescription: string, maximumAttemptCount: number): boolean";
		const json = modelJson([
			mod("Mini", "Mini", {
				types: [
					decl("Options", {
						definition: [["{"], ["\tname: string,"], ["\tretries: number,"], ["}"]],
						fields: [
							{ name: "name", type: ["string"], doc: "Display name.", line: 2 },
							{ name: "retries", type: ["number"], line: 3 },
							{ name: "timeout", type: ["number"], doc: "Overall deadline." },
						],
					}),
					decl("Manual", {
						kind: "interface",
						fields: [
							{ name: "id", type: ["number"], doc: "Unique id." },
							{ name: "label" },
						],
					}),
					decl("Bare"),
					decl("Fallback", { definition: [["string"]] }),
					decl("Registry", {
						generics: [{ name: "T", isPack: false, default: [fallbackRef] }],
						definition: [["{ items: { T }, last: ", fallbackRef, " }"]],
					}),
					decl("Widen", {
						kind: "typefunction",
						generics: [{ name: "T", isPack: false }],
						definition: [[{ text: "Widen", id: "Mini#type.Widen" }]],
					}),
					decl("Narrow", {
						kind: "typefunction",
						generics: [{ name: "T", isPack: false, default: [fallbackRef] }],
					}),
					decl("Slot", { definition: [["number"]] }),
					decl("Keyed", { definition: [["{ Slot: string, active: ", slotRef, " }"]] }),
					decl("Built", {
						kind: "interface",
						fields: [
							{ name: "Slot", type: ["string"] },
							{ name: "active", type: [slotRef] },
						],
					}),
				],
				reexports: [
					reex("Mini#reexport.helper", "helper", "Helper", {
						doc: "The **helper** module.",
					}),
				],
				members: [
					fn("Mini#fn.configure", "configure", "Mini.configure", [longSig], {
						signature: {
							callee: "Mini.configure",
							segs: [longSig],
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
						source: { file: "src/init.luau", line: 10, endLine: 20 },
					}),
				],
			}),
			mod("Helper", "Helper", { doc: "A helper." }),
		]);

		const page = emitDocsFromJson(json, testConfig()).pages.get("Mini.md")!;
		expect(page).toContain(`Mini.configure${longSig}`);
		expect(page).toContain(
			"**Parameters**\n\n- `applicationName`: Name of the application.\n- `maximumAttemptCount`: Upper bound of attempts.",
		);
		expect(page).toContain("**Returns**\n\n- `boolean`: Whether it worked.");
		expect(page).not.toContain("retryPolicyDescription`:");
		expect(page).toContain(
			"type Options = {\n\t-- Display name.\n\tname: string,\n\tretries: number,\n}",
		);
		expect(memberBlock(page, "Options")).toContain(
			"**Fields**\n\n- `timeout`: Overall deadline.",
		);
		expect(page).not.toContain("-- Overall deadline.");
		expect(page).toContain(
			"type Manual = {\n    -- Unique id.\n    id: number,\n    label: unknown,\n}",
		);
		expect(page).toContain("type Bare = unknown");
		expect(page).toContain("Mini.helper: Helper");
		expect(page).toContain("The **helper** module.");

		const regSpans = signatureSpans(memberBlock(page, "Registry")).filter(
			(s) => s.url === "/api/Mini#fallback",
		);
		expect(regSpans).toHaveLength(2);
		const defAt = regSpans[0]!.code.indexOf("> = ");
		expect(regSpans[0]!.start).toBeLessThan(defAt);
		expect(regSpans[1]!.start).toBeGreaterThan(defAt);
		expect(signatureSpans(memberBlock(page, "Narrow")).map((s) => s.text)).toEqual([
			"Fallback",
		]);
		expect(signatureLinks(page)).not.toContain("/api/Mini#widen");

		for (const name of ["Keyed", "Built"]) {
			const spans = signatureSpans(memberBlock(page, name)).filter(
				(s) => s.url === "/api/Mini#slot",
			);
			expect(spans).toHaveLength(1);
			expect(spans[0]!.text).toBe("Slot");
			expect(spans[0]!.start).toBeGreaterThan(spans[0]!.code.indexOf("active"));
		}
	});

	it("lists reachable unexported types in module order and drops unexported duplicates of exported @within types", () => {
		const page = miniPage({
			types: [
				ty(
					"src/init.luau#type.Named",
					"Named",
					[[{ text: "Inner", id: "src/init.luau#type.Inner" }]],
					{ exported: false },
				),
				ty("src/init.luau#type.Inner", "Inner", [["string"]], { exported: false }),
				ty("src/init.luau#type.Unreachable", "Unreachable", [["string"]], {
					exported: false,
				}),
				ty("src/init.luau#type.Exported", "Exported", [["string"]]),
				ty("src/init.luau#type.Handle.local", "Handle", [["number"]], { exported: false }),
				ty("src/sub.luau#type.Handle", "Handle", [["{ id: number }"]]),
			],
			members: [
				miniFn("make", {
					signature: {
						callee: "Mini.make",
						segs: [
							"(): (",
							{ text: "Named", id: "src/init.luau#type.Named" },
							", ",
							{ text: "Handle", id: "src/init.luau#type.Handle.local" },
							")",
						],
						params: [],
						returns: [],
					},
				}),
			],
		}).pages.get("Mini.md")!;

		expect(page).toMatch(/### `Named`/);
		expect(page).toMatch(/### `Inner`/);
		expect(page).toMatch(/### `Exported`/);
		expect(page).not.toContain("Unreachable");
		expect(page.indexOf("### `Named`")).toBeLessThan(page.indexOf("### `Inner`"));
		expect(page.match(/### `Handle`/g)).toHaveLength(1);
		expect(page).toContain("type Handle = { id: number }");
		expect(page).not.toContain("type Handle = number");
	});
});

describe("re-exports, passthroughs, and nested sections", () => {
	it("resolves passthrough modules (aliasOf) across pages, badges, API index, and nested sidebar", () => {
		const direct = emitDocsFromJson(
			modelJson([
				mod("src/init.luau", "Sample", {
					entry: true,
					reexports: [reex("src/init.luau#reexport.Util", "Util", "src/alias.luau")],
				}),
				mod("src/alias.luau", "Util", {
					instancePath: ["Sample", "Util"],
					aliasOf: "src/real.luau",
				}),
				mod("src/real.luau", "Real", {
					instancePath: ["Vendor", "Real"],
					doc: "The implementation.",
				}),
			]),
			testConfig(),
		);
		expect([...direct.pages.keys()].sort()).toEqual(["Real.md", "Sample.md"]);
		expect(direct.pages.get("Sample.md")!).toContain(
			'### `Util` [<Badge type="info" text="Module" />](/api/Real)',
		);
		expect(direct.apiIndex).toContain("- [Sample](/api/Sample)\n    - [Real](/api/Real)");

		const nested = emitDocsFromJson(
			modelJson([
				mod("src/init.luau", "Sample", {
					entry: true,
					reexports: [reex("src/init.luau#reexport.Middle", "Middle", "src/middle.luau")],
				}),
				mod("src/middle.luau", "Middle", {
					instancePath: ["Sample", "Middle"],
					reexports: [reex("src/middle.luau#reexport.Util", "Util", "src/alias.luau")],
				}),
				mod("src/alias.luau", "Util", {
					instancePath: ["Sample", "Middle", "Util"],
					aliasOf: "src/real.luau",
				}),
				mod("src/real.luau", "Real", {
					instancePath: ["Vendor", "Real"],
					doc: "The implementation.",
				}),
			]),
			testConfig(),
		);
		expect(outline(nested.sidebar)).toEqual(["Overview", "Sample > Middle > Real"]);
	});

	it("inlines nested `within` re-exports onto their nested section and records nested module mounts in page.exports", () => {
		const emitted = emitDocsFromJson(
			modelJson([
				mod("src/init.luau", "Flux", {
					entry: true,
					classes: [cls("src/init.luau#class.Flux.Clock", "Clock", { within: "Flux" })],
					reexports: [
						reex("src/init.luau#reexport.Flux.Clock.tick", "tick", "src/Time.luau", {
							within: "Flux.Clock",
							targetMember: "tick",
							targetId: "src/Time.luau#fn.Time.tick",
						}),
						reex("src/init.luau#reexport.Flux.Clock.Sub", "Sub", "src/Sub.luau", {
							within: "Flux.Clock",
						}),
					],
				}),
				mod("src/Time.luau", "Time", {
					instancePath: ["Flux", "Time"],
					members: [
						fn("src/Time.luau#fn.Time.tick", "tick", "Time.tick", ["(dt: number)"]),
					],
				}),
				mod("src/Sub.luau", "Sub", {
					instancePath: ["Flux", "Sub"],
					doc: "Mounted under Flux.Clock.Sub.",
				}),
			]),
			testConfig(),
		);
		const flux = emitted.pages.get("Flux.md")!;
		expect(flux).toContain("## Clock");
		expect(flux).toContain("Flux.Clock.tick(dt: number)");
		expect(flux).toContain("Flux.Clock.Sub: Sub");
		expect(emitted.pageModels.find((p) => p.slug === "Flux")!.exports).toEqual([
			{ moduleId: "src/Sub.luau", name: "Clock.Sub" },
		]);
	});

	it("handles member re-exports, runtime modules, realm guards, method-as-field re-exports, and opaque mounts", () => {
		const method = (name: string, segs: unknown[], params: object[]) =>
			fn(`src/Sig.luau#fn.Sig.${name}`, name, `Sig:${name}`, segs, {
				kind: "method",
				signature: { callee: `Sig:${name}`, segs, params, returns: [] },
			});
		const methods = [
			method("Connect", ["(fn: () -> ())"], [{ name: "fn" }]),
			method("Destroy", ["()"], []),
			method(
				"Set",
				["<", { text: "T" }, ">(value: ", { text: "T" }, "): ", { text: "T" }],
				[{ name: "value", doc: "the new value" }],
			),
		];
		const json = JSON.stringify({
			...JSON.parse(
				modelJson([
					mod("src/init.luau", "Sample", {
						doc: "The public surface.",
						reexports: [
							reex("src/init.luau#reexport.secret", "secret", "src/util.luau", {
								targetId: "src/util.luau#fn.Util.secret",
								targetMember: "secret",
							}),
							reex("src/init.luau#reexport.level", "level", "src/util.luau", {
								targetId: "src/util.luau#prop.Util.level",
								targetMember: "level",
								realm: ["server"],
							}),
							reex("src/init.luau#reexport.Util", "Util", "src/util.luau", {
								realm: ["server"],
							}),
							reex("src/init.luau#reexport.popup", "popup", "src/Popup.luau"),
							reex("src/init.luau#reexport.fs", "fs", "@lute/fs", {
								url: "https://lute.test/lute/fs",
								doc: "The file system.",
							}),
							reex("src/init.luau#reexport.readFile", "readFile", "@lute/fs", {
								targetMember: "readfile",
								url: "https://lute.test/lute/fs",
							}),
							reex("src/init.luau#reexport.plain", "plain", "@pkg/plain"),
							...methods.map((m) =>
								reex(
									`src/init.luau#reexport.${m.name.toLowerCase()}`,
									m.name.toLowerCase(),
									"src/Sig.luau",
									{ targetMember: m.name, targetId: m.id },
								),
							),
						],
					}),
					mod("src/util.luau", "Util", {
						members: [
							fn(
								"src/util.luau#fn.Util.secret",
								"secret",
								"Util.secret",
								["(): ()"],
								{
									visibility: "private",
								},
							),
							prop("src/util.luau#prop.Util.level", "level", ["number"]),
						],
					}),
					mod("src/Popup.luau", "Popup", { instancePath: ["Sample", "popup"] }),
					mod("src/Sig.luau", "Sig", {
						instancePath: ["Sample", "Sig"],
						classes: [cls("src/Sig.luau#class.Sig", "Sig", { members: methods })],
					}),
				]),
			),
			externals: { "@lute/fs": "https://lute.test/lute/fs" },
		});

		const page = emitDocsFromJson(json, testConfig()).pages.get("Sample.md")!;
		const server = '<Badge type="info" text="Server" class="luaudocs-server" />';
		expect(page).not.toContain("### `secret`");
		expect(
			emitDocsFromJson(json, testConfig({ api: { includePrivate: true } })).pages.get(
				"Sample.md",
			)!,
		).toContain("### `secret`");
		expect(page).toContain(`### \`level\` ${server} [<Badge type="info" text="from Util" />]`);
		expect(page).toContain("Sample.level: number");
		expect(page).toContain(`### \`Util\` ${server} [<Badge type="info" text="Module" />]`);
		expect(memberBlock(page, "popup")).not.toContain('text="Module"');

		const fsBlock = memberBlock(page, "fs");
		expect(fsBlock).toContain(
			'[<Badge type="info" text="Module" />](https://lute.test/lute/fs){.badge-link .ignore-header}',
		);
		expect(signatureLinks(fsBlock)).toContain("https://lute.test/lute/fs");
		expect(memberBlock(page, "readFile")).toContain(
			'[<Badge type="info" text="from @lute/fs" />](https://lute.test/lute/fs){.badge-link',
		);
		const plainBlock = memberBlock(page, "plain");
		expect(plainBlock).not.toContain("badge-link");
		expect(plainBlock).toContain("Sample.plain: @pkg/plain");

		expect(page).toContain("Sample.connect(self, fn: () -> ())");
		expect(page).toContain("Sample.destroy(self)");
		expect(page).toContain("Sample.set<T>(self, value: T): T");
		expect(memberBlock(page, "set")).toContain("- `value`: the new value");
	});

	it("renders nested classes, filters private-only sections, and escapes markdown in headings", () => {
		const outer = emitDocsFromJson(
			modelJson([
				mod("src/init.luau", "Outer", {
					doc: "See [Outer.Inner], [Outer.Inner.build] and [Outer.Inner.size].",
					classes: [
						cls("src/init.luau#class.Outer.Inner", "Inner", {
							within: "Outer",
							members: [
								prop("src/init.luau#prop.Outer.Inner.size", "size", ["number"]),
								fn(
									"src/init.luau#fn.Outer.Inner.build",
									"build",
									"Outer.Inner.build",
									["(): number"],
								),
							],
						}),
					],
				}),
			]),
			testConfig(),
		).pages.get("Outer.md")!;
		expect(outer).toContain("## Inner");
		expect(outer).toContain("Outer.Inner.build(): number");
		expect(outer).toContain("Outer.Inner.size: number");
		expect(outer).toContain("[`Outer.Inner`](/api/Outer#inner)");
		expect(outer).toContain("[`Outer.Inner.build`](/api/Outer#build)");
		expect(outer).toContain("[`Outer.Inner.size`](/api/Outer#size)");

		const sectionCls = (name: string, visibility: string) =>
			cls(`src/init.luau#class.${name}`, name, {
				members: [
					fn(`src/init.luau#fn.${name}.run`, "run", `${name}.run`, ["()"], {
						visibility,
					}),
				],
			});
		const model = {
			classes: [sectionCls("_Hidden_", "private"), sectionCls("_Shown_", "public")],
		};
		const emitted = miniPage(model);
		expect(emitted.pages.get("Mini.md")!).not.toContain("Hidden");
		expect(emitted.pageModels[0]!.anchors).not.toHaveProperty("src/init.luau#class._Hidden_");
		expect(emitted.pages.get("Mini.md")!).toContain("## \\_Shown\\_");
		expect(emitted.pageModels[0]!.anchors["src/init.luau#class._Shown_"]).toBe("shown");
		expect(
			miniPage(model, testConfig({ api: { includePrivate: true } })).pages.get("Mini.md")!,
		).toContain("## \\_Hidden\\_");
	});
});

describe("symbol table tiers, aliases, collisions, and formatting edge cases", () => {
	it("drops ambiguous names in the same tier with a warning", () => {
		const res = emitDocsFromJson(
			modelJson([
				mod("src/a.luau", "Alpha", {
					doc: "See [Config].",
					types: [ty("src/a.luau#type.Config", "Config", [["string"]])],
				}),
				mod("src/b.luau", "Beta", {
					types: [ty("src/b.luau#type.Config", "Config", [["string"]])],
				}),
			]),
			testConfig(),
		);
		expect(res.warnings).toContain(
			"ambiguous reference name dropped from link table: Config (/api/Alpha#config vs /api/Beta#config)",
		);
		expect(res.pages.get("Alpha.md")!).not.toContain("](/api/");
	});

	it("prioritizes value tiers, collapses generic/transitive pure aliases, and avoids nested section collisions with top-level pages", () => {
		const pureAlias = (
			id: string,
			name: string,
			targetText: string,
			targetId: string,
			generic = false,
		) =>
			ty(
				`${id}#type.${name}`,
				name,
				[
					generic
						? [{ text: targetText, id: targetId }, "<T>"]
						: [{ text: targetText, id: targetId }],
				],
				{ generics: generic ? [{ name: "T", isPack: false }] : [] },
			);

		const res = emitDocsFromJson(
			modelJson([
				mod("src/init.luau", "Root", {
					doc: "See [Signal], [Log], [State], [Root.Logger], [Clock], and [Root.Clock].",
					classes: [
						cls("src/init.luau#class.Root.Clock", "Clock", {
							within: "Root",
							doc: "Nested clock section.",
						}),
					],
					members: [prop("src/init.luau#prop.Root.Logger", "Logger")],
					types: [
						ty("src/init.luau#type.Signal", "Signal", [["number"]]),
						ty("src/init.luau#type.Logger", "Logger", [["string"]]),
						pureAlias("src/init.luau", "Log", "Signal.Log", "src/Signal.luau#type.Log"),
						pureAlias(
							"src/init.luau",
							"State",
							"Mid.State",
							"src/Mid.luau#type.State",
							true,
						),
					],
				}),
				mod("src/Mid.luau", "Mid", {
					instancePath: ["Root", "Mid"],
					types: [
						pureAlias("src/Mid.luau", "Log", "Signal.Log", "src/Signal.luau#type.Log"),
						pureAlias(
							"src/Mid.luau",
							"State",
							"Signal.RawState",
							"src/Signal.luau#type.RawState",
							true,
						),
					],
				}),
				mod("src/Signal.luau", "Signal", {
					instancePath: ["Root", "Signal"],
					types: [
						ty("src/Signal.luau#type.Log", "Log", [["string"]]),
						ty("src/Signal.luau#type.RawState", "RawState", [["{ value: T }"]], {
							generics: [{ name: "T", isPack: false }],
						}),
					],
				}),
				mod("src/Clock.luau", "Clock", {
					instancePath: ["Root", "Clock"],
					doc: "Top-level Clock module.",
				}),
			]),
			testConfig(),
		);

		expect(res.warnings).toEqual([]);
		const root = res.pages.get("Root.md")!;
		expect(root).toContain("[`Signal`](/api/Signal)");
		expect(root).toContain("[`Root.Logger`](/api/Root#logger-1)");
		expect(root).toContain("[`Log`](/api/Signal#log)");
		expect(root).toContain("[`State`](/api/Signal#rawstate)");
		expect(root).toContain("[`Clock`](/api/Clock)");
		expect(root).toContain("[`Root.Clock`](/api/Root#clock)");
	});

	it("handles page slug collisions, bracket prop access, doc tables/lists, URL encoding, and Roblox types", () => {
		const collided = emitDocsFromJson(
			modelJson([
				mod("src/Widget.luau", "Widget", { doc: "First." }),
				mod("src/other/Widget.luau", "Widget", {
					instancePath: ["Other", "Widget"],
					doc: "Second.",
				}),
			]),
			testConfig(),
		);
		expect([...collided.pages.keys()].sort()).toEqual(["Widget-2.md", "Widget.md"]);
		expect(collided.warnings[0]).toContain(
			"page name collision: Widget (src/other/Widget.luau)",
		);
		expect(collided.pages.get("Widget-2.md")!).toContain('title: "Widget (Other)"');
		expect(collided.pages.get("Widget-2.md")!).toContain("\n# Widget\n");

		const encoded = emitDocsFromJson(
			JSON.stringify({
				...JSON.parse(
					modelJson([
						mod("src/init.luau", "Mini", {
							doc: "See [Paren].",
							types: [
								ty("src/init.luau#type.A", "A", [["number"]]),
								ty("src/init.luau#type.B", "B", [["number"]]),
							],
							members: [
								prop("src/init.luau#prop.Mini.12187368317", "12187368317", [
									"string",
								]),
								prop("src/init.luau#prop.Mini.origin", "origin", [
									{ text: "Vector3" },
								]),
								prop("src/init.luau#prop.Mini.key", "key", [
									{ text: "Enum.KeyCode" },
								]),
								miniFn("odd", {
									source: src('src/a b/#c".luau', 5),
									signature: {
										callee: "Mini.odd",
										segs: [
											"(a: ",
											{ text: "Spaced" },
											", b: ",
											{ text: "Paren" },
											"): A | B",
										],
										params: [],
										returns: [
											{
												type: [
													{ text: "A", id: "src/init.luau#type.A" },
													" | ",
													{ text: "B", id: "src/init.luau#type.B" },
												],
												doc: "one of the two",
											},
										],
									},
									errors: [{ type: "NotFound", doc: "see [Mini.odd]" }],
								}),
							],
						}),
					]),
				),
				externals: { Spaced: "https://x.test/a b", Paren: "https://x.test/Foo_(bar)" },
			}),
			testConfig({ repo: { url: "https://github.com/example/Mini", branch: "main" } }),
		).pages.get("Mini.md")!;

		expect(encoded).toContain('Mini["12187368317"]: string');
		expect(encoded).toContain("- [`A`](/api/Mini#a) `|` [`B`](/api/Mini#b): one of the two");
		expect(encoded).toContain("| `NotFound` | see [`Mini.odd`](/api/Mini#odd) |");
		expect(encoded).toContain(
			'href="https://github.com/example/Mini/blob/main/src/a%20b/%23c%22.luau#L5"',
		);
		expect(encoded).toContain("[`Paren`](<https://x.test/Foo_(bar)>)");
		expect(signatureLinks(memberBlock(encoded, "odd"))).toEqual([
			"https://x.test/a%20b",
			"https://x.test/Foo_(bar)",
		]);
		expect(signatureLinks(memberBlock(encoded, "origin"))).toEqual([
			"https://create.roblox.com/docs/reference/engine/datatypes/Vector3",
		]);
		expect(signatureLinks(memberBlock(encoded, "key"))).toEqual([
			"https://create.roblox.com/docs/reference/engine/enums/KeyCode",
		]);
	});
});

describe("access-graph grouping and nav placement", () => {
	const nameOf = (path: string): string =>
		path
			.replace(/(\/init)?\.luau$/, "")
			.split("/")
			.pop()!;
	type Edge = PageModel["exports"][number];
	const navPage = (
		path: string,
		{
			exports = [],
			...options
		}: Partial<Omit<PageModel, "exports">> & { exports?: Array<string | Edge> } = {},
	): PageModel => {
		const name = options.title ?? nameOf(path);
		return {
			moduleId: path,
			title: name,
			slug: name,
			instancePath: path.replace(/(\/init)?\.luau$/, "").split("/"),
			entry: false,
			exports: exports.map((edge) =>
				typeof edge === "string" ? { moduleId: edge, name: nameOf(edge) } : edge,
			),
			sections: [],
			types: [],
			source: { file: path, line: 1 },
			anchors: {},
			...options,
		};
	};

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

	it("groups end-to-end from re-exports and renders the API index tree", () => {
		const model = JSON.parse(sampleJson) as {
			modules: Array<{
				id: string;
				reexports: Array<{ id: string; name: string; targetModule: string }>;
			}>;
		};
		const byId = (id: string) => model.modules.find((m) => m.id === id)!;
		byId("src/init.luau").reexports = byId("src/init.luau").reexports.filter(
			(r) => r.name !== "Query" && r.name !== "Interpolate",
		);
		byId("src/State.luau").reexports.push(
			reex("src/State.luau#reexport.Query", "Query", "src/Query.luau"),
		);
		const regrouped = emitDocsFromJson(JSON.stringify(model), SAMPLE_CONFIG);
		expect(outline(regrouped.sidebar)).toEqual([
			"Overview",
			"Sample > Color",
			"Sample > Interpolate",
			"Sample > State > Query",
			"Sample > Type",
		]);
		expect(regrouped.apiIndex).toContain("- [Sample](/api/Sample)");
		expect(regrouped.apiIndex).toContain(
			"    - [State](/api/State)\n        - [Query](/api/Query)",
		);
		expect(regrouped.apiIndex).toMatch(/#region reference -->\n\n<div class="luaudocs-tree">/);
	});

	it("builds sidebars, trails, and access paths across shortest paths, cycles, and instance fallbacks", () => {
		const tree = buildAccessTree(samplePages);
		const sidebar = apiSidebar(tree);
		const sidebarOutline = (pages: PageModel[]) => outline(apiSidebar(buildAccessTree(pages)));
		expect(outline(sidebar)).toEqual(["Overview", "Sample > Color", "Sample > State > Query"]);

		const section = sidebar.find((item) => item.text === "Sample")!;
		expect(section.link).toBe("/api/Sample");
		expect(section.collapsed).toBeUndefined();
		const stateGroup = section.items!.find((item) => item.text === "State")!;
		expect(stateGroup.link).toBe("/api/State");
		expect(stateGroup.collapsed).toBe(true);

		const trails = apiTrails(tree);
		expect(trails.get("Query.md")).toEqual([
			{ text: "Overview", link: "/api/" },
			{ text: "Sample", link: "/api/Sample" },
			{ text: "State", link: "/api/State" },
		]);
		expect(trails.get("Color.md")!.map((s) => s.text)).toEqual(["Overview", "Sample"]);
		expect(trails.get("Sample.md")!.map((s) => s.text)).toEqual(["Overview"]);
		expect(trails.get("index.md")).toEqual([]);

		const access = (pages: PageModel[]): Record<string, string | undefined> => {
			const spelled: Record<string, string | undefined> = {};
			const walk = (node: TreeNode) => {
				spelled[node.page.title] = node.access;
				node.children.forEach(walk);
			};
			buildAccessTree(pages).forEach(walk);
			return spelled;
		};
		expect(
			access([
				navPage("src/init.luau", {
					title: "Root",
					entry: true,
					exports: [
						{ moduleId: "src/Networking.luau", name: "Net" },
						{ moduleId: "src/Shared.luau", name: "end" },
					],
				}),
				navPage("src/Networking.luau"),
				navPage("src/Shared.luau"),
				navPage("src/Internal.luau"),
			]),
		).toEqual({
			Root: "Root",
			Networking: "Root.Net",
			Shared: 'Root["end"]',
			Internal: undefined,
		});

		expect(
			sidebarOutline([
				navPage("src/init.luau", {
					title: "Root",
					entry: true,
					exports: ["src/A.luau", "src/Shared.luau"],
				}),
				navPage("src/A.luau", { exports: ["src/Shared.luau"] }),
				navPage("src/Shared.luau"),
			]),
		).toEqual(["Overview", "Root > A", "Root > Shared"]);

		expect(
			sidebarOutline([
				navPage("src/init.luau", { title: "Root", entry: true, exports: ["src/A.luau"] }),
				navPage("src/A.luau", { exports: ["src/B.luau"] }),
				navPage("src/B.luau", { exports: ["src/A.luau"] }),
			]),
		).toEqual(["Overview", "Root > A > B"]);

		expect(
			sidebarOutline([
				navPage("src/init.luau", {
					title: "Lib",
					entry: true,
					instancePath: ["game", "Lib"],
					exports: ["sub/Vendor/init.luau"],
				}),
				navPage("sub/Vendor/init.luau", {
					title: "Vendor",
					instancePath: ["game", "Lib", "Vendor"],
					exports: ["sub/Vendor/Bind.luau"],
				}),
				navPage("sub/Vendor/Bind.luau", {
					title: "Bind",
					instancePath: ["game", "Lib", "Vendor", "Bind"],
				}),
				navPage("sub/Vendor/Async.luau", {
					title: "Async",
					instancePath: ["game", "Lib", "Vendor", "Async"],
				}),
			]),
		).toEqual(["Overview", "Lib > Vendor > Async", "Lib > Vendor > Bind"]);

		expect(
			sidebarOutline([
				navPage("src/init.luau", { title: "Root", entry: true, exports: [] }),
				navPage("src/Shared/Type.luau"),
			]),
		).toEqual(["Overview", "Root > Type"]);

		expect(
			sidebarOutline([
				navPage("src/init.luau", { title: "Solo", entry: true, exports: [] }),
				navPage("vendor/Detached.luau"),
			]),
		).toEqual(["Overview", "Reference > Solo", "Reference > Detached"]);
	});
});

describe("doc-model parse failures and signature-links runtime transformer", () => {
	it("rejects invalid doc-model payloads with readable errors", () => {
		expect(() => parseDocModel("not json")).toThrow(/valid JSON/);
		expect(() => parseDocModel('{"schemaVersion": 2}')).toThrow(
			/schemaVersion is 2, expected 1/,
		);
		expect(() => parseDocModel('{"name": "package"}')).toThrow(
			/schemaVersion is undefined, expected 1/,
		);
		expect(() => parseDocModel("null")).toThrow(/not a JSON object/);
		expect(() => parseDocModel("[1]")).toThrow(/not a JSON object/);
	});

	it("parses, sanitizes, and relays signature link tables across VitePress fences", () => {
		expect(parseLinks(`luau ${LINKS_TOKEN}[[0,4,"/api/X"]]`)).toEqual([[0, 4, "/api/X"]]);
		expect(parseLinks(`luau ${LINKS_TOKEN}[[0,4,"/api/X"]] more`)).toEqual([[0, 4, "/api/X"]]);
		for (const bad of [
			undefined,
			"luau",
			`luau ${LINKS_TOKEN}[[0,4`,
			`luau ${LINKS_TOKEN}{"not":"an array"}`,
		]) {
			expect(parseLinks(bad)).toBeUndefined();
		}

		interface DecoratedOptions {
			decorations?: Array<{ start: number; end: number; properties: { href: string } }>;
		}
		type Preprocess = (
			this: { options: { meta?: { __raw?: string } } },
			code: string,
			options: DecoratedOptions,
		) => void;
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

		expect(spansOf("abcdefghij", '[[5,7,"/b"],[0,3,"/a"]]')).toEqual([
			[0, 3, "/a"],
			[5, 7, "/b"],
		]);
		expect(
			spansOf(
				"abcdefghij",
				'[[0,3,"/a"],[2,5,"/overlap"],[4,20,"/past-end"],[5,5,"/empty"],[6,8,7],"junk",[6,8,"/e"]]',
			),
		).toEqual([
			[0, 3, "/a"],
			[6, 8, "/e"],
		]);
		expect(spansOf("abc", "[[0,2")).toEqual([]);

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

/**
 * Cross-project dependency model loading and resolution (`src/dependencies.ts` and `src/render.ts`).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateConfig } from "../src/config";
import { loadDependencies } from "../src/dependencies";
import { parseDocModel } from "../src/docmodel";
import { buildDependencyLinks, emitDocsFromJson } from "../src/render";
import { makeTempDirFactory, memberBlock, modelJson, signatureLinks, testConfig } from "./helpers";

const tempDir = makeTempDirFactory("luaudocs-deps-");

const dependencyJson = modelJson([
	{
		id: "src/init.luau",
		instancePath: ["Dep"],
		name: "Dep",
		doc: "The dependency's entry.",
		source: { file: "src/init.luau", line: 1 },
		members: [
			{
				id: "src/init.luau#fn.Dep.new",
				name: "new",
				kind: "function",
				tags: { custom: [] },
				visibility: "public",
				errors: [],
				signature: { callee: "Dep.new", segs: ["()"], params: [], returns: [] },
				source: { file: "src/init.luau", line: 2 },
			},
		],
		classes: [
			{
				id: "src/init.luau#class.Dep",
				name: "Dep",
				tags: { custom: [] },
				constructors: [],
				members: [],
				source: { file: "src/init.luau", line: 1 },
			},
		],
	},
	{
		id: "src/net/client.luau",
		instancePath: ["Dep", "net", "client"],
		name: "client",
		source: { file: "src/net/client.luau", line: 1 },
		types: [
			{
				id: "src/net/client.luau#type.Response",
				name: "Response",
				exported: true,
				kind: "alias",
				generics: [],
				definition: [["{ status: number }"]],
				tags: { custom: [] },
				visibility: "public",
				source: { file: "src/net/client.luau", line: 3 },
			},
			{
				id: "src/net/client.luau#type.Private",
				name: "Private",
				exported: false,
				kind: "alias",
				generics: [],
				definition: [["number"]],
				tags: { custom: [] },
				visibility: "public",
				source: { file: "src/net/client.luau", line: 5 },
			},
		],
	},
]);
const dependency = parseDocModel(dependencyJson);

describe("buildDependencyLinks and external resolution", () => {
	const links = buildDependencyLinks([
		{ alias: "dep", url: "https://dep.test/docs/", model: dependency },
	]);

	it("resolves modules, exported types, classes, and falls back to module pages for unknown/private names", () => {
		expect(links.resolve({ alias: "dep", path: "net/client" })).toBe(
			"https://dep.test/docs/api/client",
		);
		expect(links.resolve({ alias: "dep", path: "" })).toBe("https://dep.test/docs/api/Dep");
		expect(links.resolve({ alias: "dep", path: "net/client", name: "Response" })).toBe(
			"https://dep.test/docs/api/client#response",
		);
		expect(links.resolve({ alias: "dep", path: "", name: "Dep" })).toBe(
			"https://dep.test/docs/api/Dep",
		);
		expect(links.resolve({ alias: "other", path: "net/client" })).toBeUndefined();
		expect(links.resolve({ alias: "dep", path: "net/server" })).toBeUndefined();
		for (const name of ["Missing", "Private"]) {
			expect(links.resolve({ alias: "dep", path: "net/client", name })).toBe(
				"https://dep.test/docs/api/client",
			);
		}
	});

	it("links external signature references through a loaded model or falls back to the base URL", () => {
		const fn = (name: string, ref: string, line: number) => ({
			id: `src/init.luau#fn.App.${name}`,
			name,
			kind: "function",
			tags: { custom: [] },
			visibility: "public",
			errors: [],
			signature: {
				callee: `App.${name}`,
				segs: ["(): ", { text: ref }],
				params: [],
				returns: [{ type: [{ text: ref }] }],
			},
			source: { file: "src/init.luau", line },
		});
		const consumer = JSON.stringify({
			...JSON.parse(
				modelJson([
					{
						id: "src/init.luau",
						instancePath: ["App"],
						name: "App",
						source: { file: "src/init.luau", line: 1 },
						members: [
							fn("fetch", "client.Response", 4),
							fn("other", "client.Options", 8),
						],
					},
				]),
			),
			externals: {
				"client.Response": {
					url: "https://dep.test/docs/net/client",
					alias: "dep",
					path: "net/client",
					name: "Response",
				},
				"client.Options": {
					url: "https://dep.test/docs/net/client",
					alias: "dep",
					path: "net/client",
					name: "Options",
				},
			},
		});

		const withModel = emitDocsFromJson(consumer, testConfig(), links).pages.get("App.md")!;
		expect(signatureLinks(memberBlock(withModel, "fetch"))).toEqual([
			"https://dep.test/docs/api/client#response",
		]);
		expect(signatureLinks(memberBlock(withModel, "other"))).toEqual([
			"https://dep.test/docs/api/client",
		]);

		const withoutModel = emitDocsFromJson(consumer, testConfig()).pages.get("App.md")!;
		expect(signatureLinks(memberBlock(withoutModel, "fetch"))).toEqual([
			"https://dep.test/docs/net/client",
		]);
	});
});

describe("loadDependencies", () => {
	let cache: string;
	beforeEach(() => {
		cache = tempDir();
		vi.stubEnv("XDG_CACHE_HOME", cache);
		vi.stubEnv("HOME", cache);
		vi.stubEnv("LOCALAPPDATA", cache);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	const cached = (url: string): string =>
		join(
			process.platform === "darwin" ? join(cache, "Library", "Caches") : cache,
			"luaudocs",
			"models",
			`${createHash("sha256").update(url).digest("hex")}.json`,
		);

	function stubFetch(...answers: Array<Response | Error>) {
		const fetch = vi.fn(async () => {
			const next = answers.shift();
			if (next === undefined || next instanceof Error) {
				throw next ?? new Error("unexpected fetch");
			}
			return next;
		});
		vi.stubGlobal("fetch", fetch);
		return fetch;
	}

	const loadUrl = (url: string) =>
		loadDependencies(
			validateConfig({
				title: "X",
				source: { aliases: { dep: { url: "https://dep.test", model: url } } },
			}),
			tempDir(),
		);

	it("loads local models and warns on missing or malformed files", async () => {
		const root = tempDir();
		mkdirSync(join(root, "deps"), { recursive: true });
		writeFileSync(join(root, "deps", "dep.json"), dependencyJson);
		writeFileSync(join(root, "bad.json"), "{}");

		const ok = await loadDependencies(
			validateConfig({
				title: "X",
				source: { aliases: { dep: { url: "https://dep.test", model: "deps/dep.json" } } },
			}),
			root,
		);
		expect(ok.warnings).toEqual([]);
		expect(ok.loaded.map((d) => [d.alias, d.url, d.model.modules.length])).toEqual([
			["dep", "https://dep.test", 2],
		]);

		const bad = await loadDependencies(
			validateConfig({
				title: "X",
				source: {
					aliases: {
						gone: { url: "https://gone.test", model: "missing.json" },
						bad: { url: "https://bad.test", model: "bad.json" },
					},
				},
			}),
			root,
		);
		expect(bad.loaded).toEqual([]);
		expect(bad.warnings[0]).toMatch(
			/aliases\.bad: could not load .*bad\.json \(.*schemaVersion/,
		);
		expect(bad.warnings[1]).toMatch(/aliases\.gone: could not load .*missing\.json/);
	});

	it("fetches, caches, memoizes valid models, and falls back to cache on network/parse failures", async () => {
		const okUrl = "https://dep.test/ok/docmodel.json";
		const fetchOk = stubFetch(new Response(dependencyJson));
		const first = await loadUrl(okUrl);
		expect(first.warnings).toEqual([]);
		expect(first.loaded[0]?.model.modules).toHaveLength(2);
		expect(readFileSync(cached(okUrl), "utf8")).toBe(dependencyJson);
		expect((await loadUrl(okUrl)).loaded).toHaveLength(1);
		expect(fetchOk).toHaveBeenCalledTimes(1);

		const url404 = "https://dep.test/404/docmodel.json";
		stubFetch(new Response("not found", { status: 404 }));
		const res404 = await loadUrl(url404);
		expect(res404.loaded).toEqual([]);
		expect(res404.warnings[0]).toMatch(/aliases\.dep: could not load .*\(HTTP 404\)/);
		expect(existsSync(cached(url404))).toBe(false);

		for (const [slug, response] of [
			["offline", new TypeError("fetch failed")],
			["junk", new Response("<html>captive portal</html>")],
		] as const) {
			const url = `https://dep.test/${slug}/docmodel.json`;
			mkdirSync(join(cached(url), ".."), { recursive: true });
			writeFileSync(cached(url), dependencyJson);
			stubFetch(response);
			const res = await loadUrl(url);
			expect(res.loaded[0]?.model.modules).toHaveLength(2);
			expect(readFileSync(cached(url), "utf8")).toBe(dependencyJson);
		}

		const flakyUrl = "https://dep.test/flaky/docmodel.json";
		const fetchFlaky = stubFetch(new TypeError("fetch failed"), new Response(dependencyJson));
		expect((await loadUrl(flakyUrl)).loaded).toEqual([]);
		expect((await loadUrl(flakyUrl)).loaded).toHaveLength(1);
		expect(fetchFlaky).toHaveBeenCalledTimes(2);
	});
});

/**
 * Tests for the `luaudocs.toml` validator and loader (`src/config.ts`).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_ALIASES,
	defaultConfig,
	loadConfig,
	parseConfig,
	parseUrlFlag,
	validateConfig,
} from "../src/config";
import { makeTempDirFactory } from "./helpers";

const tempDir = makeTempDirFactory("luaudocs-config-");

describe("validateConfig", () => {
	it("requires a title only when no fallback exists", () => {
		expect(() => validateConfig({})).toThrow(/title is required/);
		expect(() => validateConfig({ title: 7 })).toThrow(/title: expected a string/);
		expect(validateConfig({}, "Folder").title).toBe("Folder");
		expect(validateConfig({ title: "Mine" }, "Folder").title).toBe("Mine");
	});

	it.each([
		["the root", { title: "X", titel: "X" }, /unknown key titel/],
		["[source]", { title: "X", source: { entires: ["src"] } }, /unknown key source\.entires/],
		["[site]", { title: "X", site: { logotype: "x.png" } }, /unknown key site\.logotype/],
		[
			"[site] logo",
			{ title: "X", site: { logo: { light: "l.png", dark: "d.png", lite: "l.png" } } },
			/unknown key site\.logo\.lite/,
		],
		[
			"[site] footer",
			{ title: "X", site: { footer: { copyrite: "c" } } },
			/unknown key site\.footer\.copyrite/,
		],
		[
			"[site] siteTitle",
			{ title: "X", site: { siteTitle: true } },
			/site\.siteTitle: expected a string or false/,
		],
		["[api]", { title: "X", api: { private: true } }, /unknown key api\.private/],
		["[docs]", { title: "X", docs: { directory: "docs" } }, /unknown key docs\.directory/],
		[
			"a nav item",
			{ title: "X", site: { nav: [{ text: "Guide", href: "/guide/" }] } },
			/unknown key site\.nav\[0\]\.href/,
		],
		[
			"a nested nav item",
			{
				title: "X",
				site: {
					nav: [
						{ text: "More", items: [{ text: "FAQ", link: "/faq", position: "left" }] },
					],
				},
			},
			/unknown key site\.nav\[0\]\.items\[0\]\.position/,
		],
		[
			"a head entry",
			{ title: "X", site: { head: [{ tag: "script", scr: "x.js" }] } },
			/unknown key site\.head\[0\]\.scr/,
		],
		[
			"a dangling nav item",
			{ title: "X", site: { nav: [{ text: "Dangling" }] } },
			/nav item with a link or items/,
		],
		[
			"a head entry missing tag",
			{ title: "X", site: { head: [{ attrs: {} }] } },
			/site\.head\[0\]\.tag: expected a string/,
		],
		[
			"a non-string head attr",
			{ title: "X", site: { head: [{ tag: "script", attrs: { defer: true } }] } },
			/site\.head\[0\]\.attrs\.defer: expected a string/,
		],
		[
			"a non-array source.entries",
			{ title: "X", source: { entries: "src" } },
			/source\.entries: expected an array of strings/,
		],
		[
			"a non-boolean api.includePrivate",
			{ title: "X", api: { includePrivate: "yes" } },
			/api\.includePrivate: expected a boolean/,
		],
	])("rejects invalid config at %s", (_level, data, error) => {
		expect(() => validateConfig(data)).toThrow(error);
	});

	it("preserves optional keys, nav dropdowns, head entries, and defaults", () => {
		const defaults = validateConfig({ title: "X" });
		expect(defaults.source).toEqual({ entries: ["src"], aliases: DEFAULT_ALIASES });
		expect(defaults.docs).toEqual({
			dir: ".luaudocs",
			llms: true,
			model: false,
			includeReadme: false,
			changelog: undefined,
			url: undefined,
		});
		expect(defaults.api).toEqual({
			includePrivate: false,
			linkRobloxTypes: true,
			reportUndocumented: false,
		});
		expect(defaults.repo).toBeUndefined();

		const full = validateConfig({
			title: "X",
			repo: { url: "https://github.com/user/repo/" },
			docs: { url: "https://docs.example.com//" },
			source: {
				entries: ["src"],
				include: ["**/*.luau"],
				exclude: ["**/*.spec.luau"],
				projectFile: "place.project.json",
			},
			site: {
				siteTitle: false,
				logo: "/logo.svg",
				favicon: "/icon.png",
				ogImage: "/og.png",
				footer: { message: "MIT Licensed", copyright: "Copyright" },
				nav: [
					{ text: "Guide", link: "/guide/intro", activeMatch: "^/guide/" },
					{ text: "More", items: [{ text: "Changelog", link: "/changelog" }] },
				],
				head: [
					{ tag: "script", attrs: { defer: "true", src: "/x.js" } },
					{ tag: "script", content: "track()" },
				],
			},
		});
		expect(full.repo).toEqual({ url: "https://github.com/user/repo", branch: "main" });
		expect(full.docs.url).toBe("https://docs.example.com");
		expect(full.source).toEqual({
			entries: ["src"],
			include: ["**/*.luau"],
			exclude: ["**/*.spec.luau"],
			projectFile: "place.project.json",
			aliases: DEFAULT_ALIASES,
		});
		expect(full.site.siteTitle).toBe(false);
		expect(full.site.logo).toBe("/logo.svg");
		expect(full.site.favicon).toBe("/icon.png");
		expect(full.site.ogImage).toBe("/og.png");
		expect(full.site.footer).toEqual({ message: "MIT Licensed", copyright: "Copyright" });
		expect(full.site.nav).toEqual([
			{ text: "Guide", link: "/guide/intro", activeMatch: "^/guide/" },
			{ text: "More", items: [{ text: "Changelog", link: "/changelog" }] },
		]);
		expect(full.site.head).toEqual([
			{ tag: "script", attrs: { defer: "true", src: "/x.js" } },
			{ tag: "script", content: "track()" },
		]);
	});

	it("merges and validates [source] aliases over built-in runtimes", () => {
		const config = validateConfig({
			title: "X",
			source: { aliases: { "@Pkg": "https://pkg.test/docs/", lune: false, lute: true } },
		});
		expect(config.source.aliases).toEqual({
			pkg: { url: "https://pkg.test/docs" },
			lute: {},
			std: DEFAULT_ALIASES.std,
		});
		expect(
			validateConfig({
				title: "X",
				source: { aliases: { dep: { url: "https://dep.test/", model: "deps/dep.json" } } },
			}).source.aliases.dep,
		).toEqual({ url: "https://dep.test", model: "deps/dep.json" });

		for (const [alias, err] of [
			[{ model: 1 }, /source\.aliases\.dep\.model: expected a string/],
			[{ site: "x" }, /unknown key source\.aliases\.dep\.site/],
			[{ model: "dep.json" }, /source\.aliases\.dep\.url: expected a URL beside model/],
			[5, /source\.aliases\.dep: expected a URL, a table with url and model, true, or false/],
			["docs", /source\.aliases\.dep/],
			["ftp://example.com/dep", /source\.aliases\.dep: expected an http\(s\) URL/],
		] as const) {
			expect(() =>
				validateConfig({ title: "X", source: { aliases: { dep: alias } } }),
			).toThrow(err);
		}
	});
});

describe("parseConfig and parseUrlFlag", () => {
	it("reports TOML syntax errors and validates http(s) URLs", () => {
		expect(() => parseConfig("title = ")).toThrow(/luaudocs\.toml:/);
		expect(parseUrlFlag("https://user.github.io/repo/")).toBe("https://user.github.io/repo");
		expect(parseUrlFlag("http://localhost:8080/")).toBe("http://localhost:8080");
		expect(() => parseUrlFlag("not a url")).toThrow(/--url: expected an http\(s\) URL/);
		expect(() => parseUrlFlag("docs.example.com:8080")).toThrow(/--url: expected an http\(s\)/);
		expect(() => validateConfig({ title: "X", repo: { url: "not a url" } })).toThrow(
			/repo\.url: expected an http\(s\) URL/,
		);
		expect(() => validateConfig({ title: "X", docs: { url: "docs.example.com" } })).toThrow(
			/docs\.url: expected an http\(s\) URL/,
		);
		expect(() =>
			validateConfig({ title: "X", repo: { url: "ssh://git@github.com/a/b" } }),
		).toThrow(/repo\.url: expected an http\(s\) URL/);
	});
});

describe("loadConfig", () => {
	it("walks up from nested directories and synthesizes defaults when absent", () => {
		const dir = tempDir();
		writeFileSync(join(dir, "luaudocs.toml"), 'title = "X"\n[source]\nentries = ["lib"]\n');
		mkdirSync(join(dir, "lib", "nested"), { recursive: true });
		const loaded = loadConfig(join(dir, "lib", "nested"));
		expect(loaded.root).toBe(dir);
		expect(loaded.configPath).toBe(join(dir, "luaudocs.toml"));
		expect(loaded.config.source.entries).toEqual(["lib"]);

		const bare = tempDir();
		mkdirSync(join(bare, "src"));
		mkdirSync(join(bare, "lib"));
		const synth = loadConfig(bare);
		expect(synth.configPath).toBeUndefined();
		expect(synth.root).toBe(bare);
		expect(synth.config.title).toBe(basename(bare));
		expect(synth.config.source.entries).toEqual(["src", "lib"]);
		expect(synth.config.docs.dir).toBe(".luaudocs");

		const emptyToml = tempDir();
		writeFileSync(join(emptyToml, "luaudocs.toml"), "");
		expect(loadConfig(emptyToml).config.title).toBe(basename(emptyToml));

		expect(() => defaultConfig(tempDir())).toThrow(/no luaudocs\.toml found .*luaudocs init/);
	});

	it("normalizes [docs] dir inside the project and rejects root or outside paths", () => {
		const root = tempDir();
		for (const [dir, expected] of [
			["./docs/", "docs"],
			["docs//site/", "docs/site"],
			["sub/../site", "site"],
			[join(root, "site"), "site"],
		] as const) {
			writeFileSync(join(root, "luaudocs.toml"), `[docs]\ndir = ${JSON.stringify(dir)}\n`);
			expect(loadConfig(root).config.docs.dir, dir).toBe(expected);
		}

		const outside = tempDir();
		for (const bad of [".", "", "./", "..", "../..", "sub/../", "../site", root, outside]) {
			writeFileSync(join(root, "luaudocs.toml"), `[docs]\ndir = ${JSON.stringify(bad)}\n`);
			expect(() => loadConfig(root), bad).toThrow(
				/docs\.dir: expected a directory inside the project/,
			);
		}
	});
});

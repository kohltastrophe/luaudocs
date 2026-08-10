/**
 * The hand-rolled luaudocs.toml validator. Strictness is the feature under
 * test: a misspelled key must fail the build, not silently fall back to its
 * default, so unknown-key rejection is pinned at every nesting level the
 * config has.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, parseConfig, parseUrlFlag, validateConfig } from "../src/config";
import { makeTempDirFactory } from "./helpers";

const tempDir = makeTempDirFactory("luaudocs-config-");

describe("validateConfig", () => {
	it("requires a title only when no fallback exists", () => {
		expect(() => validateConfig({})).toThrow(/title is required/);
		expect(() => validateConfig({ title: 7 })).toThrow(/title: expected a string/);
		// the loaders pass the folder name; an explicit title still wins
		expect(validateConfig({}, "Folder").title).toBe("Folder");
		expect(validateConfig({ title: "Mine" }, "Folder").title).toBe("Mine");
	});

	// one row per nesting level, so a level losing its noUnknownKeys call fails
	// by name rather than by whichever other row happened to share the key
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
	])("rejects an unknown key on %s", (_level, data, error) => {
		expect(() => validateConfig(data)).toThrow(error);
	});

	it("rejects a nav item with neither link nor items", () => {
		expect(() => validateConfig({ title: "X", site: { nav: [{ text: "Dangling" }] } })).toThrow(
			/nav item with a link or items/,
		);
	});

	it("keeps nested nav items, dropdowns and activeMatch included", () => {
		const config = validateConfig({
			title: "X",
			site: {
				nav: [
					{ text: "Guide", link: "/guide/intro", activeMatch: "^/guide/" },
					{ text: "More", items: [{ text: "Changelog", link: "/changelog" }] },
				],
			},
		});
		expect(config.site.nav).toEqual([
			{ text: "Guide", link: "/guide/intro", activeMatch: "^/guide/" },
			{ text: "More", items: [{ text: "Changelog", link: "/changelog" }] },
		]);
	});

	it("keeps [[site.head]] entries, attrs and content included", () => {
		const config = validateConfig({
			title: "X",
			site: {
				head: [
					{ tag: "script", attrs: { defer: "true", src: "/x.js" } },
					{ tag: "script", content: "track()" },
				],
			},
		});
		expect(config.site.head).toEqual([
			{ tag: "script", attrs: { defer: "true", src: "/x.js" } },
			{ tag: "script", content: "track()" },
		]);
	});

	it("rejects malformed [[site.head]] entries with the path that holds them", () => {
		expect(() => validateConfig({ title: "X", site: { head: [{ attrs: {} }] } })).toThrow(
			/site\.head\[0\]\.tag: expected a string/,
		);
		// TOML allows non-string attr values, but head attributes are text
		expect(() =>
			validateConfig({
				title: "X",
				site: { head: [{ tag: "script", attrs: { defer: true } }] },
			}),
		).toThrow(/site\.head\[0\]\.attrs\.defer: expected a string/);
	});

	it("validates urls and trims their trailing slashes", () => {
		expect(() => validateConfig({ title: "X", repo: { url: "not a url" } })).toThrow(
			/repo\.url: expected a URL/,
		);
		expect(() => validateConfig({ title: "X", docs: { url: "docs.example.com" } })).toThrow(
			/docs\.url: expected a URL/,
		);
		const config = validateConfig({
			title: "X",
			repo: { url: "https://github.com/user/repo/" },
			docs: { url: "https://docs.example.com//" },
		});
		// links append their own separators, so a kept slash would double them
		expect(config.repo?.url).toBe("https://github.com/user/repo");
		expect(config.docs.url).toBe("https://docs.example.com");
	});

	// the strictness rows above prove wrong keys fail; this proves the right
	// ones arrive, for the optional keys nothing else in the suite touches
	it("keeps every optional key it validates", () => {
		const config = validateConfig({
			title: "X",
			source: {
				entries: ["src"],
				include: ["**/*.luau"],
				exclude: ["**/*.spec.luau"],
				projectFile: "place.project.json",
			},
			site: {
				// false: the value a truthiness test would drop
				siteTitle: false,
				logo: "/logo.svg",
				favicon: "/icon.png",
				ogImage: "/og.png",
				footer: { message: "MIT Licensed", copyright: "Copyright" },
			},
		});
		expect(config.source).toEqual({
			entries: ["src"],
			include: ["**/*.luau"],
			exclude: ["**/*.spec.luau"],
			projectFile: "place.project.json",
		});
		expect(config.site.siteTitle).toBe(false);
		expect(config.site.logo).toBe("/logo.svg");
		expect(config.site.favicon).toBe("/icon.png");
		expect(config.site.ogImage).toBe("/og.png");
		expect(config.site.footer).toEqual({ message: "MIT Licensed", copyright: "Copyright" });
	});

	it("fills every default", () => {
		const config = validateConfig({ title: "X" });
		expect(config.source.entries).toEqual(["src"]);
		expect(config.docs.dir).toBe(".luaudocs");
		expect(config.api).toEqual({ includePrivate: false, linkRobloxTypes: true });
		expect(config.docs.llms).toBe(true);
		expect(config.docs.includeReadme).toBe(false);
		expect(config.repo).toBeUndefined();
	});

	it("defaults the branch when [repo] sets only a url", () => {
		const config = validateConfig({ title: "X", repo: { url: "https://example.test/x" } });
		expect(config.repo).toEqual({ url: "https://example.test/x", branch: "main" });
	});

	it("rejects mistyped values with the path that holds them", () => {
		expect(() => validateConfig({ title: "X", source: { entries: "src" } })).toThrow(
			/source\.entries: expected an array of strings/,
		);
		expect(() => validateConfig({ title: "X", api: { includePrivate: "yes" } })).toThrow(
			/api\.includePrivate: expected a boolean/,
		);
	});
});

describe("parseConfig", () => {
	it("reports TOML syntax errors under the config's name", () => {
		expect(() => parseConfig("title = ")).toThrow(/luaudocs\.toml:/);
	});
});

describe("parseUrlFlag", () => {
	it("applies [docs] url's rule, phrased for the flag", () => {
		expect(parseUrlFlag("https://user.github.io/repo/")).toBe("https://user.github.io/repo");
		expect(() => parseUrlFlag("not a url")).toThrow(/--url: expected a URL/);
	});
});

describe("loadConfig", () => {
	it("walks up from a nested start directory", () => {
		const dir = tempDir();
		writeFileSync(join(dir, "luaudocs.toml"), 'title = "X"\n[source]\nentries = ["lib"]\n');
		mkdirSync(join(dir, "lib", "nested"), { recursive: true });

		const loaded = loadConfig(join(dir, "lib", "nested"));
		expect(loaded.root).toBe(dir);
		expect(loaded.configPath).toBe(join(dir, "luaudocs.toml"));
		expect(loaded.config.source.entries).toEqual(["lib"]);
	});

	it("synthesizes defaults when no config exists: folder title, probed entries", () => {
		const dir = tempDir();
		mkdirSync(join(dir, "src"));
		const loaded = loadConfig(dir);
		expect(loaded.configPath).toBeUndefined();
		expect(loaded.root).toBe(dir);
		expect(loaded.config.title).toBe(basename(dir));
		expect(loaded.config.source.entries).toEqual(["src"]);
		// the rest arrives through the same validator as a real config
		expect(loaded.config.docs.dir).toBe(".luaudocs");
	});

	it("keeps every conventional root the probe finds", () => {
		const dir = tempDir();
		mkdirSync(join(dir, "src"));
		mkdirSync(join(dir, "lib"));
		expect(loadConfig(dir).config.source.entries).toEqual(["src", "lib"]);
	});

	it("defaults the title from the folder when the config omits it", () => {
		const dir = tempDir();
		writeFileSync(join(dir, "luaudocs.toml"), "");
		expect(loadConfig(dir).config.title).toBe(basename(dir));
	});

	it("points at `luaudocs init` when there is no config and nothing to probe", () => {
		const dir = tempDir();
		expect(() => loadConfig(dir)).toThrow(/no luaudocs\.toml found .*luaudocs init/);
	});
});

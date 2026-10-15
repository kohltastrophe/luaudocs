/**
 * Tests for `syncDir`, `filterModel`, and `runBuild` (`src/build.ts`).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	createContext,
	filterModel,
	runBuild,
	syncDir,
	type BuildContext,
	type RenderedModel,
} from "../src/build";
import { parseDocModel, type DocModel } from "../src/docmodel";
import { emitDocs } from "../src/render";
import { makeTempDirFactory, modelJson, readFixture } from "./helpers";

const tempDir = makeTempDirFactory("luaudocs-sync-");

function seed(dir: string, files: Record<string, string>): void {
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(dir, rel);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, content);
	}
}

describe("syncDir", () => {
	it("writes new/changed files, sweeps stale files/dirs, and skips unchanged files", () => {
		const dir = tempDir();
		seed(dir, { "stale.md": "old\n", "keep.md": "old\n", "sub/gone.md": "old\n" });

		expect(
			syncDir(
				dir,
				new Map([
					["keep.md", "new\n"],
					["added.md", "fresh\n"],
				]),
			),
		).toEqual({ written: 2, deleted: 2, unchanged: 0 });
		expect(readFileSync(join(dir, "keep.md"), "utf8")).toBe("new\n");
		expect(readFileSync(join(dir, "added.md"), "utf8")).toBe("fresh\n");
		expect(existsSync(join(dir, "stale.md"))).toBe(false);
		expect(existsSync(join(dir, "sub"))).toBe(false);

		expect(
			syncDir(
				dir,
				new Map([
					["keep.md", "new\n"],
					["added.md", "fresh\n"],
				]),
			),
		).toEqual({ written: 0, deleted: 0, unchanged: 2 });
	});

	it("respects deleteStale = false, keepForeign exemptions, case-flips, and empty missing dirs", () => {
		const noSweep = tempDir();
		seed(noSweep, { "stale.md": "old\n" });
		expect(syncDir(noSweep, new Map([["page.md", "new\n"]]), false).deleted).toBe(0);
		expect(existsSync(join(noSweep, "stale.md"))).toBe(true);

		const foreign = tempDir();
		seed(foreign, {
			"dist/index.html": "built\n",
			"cache/deps/x.json": "cached\n",
			"config.mts.timestamp-123.mjs": "transient\n",
			"generated/stale.ts": "old\n",
		});
		syncDir(
			foreign,
			new Map([["config.mts", "baked\n"]]),
			true,
			(rel) =>
				rel === "dist" ||
				rel.startsWith("dist/") ||
				rel === "cache" ||
				rel.startsWith("cache/") ||
				rel.includes(".timestamp-"),
		);
		expect(readFileSync(join(foreign, "dist/index.html"), "utf8")).toBe("built\n");
		expect(readFileSync(join(foreign, "cache/deps/x.json"), "utf8")).toBe("cached\n");
		expect(existsSync(join(foreign, "config.mts.timestamp-123.mjs"))).toBe(true);
		expect(existsSync(join(foreign, "generated/stale.ts"))).toBe(false);

		const recased = tempDir();
		seed(recased, { "widget.md": "old\n" });
		syncDir(recased, new Map([["Widget.md", "new\n"]]));
		expect(readFileSync(join(recased, "Widget.md"), "utf8")).toBe("new\n");
		expect(readdirSync(recased)).toEqual(["Widget.md"]);

		const never = join(tempDir(), "never");
		syncDir(never, new Map());
		expect(existsSync(never)).toBe(false);
	});
});

describe("filterModel ([source] include/exclude)", () => {
	function filterable(ids: string[], files: Array<string | undefined>): DocModel {
		const model = parseDocModel(modelJson(ids.map((id) => ({ id }))));
		model.diagnostics = files.map((file) => ({
			severity: "error",
			code: "parse-error",
			message: "x",
			...(file === undefined ? {} : { file }),
		}));
		return model;
	}
	const ids = (model: DocModel): string[] => model.modules.map((m) => m.id);

	it("filters modules and file-scoped diagnostics across globs, dot-dirs, and Windows paths", () => {
		const passthrough = filterable(["src/a.luau"], ["src/a.luau"]);
		expect(filterModel(passthrough, undefined, undefined)).toBe(passthrough);
		expect(filterModel(passthrough, undefined, [])).toBe(passthrough);

		expect(ids(filterModel(filterable(["src/a.luau"], []), [], undefined))).toEqual([]);
		expect(
			ids(
				filterModel(
					filterable(["src/.hidden/a.luau", "src/b.luau"], []),
					["src/.hidden/**"],
					undefined,
				),
			),
		).toEqual(["src/.hidden/a.luau"]);

		const win = filterModel(
			filterable(["src\\gen\\a.luau", "src\\b.luau"], ["src\\gen\\a.luau"]),
			undefined,
			["src/gen/**"],
		);
		expect(ids(win)).toEqual(["src\\b.luau"]);
		expect(win.diagnostics).toEqual([]);

		const diag = filterModel(
			filterable(
				["src/a.luau", "src/gen/b.luau"],
				["src/gen/b.luau", "src/a.luau", undefined],
			),
			undefined,
			["src/gen/**"],
		);
		expect(ids(diag)).toEqual(["src/a.luau"]);
		expect(diag.diagnostics.map((d) => d.file)).toEqual(["src/a.luau", undefined]);
	});
});

describe("runBuild", () => {
	const rendered = (context: BuildContext, model: DocModel): RenderedModel => ({
		model,
		result: emitDocs(model, context.config),
	});

	it("validates guides before writing and toggles public/docmodel.json with [docs] model", async () => {
		const badDir = tempDir();
		seed(badDir, {
			"luaudocs.toml": "[source]\nentries = []\n",
			".luaudocs/api/stale.md": "old\n",
			".luaudocs/guide/reference/_category_.json": '{ "label": "Reference", }\n',
			".luaudocs/guide/reference/cli.md": "# CLI\n",
		});
		await expect(runBuild(createContext(badDir))).rejects.toThrow(/_category_\.json/);
		expect(existsSync(join(badDir, ".luaudocs", "api", "stale.md"))).toBe(true);

		const dir = tempDir();
		seed(dir, { "luaudocs.toml": "[source]\nentries = []\n[docs]\nmodel = true\n" });
		await runBuild(createContext(dir));
		const published = join(dir, ".luaudocs", "public", "docmodel.json");
		expect(JSON.parse(readFileSync(published, "utf8")).schemaVersion).toBe(1);

		seed(dir, { "luaudocs.toml": "[source]\nentries = []\n" });
		await runBuild(createContext(dir));
		expect(existsSync(published)).toBe(false);
	});

	it("preserves previously generated pages and navigation on an error build", async () => {
		const dir = tempDir();
		seed(dir, {
			"luaudocs.toml": '[docs]\nmodel = true\nurl = "https://docs.example.com"\n',
			"CHANGELOG.md": "# Changelog\n\n- first\n",
		});
		const docs = join(dir, ".luaudocs");
		const good = parseDocModel(readFixture("docmodel-sample.json"));
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await runBuild(createContext(dir), { rendered: rendered(createContext(dir), good) });
			const watched = [
				"public/docmodel.json",
				"public/llms.txt",
				"public/llms-full.txt",
				"changelog.md",
				"api/index.md",
				".vitepress/generated/api-nav.ts",
			];
			const before = new Map(
				watched.map((rel) => [rel, readFileSync(join(docs, rel), "utf8")]),
			);
			const pagesBefore = readdirSync(join(docs, "api")).sort();
			expect(pagesBefore.length).toBeGreaterThan(2);

			const broken = parseDocModel(readFixture("docmodel-sample.json"));
			broken.modules = broken.modules.slice(0, 1);
			broken.diagnostics = [
				{ severity: "error", code: "parse-error", message: "boom", file: "src/State.luau" },
			];
			seed(dir, { "CHANGELOG.md": "# Changelog\n\n- second\n" });
			const outcome = await runBuild(createContext(dir), {
				rendered: rendered(createContext(dir), broken),
			});

			expect(outcome.counts.errors).toBe(1);
			expect(outcome.summary.deleted).toBe(0);
			expect(readdirSync(join(docs, "api")).sort()).toEqual(pagesBefore);
			for (const [rel, text] of before) {
				expect(readFileSync(join(docs, rel), "utf8"), rel).toBe(text);
			}
		} finally {
			vi.restoreAllMocks();
		}
	});
});

/**
 * syncDir, the write contract: <docs>/api/ and <docs>/.vitepress/ are made to
 * contain exactly the emitted set. Everything here fails silently in the field
 * (a deleted user file, a kept stale page), so each branch gets its own case:
 * the sweep, the error-build skip, the keepForeign exemptions, and the
 * case-flip convergence.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { syncDir } from "../src/build";
import { makeTempDirFactory } from "./helpers";

const tempDir = makeTempDirFactory("luaudocs-sync-");

function seed(dir: string, files: Record<string, string>): void {
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(dir, rel);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, content);
	}
}

describe("syncDir", () => {
	it("makes the directory contain exactly the emitted set", () => {
		const dir = tempDir();
		seed(dir, { "stale.md": "old\n", "keep.md": "old\n", "sub/gone.md": "old\n" });

		const summary = syncDir(
			dir,
			new Map([
				["keep.md", "new\n"],
				["added.md", "fresh\n"],
			]),
		);

		expect(readFileSync(join(dir, "keep.md"), "utf8")).toBe("new\n");
		expect(readFileSync(join(dir, "added.md"), "utf8")).toBe("fresh\n");
		expect(existsSync(join(dir, "stale.md"))).toBe(false);
		// the sweep also removes the directory it emptied
		expect(existsSync(join(dir, "sub"))).toBe(false);
		expect(summary).toEqual({ written: 2, deleted: 2, unchanged: 0 });
	});

	it("reports an identical file as unchanged, so watchers see no event", () => {
		const dir = tempDir();
		seed(dir, { "same.md": "content\n" });
		const summary = syncDir(dir, new Map([["same.md", "content\n"]]));
		expect(summary).toEqual({ written: 0, deleted: 0, unchanged: 1 });
	});

	it("skips the sweep when deleteStale is off (error builds)", () => {
		const dir = tempDir();
		seed(dir, { "stale.md": "old\n" });
		const summary = syncDir(dir, new Map([["page.md", "new\n"]]), false);
		expect(existsSync(join(dir, "stale.md"))).toBe(true);
		expect(summary.deleted).toBe(0);
	});

	it("leaves keepForeign paths alone inside a tool-owned tree", () => {
		const dir = tempDir();
		// what .vitepress/ holds after a build: VitePress's own output and
		// cache beside the generated files (see isVitepressOwn in src/site.ts)
		seed(dir, {
			"dist/index.html": "built\n",
			"cache/deps/x.json": "cached\n",
			"config.mts.timestamp-123.mjs": "transient\n",
			"generated/stale.ts": "old\n",
		});

		syncDir(
			dir,
			new Map([["config.mts", "baked\n"]]),
			true,
			(rel) =>
				rel === "dist" ||
				rel.startsWith("dist/") ||
				rel === "cache" ||
				rel.startsWith("cache/") ||
				rel.includes(".timestamp-"),
		);

		expect(readFileSync(join(dir, "dist/index.html"), "utf8")).toBe("built\n");
		expect(readFileSync(join(dir, "cache/deps/x.json"), "utf8")).toBe("cached\n");
		expect(existsSync(join(dir, "config.mts.timestamp-123.mjs"))).toBe(true);
		// the exemption is not a blanket skip: generated leftovers still sweep
		expect(existsSync(join(dir, "generated/stale.ts"))).toBe(false);
	});

	it("converges a re-cased slug to the emitted casing", () => {
		// on a case-sensitive filesystem the old casing is swept as stale; on a
		// case-preserving one (the Windows CI leg) the write lands in the
		// old-cased file and the sweep renames it. Same postcondition, so this
		// one test covers whichever branch the host takes.
		const dir = tempDir();
		seed(dir, { "widget.md": "old\n" });
		syncDir(dir, new Map([["Widget.md", "new\n"]]));

		expect(readFileSync(join(dir, "Widget.md"), "utf8")).toBe("new\n");
		// readdir names are the ground truth: existsSync answers yes for
		// either casing on a case-preserving filesystem
		expect(readdirSync(dir)).toEqual(["Widget.md"]);
	});

	it("creates nothing for an empty set over a missing directory", () => {
		const dir = join(tempDir(), "never");
		syncDir(dir, new Map());
		expect(existsSync(dir)).toBe(false);
	});
});

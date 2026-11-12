/** Shared test seams: validated configs, fixture paths, temp dirs, inline models. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect } from "vitest";
import { validateConfig, type LuauDocsConfig } from "../src/config";
import type { SourceSpan } from "../src/docmodel";
import { API_DIR, filesUnder as walkFiles, type BuildContext } from "../src/pages";
import { parseLinks } from "../templates/runtime/signature-links";

/**
 * Built through the real validator rather than hand-written, so tests exercise
 * the real defaults instead of a parallel set of `?? true` fallbacks.
 */
export const testConfig = (overrides: Record<string, unknown> = {}): LuauDocsConfig =>
	validateConfig({ title: "Sample", source: { entries: ["src"] }, ...overrides });

/** Synthesizes a `BuildContext` rooted at `root` without reading `luaudocs.toml` from disk. */
export const testContext = (
	root: string,
	overrides: Record<string, unknown> = {},
	configPath?: string,
): BuildContext => {
	const config = testConfig(overrides);
	const docsDir = resolve(root, config.docs.dir);
	return {
		config,
		root,
		...(configPath === undefined ? {} : { configPath }),
		docsDir,
		apiDir: join(docsDir, API_DIR),
	};
};

/** Derived from this file, so test/e2e addresses fixtures the same way. */
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));

/** Absolute path to a fixture file or project directory. */
export const fixturePath = (...segments: string[]): string => join(fixtures, ...segments);

/** A fixture read as text (doc-model captures, moonwave configs). */
export const readFixture = (...segments: string[]): string =>
	readFileSync(fixturePath(...segments), "utf8");

/** Every file under `dir`, absolute: the build's own walk, so tests cannot
 * disagree with it about what a directory contains. */
export const filesUnder = (dir: string): string[] => walkFiles(dir).map((file) => file.abs);

/** Temp dirs for one suite, removed together when the file finishes. */
export function makeTempDirFactory(prefix: string): () => string {
	const dirs: string[] = [];
	afterAll(() => {
		for (const dir of dirs) {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	return () => {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		dirs.push(dir);
		return dir;
	};
}

/** Writes a relative-path -> content map under `dir`, creating parent directories. */
export function seed(dir: string, files: Record<string, string | Buffer | undefined>): void {
	for (const [rel, content] of Object.entries(files)) {
		if (content !== undefined) {
			const abs = join(dir, rel);
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, content);
		}
	}
}

/**
 * `defaultToml` is written as luaudocs.toml unless the caller's own files
 * override it. Parent directories are created.
 */
export function makeProjectFactory(
	prefix: string,
	defaultToml: string,
): (files?: Record<string, string>) => string {
	const tempDir = makeTempDirFactory(prefix);
	return (files = {}) => {
		const dir = tempDir();
		seed(dir, { "luaudocs.toml": defaultToml, ...files });
		return dir;
	};
}

/**
 * One member's section of a rendered page, for assertions that count something
 * a page-wide search would total across every member instead.
 */
export const memberBlock = (page: string, name: string): string => {
	const start = page.indexOf(`### \`${name}\``);
	expect(start, `no \`### \`${name}\`\` heading on the page`).toBeGreaterThan(-1);
	const rest = page.slice(start);
	const next = rest.indexOf("\n### ", 1);
	return next === -1 ? rest : rest.slice(0, next);
};

/**
 * One marker must be present. A string or a regex is only how precisely a given
 * row needs to say what it is guarding.
 */
export const has = (haystack: string, marker: string | RegExp): void => {
	if (typeof marker === "string") {
		expect(haystack).toContain(marker);
	} else {
		expect(haystack).toMatch(marker);
	}
};

/** One signature fence: its code, and the spans the runtime plugin will link. */
export interface SignatureSpan {
	url: string;
	start: number;
	/** what the span covers, so a test asserts the text, not just a count */
	text: string;
	/** the fence's code, for locating the occurrence a span should have landed on */
	code: string;
}

/**
 * Signature links are offsets rather than markup, so a substring search for
 * `href=` would find only the prose links.
 */
export const signatureSpans = (page: string): SignatureSpan[] =>
	[...page.matchAll(/^ {0,3}`{3,}(.*)\n([\s\S]*?)\n`{3,}$/gm)].flatMap((match) => {
		// the runtime's own parser decides what counts as a link table, so this
		// exercises the real wire format instead of a copy
		const links = parseLinks(match[1]);
		if (links === undefined) {
			return [];
		}
		const code = match[2]!;
		return links.map(([start, end, url]) => ({
			url,
			start,
			text: code.slice(start, end),
			code,
		}));
	});

/** Just the urls, for rows that only care that something was linked at all. */
export const signatureLinks = (page: string): string[] =>
	signatureSpans(page).map((span) => span.url);

/** Source span default for hand-built doc-model nodes. */
export const testSrc = (file = "src/init.luau", line = 1): SourceSpan => ({ file, line });

/** Hand-built module node with valid spine defaults. */
export const testMod = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
	id,
	instancePath: [name],
	name,
	source: testSrc(id),
	classes: [],
	members: [],
	types: [],
	reexports: [],
	...extra,
});

/** Hand-built property member node with valid defaults. */
export const testProp = (
	id: string,
	name: string,
	propType?: unknown[],
	extra: Record<string, unknown> = {},
) => ({
	id,
	name,
	kind: "prop" as const,
	type: propType,
	tags: { custom: [] },
	visibility: "public" as const,
	readonly: false,
	source: testSrc(),
	...extra,
});

/** Hand-built function member node with valid defaults. */
export const testFn = (
	id: string,
	name: string,
	callee: string,
	segs: unknown[] = ["()"],
	extra: Record<string, unknown> = {},
) => ({
	id,
	name,
	kind: "function" as const,
	visibility: "public" as const,
	tags: { custom: [] },
	errors: [],
	signature: { callee, segs, params: [], returns: [] },
	source: testSrc("src/init.luau", 5),
	...extra,
});

/** Hand-built type alias/interface declaration node with valid defaults. */
export const testType = (
	id: string,
	name: string,
	definition?: unknown[][],
	extra: Record<string, unknown> = {},
) => ({
	id,
	name,
	exported: true,
	kind: "alias" as const,
	generics: [],
	definition,
	tags: { custom: [] },
	visibility: "public" as const,
	source: testSrc(),
	...extra,
});

/**
 * The doc-model envelope around hand-built modules. Defaulting every spine field
 * and list here keeps each inline model down to the fields its rule needs.
 */
export const modelJson = (modules: unknown[]): string =>
	JSON.stringify({
		schemaVersion: 1,
		project: { entryPoints: ["src/init.luau"] },
		diagnostics: [],
		modules: modules.map((module) => {
			const raw = module as Record<string, unknown>;
			const id = typeof raw.id === "string" ? raw.id : "src/init.luau";
			const stem =
				id
					.replace(/(\/init)?\.(d\.)?luau$/, "")
					.split(/[\\/]/)
					.pop() || "Init";
			const name = typeof raw.name === "string" ? raw.name : stem;
			return {
				id,
				name,
				instancePath: [name],
				source: testSrc(id),
				classes: [],
				members: [],
				types: [],
				reexports: [],
				...raw,
			};
		}),
	});

/** Structural sidebar/guide outline node accepted by `outline`. */
export interface OutlineItem {
	text: string;
	items?: readonly OutlineItem[];
}

/** "Group > Child, Group > Sub > Leaf": flattened for readable assertions. */
export const outline = (items: readonly OutlineItem[], trail: string[] = []): string[] =>
	items.flatMap((item) => {
		const here = [...trail, item.text];
		return item.items && item.items.length > 0 ? outline(item.items, here) : [here.join(" > ")];
	});

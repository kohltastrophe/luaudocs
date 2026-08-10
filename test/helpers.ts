/** Shared test seams: validated configs, fixture paths, temp dirs, inline models. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect } from "vitest";
import { filesUnder as walkFiles } from "../src/build";
import { validateConfig, type LuauDocsConfig } from "../src/config";
import type { SidebarItem } from "../src/nav";
import { parseLinks } from "../templates/runtime/signature-links";

/**
 * Built through the real validator rather than hand-written, so tests exercise
 * the real defaults instead of a parallel set of `?? true` fallbacks.
 */
export const testConfig = (overrides: Record<string, unknown> = {}): LuauDocsConfig =>
	validateConfig({ title: "Sample", source: { entries: ["src"] }, ...overrides });

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
		for (const [rel, content] of Object.entries({ "luaudocs.toml": defaultToml, ...files })) {
			const abs = join(dir, rel);
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, content);
		}
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

/**
 * The doc-model envelope around hand-built modules. Defaulting every list here
 * keeps each inline model down to the one list its rule needs.
 */
export const modelJson = (modules: unknown[]): string =>
	JSON.stringify({
		schemaVersion: 1,
		project: { entryPoints: ["src/init.luau"] },
		diagnostics: [],
		modules: modules.map((module) => ({
			classes: [],
			members: [],
			types: [],
			reexports: [],
			...(module as object),
		})),
	});

/** "Group > Child, Group > Sub > Leaf": flattened for readable assertions. */
export const outline = (items: SidebarItem[], trail: string[] = []): string[] =>
	items.flatMap((item) => {
		const here = [...trail, item.text];
		return item.items && item.items.length > 0 ? outline(item.items, here) : [here.join(" > ")];
	});

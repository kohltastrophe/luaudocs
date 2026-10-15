/**
 * The pinned Lute install: the archive reader, the digest check, and the
 * rename that commits an install into the cache, on bytes and directories
 * built here, and the first-use path up to the download against a stubbed
 * fetch and a temp cache. A real download stays with the e2e suite.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commitInstall, resolveLute, unzipSingleFile, verifyChecksum } from "../src/lute";
import { makeTempDirFactory } from "./helpers";

const tempDir = makeTempDirFactory("luaudocs-lute-");

interface Entry {
	name: string;
	data: Buffer;
	/** 0 stored, 8 deflated: the two methods a release zip uses */
	method: 0 | 8;
	/** an extra field in the local header only, which moves the data */
	localExtra?: number;
}

/** A zip archive, laid out the way the reader walks one: local headers and
 * data, the central directory, then the end record. CRCs stay zero, since
 * the reader trusts the pinned digest instead. */
function zip(entries: Entry[]): Buffer {
	const body: Buffer[] = [];
	const directory: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const packed = entry.method === 8 ? deflateRawSync(entry.data) : entry.data;
		const name = Buffer.from(entry.name);
		const extra = Buffer.alloc(entry.localExtra ?? 0);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(entry.method, 8);
		local.writeUInt32LE(packed.length, 18);
		local.writeUInt32LE(entry.data.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(extra.length, 28);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(entry.method, 10);
		central.writeUInt32LE(packed.length, 20);
		central.writeUInt32LE(entry.data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		body.push(local, name, extra, packed);
		directory.push(central, name);
		offset += local.length + name.length + extra.length + packed.length;
	}
	const centralDir = Buffer.concat(directory);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralDir.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...body, centralDir, end]);
}

/** Compressible enough that deflate really changes the bytes. */
const BINARY = Buffer.from("\x7fELF lute binary ".repeat(200), "latin1");

describe("unzipSingleFile", () => {
	it("unpacks a stored entry", () => {
		expect(unzipSingleFile(zip([{ name: "lute", data: BINARY, method: 0 }]))).toEqual(BINARY);
	});

	// the data sits behind the LOCAL header's name and extra lengths, which
	// may differ from the central directory's
	it("unpacks a deflated entry behind a local extra field", () => {
		const archive = zip([{ name: "lute", data: BINARY, method: 8, localExtra: 9 }]);
		expect(archive.length).toBeLessThan(BINARY.length);
		expect(unzipSingleFile(archive)).toEqual(BINARY);
	});

	it("refuses an archive holding more than the one file", () => {
		const archive = zip([
			{ name: "lute", data: BINARY, method: 0 },
			{ name: "README", data: Buffer.from("hi"), method: 0 },
		]);
		expect(() => unzipSingleFile(archive)).toThrow(
			/expected 1 file in the Lute archive, found 2/,
		);
	});

	it("refuses bytes that are not a zip", () => {
		expect(() => unzipSingleFile(Buffer.from("<html>rate limited</html>"))).toThrow(
			/not a zip archive/,
		);
	});
});

describe("verifyChecksum", () => {
	const archive = zip([{ name: "lute", data: BINARY, method: 8 }]);
	const sha256 = createHash("sha256").update(archive).digest("hex");

	it("passes the pinned digest and names both sides of a mismatch", () => {
		expect(() => verifyChecksum(archive, { zip: "lute.zip", sha256 })).not.toThrow();
		const tampered = Buffer.concat([archive, Buffer.from([0])]);
		expect(() => verifyChecksum(tampered, { zip: "lute.zip", sha256 })).toThrow(
			new RegExp(`checksum mismatch for lute\\.zip: expected ${sha256}, got [0-9a-f]{64}`),
		);
	});
});

describe("commitInstall", () => {
	/** A cache dir with a staged install beside where it goes. */
	function staged(binary: string): { staging: string; target: string } {
		const root = tempDir();
		const staging = join(root, "1.0.0.tmp-1");
		mkdirSync(staging);
		writeFileSync(join(staging, "lute"), binary);
		return { staging, target: join(root, "1.0.0") };
	}

	it("renames the staging dir into place", () => {
		const { staging, target } = staged("mine");
		commitInstall(staging, target, "lute");
		expect(readFileSync(join(target, "lute"), "utf8")).toBe("mine");
		expect(existsSync(staging)).toBe(false);
	});

	// the race loser used to clear the winner's install to make room for its
	// own, and a build spawning the binary in between found nothing there
	it("leaves a racing winner's install in place", () => {
		const { staging, target } = staged("loser");
		mkdirSync(target);
		writeFileSync(join(target, "lute"), "winner");
		writeFileSync(join(target, "marker"), "untouched");
		commitInstall(staging, target, "lute");
		expect(readFileSync(join(target, "lute"), "utf8")).toBe("winner");
		expect(readdirSync(target).sort()).toEqual(["lute", "marker"]);
	});

	// an install that lost its binary (a quarantine, a half-removal) would
	// otherwise fail the rename on every run, forever
	it("replaces a leftover install directory missing its binary", () => {
		const { staging, target } = staged("fresh");
		mkdirSync(target);
		writeFileSync(join(target, "leftover"), "x");
		commitInstall(staging, target, "lute");
		expect(readdirSync(target)).toEqual(["lute"]);
		expect(readFileSync(join(target, "lute"), "utf8")).toBe("fresh");
	});
});

describe("resolveLute on first use", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	// stdout is the extractor's JSON: CONTRIBUTING pipes `bun run lute -- run
	// ...` into jq, which a progress line on stdout breaks on a fresh cache
	it.runIf(
		["linux-x64", "linux-arm64", "darwin-arm64", "win32-x64"].includes(
			`${process.platform}-${process.arch}`,
		),
	)("reports the install on stderr, never stdout", async () => {
		const cache = tempDir();
		vi.stubEnv("LUAUDOCS_LUTE", "");
		vi.stubEnv("XDG_CACHE_HOME", cache);
		vi.stubEnv("HOME", cache);
		vi.stubEnv("LOCALAPPDATA", cache);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("fetch failed");
			}),
		);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(resolveLute()).rejects.toThrow(/could not download Lute/);
		expect(log).not.toHaveBeenCalled();
		expect(error.mock.calls.join("\n")).toContain("installing Lute");
	});
});

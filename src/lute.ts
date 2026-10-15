/**
 * Owns the Lute binary that runs the extractor: the pinned version, the
 * platform asset table, the download, and the per-user cache directory.
 *
 * Because extraction output depends on the Lute parser version, LuauDocs pins
 * an exact Lute release (just as `src/site.ts` pins VitePress) and downloads it
 * automatically rather than requiring every consumer to configure a toolchain
 * manager. The cache is keyed by version outside the package directory, so
 * `npx luaudocs` runs and LuauDocs upgrades reuse an existing download.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import pc from "picocolors";

/**
 * Bumping `LUTE_VERSION` is a deliberate release step: re-run
 * `bun run regen:docmodels` and inspect the diff, because extractor output
 * follows what this Lute version parses. Checksums come from each release
 * asset's `digest` field.
 */
export const LUTE_VERSION = "1.0.0";

/**
 * Maps `${process.platform}-${process.arch}` to its release archive and SHA-256
 * digest. Platforms absent from this table (Intel macOS, musl Linux, BSD) have
 * no prebuilt binary and fall back to `lute` on `PATH`.
 */
const ASSETS: Record<string, { zip: string; sha256: string }> = {
	"linux-x64": {
		zip: "lute-linux-x86_64.zip",
		sha256: "de7a6dab06b21df572c49257ec24a4cf1ecd54fb854de856aa377a1188255c95",
	},
	"linux-arm64": {
		zip: "lute-linux-aarch64.zip",
		sha256: "78638a2013f38e365b31272b60853eb74dc0e0e425a71d806c4930ebd004b318",
	},
	"darwin-arm64": {
		zip: "lute-macos-aarch64.zip",
		sha256: "6d120b5d2804e62ab2453565e755d022bd6902307cabcd0fedb4cdcbd4251e84",
	},
	"win32-x64": {
		zip: "lute-windows-x86_64.zip",
		sha256: "4f5de7cb1844d0df4e5796ad08d485ce7b6c35f7ba8d54046c7e7a12e7c28d92",
	},
};

export interface Lute {
	/** `argv[0]` for spawning Lute: an absolute path, or `"lute"` on `PATH`. */
	command: string;
	/** Diagnostic hint shown when spawning `command` fails outright. */
	hint: string;
}

const OVERRIDE = "LUAUDOCS_LUTE";

/** Returns the per-user cache root following each platform's convention. */
export function cacheHome(): string {
	if (process.platform === "win32") {
		return process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
	}
	if (process.platform === "darwin") {
		return join(homedir(), "Library", "Caches");
	}
	return process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
}

function installDir(): string {
	return join(cacheHome(), "luaudocs", "lute", LUTE_VERSION);
}

function binaryName(): string {
	return process.platform === "win32" ? "lute.exe" : "lute";
}

/**
 * Resolves the Lute binary to spawn, downloading the pinned release on first use.
 *
 * Resolution order: `LUAUDOCS_LUTE` environment override first, then the cached
 * pinned binary for supported platforms, and finally `lute` on `PATH` for
 * platforms without a prebuilt binary.
 */
export async function resolveLute(): Promise<Lute> {
	const override = process.env[OVERRIDE];
	if (override) {
		if (!existsSync(override)) {
			throw new Error(`${OVERRIDE} is set to ${override}, which does not exist`);
		}
		return {
			command: override,
			hint: `could not run the Lute ${OVERRIDE} points at (${override}).`,
		};
	}

	const asset = ASSETS[`${process.platform}-${process.arch}`];
	if (asset === undefined) {
		return {
			command: "lute",
			hint: [
				"could not run `lute`.",
				`luaudocs installs Lute ${LUTE_VERSION} itself, but there is no prebuilt binary for ${process.platform}-${process.arch}.`,
				"Build Lute from source (https://github.com/luau-lang/lute), then put it on your PATH",
				`or point ${OVERRIDE} at it.`,
			].join("\n"),
		};
	}

	const binary = join(installDir(), binaryName());
	if (!existsSync(binary)) {
		await install(asset);
	}
	return {
		command: binary,
		hint: [
			`could not run the Lute luaudocs installed (${binary}).`,
			"Delete that directory to force a fresh download, or point",
			`${OVERRIDE} at a Lute of your own.`,
		].join("\n"),
	};
}

/**
 * Downloads, verifies, and unpacks the release archive. Unpacks into a
 * PID-suffixed sibling directory and renames it into place so a half-written
 * binary never sits at the path `resolveLute` checks, and concurrent builds
 * racing to install converge cleanly on one working binary.
 */
async function install(asset: { zip: string; sha256: string }): Promise<void> {
	const url = `https://github.com/luau-lang/lute/releases/download/v${LUTE_VERSION}/${asset.zip}`;
	// Log to stderr so `bun run lute -- run ... | jq` keeps stdout clean for JSON even on first install.
	console.error(pc.cyan(`installing Lute ${LUTE_VERSION} (${asset.zip}) into ${installDir()}`));

	let zip: Buffer;
	try {
		// Node's `fetch` has no default timeout; bound the download so a stalled
		// connection fails instead of hanging until CI's job timeout.
		const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
		if (!response.ok) {
			throw new Error(`${response.status} ${response.statusText}`);
		}
		zip = Buffer.from(await response.arrayBuffer());
	} catch (error) {
		throw new Error(
			[
				`could not download Lute ${LUTE_VERSION} from ${url}`,
				`  ${error instanceof Error ? error.message : String(error)}`,
				`If this machine has no network access, install Lute yourself and point ${OVERRIDE} at it.`,
			].join("\n"),
		);
	}

	verifyChecksum(zip, asset);

	const staging = `${installDir()}.tmp-${process.pid}`;
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(staging, { recursive: true });
	try {
		const staged = join(staging, binaryName());
		writeFileSync(staged, unzipSingleFile(zip));
		chmodSync(staged, 0o755);
		commitInstall(staging, installDir(), binaryName());
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

/**
 * Atomically renames `staging` to `target`. If another concurrent process won
 * the race and placed `binaryFile` at `target`, returns immediately without
 * disturbing the winner's install. Only removes an existing `target` directory
 * when `binaryFile` is missing inside it (for example, after an interrupted
 * removal or antivirus quarantine).
 */
export function commitInstall(staging: string, target: string, binaryFile: string): void {
	const binary = join(target, binaryFile);
	try {
		renameSync(staging, target);
		return;
	} catch (error) {
		if (existsSync(binary)) {
			return;
		}
		if (!existsSync(target)) {
			throw error;
		}
	}
	// An existing `target` directory missing its binary would fail `renameSync`
	// permanently (`ENOTEMPTY` on POSIX, `EPERM` on Windows); clear it and retry.
	rmSync(target, { recursive: true, force: true });
	try {
		renameSync(staging, target);
	} catch (error) {
		// Another process won the race between `rmSync` and `renameSync`.
		if (!existsSync(binary)) {
			throw error;
		}
	}
}

/**
 * Verifies the downloaded archive against its pinned SHA-256 digest before
 * unpacking or executing any bytes.
 */
export function verifyChecksum(zip: Buffer, asset: { zip: string; sha256: string }): void {
	const digest = createHash("sha256").update(zip).digest("hex");
	if (digest !== asset.sha256) {
		throw new Error(
			`checksum mismatch for ${asset.zip}: expected ${asset.sha256}, got ${digest}`,
		);
	}
}

/**
 * Extracts the single binary entry from a Lute release `.zip` archive. Runs
 * only after `verifyChecksum`, so any unexpected archive structure throws.
 */
export function unzipSingleFile(zip: Buffer): Buffer {
	// Scan backward for the End of Central Directory (EOCD) signature (`PK\x05\x06`).
	const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	if (eocd === -1) {
		throw new Error("not a zip archive");
	}
	const entries = zip.readUInt16LE(eocd + 10);
	if (entries !== 1) {
		throw new Error(`expected 1 file in the Lute archive, found ${entries}`);
	}

	const central = zip.readUInt32LE(eocd + 16);
	const method = zip.readUInt16LE(central + 10);
	const compressedSize = zip.readUInt32LE(central + 20);
	const uncompressedSize = zip.readUInt32LE(central + 24);
	const local = zip.readUInt32LE(central + 42);

	// Advance past the 30-byte local file header plus its variable-length filename and extra fields.
	const data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
	const body = zip.subarray(data, data + compressedSize);
	const file = method === 0 ? body : method === 8 ? inflateRawSync(body) : undefined;
	if (file === undefined) {
		throw new Error(`unsupported zip compression method ${method}`);
	}
	if (file.length !== uncompressedSize) {
		throw new Error(
			`Lute archive unpacked to ${file.length} bytes, expected ${uncompressedSize}`,
		);
	}
	return file;
}

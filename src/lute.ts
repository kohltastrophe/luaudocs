/**
 * Owns the Lute the extractor runs on: the pinned version, the platform asset
 * table, the download, and the cache it lands in. Nothing else in the codebase
 * decides which Lute runs.
 *
 * Extraction behavior is tied to the Lute version, so this pins one exactly the
 * way `src/site.ts` pins VitePress, and downloads it rather than asking every
 * project to install a toolchain manager and declare the same pin. The cache is
 * keyed by version and lives outside the package, so `npx luaudocs` and an
 * upgrade of luaudocs itself both reuse what is already there.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import pc from "picocolors";

/**
 * Bumping this is a deliberate release: rerun `bun run regen:docmodels` and
 * read the diff, since the extractor's output is whatever this Lute parses.
 * The checksums come from the release assets' own `digest` field.
 */
export const LUTE_VERSION = "1.0.0";

/**
 * `${process.platform}-${process.arch}` to the release asset. Anything absent
 * (Intel macOS, musl, BSD) has no prebuilt binary to fetch and falls back to
 * whatever `lute` the PATH offers.
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
	/** argv[0] for the spawn: an absolute path, or `lute` off the PATH. */
	command: string;
	/** What to tell the user when that spawn fails to start at all. */
	hint: string;
}

const OVERRIDE = "LUAUDOCS_LUTE";

/** The per-user cache root, following each platform's own convention. */
function cacheHome(): string {
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
 * Resolves the Lute to spawn, downloading the pinned build on first use.
 *
 * The order is fixed: an explicit `LUAUDOCS_LUTE` always wins, then the cached
 * pin, then the PATH. The PATH is deliberately last: a `lute` there is some
 * other version by definition, since the pin is never installed to it.
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
		await install(asset, binary);
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
 * Fetches, verifies, and unpacks the release zip. Unpacking happens in a
 * sibling directory that is renamed into place, so a half-written binary is
 * never at the path `resolveLute` probes, and two builds racing each other
 * leave one good install rather than a torn one.
 */
async function install(asset: { zip: string; sha256: string }, binary: string): Promise<void> {
	const url = `https://github.com/luau-lang/lute/releases/download/v${LUTE_VERSION}/${asset.zip}`;
	console.log(pc.cyan(`installing Lute ${LUTE_VERSION} (${asset.zip}) into ${installDir()}`));

	let zip: Buffer;
	try {
		// no default timeout in node's fetch, and this is the one unbounded
		// network call on the critical path: a proxy that accepts the handshake
		// and never answers would otherwise hang the build to CI's job limit
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

	const digest = createHash("sha256").update(zip).digest("hex");
	if (digest !== asset.sha256) {
		throw new Error(
			`checksum mismatch for ${asset.zip}: expected ${asset.sha256}, got ${digest}`,
		);
	}

	const staging = `${installDir()}.tmp-${process.pid}`;
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(staging, { recursive: true });
	try {
		const staged = join(staging, binaryName());
		writeFileSync(staged, unzipSingleFile(zip));
		chmodSync(staged, 0o755);
		// a leftover install directory that lost its binary (an antivirus
		// quarantine, a half-removed install) would fail the rename forever:
		// ENOTEMPTY here, EPERM on Windows, and nothing self-heals
		rmSync(installDir(), { recursive: true, force: true });
		renameSync(staging, installDir());
	} catch (error) {
		rmSync(staging, { recursive: true, force: true });
		// the loser of a race finds the winner's install already in place, which
		// is the outcome it wanted; anything else is a real failure
		if (!existsSync(binary)) {
			throw error;
		}
	}
}

/**
 * Extracts the single file a Lute release zip holds. The bytes are
 * checksum-verified before this runs, so any archive this small reader cannot
 * handle is a bad pin, and throws.
 */
function unzipSingleFile(zip: Buffer): Buffer {
	// end of central directory record, scanned from the back because a trailing
	// archive comment (never present here) would sit after its fixed 22 bytes
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

	// the local header repeats the name and extra fields at its own lengths,
	// which are the ones the file data actually sits behind
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

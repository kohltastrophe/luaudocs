/**
 * Loads published doc models for `[source] aliases` entries that set `model`,
 * either from a local path or fetched by URL. This lets a type reached through
 * an alias link to its exact entry on the dependency's site rather than just
 * the module page. This module handles I/O only, while `src/render.ts` resolves
 * the loaded models into links.
 *
 * Unreadable models produce a warning rather than failing the build, because
 * the alias still falls back to its base `url`. Caches fetched models per user
 * (beside the Lute install) and reuses them when offline, so an offline rebuild
 * links identically to the last online build. Caches only valid, parsed models
 * so a bad HTTP response never evicts a working copy.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compareCodePoints, errorMessage, type LuauDocsConfig } from "./config";
import { parseDocModel, type DocModel } from "./docmodel";
import { cacheHome } from "./lute";

export interface LoadedDependency {
	alias: string;
	/** Base URL of the dependency's published docs site. */
	url: string;
	model: DocModel;
}

export interface LoadedDependencies {
	loaded: LoadedDependency[];
	warnings: string[];
}

export async function loadDependencies(
	config: LuauDocsConfig,
	root: string,
): Promise<LoadedDependencies> {
	const loaded: LoadedDependency[] = [];
	const warnings: string[] = [];
	// Sort aliases alphabetically so warnings appear in a deterministic order across builds.
	const specs = Object.entries(config.source.aliases).sort(([a], [b]) => compareCodePoints(a, b));
	const outcomes = await Promise.all(
		specs.map(async ([alias, { url, model }]) => {
			// Config validation guarantees that `model` is paired with `url`.
			if (model === undefined || url === undefined) {
				return undefined;
			}
			try {
				return { loaded: { alias, url, model: await readModel(model, root) } };
			} catch (error) {
				const reason = errorMessage(error);
				return {
					warning: `[source] aliases.${alias}: could not load its doc model from ${model} (${reason}); types reached through @${alias} link to their module pages under ${url} instead of their exact entries`,
				};
			}
		}),
	);
	for (const outcome of outcomes) {
		if (outcome?.loaded) {
			loaded.push(outcome.loaded);
		} else if (outcome?.warning) {
			warnings.push(outcome.warning);
		}
	}
	return { loaded, warnings };
}

async function readModel(source: string, root: string): Promise<DocModel> {
	if (/^https?:\/\//i.test(source)) {
		return await fetchCached(source);
	}
	return parseDocModel(readFileSync(resolve(root, source), "utf8"));
}

/**
 * Deduplicates live online fetches to one per URL per process, since `dev`
 * re-renders on every save and a dependency's published model does not change
 * mid-session. Evicts failed fetches and offline cache fallbacks so the next
 * rebuild retries the network when connectivity returns.
 */
const fetched = new Map<string, Promise<DocModel>>();

function fetchCached(url: string): Promise<DocModel> {
	const existing = fetched.get(url);
	if (existing !== undefined) {
		return existing;
	}
	const pending = fetchModel(url).then(
		({ model, live }) => {
			if (!live) {
				fetched.delete(url);
			}
			return model;
		},
		(error) => {
			fetched.delete(url);
			throw error;
		},
	);
	fetched.set(url, pending);
	return pending;
}

async function fetchModel(url: string): Promise<{ model: DocModel; live: boolean }> {
	const dir = join(cacheHome(), "luaudocs", "models");
	const cacheFile = join(dir, `${createHash("sha256").update(url).digest("hex")}.json`);
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const text = await response.text();
		const model = parseDocModel(text);
		const tempFile = `${cacheFile}.${randomUUID().slice(0, 8)}.tmp`;
		try {
			mkdirSync(dir, { recursive: true });
			writeFileSync(tempFile, text);
			renameSync(tempFile, cacheFile);
		} catch {
			try {
				rmSync(tempFile, { force: true });
			} catch {
				// Best-effort cleanup when the cache directory is unwritable.
			}
		}
		return { model, live: true };
	} catch (error) {
		if (existsSync(cacheFile)) {
			try {
				return { model: parseDocModel(readFileSync(cacheFile, "utf8")), live: false };
			} catch {
				try {
					rmSync(cacheFile, { force: true });
				} catch {
					// Ignore removal errors on read-only filesystems.
				}
			}
		}
		throw error;
	}
}

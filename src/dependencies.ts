/**
 * Loads published doc models for `[source] aliases` entries that set `model`,
 * either from a local path or fetched by URL. This lets a type reached through
 * an alias link to its exact entry on the dependency's site rather than just
 * the module page. This module handles I/O only; `src/render.ts` resolves the
 * loaded models into links.
 *
 * Unreadable models produce a warning rather than failing the build, because
 * the alias still falls back to its base `url`. Fetched models are cached per
 * user (beside the Lute install) and reused when offline, so an offline rebuild
 * links identically to the last online build. Only valid, parsed models are
 * cached so a bad HTTP response never evicts a working copy.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LuauDocsConfig } from "./config";
import { parseDocModel, type DocModel } from "./docmodel";
import { cacheHome } from "./lute";
import type { LoadedDependency } from "./render";

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
	const specs = Object.entries(config.source.aliases).sort(([a], [b]) => (a < b ? -1 : 1));
	for (const [alias, { url, model }] of specs) {
		// Config validation guarantees that `model` is paired with `url`.
		if (model === undefined || url === undefined) {
			continue;
		}
		try {
			loaded.push({ alias, url, model: await readModel(model, root) });
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			warnings.push(
				`[source] aliases.${alias}: could not load its doc model from ${model} (${reason}); types reached through @${alias} link to their module pages under ${url} instead of their exact entries`,
			);
		}
	}
	return { loaded, warnings };
}

async function readModel(source: string, root: string): Promise<DocModel> {
	if (/^https?:\/\//i.test(source)) {
		return fetchCached(source);
	}
	return parseDocModel(readFileSync(resolve(root, source), "utf8"));
}

/**
 * Deduplicates fetches to one per URL per process: `dev` re-renders on every
 * save, and a dependency's published model does not change mid-session. Failed
 * fetches are evicted so the next rebuild retries the network.
 */
const fetched = new Map<string, Promise<DocModel>>();

function fetchCached(url: string): Promise<DocModel> {
	let pending = fetched.get(url);
	if (pending === undefined) {
		pending = fetchModel(url);
		fetched.set(url, pending);
		pending.catch(() => fetched.delete(url));
	}
	return pending;
}

async function fetchModel(url: string): Promise<DocModel> {
	const dir = join(cacheHome(), "luaudocs", "models");
	const file = join(dir, `${createHash("sha256").update(url).digest("hex")}.json`);
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const text = await response.text();
		const model = parseDocModel(text);
		mkdirSync(dir, { recursive: true });
		writeFileSync(file, text);
		return model;
	} catch (error) {
		if (existsSync(file)) {
			return parseDocModel(readFileSync(file, "utf8"));
		}
		throw error;
	}
}

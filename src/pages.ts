/**
 * Organizes `DocModel` into `PageModel[]` (one page per module, with its classes
 * rendered as sections). Owns visibility filtering, the reachable-type closure,
 * re-export inlining, page-slug disambiguation, and the module export edges
 * that `src/nav.ts` follows. `mintAnchors` in `src/render.ts` populates heading
 * anchors afterward.
 */
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import type {
	Badges,
	Class,
	DocModel,
	Fn,
	Inline,
	Member,
	Module,
	Prop,
	Reexport,
	SourceSpan,
	TypeDecl,
} from "./docmodel";
import { compareCodePoints, toPosix, type LuauDocsConfig } from "./config";
import { frontmatter } from "./markdown";

export { toPosix };

export interface BuildContext {
	config: LuauDocsConfig;
	/**
	 * Base directory for all relative paths (the directory containing
	 * `luaudocs.toml`, or `startDir` when running with synthesized defaults).
	 */
	root: string;
	/** Absent when the project runs on synthesized defaults. */
	configPath?: string;
	docsDir: string;
	apiDir: string;
}

/**
 * Packages written into the generated docs `package.json` by `docsPackageJson`,
 * checked by `ensureVitepress` to detect missing dependencies in an existing install.
 */
export const SITE_DEPENDENCIES = ["vitepress", "vitepress-plugin-group-icons", "vue"] as const;

/** `<docsDir>/api/` on disk, served at `/api/`. */
export const API_DIR = "api";

/** Returns the site-absolute URL of an API page (`""` is the overview index). */
export function apiHref(slug: string, anchor?: string): string {
	return `/${API_DIR}/${slug}${anchor ? `#${anchor}` : ""}`;
}

/** Returns a page's key in `EmitResult.pages` and filename under `api/`. */
export function apiPageFile(slug: string): string {
	return `${slug}.md`;
}

/**
 * Writes `absPath` only when its content differs, so file watchers (VitePress
 * HMR) only react to real changes. Compares raw bytes when given a `Uint8Array`
 * because the runtime templates include a `.woff2` font that a UTF-8 round-trip
 * would corrupt with `U+FFFD` replacement characters.
 */
export function writeIfChanged(absPath: string, content: string | Uint8Array): boolean {
	try {
		const unchanged =
			typeof content === "string"
				? readFileSync(absPath, "utf8") === content
				: readFileSync(absPath).equals(content);
		if (unchanged) {
			return false;
		}
	} catch {
		// Missing or unreadable file: fall through to write.
	}
	mkdirSync(dirname(absPath), { recursive: true });
	writeFileSync(absPath, content);
	return true;
}

/** Writes `content` when defined, or removes `absPath` if it exists. */
export function syncFile(absPath: string, content: string | undefined): void {
	if (content !== undefined) {
		writeIfChanged(absPath, content);
	} else if (existsSync(absPath)) {
		rmSync(absPath);
	}
}

/**
 * Lists every file under `root` (following file and directory symlinks while
 * guarding against symlink cycles), POSIX-relative and sorted (`[]` if `root` is missing).
 */
export function filesUnder(root: string): Array<{ abs: string; rel: string }> {
	if (!existsSync(root)) {
		return [];
	}
	const results: Array<{ abs: string; rel: string }> = [];
	const seenDirs = new Set<string>();
	const walk = (dir: string) => {
		try {
			const real = realpathSync(dir);
			if (seenDirs.has(real)) {
				return;
			}
			seenDirs.add(real);
		} catch {
			return;
		}
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const abs = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(abs);
			} else if (entry.isFile()) {
				results.push({ abs, rel: toPosix(relative(root, abs)) });
			} else if (entry.isSymbolicLink()) {
				const target = statSync(abs, { throwIfNoEntry: false });
				if (target?.isDirectory()) {
					walk(abs);
				} else if (target?.isFile()) {
					results.push({ abs, rel: toPosix(relative(root, abs)) });
				}
			}
		}
	};
	walk(root);
	return results.sort((a, b) => compareCodePoints(a.rel, b.rel));
}

export interface SyncSummary {
	written: number;
	deleted: number;
	unchanged: number;
}

function addAncestorDirs(target: Set<string>, relPath: string): void {
	for (let slash = relPath.indexOf("/"); slash !== -1; slash = relPath.indexOf("/", slash + 1)) {
		target.add(relPath.slice(0, slash));
	}
}

function indexUniqueLower(items: Iterable<string>): Map<string, string | null> {
	const byLower = new Map<string, string | null>();
	for (const item of items) {
		const lower = item.toLowerCase();
		byLower.set(lower, byLower.has(lower) ? null : item);
	}
	return byLower;
}

function renameEntryCase(parentPath: string, fromName: string, toName: string): void {
	const from = join(parentPath, fromName);
	const to = join(parentPath, toName);
	// Hop through a distinct sibling name because Windows `MoveFileExW` can
	// treat a direct case-only directory rename as a no-op.
	const temp = join(parentPath, `.luaudocs-case-${randomUUID().slice(0, 8)}`);
	renameSync(from, temp);
	try {
		renameSync(temp, to);
	} catch (error) {
		try {
			renameSync(temp, from);
		} catch {
			// Best-effort rollback if the second rename fails.
		}
		throw error;
	}
}

/**
 * Syncs `dir` to contain the exact `files` map. `deleteStale: false` skips the
 * stale-file sweep (on error builds), and `keepForeign` exempts paths owned by
 * another process inside a tool-owned tree (such as VitePress's `dist/` and `cache/`).
 *
 * On case-insensitive, case-preserving filesystems (macOS and Windows), writing
 * a re-cased slug or directory updates the existing entry in place without
 * changing its directory-entry casing. Because slugs never collide
 * case-insensitively within a build (`claimSlug`), the sweep re-cases matching
 * directories and files in place instead of deleting them.
 */
export function syncDir(
	dir: string,
	files: Map<string, string | Uint8Array>,
	deleteStale = true,
	keepForeign?: (relPath: string) => boolean,
): SyncSummary {
	const summary: SyncSummary = { written: 0, deleted: 0, unchanged: 0 };
	if (!existsSync(dir) && files.size === 0) {
		return summary;
	}
	mkdirSync(dir, { recursive: true });

	const keep = new Set<string>();
	const keepDirs = new Set<string>();
	for (const relPath of files.keys()) {
		// Record the normalized relative path (`filesUnder` uses the same form) so a
		// non-canonical key (`./Foo.md`) is not written and then swept.
		const canonical = toPosix(relative(dir, join(dir, relPath)));
		keep.add(canonical);
		addAncestorDirs(keepDirs, canonical);
	}

	if (deleteStale) {
		const onDiskFiles: Array<{ abs: string; rel: string }> = [];
		const onDiskDirs: Array<{ name: string; abs: string; rel: string }> = [];
		const presentFiles = new Set<string>();
		const presentDirs = new Set<string>();
		const foreignDirs = new Set<string>();
		for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
			const abs = join(entry.parentPath, entry.name);
			const rel = toPosix(relative(dir, abs));
			if (keepForeign?.(rel)) {
				addAncestorDirs(foreignDirs, rel);
				continue;
			}
			if (entry.isDirectory()) {
				onDiskDirs.push({ name: entry.name, abs, rel });
				presentDirs.add(rel);
			} else if (entry.isFile() || entry.isSymbolicLink()) {
				onDiskFiles.push({ abs, rel });
				presentFiles.add(rel);
			}
		}

		let keepFileByLower: Map<string, string | null> | undefined;
		const survivorsToRecase: Array<{ rel: string; kept: string }> = [];
		for (const { abs, rel } of onDiskFiles) {
			if (keep.has(rel)) {
				continue;
			}
			keepFileByLower ??= indexUniqueLower(keep);
			const kept = keepFileByLower.get(rel.toLowerCase());
			if (kept != null && !presentFiles.has(kept)) {
				presentFiles.add(kept);
				survivorsToRecase.push({ rel, kept });
				continue;
			}
			rmSync(abs);
			summary.deleted += 1;
		}

		// Remove emptied directories deepest-first before re-casing surviving ones.
		const liveDirs: Array<{ name: string; rel: string }> = [];
		onDiskDirs.sort((a, b) => b.rel.length - a.rel.length);
		for (const { name, abs, rel } of onDiskDirs) {
			if (!foreignDirs.has(rel)) {
				try {
					rmdirSync(abs);
					presentDirs.delete(rel);
					continue;
				} catch {
					// Non-empty directory holds a surviving kept or foreign file.
				}
			}
			liveDirs.push({ name, rel });
		}

		// Re-case surviving directories shallowest-first, tracking each directory's
		// live path on disk so nested renames address the updated parent.
		let keepDirByLower: Map<string, string | null> | undefined;
		const dirMap = new Map<string, string>();
		liveDirs.reverse();
		for (const { name, rel } of liveDirs) {
			const parentRel = posix.dirname(rel);
			const actualParent = parentRel === "." ? "." : (dirMap.get(parentRel) ?? parentRel);
			const currentRel = actualParent === "." ? name : `${actualParent}/${name}`;
			if (keepDirs.has(currentRel) || foreignDirs.has(rel)) {
				dirMap.set(rel, currentRel);
				continue;
			}
			keepDirByLower ??= indexUniqueLower(keepDirs);
			const keptDir = keepDirByLower.get(rel.toLowerCase());
			if (
				keptDir != null &&
				actualParent === posix.dirname(keptDir) &&
				!presentDirs.has(keptDir)
			) {
				presentDirs.delete(rel);
				presentDirs.add(keptDir);
				const keptName = posix.basename(keptDir);
				if (name !== keptName) {
					renameEntryCase(
						actualParent === "." ? dir : join(dir, actualParent),
						name,
						keptName,
					);
				}
				dirMap.set(rel, keptDir);
			} else {
				dirMap.set(rel, currentRel);
			}
		}

		for (const { rel, kept } of survivorsToRecase) {
			const relDir = posix.dirname(rel);
			const curDir = relDir === "." ? "." : (dirMap.get(relDir) ?? relDir);
			const keptDir = posix.dirname(kept);
			const oldName = posix.basename(rel);
			const keptName = posix.basename(kept);
			if (curDir === keptDir) {
				if (oldName !== keptName) {
					renameEntryCase(keptDir === "." ? dir : join(dir, keptDir), oldName, keptName);
				}
				continue;
			}
			const dest = join(dir, kept);
			mkdirSync(dirname(dest), { recursive: true });
			renameSync(join(dir, curDir === "." ? oldName : `${curDir}/${oldName}`), dest);
			for (let cur = curDir; cur !== "."; cur = posix.dirname(cur)) {
				try {
					rmdirSync(join(dir, cur));
				} catch {
					break;
				}
			}
		}
	}

	for (const [relPath, content] of files) {
		if (writeIfChanged(join(dir, relPath), content)) {
			summary.written += 1;
		} else {
			summary.unchanged += 1;
		}
	}

	if (deleteStale && files.size === 0) {
		try {
			rmdirSync(dir);
		} catch {
			// Root directory still holds foreign files.
		}
	}
	return summary;
}

/** Compares titles with a pinned `"en"` locale so sort order is identical across OS/ICU builds. */
export function compareTitles(a: string, b: string): number {
	return a.localeCompare(b, "en");
}

/**
 * Ownership marker placed on the first line (or first frontmatter line) of
 * files LuauDocs writes into user-owned locations (`<docs>/index.md`,
 * `<docs>/.gitignore`, `<docs>/changelog.md`). A file without this marker
 * belongs to the user and is never overwritten, and deleting the marker line is
 * how an author takes ownership of a generated file.
 */
export const GENERATED_MARK = "# Generated by luaudocs";

/**
 * HTML comment form of `GENERATED_MARK` for the project-root `llms.txt`, which
 * has no YAML frontmatter and reserves `#` on line 1 for the `llms.txt` H1 title.
 */
export const GENERATED_COMMENT_MARK = `<!-- ${GENERATED_MARK.slice(2)}`;

/**
 * Returns `true` when `content` carries `GENERATED_MARK` or `GENERATED_COMMENT_MARK`
 * on its first line or on the first line inside its YAML frontmatter (using
 * `frontmatter()` so CRLF checkouts are handled identically).
 */
export function isGeneratedFile(content: string): boolean {
	const head = frontmatter(content) || content;
	return head.startsWith(GENERATED_MARK) || head.startsWith(GENERATED_COMMENT_MARK);
}

/**
 * The 21 Luau reserved keywords, which require bracket indexing (`t["end"]`)
 * rather than dot access. Contextual keywords (`continue`, `type`, `export`,
 * `typeof`) are valid identifiers after `.` and are intentionally excluded.
 * Mirrors `LUAU_KEYWORDS` in `extractor/model/members.luau`.
 */
const LUAU_KEYWORDS = new Set([
	"and",
	"break",
	"do",
	"else",
	"elseif",
	"end",
	"false",
	"for",
	"function",
	"if",
	"in",
	"local",
	"nil",
	"not",
	"or",
	"repeat",
	"return",
	"then",
	"true",
	"until",
	"while",
]);

/** Formats member access as `container.name` for valid identifiers, `container[K]` for indexers, or `container["name"]` otherwise. */
export function memberAccess(container: string, name: string): string {
	if (name.startsWith("[") && name.endsWith("]")) {
		return `${container}${name}`;
	}
	if (/^[A-Za-z_]\w*$/.test(name) && !LUAU_KEYWORDS.has(name)) {
		return `${container}.${name}`;
	}
	return `${container}[${JSON.stringify(name)}]`;
}

/**
 * Formats YAML frontmatter for generated pages, disabling `editLink` and
 * `lastUpdated` so VitePress does not invite edits to tool-owned files.
 */
export function generatedFrontmatter(title: string, extra: string[] = []): string {
	return [
		"---",
		`title: ${JSON.stringify(title)}`,
		...extra,
		"editLink: false",
		"lastUpdated: false",
		"---",
	].join("\n");
}

export const TYPES_HEADING = "Types";

export const MEMBER_HEADINGS = [
	{ text: "Properties", kind: "prop" },
	{ text: "Functions", kind: "function" },
	{ text: "Methods", kind: "method" },
	{ text: "Metamethods", kind: "metamethod" },
] as const;

/** Provenance metadata for a member inlined from another module. */
export interface ReexportInfo {
	/** Defining module's display name (rendered as `"from <from>"`). */
	from?: string;
	/** True for a whole-module mount (rendered as `"Module"`). */
	module?: true;
	/** Doc-model id of the target declaration (or target module for a whole-module mount), linked when it has a page. */
	targetId?: string;
	/** External documentation URL when the re-export targets a runtime alias (`[source] aliases`). */
	url?: string;
}

export type PageProp = Prop & { reexport?: ReexportInfo };
export type PageFn = Fn & { reexport?: ReexportInfo };
export type PageMember = PageProp | PageFn;
export type PageType = TypeDecl & { reexport?: ReexportInfo };

export interface PageSection {
	/**
	 * Section heading (`""` for the primary module-level section). Members of a
	 * named nested section still mint bare-name anchors, so duplicate member
	 * names across sections on the same page receive `-1`, `-2` suffixes.
	 */
	name: string;
	/**
	 * Key in `PageModel.anchors` for this section's heading (`undefined` for the
	 * primary section, which has no H2 heading). Uses the class `id` rather than
	 * `name` because two nested classes on one page can share a short name.
	 */
	id?: string;
	/**
	 * Full container prefix for members in this section (`Color.Linear`, or the
	 * module name for the primary section). Composed from `within` + `name`
	 * rather than the short section heading.
	 */
	container: string;
	doc?: string;
	tags?: Badges;
	constructors: string[];
	/** Visible members in this section, grouped under headings by `kind` at render time. */
	members: PageMember[];
	source?: SourceSpan;
}

/** Groups a section's visible members under occupied kind headings in page render order. */
export function membersByKind(
	section: PageSection,
): Array<{ text: (typeof MEMBER_HEADINGS)[number]["text"]; members: PageMember[] }> {
	return MEMBER_HEADINGS.flatMap(({ text, kind }) => {
		const members = section.members.filter((member) => member.kind === kind);
		return members.length > 0 ? [{ text, members }] : [];
	});
}

export interface PageModel {
	slug: string;
	title: string;
	/**
	 * Disambiguated title qualified with the parent instance segment
	 * (`"Defaults (Flux)"`), set only when another module claimed `title` first.
	 * Used in the sidebar, search index, and browser tab, while the page H1 and
	 * URL slug still use `title`.
	 */
	navTitle?: string;
	moduleId: string;
	/** Instance path, root-first (from the Rojo project tree, or folder layout without one). */
	instancePath: string[];
	/** True when this module is one of the project's entry points. */
	entry: boolean;
	/**
	 * Submodules mounted on this page's return value (with `aliasOf` chains
	 * resolved) and the field names they are mounted under. `src/nav.ts` walks
	 * these edges to build the public access tree (`Flux.Motion.Color`).
	 */
	exports: Array<{ moduleId: string; name: string }>;
	doc?: string;
	tags?: Badges;
	sections: PageSection[];
	types: PageType[];
	source: SourceSpan;
	/** Maps member, type, and class IDs to the heading anchor VitePress will mint. */
	anchors: Record<string, string>;
}

/** Returns the title used in the sidebar, search index, and browser tab (`navTitle ?? title`). */
export function displayTitle(page: PageModel): string {
	return page.navTitle ?? page.title;
}

/**
 * Returns a page's summary doc source (`page.doc`, falling back to the primary
 * section's doc when a factory module documents its `@class` block instead).
 */
export function pageSummaryDoc(page: PageModel): string | undefined {
	return page.doc ?? page.sections[0]?.doc;
}

export interface BuildResult {
	pages: PageModel[];
	warnings: string[];
	/** Follows `aliasOf` chains to the target module that owns a page. */
	resolveAlias: (moduleId: string) => string;
}

/**
 * Returns `true` when `cls` is the module's primary class (same name as the
 * module and not relocated from elsewhere via `@within`), which merges into the
 * page's top-level section rather than rendering under a separate H2.
 */
export function isPrimaryClass(cls: Class, moduleName: string): boolean {
	return cls.name === moduleName && !cls.within;
}

/**
 * Builds a resolver that follows `aliasOf` chains (passthrough `return require(X)`
 * modules that have no page of their own) to the final target module ID.
 */
function aliasResolver(model: DocModel): (moduleId: string) => string {
	const aliases = new Map<string, string>();
	for (const module of model.modules) {
		if (module.aliasOf !== undefined) {
			aliases.set(module.id, module.aliasOf);
		}
	}
	return (moduleId: string) => {
		let current = moduleId;
		const seen = new Set<string>();
		while (aliases.has(current) && !seen.has(current)) {
			seen.add(current);
			current = aliases.get(current)!;
		}
		return current;
	};
}

function isVisible(member: { visibility: string }, includePrivate: boolean): boolean {
	return includePrivate || member.visibility !== "private";
}

function visible<T extends { visibility: string }>(members: T[], includePrivate: boolean): T[] {
	return members.filter((member) => isVisible(member, includePrivate));
}

function sectionHasContent(section: PageSection): boolean {
	return section.members.length > 0 || Boolean(section.doc);
}

function classToSection(cls: Class, primaryName: string, includePrivate: boolean): PageSection {
	const isPrimary = isPrimaryClass(cls, primaryName);
	const qualifiedName = cls.within ? `${cls.within}.${cls.name}` : cls.name;
	return {
		name: isPrimary ? "" : cls.name,
		id: isPrimary ? undefined : cls.id,
		container: isPrimary ? primaryName : qualifiedName,
		doc: cls.doc,
		tags: cls.tags,
		constructors: cls.constructors,
		members: visible(cls.members, includePrivate),
		source: cls.source,
	};
}

/**
 * Computes the set of `TypeDecl` IDs that earn an entry on their module's page.
 *
 * Includes every visible `export type` and `type function`, every visible
 * unexported type referenced by a visible member signature, and the transitive
 * closure of types referenced by those declarations.
 *
 * Computed across the entire model at once rather than per module because
 * `@within` can move a member onto another module's page while its signature
 * still references types in its defining module.
 */
function listedTypeIds(model: DocModel, includePrivate: boolean): Set<string> {
	const decls = new Map(model.modules.flatMap((m) => m.types.map((ty) => [ty.id, ty] as const)));
	const listed = new Set<string>();
	const queue: string[] = [];
	const add = (id: string | undefined) => {
		if (id === undefined || listed.has(id)) {
			return;
		}
		const decl = decls.get(id);
		if (decl !== undefined && isVisible(decl, includePrivate)) {
			listed.add(id);
			queue.push(id);
		}
	};
	const mention = (segs: Inline | undefined) => {
		for (const seg of segs ?? []) {
			if (typeof seg !== "string") {
				add(seg.id);
			}
		}
	};

	const mentionMember = (member: Member) => {
		if (isVisible(member, includePrivate)) {
			// `signature.segs` spans the entire signature after `callee`,
			// covering parameters, returns, and generic defaults in one pass.
			mention(member.kind === "prop" ? member.type : member.signature.segs);
		}
	};
	for (const module of model.modules) {
		// `type function` has no `export` keyword in Luau, so list it whenever visible.
		for (const ty of module.types) {
			if (ty.exported || ty.kind === "typefunction") {
				add(ty.id);
			}
		}
		for (const member of module.members) {
			mentionMember(member);
		}
		for (const cls of module.classes) {
			for (const member of cls.members) {
				mentionMember(member);
			}
		}
	}

	while (queue.length > 0) {
		const decl = decls.get(queue.pop()!)!;
		for (const line of decl.definition ?? []) {
			mention(line);
		}
		mention(decl.params);
		for (const field of decl.fields ?? []) {
			mention(field.type);
		}
		// Generic defaults are type positions too.
		for (const generic of decl.generics) {
			mention(generic.default);
		}
	}
	return listed;
}

/** Target declaration that a `Reexport.targetId` can resolve to. */
type Definition = { member?: Member; cls?: Class };

function definitionsById(model: DocModel): Map<string, Definition> {
	const byId = new Map<string, Definition>();
	for (const module of model.modules) {
		for (const container of [module, ...module.classes]) {
			for (const member of container.members) {
				byId.set(member.id, { member });
			}
		}
		for (const cls of module.classes) {
			byId.set(cls.id, { cls });
		}
	}
	return byId;
}

/**
 * Builds a module's primary section (merging any classes whose name matches the
 * module) and its list of nested class sections.
 */
function buildSections(
	module: Module,
	includePrivate: boolean,
): { primary: PageSection; nested: PageSection[] } {
	const primary: PageSection = {
		name: "",
		container: module.name,
		constructors: [],
		members: visible(module.members, includePrivate),
	};

	const seenConstructors = new Set<string>();
	const nested: PageSection[] = [];
	for (const cls of module.classes) {
		const section = classToSection(cls, module.name, includePrivate);
		if (section.name === "") {
			// Multiple class entries can share the module's name (for example,
			// the root table plus a floating `-- @class M` block), so merge their
			// docs, tags, constructors, and members into `primary`.
			primary.doc = primary.doc ?? section.doc;
			primary.tags = primary.tags ?? section.tags;
			for (const id of section.constructors) {
				if (!seenConstructors.has(id)) {
					seenConstructors.add(id);
					primary.constructors.push(id);
				}
			}
			primary.members.push(...section.members);
		} else {
			nested.push(section);
		}
	}
	// A callable module with no comment block of its own promotes its call
	// member's comment to `module.doc` (the page intro and index summary).
	// Strip the duplicate on `PageMember` once so rendering, anchor minting,
	// and `llms.txt` all see the deduplicated member.
	primary.members = primary.members.map((member) =>
		member.kind !== "prop" &&
		member.doc !== undefined &&
		member.doc === module.doc &&
		member.signature.callee === module.name
			? { ...member, doc: undefined }
			: member,
	);
	return { primary, nested };
}

function isModuleMount(reexport: Reexport): boolean {
	return reexport.targetMember === undefined;
}

/**
 * Overrides `tags.realm` when the re-export site carries its own realm guard
 * or realm tag, since the re-exported field only exists where that guard passes.
 */
function withRealm(tags: Badges, reexport: Reexport): Badges {
	return reexport.realm === undefined ? tags : { ...tags, realm: reexport.realm };
}

/**
 * Synthesizes a `PageProp` for a re-export that does not inline a specific
 * `Member` (such as a whole-module mount, a nested class mount, or an
 * undocumented target member).
 */
function synthesizedProp(
	reexport: Reexport,
	fields: Pick<PageProp, "type" | "doc" | "source" | "reexport">,
): PageProp {
	return {
		id: reexport.id,
		name: reexport.name,
		kind: "prop",
		tags: withRealm({ custom: [] }, reexport),
		visibility: "public",
		readonly: false,
		...fields,
	};
}

/** Shared lookup tables for `inlineReexports`. */
interface ReexportContext {
	includePrivate: boolean;
	modulesById: Map<string, Module>;
	definitions: Map<string, Definition>;
}

/**
 * Converts a colon-method signature into a dot-function signature by inserting
 * `self` as the first parameter in both `segs` (at the first `(` outside `<...>`)
 * and `params`.
 */
function withSelf(signature: Fn["signature"]): Fn["signature"] {
	let depth = 0;
	let quote: string | undefined;
	let inserted = false;
	const segs = signature.segs.map((seg) => {
		if (inserted || typeof seg !== "string") {
			return seg;
		}
		for (let index = 0; index < seg.length; index += 1) {
			const char = seg[index]!;
			if (quote !== undefined) {
				if (char === "\\") {
					index += 1;
				} else if (char === quote) {
					quote = undefined;
				}
				continue;
			}
			if (char === '"' || char === "'" || char === "`") {
				quote = char;
			} else if (char === "<") {
				depth += 1;
			} else if (char === ">" && seg[index - 1] !== "-") {
				depth -= 1;
			} else if (char === "(" && depth === 0) {
				inserted = true;
				const empty = signature.params.length === 0;
				return `${seg.slice(0, index + 1)}self${empty ? "" : ", "}${seg.slice(index + 1)}`;
			}
		}
		return seg;
	});
	return { ...signature, segs, params: [{ name: "self" }, ...signature.params] };
}

/**
 * Inlines `module.reexports` into their owning section (`primary` or a matching
 * `nested` section). Resolved members keep their kind (with methods converted to
 * dot-called functions), while whole-module mounts, class mounts, and
 * undocumented targets become synthesized properties.
 */
function inlineReexports(
	module: Module,
	primary: PageSection,
	nested: PageSection[],
	ctx: ReexportContext,
): void {
	const sectionByName = new Map<string, PageSection>();
	for (const section of nested) {
		if (!sectionByName.has(section.container)) {
			sectionByName.set(section.container, section);
		}
		if (!sectionByName.has(section.name)) {
			sectionByName.set(section.name, section);
		}
	}
	const seenIds = new Set<string>(
		[primary, ...nested].flatMap((section) => section.members.map((member) => member.id)),
	);

	for (const reexport of module.reexports) {
		if (seenIds.has(reexport.id)) {
			continue;
		}
		const section =
			(reexport.within ? sectionByName.get(reexport.within) : undefined) ?? primary;
		const target = ctx.modulesById.get(reexport.targetModule);
		const { member, cls } = (reexport.targetId && ctx.definitions.get(reexport.targetId)) || {};
		// Skip private definitions when `includePrivate` is false.
		if (member && !isVisible(member, ctx.includePrivate)) {
			continue;
		}
		seenIds.add(reexport.id);
		if (member) {
			const shared = {
				id: reexport.id,
				name: reexport.name,
				doc: reexport.doc ?? member.doc,
				tags: withRealm(member.tags, reexport),
				reexport: { from: target?.name, targetId: member.id },
			};
			if (member.kind === "prop") {
				section.members.push({ ...member, ...shared });
			} else {
				// Re-exported functions and methods are exposed as table fields
				// on `section.container` (`M.name`), so a colon method becomes a
				// dot-called function with an explicit `self` parameter.
				const signature =
					member.kind === "method" ? withSelf(member.signature) : member.signature;
				section.members.push({
					...member,
					...shared,
					kind: "function",
					signature: {
						...signature,
						callee: memberAccess(section.container, reexport.name),
					},
				});
			}
		} else if (cls) {
			// Re-exporting a nested class from another module: synthesize a
			// property typed and linked to that class's section.
			section.members.push(
				synthesizedProp(reexport, {
					type: [{ text: cls.name, id: cls.id }],
					doc: reexport.doc ?? cls.doc,
					source: cls.source,
					reexport: { from: target?.name, targetId: cls.id },
				}),
			);
		} else {
			// Whole-module mount or a member the target module does not document.
			// Both link to the target module page, and whole-module mounts carry
			// the target module (or `@alias/path` runtime require) as their type.
			const mount = isModuleMount(reexport);
			// Project module IDs are relative paths, so a leading `@` identifies
			// a runtime alias (`@lute/fs`).
			const runtime = reexport.targetModule.startsWith("@");
			const targetName = target?.name ?? (runtime ? reexport.targetModule : undefined);
			const targetId = target?.id ?? (runtime ? reexport.targetModule : undefined);
			const type =
				mount && targetName !== undefined
					? [{ text: targetName, ...(target ? { id: target.id } : {}) }]
					: undefined;
			section.members.push(
				synthesizedProp(reexport, {
					type,
					doc: reexport.doc,
					source: target?.source ?? module.source,
					reexport: {
						...(mount ? { module: true } : { from: targetName }),
						targetId,
						url: reexport.url,
					},
				}),
			);
		}
	}
}

/**
 * Claims a case-insensitively unique page slug for `module`, stripping leading
 * and trailing dots/hyphens and appending `-2`, `-3`, ... on collision while
 * skipping any suffix already claimed by a literal `Foo-2` module name.
 */
function claimSlug(
	module: Module,
	usedSlugs: Set<string>,
	warnings: string[],
): { slug: string; collided: boolean } {
	const base = module.name.replace(/[^\w.-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "") || "module";
	let slug = base;
	for (let n = 2; usedSlugs.has(slug.toLowerCase()); n += 1) {
		slug = `${base}-${n}`;
	}
	usedSlugs.add(slug.toLowerCase());
	const collided = slug !== base;
	if (collided) {
		warnings.push(`page name collision: ${module.name} (${module.id}) becomes /${slug}`);
	}
	return { slug, collided };
}

/**
 * Populates `page.exports` for whole-module mounts, resolving `aliasOf` chains
 * so mounting a passthrough module still links to the target module's page. If a
 * module is mounted under multiple keys, the first key wins.
 */
function linkExports(
	pages: PageModel[],
	modulesById: Map<string, Module>,
	resolveAlias: (moduleId: string) => string,
): void {
	const pageIds = new Set(pages.map((page) => page.moduleId));
	for (const page of pages) {
		const seen = new Set<string>([page.moduleId]);
		const prefix = `${page.title}.`;
		for (const reexport of modulesById.get(page.moduleId)?.reexports ?? []) {
			const target = resolveAlias(reexport.targetModule);
			if (!isModuleMount(reexport) || !pageIds.has(target) || seen.has(target)) {
				continue;
			}
			seen.add(target);
			const within = reexport.within?.startsWith(prefix)
				? reexport.within.slice(prefix.length)
				: reexport.within;
			page.exports.push({
				moduleId: target,
				name: within ? `${within}.${reexport.name}` : reexport.name,
			});
		}
	}
}

export function buildPages(model: DocModel, config: LuauDocsConfig): BuildResult {
	const includePrivate = config.api.includePrivate;
	const warnings: string[] = [];
	const pages: PageModel[] = [];
	// Reserve `"index"` because the generated API overview page always writes `api/index.md`.
	const usedSlugs = new Set<string>(["index"]);
	const normalize = (path: string) => toPosix(path).replace(/^\.\//, "");
	const resolveAlias = aliasResolver(model);
	// Propagate the `entry` flag across `aliasOf` chains so a passthrough entry
	// (`return require(script.Impl)`) transfers its root status to `Impl`.
	const entryIds = new Set(model.project.entryPoints.map(normalize));
	for (const module of model.modules) {
		if (entryIds.has(normalize(module.id))) {
			entryIds.add(normalize(resolveAlias(module.id)));
		}
	}
	// Compute reachable types across the full model before filtering individual pages.
	const listed = listedTypeIds(model, includePrivate);
	const modulesById = new Map(model.modules.map((module) => [module.id, module]));
	const ctx: ReexportContext = {
		includePrivate,
		modulesById,
		definitions: definitionsById(model),
	};

	for (const module of model.modules) {
		if (module.aliasOf !== undefined) {
			continue; // Passthrough modules resolve to their target's page.
		}

		const { primary, nested } = buildSections(module, includePrivate);
		const exportedNames = new Set(
			module.types.filter((ty) => listed.has(ty.id) && ty.exported).map((ty) => ty.name),
		);
		// Preserve declaration order from `module.types`, dropping unexported
		// local aliases when a relocated `@within` exported type already owns the name.
		const types = module.types.filter(
			(ty) => listed.has(ty.id) && (ty.exported || !exportedNames.has(ty.name)),
		);
		inlineReexports(module, primary, nested, ctx);
		// Drop nested classes that have no visible members or doc comment, while keeping
		// `primary` unconditionally because it holds module-level members and badges.
		const sections = [primary, ...nested.filter(sectionHasContent)];
		if (!sections.some(sectionHasContent) && types.length === 0 && !module.doc) {
			continue;
		}

		const { slug, collided } = claimSlug(module, usedSlugs, warnings);
		// Qualify collided titles with their parent instance segment so search
		// results, sidebar items, and browser tabs remain distinguishable.
		const parent = module.instancePath[module.instancePath.length - 2];
		pages.push({
			slug,
			title: module.name,
			navTitle: collided && parent !== undefined ? `${module.name} (${parent})` : undefined,
			moduleId: module.id,
			instancePath: module.instancePath,
			entry: entryIds.has(normalize(module.id)),
			exports: [],
			doc: module.doc,
			tags: primary.tags,
			sections,
			types,
			source: module.source,
			anchors: {},
		});
	}

	linkExports(pages, modulesById, resolveAlias);
	return { pages, warnings, resolveAlias };
}

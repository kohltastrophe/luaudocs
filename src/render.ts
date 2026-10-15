/**
 * Markdown emission, deliberately kept in one file because its pieces must not
 * drift: `pageSteps` yields a page's render order, `mintAnchors` walks the same
 * steps to predict the heading id VitePress will mint for each, and the
 * SymbolTable turns those predictions into links. A drift between the walks
 * fails *silently*: VitePress strips the fragment before its dead-link check,
 * so a wrong anchor ships as a link that scrolls nowhere. test/anchors.test.ts
 * asserts both directions against the real VitePress renderer.
 *
 * Linking policy: never emit a link we cannot resolve. Signature links are
 * recorded as offset spans while the display's segments are joined, so the join
 * IS the offset computation.
 */
import type {
	Badges,
	DocModel,
	ExternalRef,
	Generic,
	Inline,
	Module,
	Seg,
	SourceSpan,
	TypeField,
} from "./docmodel";
import { parseDocModel } from "./docmodel";
import { repoFileUrl, validateConfig, type LuauDocsConfig } from "./config";
import {
	BADGE_LINK_ATTRS,
	encodeHref,
	escapeHtml,
	escapeMarkdown,
	headingSlug,
	linkDestination,
	mapOutsideCodeSpans,
	mapOutsideFences,
	proseHeadings,
	region,
	sourceLinkAnchor,
	stripLinks,
	unwrap,
} from "./markdown";
import {
	apiHref,
	apiPageFile,
	buildPages,
	displayTitle,
	generatedFrontmatter,
	isPrimaryClass,
	memberAccess,
	toPosix,
	TYPES_HEADING,
	type PageFn,
	type PageModel,
	type PageProp,
	type PageSection,
	type PageType,
	type ReexportInfo,
} from "./pages";
import { apiSidebar, apiTrails, buildAccessTree, renderApiIndex, type SidebarItem } from "./nav";
import { LINKS_TOKEN } from "../templates/runtime/signature-links";
import type { TrailSegment } from "../templates/runtime/markup";
import robloxNames from "./generated/roblox-names.json";

/** Luau builtins: never linked. */
const LUAU_BUILTINS = new Set([
	"string",
	"number",
	"boolean",
	"table",
	"thread",
	"buffer",
	"vector",
	"function",
	"userdata",
	"any",
	"unknown",
	"never",
	"nil",
	"self",
	"true",
	"false",
]);

// Every Roblox class, enum, and datatype maps to Creator Hub docs when
// linkRobloxTypes is on. Generated from the API dump at install/CI time and
// baked into the bundle, so a build never fetches it.
const ROBLOX_DATATYPES = new Set<string>(robloxNames.datatypes);
const ROBLOX_CLASSES = new Set<string>(robloxNames.classes);
const ROBLOX_ENUMS = new Set<string>(robloxNames.enums);

interface RenderOptions {
	symbols: SymbolTable;
	/** The validated luaudocs.toml, read directly so defaults live in
	 * config.ts alone and are never duplicated here. */
	config: LuauDocsConfig;
	/** Names the extractor could not resolve locally: an `@external` URL or a
	 * runtime-alias reference, consulted before the Roblox lists. */
	externals?: Record<string, string | ExternalRef>;
	/** Published doc models for dependencies, turning runtime-alias references
	 * into exact links on the dependency's site. */
	dependencies?: DependencyLinks;
}

const ROBLOX_DOCS = "https://create.roblox.com/docs/reference/engine";

function robloxUrl(name: string): string | undefined {
	// Every type position spells an enum through the `Enum` global.
	const enumName = /^Enum\.(\w+)$/.exec(name)?.[1];
	if (enumName !== undefined) {
		return ROBLOX_ENUMS.has(enumName) ? `${ROBLOX_DOCS}/enums/${enumName}` : undefined;
	}
	const kind = ROBLOX_DATATYPES.has(name)
		? "datatypes"
		: ROBLOX_CLASSES.has(name)
			? "classes"
			: ROBLOX_ENUMS.has(name)
				? "enums"
				: undefined;
	return kind ? `${ROBLOX_DOCS}/${kind}/${name}` : undefined;
}

/**
 * Resolves a name outside the project: the author's `@external` map wins over
 * the Roblox engine lists. Percent-encoded, since an author's URL can contain
 * characters that link destinations cannot carry raw.
 */
function externalUrl(name: string, options: RenderOptions): string | undefined {
	const external = options.externals?.[name];
	if (typeof external === "string") {
		return encodeHref(external);
	}
	if (external !== undefined) {
		// Resolve the exact entry when the dependency published a model, or fall back to its base URL.
		const url = options.dependencies?.resolve(external) ?? external.url;
		return url === undefined ? undefined : encodeHref(url);
	}
	if (options.config.api.linkRobloxTypes && !LUAU_BUILTINS.has(name)) {
		return robloxUrl(name);
	}
	return undefined;
}

/** Resolves a reference segment: project symbol ID first, then by-text external fallbacks. */
function segHref(seg: { text: string; id?: string }, options: RenderOptions): string | undefined {
	return seg.id ? options.symbols.linkForId(seg.id) : externalUrl(seg.text, options);
}

export function inlineText(segs: Inline): string {
	return segs.map((seg) => (typeof seg === "string" ? seg : seg.text)).join("");
}

/**
 * Checks for a pure re-spelling (`export type Log = Util.Log` or
 * `export type State<T> = Graph.State<T>`) where the definition is a single
 * reference segment with optional `<...>` type arguments, and returns the
 * origin declaration's ID.
 */
function pureAliasRef(ty: PageType): string | undefined {
	if (ty.kind !== "alias" || ty.definition?.length !== 1 || ty.fields?.length) {
		return undefined;
	}
	const [head, ...rest] = ty.definition[0] ?? [];
	if (typeof head !== "object" || !head.id) {
		return undefined;
	}
	return rest.length === 0 || /^<[^>]+>$/.test(inlineText(rest)) ? head.id : undefined;
}

/*
 * ---------------------------------------------------------------- prose links
 */

/**
 * Resolves Moonwave bracket references in prose markdown (`[Class]`,
 * `[Class.member]`, and `[CFrame]`-style Roblox and `@external` names). Skips
 * fenced and indented code blocks, inline code spans, and existing markdown links.
 */
function linkifyProse(markdown: string, options: RenderOptions): string {
	const rewriteLine = (line: string): string =>
		mapOutsideCodeSpans(line, (part) =>
			part.replace(
				// `](` and `][` are markdown links, `]:` is a link-reference
				// definition, and a leading `]` means THIS bracket is the
				// label half of a `[text][Ref]` reference link. Allow any number
				// of dotted segments, since a nested class's member is spelled
				// in full (`Color.Linear.fromGamma`).
				/(?<!\])\[([A-Za-z_]\w*(?:[.:][A-Za-z_]\w*)*)\](?![([:])/g,
				(match, name: string) => {
					// Try project symbols first; a bare identifier falls back to
					// @external or Roblox, but never a Class.member form, which
					// would fabricate an anchor.
					const url =
						options.symbols.linkForName(name) ??
						(/^[A-Za-z_]\w*$/.test(name) ? externalUrl(name, options) : undefined);
					return url ? `[\`${name}\`](${linkDestination(url)})` : match;
				},
			),
		);

	// Indented code is left verbatim like fenced code: a 4-space or tab-indented
	// line after a blank boundary opens a code block (CommonMark: indented code
	// cannot interrupt a paragraph). The state spans fence boundaries, since a
	// fence line is a non-blank line that ends any indented run.
	let prevBlank = true; // text start counts as a blank boundary
	let inIndentedCode = false;
	return mapOutsideFences(markdown, (segment) => {
		const out = segment
			.split("\n")
			.map((line) => {
				const blank = /^[ \t]*$/.test(line);
				const wasBlank = prevBlank;
				prevBlank = blank;
				const codeIndent = !blank && /^(?:[ \t]*\t| {4})/.test(line);
				if (inIndentedCode) {
					if (blank || codeIndent) {
						return line;
					}
					inIndentedCode = false;
				} else if (codeIndent && wasBlank) {
					inIndentedCode = true;
					return line;
				}
				return rewriteLine(line);
			})
			.join("\n");
		prevBlank = false;
		inIndentedCode = false;
		return out;
	});
}

/**
 * Merges runs of unlinked segments into one code span so a display whose
 * references resolve nowhere reads as a single code span. Edge whitespace stays
 * outside the span: CommonMark strips spaces that pad both ends of a code span,
 * so `A | B` would otherwise collapse to `A|B`.
 */
function linkifyInline(type: Inline, options: RenderOptions): string {
	const parts: string[] = [];
	let plain = "";
	const flush = () => {
		const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(plain)!;
		parts.push(core === "" ? plain : `${lead}\`${core}\`${trail}`);
		plain = "";
	};
	for (const seg of type) {
		if (typeof seg === "string") {
			plain += seg;
			continue;
		}
		const href = segHref(seg, options);
		if (href === undefined) {
			plain += seg.text;
			continue;
		}
		flush();
		parts.push(`[\`${seg.text}\`](${linkDestination(href)})`);
	}
	flush();
	return parts.join("");
}

/*
 * --------------------------------------------------------------------- badges
 */

/**
 * Renders a `<Badge>` with escaped text so no call site can forget to escape it.
 * `cls` passes through onto the rendered span to style realm badges beyond
 * VitePress's four built-in types, while `type` stays as the fallback when
 * luaudocs.css is not loaded.
 */
function badge(type: "info" | "tip" | "warning" | "danger", text: string, cls?: string): string {
	const attr = cls ? ` class="${cls}"` : "";
	return `<Badge type="${type}" text="${escapeHtml(text)}"${attr} />`;
}

/**
 * Structured badge data shared between rendered pages and `llms.txt`. `note`
 * is used on deprecation badges only: pages render it as a standalone warning
 * container (`deprecationNotice`), while `llms.txt` folds it into the label.
 */
export interface BadgeLabel {
	type: "info" | "tip" | "warning" | "danger";
	text: string;
	cls?: string;
	note?: string;
}

/** Returns every badge a declaration's tags earn, in heading display order. */
export function badgeLabels(
	tags: Badges | undefined,
	visibility?: "public" | "private",
): BadgeLabel[] {
	return [
		...(tags?.deprecated
			? [
					{
						type: "danger" as const,
						text: `Deprecated${tags.deprecated.version ? ` since ${tags.deprecated.version}` : ""}`,
						note: tags.deprecated.note,
					},
				]
			: []),
		...(visibility === "private" ? [{ type: "danger" as const, text: "Private" }] : []),
		...(tags?.unreleased ? [{ type: "warning" as const, text: "Unreleased" }] : []),
		...(tags?.yields ? [{ type: "warning" as const, text: "Yields" }] : []),
		...(tags?.realm ?? []).map((realm) => ({
			type: "info" as const,
			text: `${realm[0]!.toUpperCase()}${realm.slice(1)}`,
			cls: `luaudocs-${realm}`,
		})),
		...(tags?.since ? [{ type: "tip" as const, text: `since ${tags.since}` }] : []),
		...(tags?.custom ?? []).map((text) => ({ type: "info" as const, text })),
	];
}

function badgeMarkup(tags: Badges | undefined, visibility?: "public" | "private"): string {
	return badgeLabels(tags, visibility)
		.map((label) => badge(label.type, label.text, label.cls))
		.join(" ");
}

/** A property's badge when it cannot be assigned. */
export const READ_ONLY_LABEL = "Read Only";

/** "Module" for whole-module mounts, "from X" for members defined in module X. */
export function reexportLabel(re: ReexportInfo): string {
	return re.module ? "Module" : re.from ? `from ${re.from}` : "Re-export";
}

/** The deprecation note is prose like any other doc text, so `[M.newThing]` references resolve. */
function deprecationNotice(tags: Badges | undefined, options: RenderOptions): string {
	if (!tags?.deprecated) {
		return "";
	}
	const note =
		tags.deprecated.note ?? "This item is deprecated and may be removed in a future version.";
	return `::: warning DEPRECATED\n${linkifyProse(note, options)}\n:::`;
}

/*
 * ----------------------------------------------------------------- page steps
 */

/**
 * One step of a page's render. Both `renderPage` (which emits markdown) and
 * `mintAnchors` (which predicts heading slugs) consume this single sequence.
 * Two properties of the order must hold:
 *
 *   - Types come before the primary section's members. On a page with both
 *     `Action` (a type) and `action()` (a function), the type takes `#action`
 *     and the function takes `#action-1`.
 *   - Only headings that actually render are yielded as steps, so omitted
 *     sections never consume a slug.
 */
type PageStep =
	/** H1: the page title, with the module's badges and source link */
	| { kind: "title" }
	/** H2: a named (nested) section, with its badges and source link */
	| { kind: "sectionHeading"; section: PageSection }
	/**
	 * A plain text heading (`Types` or a member-list heading). `id` keys the
	 * slug it mints in `anchors`, which also names the region marker wrapping
	 * the block so `<!--@include-->` can slice the heading and its entries together.
	 */
	| { kind: "heading"; level: 2 | 3; text: string; id: string }
	/** Prose whose own ATX headings mint slugs of their own. */
	| { kind: "prose"; doc: string }
	| { kind: "constructors"; section: PageSection }
	| { kind: "type"; ty: PageType }
	| { kind: "prop"; prop: PageProp; container: string }
	| { kind: "fn"; fn: PageFn };

/** Yields a section's heading, prose, and constructor links in render order. */
function* introSteps(page: PageModel, section: PageSection): Generator<PageStep> {
	if (section.name !== "") {
		yield { kind: "sectionHeading", section };
		if (section.doc) {
			yield { kind: "prose", doc: section.doc };
		}
	} else if (section.doc && section.doc !== page.doc) {
		// The primary section's prose renders only when it differs from the
		// module doc (e.g., the factory pattern with two separate comment blocks).
		yield { kind: "prose", doc: section.doc };
	}
	if (section.constructors.length > 0) {
		yield { kind: "constructors", section };
	}
}

/** The member kinds in page order, each under its heading. */
export const MEMBER_HEADINGS = [
	{ text: "Properties", kind: "prop" },
	{ text: "Functions", kind: "function" },
	{ text: "Methods", kind: "method" },
	{ text: "Metamethods", kind: "metamethod" },
] as const;

/**
 * Yields a section's members grouped under occupied kind headings. Nested
 * sections skip the kind headings because both the kind heading and member
 * headings would be `###`, so nested members sit directly under the section
 * heading in kind order.
 */
function* memberSteps(page: PageModel, section: PageSection): Generator<PageStep> {
	const labeled = section.name === "";
	const container = section.container;
	for (const { text, kind } of MEMBER_HEADINGS) {
		const members = section.members.filter((member) => member.kind === kind);
		if (members.length === 0) {
			continue;
		}
		if (labeled) {
			yield { kind: "heading", level: 2, text, id: `${section.id ?? ""}:${text}` };
		}
		for (const member of members) {
			// A callable module with no comment block of its own promotes its
			// call member's comment to the module blurb (the page intro and index
			// summary); repeating it byte-for-byte on the member adds nothing.
			// Stripped here so rendering and anchor minting see the same doc.
			const deduped =
				member.kind !== "prop" &&
				member.doc !== undefined &&
				member.doc === page.doc &&
				member.signature.callee === page.title
					? { ...member, doc: undefined }
					: member;
			yield deduped.kind === "prop"
				? { kind: "prop", prop: deduped, container }
				: { kind: "fn", fn: deduped };
		}
	}
}

/** A declaration rendered by a member step (type, property, or function). */
type Decl = PageType | PageProp | PageFn;

/** Returns the declaration for a member step, or `undefined` for other steps. */
function declOf(step: PageStep): Decl | undefined {
	switch (step.kind) {
		case "type":
			return step.ty;
		case "prop":
			return step.prop;
		case "fn":
			return step.fn;
		default:
			return undefined;
	}
}

/** Yields the entire page in render order. */
function* pageSteps(page: PageModel): Generator<PageStep> {
	yield { kind: "title" };
	if (page.doc) {
		yield { kind: "prose", doc: page.doc };
	}
	const [primary, ...nested] = page.sections;
	if (primary) {
		yield* introSteps(page, primary);
	}
	// Types lead because they define the vocabulary used by the signatures below them.
	if (page.types.length > 0) {
		yield { kind: "heading", level: 2, text: TYPES_HEADING, id: `:${TYPES_HEADING}` };
		for (const ty of page.types) {
			yield { kind: "type", ty };
		}
	}
	if (primary) {
		yield* memberSteps(page, primary);
	}
	for (const section of nested) {
		yield* introSteps(page, section);
		yield* memberSteps(page, section);
	}
}

/**
 * The `anchors` key holding the slug of the page's own H1. Synthetic, like the
 * heading-step IDs: it names the region wrapping the whole page so an embed
 * can pull in a module's title, description, and members as one block.
 */
const PAGE_ANCHOR = ":page";

/**
 * Predicts the anchor VitePress will mint for every member, type, and named
 * section by walking `pageSteps` and applying `markdown-it-anchor`'s rule
 * (slugify, then append `-1`, `-2`, ... on collision).
 */
function mintAnchors(page: PageModel): Record<string, string> {
	const anchors: Record<string, string> = {};
	const used = new Set<string>();

	/**
	 * `explicit` is an author's `{#id}`, which `markdown-it-anchor` takes as-is.
	 * A duplicate explicit ID is a VitePress build error rather than a numbered
	 * suffix, so we only need to record it in `used`.
	 */
	const mint = (text: string, key?: string, explicit?: string) => {
		let slug = explicit ?? headingSlug(text);
		if (explicit === undefined) {
			const base = slug;
			for (let n = 1; used.has(slug); n += 1) {
				slug = `${base}-${n}`;
			}
		}
		used.add(slug);
		if (key !== undefined) {
			anchors[key] = slug;
		}
	};
	const prose = (markdown: string | undefined) => {
		for (const heading of proseHeadings(markdown)) {
			mint(heading.text, undefined, heading.id);
		}
	};

	for (const step of pageSteps(page)) {
		// Deprecation notices render as block markdown right after their owner's
		// heading, so headings inside a deprecation notice mint slugs ahead of
		// the owner's main doc prose.
		const decl = declOf(step);
		if (decl !== undefined) {
			// Mint from the bare name (what the heading's code span slugifies to):
			// a nested section's member heading is `### \`fromGamma\``, so a name
			// shared across two sections collides and the second gets `-1`.
			mint(decl.name, decl.id);
			prose(decl.tags?.deprecated?.note);
			prose(decl.doc);
			continue;
		}
		switch (step.kind) {
			case "title":
				mint(page.title, PAGE_ANCHOR);
				prose(page.tags?.deprecated?.note);
				break;
			case "sectionHeading":
				mint(step.section.name, step.section.id);
				prose(step.section.tags?.deprecated?.note);
				break;
			case "heading":
				mint(step.text, step.id);
				break;
			case "prose":
				prose(step.doc);
				break;
			case "constructors":
				break; // rendered as a bold line of links, not a heading
		}
	}
	return anchors;
}

/*
 * --------------------------------------------------------------- symbol table
 */

interface SymbolTarget {
	page: string; // slug
	anchor?: string;
	/**
	 * Reader-facing member name (`Flux.compute`), qualified by the container it
	 * renders under. Populated for members only, not types or classes.
	 */
	name?: string;
}

/**
 * Maps doc-model IDs and human reference spellings to page slugs and anchors.
 * Anchors are read from `PageModel.anchors` rather than recomputed from a name,
 * since only `mintAnchors` knows which declaration won a slug collision.
 */
class SymbolTable {
	private byId = new Map<string, SymbolTarget>();
	private byName = new Map<string, SymbolTarget>();
	private ambiguous = new Set<string>();
	private moduleSlug = new Map<string, string>();

	constructor(
		model: DocModel,
		pages: PageModel[],
		warnings: string[],
		resolveAlias: (moduleId: string) => string,
	) {
		const moduleSlug = this.moduleSlug;
		const pageByModule = new Map<string, PageModel>();
		for (const page of pages) {
			moduleSlug.set(page.moduleId, page.slug);
			pageByModule.set(page.moduleId, page);
		}

		// Alias modules resolve to their target's page via the resolver built in buildPages.
		for (const module of model.modules) {
			if (module.aliasOf !== undefined) {
				const target = moduleSlug.get(resolveAlias(module.id));
				if (target) {
					moduleSlug.set(module.id, target);
				}
			}
		}

		// Names register in tiers, and ambiguity (with its warning) only occurs
		// within the same tier. The value surface (pages, sections, and members)
		// claims spellings first; exported types take remaining names (since a
		// module and its same-named type read as one entity); and pure re-spelling
		// aliases (`export type Log = Util.Log`) claim their qualified name while
		// pointing the bare name at the origin declaration.
		const pageTitles = new Set(pages.map((page) => page.title));
		for (const page of pages) {
			this.registerName(page.title, { page: page.slug }, warnings);
			for (const section of page.sections) {
				const containerName = section.container;
				if (section.name !== "" && section.id !== undefined) {
					const target = { page: page.slug, anchor: page.anchors[section.id] };
					// A nested class registers under its qualified container name
					// (`Color.Linear`) and only claims its short name (`Linear`) when
					// no top-level page already owns that title.
					if (containerName === section.name || !pageTitles.has(section.name)) {
						this.registerName(section.name, target, warnings);
					}
					if (containerName !== section.name) {
						this.registerName(containerName, target, warnings);
					}
				}
				for (const member of section.members) {
					const target = {
						page: page.slug,
						anchor: page.anchors[member.id],
						name: `${containerName}.${member.name}`,
					};
					this.byId.set(member.id, target);
					this.registerName(target.name, target, warnings);
					// Methods also register under colon syntax (`Class:method`).
					if (member.kind === "method") {
						this.registerName(`${containerName}:${member.name}`, target, warnings);
					}
				}
			}
		}

		const valueNames = new Set(this.byName.keys());
		const aliasOfId = new Map<string, string>();
		const aliases: Array<{ name: string; target: SymbolTarget; refId: string }> = [];
		for (const page of pages) {
			for (const ty of page.types) {
				const target = { page: page.slug, anchor: page.anchors[ty.id] };
				this.byId.set(ty.id, target);
				const qualified = `${page.title}.${ty.name}`;
				if (!valueNames.has(qualified)) {
					this.registerName(qualified, target, warnings);
				}
				const refId = pureAliasRef(ty);
				if (refId !== undefined) {
					aliasOfId.set(ty.id, refId);
				}
				// Only exported types register under their bare name: an unexported
				// type cannot be named outside its module, so registering it would
				// only make an exported name elsewhere ambiguous.
				if (!ty.exported || valueNames.has(ty.name)) {
					continue;
				}
				if (refId === undefined) {
					this.registerName(ty.name, target, warnings);
				} else {
					aliases.push({ name: ty.name, target, refId });
				}
			}
		}

		const typeNames = new Set(this.byName.keys());
		const seenAliasOrigin = new Map<string, string>();
		for (const alias of aliases) {
			if (!typeNames.has(alias.name)) {
				let rootId = alias.refId;
				for (let step = 0; step < 16 && aliasOfId.has(rootId); step += 1) {
					rootId = aliasOfId.get(rootId)!;
				}
				if (seenAliasOrigin.get(alias.name) === rootId) {
					continue;
				}
				seenAliasOrigin.set(alias.name, rootId);
				// If the origin declaration rendered no anchor of its own (e.g., an
				// unexported or suppressed type), fall back to the alias's anchor.
				this.registerName(alias.name, this.byId.get(rootId) ?? alias.target, warnings);
			}
		}

		// Class entries resolve to their section heading (or the page itself for a
		// primary class); IDs on skipped pages stay unregistered.
		for (const module of model.modules) {
			const page = pageByModule.get(module.id);
			if (!page) {
				continue;
			}
			for (const cls of module.classes) {
				this.byId.set(
					cls.id,
					isPrimaryClass(cls, module.name)
						? { page: page.slug }
						: { page: page.slug, anchor: page.anchors[cls.id] },
				);
			}
		}
	}

	private registerName(name: string, target: SymbolTarget, warnings: string[]) {
		if (this.ambiguous.has(name)) {
			return;
		}
		const existing = this.byName.get(name);
		if (existing === undefined) {
			this.byName.set(name, target);
			return;
		}
		if (existing.page !== target.page || existing.anchor !== target.anchor) {
			// When one spelling resolves to two distinct targets in the same tier
			// (e.g., two modules named Defaults, or Config.get on two pages), drop
			// the bare name from the link table and warn so the author can qualify it.
			this.ambiguous.add(name);
			this.byName.delete(name);
			warnings.push(
				`ambiguous reference name dropped from link table: ${name} (${this.url(existing)} vs ${this.url(target)})`,
			);
		}
	}

	/** Resolves member/type IDs first, then module IDs (following aliases). */
	linkForId(id: string): string | undefined {
		const target = this.byId.get(id);
		if (target) {
			return this.url(target);
		}
		const slug = this.moduleSlug.get(id);
		return slug ? apiHref(slug) : undefined;
	}

	/** Returns a member ID's reader-facing qualified name; see `SymbolTarget.name`. */
	nameForId(id: string): string | undefined {
		return this.byId.get(id)?.name;
	}

	linkForName(name: string): string | undefined {
		const target = this.byName.get(name);
		return target ? this.url(target) : undefined;
	}

	private url(target: SymbolTarget): string {
		return apiHref(target.page, target.anchor);
	}
}

/*
 * --------------------------------------------------------- dependency links
 */

/** A dependency's published doc model (`[source] aliases` with a `model`). */
export interface LoadedDependency {
	alias: string;
	/** Base URL of the dependency's published docs site. */
	url: string;
	model: DocModel;
}

export interface DependencyLinks {
	/** Resolves a runtime-alias reference to the type's entry on the dependency's
	 * site, or its module page if the type itself has no entry. Returns `undefined`
	 * when the alias published no model or the module is not in that model. */
	resolve(ref: ExternalRef): string | undefined;
}

/** Normalizes a module ID to its require-path form (no extension, no `/init`). */
function requirePathOf(moduleId: string): string {
	return toPosix(moduleId)
		.replace(/^\.\//, "")
		.replace(/\.luau?$/, "")
		.replace(/(^|\/)init$/, "");
}

/**
 * Builds each dependency's pages and symbol table the same way its own site
 * built them so references resolve to the exact anchors the dependency minted.
 * Uses default config values and discards the dependency's own build warnings.
 */
export function buildDependencyLinks(loaded: LoadedDependency[]): DependencyLinks {
	interface Dependency {
		url: string;
		symbols: SymbolTable;
		/** require path -> module */
		modules: Map<string, Module>;
	}
	const byAlias = new Map<string, Dependency>();
	for (const dep of loaded) {
		const { pages, warnings, resolveAlias } = buildPages(
			dep.model,
			validateConfig({ title: dep.alias }),
		);
		for (const page of pages) {
			page.anchors = mintAnchors(page);
		}
		const modules = new Map(
			dep.model.modules.map((module) => [requirePathOf(module.id), module]),
		);
		// A bare `@alias` require targets the dependency's primary entry module.
		const entry = dep.model.project.entryPoints[0];
		const entryModule = entry === undefined ? undefined : modules.get(requirePathOf(entry));
		if (entryModule !== undefined) {
			modules.set("", entryModule);
		}
		byAlias.set(dep.alias, {
			url: dep.url.replace(/\/+$/, ""),
			symbols: new SymbolTable(dep.model, pages, warnings, resolveAlias),
			modules,
		});
	}

	// `@lute/net/client` maps to `lute/net/client.luau` in one repo layout and
	// `src/net/client.luau` in another: try an exact match first, then the
	// shortest module path that ends with `/${path}`.
	const moduleFor = (dep: Dependency, path: string): Module | undefined => {
		const exact = dep.modules.get(path);
		if (exact !== undefined) {
			return exact;
		}
		let best: [string, Module] | undefined;
		for (const [candidate, module] of dep.modules) {
			if (
				candidate.endsWith(`/${path}`) &&
				(best === undefined || candidate.length < best[0].length)
			) {
				best = [candidate, module];
			}
		}
		return best?.[1];
	};

	return {
		resolve(ref) {
			const dep = byAlias.get(ref.alias);
			const module = dep && moduleFor(dep, ref.path);
			if (dep === undefined || module === undefined) {
				return undefined;
			}
			// If the specific type is not documented in the model, fall back to
			// its module's page rather than guessing an anchor.
			const decl =
				ref.name === undefined
					? undefined
					: (module.types.find((ty) => ty.name === ref.name && ty.exported) ??
						module.classes.find((cls) => cls.name === ref.name));
			const href =
				(decl && dep.symbols.linkForId(decl.id)) ?? dep.symbols.linkForId(module.id);
			return href === undefined ? undefined : dep.url + href;
		},
	};
}

/*
 * --------------------------------------------------------------------- fences
 */

/**
 * Builds a Luau signature code fence while recording link spans at their exact
 * byte offsets as segments are appended.
 */
class Fence {
	private body = "";
	private spans: Array<[number, number, string]> = [];

	constructor(private options: RenderOptions) {}

	text(text: string): this {
		this.body += text;
		return this;
	}

	seg(seg: Seg): this {
		if (typeof seg === "string") {
			return this.text(seg);
		}
		const href = segHref(seg, this.options);
		if (href !== undefined) {
			// Encode at the single point where every span is recorded so no URL
			// can inject a space or quote into the fence's info string.
			this.spans.push([
				this.body.length,
				this.body.length + seg.text.length,
				encodeHref(href),
			]);
		}
		return this.text(seg.text);
	}

	segs(segs: Inline): this {
		for (const seg of segs) {
			this.seg(seg);
		}
		return this;
	}

	/** Appends `<T, U... = D>`, linking any references inside generic defaults. */
	generics(generics: Generic[]): this {
		if (generics.length === 0) {
			return this;
		}
		this.text("<");
		for (const [index, generic] of generics.entries()) {
			if (index > 0) {
				this.text(", ");
			}
			this.text(`${generic.name}${generic.isPack ? "..." : ""}`);
			if (generic.default) {
				this.text(" = ").segs(generic.default);
			}
		}
		return this.text(">");
	}

	/**
	 * Emits the fence. The info string carries `luaudocs-links=...` (compact JSON
	 * with no whitespace) only when at least one reference resolved; otherwise it
	 * emits a plain `luau` fence.
	 */
	render(): string {
		const info =
			this.spans.length > 0 ? `luau ${LINKS_TOKEN}${JSON.stringify(this.spans)}` : "luau";
		return ["```" + info, this.body, "```"].join("\n");
	}
}

/** Flattens a field doc into a single comment line, with markdown syntax stripped. */
function commentText(doc: string): string {
	return stripLinks(unwrap(doc))
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.trim();
}

/**
 * Splices each documented field's doc as a `-- comment` line above the field.
 * Placement is a direct lookup: `field.line` is the extractor's 1-based index
 * into these definition lines. Fields without a line (or whose line was already
 * claimed by an earlier field) are returned as `leftovers` to render as a prose
 * list below the fence.
 */
function spliceFieldDocs(
	definition: Inline[],
	fields: TypeField[],
): { lines: Inline[]; leftovers: TypeField[] } {
	const comments = new Map<number, string>();
	const claimed = new Set<number>();
	const leftovers: TypeField[] = [];
	for (const field of fields) {
		// Line 1 shares its rendered line with the `type X = ` prefix, so it
		// cannot take a comment line above it.
		const index = field.line !== undefined && field.line > 1 ? field.line - 1 : -1;
		// Every field claims its line, including undocumented ones: comments sit
		// *above* the line, so if only documented fields claimed lines, `b` in
		// `a: string, b: number,` would place its doc above `a`.
		const line = definition[index];
		if (line === undefined || claimed.has(index)) {
			if (field.doc && !field.docInDisplay) {
				leftovers.push(field);
			}
			continue;
		}
		claimed.add(index);
		if (!field.doc || field.docInDisplay) {
			continue;
		}
		const indent = inlineText(line).match(/^\s*/)?.[0] ?? "";
		comments.set(index, `${indent}-- ${commentText(field.doc)}`);
	}
	const lines: Inline[] = [];
	for (const [index, line] of definition.entries()) {
		const comment = comments.get(index);
		if (comment !== undefined) {
			lines.push([comment]);
		}
		lines.push(line);
	}
	return { lines, leftovers };
}

function fnFence(fn: PageFn, options: RenderOptions): string {
	// The callee is appended as plain text, so a member's own name never links to itself.
	return new Fence(options).text(fn.signature.callee).segs(fn.signature.segs).render();
}

/** `Container.name: <type>`, with the callee prefix included in the offset walk. */
function propFence(prop: PageProp, containerName: string, options: RenderOptions): string {
	const fence = new Fence(options).text(memberAccess(containerName, prop.name));
	if (prop.type) {
		fence.text(": ").segs(prop.type);
	}
	return fence.render();
}

/** Formats `<T, U... = D>` as plain text for `llms.txt`. */
export function genericsText(generics: Generic[]): string {
	if (generics.length === 0) {
		return "";
	}
	const parts = generics.map(
		(generic) =>
			`${generic.name}${generic.isPack ? "..." : ""}` +
			(generic.default ? ` = ${inlineText(generic.default)}` : ""),
	);
	return `<${parts.join(", ")}>`;
}

/** Formats `type Name<generics> = <definition>`, recording link spans as segments join. */
function typeFence(
	ty: PageType,
	options: RenderOptions,
): { fence: string; leftovers: TypeField[] } {
	// A type function is called like a function, so its fence shows the
	// parameter list while the body stays behind the source link.
	if (ty.kind === "typefunction") {
		const fence = new Fence(options).text(`type function ${ty.name}`).generics(ty.generics);
		if (ty.params) {
			fence.segs(ty.params);
		}
		return { fence: fence.render(), leftovers: [] };
	}

	const fence = new Fence(options).text(`type ${ty.name}`).generics(ty.generics);

	const fields = ty.fields ?? [];
	if (ty.definition) {
		const { lines, leftovers } = spliceFieldDocs(ty.definition, fields);
		fence.text(" = ");
		for (const [index, line] of lines.entries()) {
			if (index > 0) {
				fence.text("\n");
			}
			fence.segs(line);
		}
		return { fence: fence.render(), leftovers };
	}
	// A tag-declared `@interface` with no AST type expression: synthesize the
	// table type from its `@field` entries with field docs as `--` comments.
	if (fields.length > 0) {
		fence.text(" = {");
		for (const field of fields) {
			if (field.doc) {
				fence.text(`\n    -- ${commentText(field.doc)}`);
			}
			fence.text(`\n    ${field.name}: `);
			if (field.type) {
				fence.segs(field.type);
			} else {
				fence.text("unknown");
			}
			fence.text(",");
		}
		fence.text("\n}");
		return { fence: fence.render(), leftovers: [] };
	}
	return { fence: fence.text(" = unknown").render(), leftovers: [] };
}

/*
 * -------------------------------------------------------------- member blocks
 */

function sourceLink(span: SourceSpan | undefined, options: RenderOptions): string {
	const repo = options.config.repo;
	if (!span || !repo) {
		return "";
	}
	const lines = `#L${span.line}${span.endLine ? `-L${span.endLine}` : ""}`;
	// Encode `#` and `?` in file paths as data rather than URL query/fragment delimiters.
	const path = encodeURI(toPosix(span.file)).replace(/[#?]/g, encodeURIComponent);
	return sourceLinkAnchor(`${repoFileUrl(repo, path)}${lines}`);
}

/** Escapes `|` and replaces newlines with `<br />` inside a markdown table cell. */
function cellText(text: string | undefined): string {
	return text ? text.replace(/\|/g, "\\|").replace(/\n+/g, "<br />") : "";
}

/** Flattens a doc string into a single list-item line, resolving prose references. */
function itemText(doc: string, options: RenderOptions): string {
	return unwrap(linkifyProse(doc, options).trim());
}

/**
 * Formats a heading from H1 page titles down to H3 members.
 *
 * Emits no explicit `{#id}`: VitePress mints the slug from the heading's text
 * tokens and `mintAnchors` predicts that exact slug, so everything appended
 * after `name` must contribute zero text tokens. Self-closing `<Badge text="..." />`
 * tags and the empty source-link anchor render as HTML tokens only, so
 * `### \`Connect\` <Badge .../>` still mints `connect` (whereas a `<Badge>` with
 * slot children would fold its text into the slug).
 */
function heading(level: number, name: string, badges: string, source: string): string {
	return `${"#".repeat(level)} ${name}${badges ? ` ${badges}` : ""}${source ? ` ${source}` : ""}`;
}

/**
 * Formats the re-export badge (`reexportLabel`), linked to the origin definition.
 *
 * The markdown link wraps the `<Badge>` rather than sitting inside its slot:
 * slot children are heading text tokens, so `<Badge>[from Foo](...)</Badge>`
 * would mint `connect-from-foo` instead of `connect`. Wrapping with a markdown
 * link lets VitePress prefix the site base and run its dead-link check while
 * contributing no text tokens (since `<Badge />` is an HTML token). The trailing
 * `.ignore-header` class on the link makes VitePress's outline skip it.
 */
function reexportBadge(re: ReexportInfo | undefined, options: RenderOptions): string {
	if (!re) {
		return "";
	}
	const text = reexportLabel(re);
	const url = (re.targetId ? options.symbols.linkForId(re.targetId) : undefined) ?? re.url;
	if (url) {
		return `[${badge("info", text)}](${linkDestination(url)})${BADGE_LINK_ATTRS}`;
	}
	// A "Module" badge promises a target page; when the mounted module has no
	// page (e.g., an opaque module), omit the badge so the entry reads as a
	// plain property. Provenance badges ("from X") still carry meaning unlinked.
	return re.module ? "" : badge("info", text);
}

const KIND_LABEL = {
	alias: "type",
	interface: "interface",
	typefunction: "type function",
} as const;

/**
 * Formats a member block (heading, deprecation notice, signature fence, prose,
 * and labeled subsections). Member names are wrapped in a code span so
 * identifiers containing markdown syntax (`__index`, `<T>`) never render as
 * emphasis or raw HTML tags; `markdown-it-anchor` strips backticks when
 * computing the heading slug.
 */
function memberBlock(
	decl: Decl,
	fence: string,
	options: RenderOptions,
	extra: string[] = [],
): string {
	const badges = [
		"exported" in decl ? badge("info", KIND_LABEL[decl.kind]) : "",
		badgeMarkup(decl.tags, decl.visibility),
		"readonly" in decl && decl.readonly ? badge("info", READ_ONLY_LABEL) : "",
		reexportBadge(decl.reexport, options),
	]
		.filter(Boolean)
		.join(" ");
	return [
		heading(3, `\`${decl.name}\``, badges, sourceLink(decl.source, options)),
		deprecationNotice(decl.tags, options),
		fence,
		decl.doc ? linkifyProse(decl.doc, options) : "",
		...extra,
	]
		.filter(Boolean)
		.join("\n\n");
}

/** Formats a labeled subsection under a member, or `""` when `rows` is empty. */
function section(label: string, rows: string[], header: string[] = []): string {
	return rows.length > 0 ? [`**${label}**`, "", ...header, ...rows].join("\n") : "";
}

function renderFn(fn: PageFn, options: RenderOptions): string {
	return memberBlock(fn, fnFence(fn, options), options, [
		section(
			"Parameters",
			fn.signature.params
				.filter((param) => param.doc)
				.map((param) => `- \`${param.name}\`: ${itemText(param.doc!, options)}`),
		),
		section(
			"Returns",
			fn.signature.returns
				.filter((ret) => ret.doc)
				.map((ret) => {
					const type = ret.type ? `${linkifyInline(ret.type, options)}: ` : "";
					return `- ${type}${itemText(ret.doc!, options)}`;
				}),
		),
		section(
			"Errors",
			fn.errors.map(
				(err) =>
					`| \`${cellText(err.type)}\` | ` +
					`${cellText(err.doc && linkifyProse(err.doc, options).trim())} |`,
			),
			["| Type | Description |", "| :-- | :-- |"],
		),
	]);
}

function renderProp(prop: PageProp, containerName: string, options: RenderOptions): string {
	return memberBlock(prop, propFence(prop, containerName, options), options);
}

function renderType(ty: PageType, options: RenderOptions): string {
	const { fence, leftovers } = typeFence(ty, options);
	return memberBlock(ty, fence, options, [
		section(
			"Fields",
			leftovers.map((field) => `- \`${field.name}\`: ${itemText(field.doc!, options)}`),
		),
	]);
}

/**
 * Renders the **Constructors:** link row for a class section. Constructors
 * often live on another module's page (e.g., a top-level factory), so the
 * symbol table provides both the link and the qualified display name.
 * Unresolvable constructor IDs are omitted.
 */
function constructorLinks(section: PageSection, options: RenderOptions): string {
	const links = section.constructors
		.map((id) => {
			const url = options.symbols.linkForId(id);
			const label = options.symbols.nameForId(id);
			return url && label ? `[\`${label}\`](${linkDestination(url)})` : undefined;
		})
		.filter(Boolean);
	return links.length > 0 ? `**Constructors:** ${links.join(" · ")}` : "";
}

function renderPage(page: PageModel, options: RenderOptions): string {
	const parts: string[] = [
		generatedFrontmatter(displayTitle(page), ["outline: [2, 3]"]),
		// Informational only; nothing parses this comment.
		`<!-- generated by luaudocs from ${page.moduleId} -->`,
	];

	// Wrap every heading block and every member in `#region` / `#endregion`
	// markers named after the slug that heading mints.
	let openBlock: string | undefined;
	const closeBlock = () => {
		const marker = region(openBlock, true);
		openBlock = undefined;
		return marker;
	};
	// Outermost region wrapping the title, module description, and all member
	// blocks so a single `<!--@include-->` can embed the entire page.
	const pageRegion = page.anchors[PAGE_ANCHOR];
	parts.push(region(pageRegion));

	for (const step of pageSteps(page)) {
		// A heading block runs until the next section/kind heading or the end of the page.
		if (step.kind === "heading" || step.kind === "sectionHeading" || step.kind === "title") {
			parts.push(closeBlock());
		}
		if (step.kind === "heading") {
			openBlock = page.anchors[step.id];
			parts.push(region(openBlock));
		}
		const decl = declOf(step);
		const member = decl && page.anchors[decl.id];
		parts.push(region(member));
		switch (step.kind) {
			case "title":
				parts.push(
					// Backslash-escaped rather than wrapped in a code span so page
					// titles keep prose typography without rendering `_Inner_` as emphasis.
					heading(
						1,
						escapeMarkdown(page.title),
						badgeMarkup(page.tags, undefined),
						sourceLink(page.source, options),
					),
					deprecationNotice(page.tags, options),
				);
				break;
			case "sectionHeading":
				parts.push(
					heading(
						2,
						escapeMarkdown(step.section.name),
						badgeMarkup(step.section.tags, undefined),
						sourceLink(step.section.source, options),
					),
					deprecationNotice(step.section.tags, options),
				);
				break;
			case "heading":
				parts.push(heading(step.level, step.text, "", ""));
				break;
			case "prose":
				parts.push(linkifyProse(step.doc, options));
				break;
			case "constructors":
				parts.push(constructorLinks(step.section, options));
				break;
			case "type":
				parts.push(renderType(step.ty, options));
				break;
			case "prop":
				parts.push(renderProp(step.prop, step.container, options));
				break;
			case "fn":
				parts.push(renderFn(step.fn, options));
				break;
		}
		parts.push(region(member, true));
	}
	parts.push(closeBlock(), region(pageRegion, true));

	return parts.filter((part) => part !== "").join("\n\n") + "\n";
}

/*
 * ------------------------------------------------------------------ emit seam
 */

export interface EmitResult {
	/** `"Slug.md"` -> page markdown; the API index page is in `apiIndex` instead. */
	pages: Map<string, string>;
	/**
	 * `"Slug.md"` (plus `"index.md"`) -> breadcrumb trail segments within the
	 * API tree. `src/site.ts` prepends `Home` and bakes these for the runtime rule.
	 */
	trails: Map<string, TrailSegment[]>;
	/** `api/index.md` markdown; absent when the model produced no pages. */
	apiIndex?: string;
	/** The generated API sidebar tree. */
	sidebar: SidebarItem[];
	/** Organized page models with predicted anchors (used by `llms.ts` and `test/anchors.test.ts`). */
	pageModels: PageModel[];
	warnings: string[];
}

/** Renders the doc model into markdown pages, trails, and sidebar entries. */
export function emitDocs(
	model: DocModel,
	config: LuauDocsConfig,
	dependencies?: DependencyLinks,
): EmitResult {
	const { pages, warnings, resolveAlias } = buildPages(model, config);
	// Mint anchors before constructing SymbolTable, which reads `page.anchors` directly.
	for (const page of pages) {
		page.anchors = mintAnchors(page);
	}
	const symbols = new SymbolTable(model, pages, warnings, resolveAlias);
	const options: RenderOptions = { symbols, config, externals: model.externals, dependencies };

	// Build one access tree shared by page trails, the API index, and the sidebar.
	const tree = buildAccessTree(pages);
	const trails = apiTrails(tree);

	const rendered = new Map<string, string>();
	for (const page of pages) {
		rendered.set(apiPageFile(page.slug), renderPage(page, options));
	}

	return {
		pages: rendered,
		trails,
		// Omit the API index when the project produced no module pages.
		apiIndex:
			pages.length > 0
				? renderApiIndex(tree, (markdown) => linkifyProse(markdown, options))
				: undefined,
		sidebar: apiSidebar(tree),
		pageModels: pages,
		warnings,
	};
}

/** Parses extractor JSON and emits docs (the entry point used by renderer tests). */
export function emitDocsFromJson(
	jsonText: string,
	config: LuauDocsConfig,
	dependencies?: DependencyLinks,
): EmitResult {
	return emitDocs(parseDocModel(jsonText), config, dependencies);
}

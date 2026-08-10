/**
 * Markdown emission, deliberately one file because its pieces must not drift:
 * `pageSteps` yields a page's render order, `mintAnchors` walks the same steps
 * to predict the heading id VitePress will mint for each, and the SymbolTable
 * turns those predictions into links. A drift between the walks fails
 * *silently*: VitePress strips the fragment before its dead-link check, so a
 * wrong anchor ships as a link that scrolls nowhere. test/anchors.test.ts
 * asserts both directions against the real VitePress renderer.
 *
 * Linking policy: never emit a link we cannot resolve. Signature links are
 * recorded as offset spans while the display's segments are joined, so the join
 * IS the offset computation.
 */
import type { Badges, DocModel, Generic, Inline, Seg, SourceSpan, TypeField } from "./docmodel";
import { parseDocModel } from "./docmodel";
import { repoFileUrl, type LuauDocsConfig } from "./config";
import {
	escapeHtml,
	headingSlug,
	mapOutsideCodeSpans,
	mapOutsideFences,
	outsideFences,
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

// Every Roblox class, enum, and datatype -> creator docs, linked when
// linkRobloxTypes is on. Generated from the API dump at install/CI time and
// baked into the bundle, so a build never fetches it.
const ROBLOX_DATATYPES = new Set<string>(robloxNames.datatypes);
const ROBLOX_CLASSES = new Set<string>(robloxNames.classes);
const ROBLOX_ENUMS = new Set<string>(robloxNames.enums);

interface RenderOptions {
	symbols: SymbolTable;
	/** the validated luaudocs.toml, read straight off, so defaults live in
	 * config.ts alone and are never respelled here */
	config: LuauDocsConfig;
	/** `@external` name -> URL overrides; consulted before the Roblox lists. */
	externals?: Record<string, string>;
}

function robloxUrl(name: string): string | undefined {
	if (ROBLOX_DATATYPES.has(name)) {
		return `https://create.roblox.com/docs/reference/engine/datatypes/${name}`;
	}
	if (ROBLOX_CLASSES.has(name)) {
		return `https://create.roblox.com/docs/reference/engine/classes/${name}`;
	}
	if (ROBLOX_ENUMS.has(name)) {
		return `https://create.roblox.com/docs/reference/engine/enums/${name}`;
	}
	return undefined;
}

/**
 * Where a project-unresolvable name links: the author's `@external` map wins
 * over the engine guess.
 */
function externalUrl(name: string, options: RenderOptions): string | undefined {
	const external = options.externals?.[name];
	if (external !== undefined) {
		return external;
	}
	if (options.config.api.linkRobloxTypes && !LUAU_BUILTINS.has(name) && !name.includes(".")) {
		return robloxUrl(name);
	}
	return undefined;
}

/** Where a ref segment links: a project id first, else the by-text fallbacks. */
function segHref(seg: { text: string; id?: string }, options: RenderOptions): string | undefined {
	return seg.id ? options.symbols.linkForId(seg.id) : externalUrl(seg.text, options);
}

function inlineText(segs: Inline): string {
	return segs.map((seg) => (typeof seg === "string" ? seg : seg.text)).join("");
}

/**
 * A pure re-spelling (`export type Log = Util.Log`): the entire definition is
 * one ref segment. Returns the origin declaration's id.
 */
function pureAliasRef(ty: PageType): string | undefined {
	const line = ty.definition?.length === 1 ? ty.definition[0] : undefined;
	const seg = line?.length === 1 ? line[0] : undefined;
	return typeof seg === "object" ? seg.id : undefined;
}

/*
 * ---------------------------------------------------------------- prose links
 */

/**
 * Resolves moonwave bracket references in prose markdown ([Class],
 * [Class.member], [CFrame]-style Roblox and @external names). Skips fenced and
 * indented code blocks, inline code spans, and existing markdown links.
 */
function linkifyProse(markdown: string, options: RenderOptions): string {
	const rewriteLine = (line: string): string =>
		mapOutsideCodeSpans(line, (part) =>
			part.replace(
				// `](`/`][` are markdown links, `]:` a link-reference
				// definition, and a leading `]` means THIS bracket is the
				// label half of a `[text][Ref]` reference link. Any number of
				// dotted segments, since a nested class's member is spelled
				// in full (`Color.Linear.fromGamma`).
				/(?<!\])\[([A-Za-z_]\w*(?:[.:][A-Za-z_]\w*)*)\](?![([:])/g,
				(match, name: string) => {
					// project symbols first; a bare identifier falls back to
					// @external/Roblox, but never a Class.member form,
					// which would fabricate an anchor
					const url =
						options.symbols.linkForName(name) ??
						(/^[A-Za-z_]\w*$/.test(name) ? externalUrl(name, options) : undefined);
					return url ? `[\`${name}\`](${url})` : match;
				},
			),
		);

	// indented code is left verbatim like fenced code: a 4-space/tab-indented
	// line after a blank boundary opens a code block (CommonMark: indented code
	// cannot interrupt a paragraph). The state spans fence boundaries, since a
	// fence line is a non-blank line that ends any indented run.
	let firstSegment = true;
	let prevBlank = true; // text start counts as a blank boundary
	let inIndentedCode = false;
	return mapOutsideFences(markdown, (segment) => {
		if (!firstSegment) {
			prevBlank = false;
			inIndentedCode = false;
		}
		firstSegment = false;
		return segment
			.split("\n")
			.map((line) => {
				const blank = /^[ \t]*$/.test(line);
				const wasBlank = prevBlank;
				prevBlank = blank;
				const indent = line.match(/^[ \t]*/)![0];
				const codeIndent = !blank && (indent.length >= 4 || indent.includes("\t"));
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
	});
}

/**
 * Runs of unlinked segments merge into one code span, so a display whose refs
 * resolve nowhere reads as the single span it always was.
 */
function linkifyInline(type: Inline, options: RenderOptions): string {
	const parts: string[] = [];
	let plain = "";
	const flush = () => {
		if (plain !== "") {
			parts.push(`\`${plain}\``);
			plain = "";
		}
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
		parts.push(`[\`${seg.text}\`](${href})`);
	}
	flush();
	return parts.join("");
}

/*
 * --------------------------------------------------------------------- badges
 */

/**
 * One `<Badge>`, its text escaped here so no call site can forget to. `cls`
 * rides through as a fallthrough attribute onto the rendered span, which is
 * how a badge takes a color VitePress's four types do not have; `type` stays
 * the fallback for anything that does not load luaudocs.css.
 */
function badge(type: "info" | "tip" | "warning" | "danger", text: string, cls?: string): string {
	const attr = cls ? ` class="${cls}"` : "";
	return `<Badge type="${type}" text="${escapeHtml(text)}"${attr} />`;
}

function badgeMarkup(tags: Badges | undefined, visibility?: "public" | "private"): string {
	const parts: string[] = [];
	if (tags?.deprecated) {
		parts.push(
			badge(
				"danger",
				`Deprecated${tags.deprecated.version ? ` since ${tags.deprecated.version}` : ""}`,
			),
		);
	}
	if (visibility === "private") {
		parts.push(badge("danger", "Private"));
	}
	if (tags?.unreleased) {
		parts.push(badge("warning", "Unreleased"));
	}
	if (tags?.yields) {
		parts.push(badge("warning", "Yields"));
	}
	for (const realm of tags?.realm ?? []) {
		parts.push(
			badge("info", `${realm[0]!.toUpperCase()}${realm.slice(1)}`, `luaudocs-${realm}`),
		);
	}
	if (tags?.since) {
		parts.push(badge("tip", `since ${tags.since}`));
	}
	for (const custom of tags?.custom ?? []) {
		parts.push(badge("info", custom));
	}
	return parts.join(" ");
}

/** The note is prose like any other doc text, so `[M.newThing]` refs resolve. */
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

/** `> `/`>> ` container markers: a heading inside a quote is still a heading. */
const BLOCKQUOTE_MARKERS = /^ {0,3}(?:> ?)+/;
const ATX_HEADING = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
/** A setext underline: `=` or `-` runs alone on the line. */
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
/**
 * A line a setext underline can turn into a heading. Excludes the leaf blocks
 * that instead *close* before the underline (a list item, a table row, an HTML
 * block), so `- item` over `---` reads as the thematic break it is rather than
 * a heading that never mints.
 */
const SETEXT_CANDIDATE = /^ {0,3}(?![*+-]\s|\d{1,9}[.)]\s|\||<)\S/;

/**
 * Every heading's text inside prose markdown, fenced code excluded. These mint
 * anchor ids and so consume slugs the members around them would otherwise get.
 *
 * Three spellings count, because markdown-it-anchor keys off the `heading_open`
 * token and cannot tell how the heading was written: ATX (`## Name`), ATX in a
 * blockquote (`> ## Name`), and setext (`Name` underlined with `===` or `---`),
 * the one that has to look at the preceding line.
 */
function proseHeadingTexts(markdown: string | undefined): string[] {
	if (!markdown) {
		return [];
	}
	const texts: string[] = [];
	const push = (raw: string) => texts.push(stripLinks(raw));
	for (const part of outsideFences(markdown)) {
		// the whole paragraph a setext underline would apply to, not just its
		// last line: markdown-it's heading text keeps softbreak tokens
		// (content ""), so a hard-wrapped setext heading slugs from every line
		// concatenated with no separator
		let paragraph: string | undefined;
		// a `#` line inside `<!-- -->` or an open tag's block is html_block
		// content to markdown-it, which mints no slug for it. Comments run to
		// their `-->` line, tag blocks to the next blank line.
		let inHtmlComment = false;
		let inHtmlBlock = false;
		for (const rawLine of part.split("\n")) {
			const line = rawLine.replace(BLOCKQUOTE_MARKERS, "");
			if (inHtmlComment || inHtmlBlock) {
				inHtmlComment = inHtmlComment && !line.includes("-->");
				inHtmlBlock = inHtmlBlock && !/^[ \t]*$/.test(line);
				paragraph = undefined;
				continue;
			}
			const html = /^ {0,3}<(!--|\/?[A-Za-z])/.exec(line);
			if (html) {
				if (html[1] === "!--") {
					inHtmlComment = !line.slice(line.indexOf("<!--") + 4).includes("-->");
				} else {
					inHtmlBlock = true;
				}
				paragraph = undefined;
				continue;
			}
			const atx = ATX_HEADING.exec(line);
			if (atx) {
				push(atx[1]!);
				paragraph = undefined;
				continue;
			}
			if (paragraph !== undefined && SETEXT_UNDERLINE.test(line)) {
				push(paragraph);
				paragraph = undefined;
				continue;
			}
			paragraph = SETEXT_CANDIDATE.test(line) ? (paragraph ?? "") + line.trim() : undefined;
		}
	}
	return texts;
}

/**
 * One step of a page's render. The single walk both sides consume: renderPage
 * turns each step into markdown, mintAnchors turns each into a slug. Two
 * properties of the order, both easy to undo:
 *
 *   - Types come before the primary section's members. On a page with both
 *     `Action` (a type) and `action()` (a function) the type takes `#action`
 *     and the function `#action-1`.
 *   - Only headings that actually render are steps, so nothing that never
 *     reaches the page consumes a slug.
 */
type PageStep =
	/** H1: the page title, with the module's badges and source link */
	| { kind: "title" }
	/** H2: a named (nested) section, with its badges and source link */
	| { kind: "sectionHeading"; section: PageSection }
	/**
	 * A plain text heading: `Types`, a member-list heading. `id` keys the slug
	 * it mints in `anchors`, which is what names the region the emitter wraps
	 * the block in, so an embed can slice it heading and all.
	 */
	| { kind: "heading"; level: 2 | 3; text: string; id: string }
	/** prose whose own ATX headings mint ids of their own */
	| { kind: "prose"; doc: string }
	| { kind: "constructors"; section: PageSection }
	| { kind: "type"; ty: PageType }
	| { kind: "prop"; prop: PageProp; container: string }
	| { kind: "fn"; fn: PageFn };

/** A section's heading, prose and constructor links, in render order. */
function* introSteps(page: PageModel, section: PageSection): Generator<PageStep> {
	if (section.name !== "") {
		yield { kind: "sectionHeading", section };
		if (section.doc) {
			yield { kind: "prose", doc: section.doc };
		}
	} else if (section.doc && section.doc !== page.doc) {
		// the primary section's prose renders only when it differs from the
		// module doc (the factory pattern: two separate blocks)
		yield { kind: "prose", doc: section.doc };
	}
	if (section.constructors.length > 0) {
		yield { kind: "constructors", section };
	}
}

const MEMBER_HEADINGS = [
	{ text: "Properties", kind: "prop" },
	{ text: "Functions", kind: "function" },
	{ text: "Methods", kind: "method" },
	{ text: "Metamethods", kind: "metamethod" },
] as const;

/**
 * A section's members grouped under the kind headings, occupied ones only.
 * A nested section skips the labels: they would render level with the member
 * headings they group (both ###), so its members are direct children of the
 * section heading, still in kind order.
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
			// a callable module with no block of its own promotes its member's
			// comment to the module blurb (the page intro and index summary);
			// the member repeating it byte-for-byte says nothing new. Only the
			// bare callee can be that promoted member. Stripped here so
			// rendering and anchor minting see the same doc.
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

/** The whole page, in render order. */
function* pageSteps(page: PageModel): Generator<PageStep> {
	yield { kind: "title" };
	if (page.doc) {
		yield { kind: "prose", doc: page.doc };
	}
	const [primary, ...nested] = page.sections;
	if (primary) {
		yield* introSteps(page, primary);
	}
	// types lead: they define the vocabulary the signatures below them use
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
 * heading-step ids: it names the region wrapping the whole page, so an embed
 * can pull in a module's title, description and members as one block.
 */
const PAGE_ANCHOR = ":page";

/**
 * The anchor VitePress will mint for every member, type and named section:
 * walk `pageSteps`, applying markdown-it-anchor's rule (slugify, then `-1`,
 * `-2`, ... on a repeat).
 */
function mintAnchors(page: PageModel): Record<string, string> {
	const anchors: Record<string, string> = {};
	const used = new Set<string>();

	const mint = (text: string, id?: string) => {
		const base = headingSlug(text);
		let slug = base;
		for (let n = 1; used.has(slug); n += 1) {
			slug = `${base}-${n}`;
		}
		used.add(slug);
		if (id !== undefined) {
			anchors[id] = slug;
		}
	};
	// a deprecation notice renders as block markdown right after its owner's
	// heading, so headings inside it mint ids ahead of the owner's prose
	const deprecation = (tags: Badges | undefined) => {
		for (const text of proseHeadingTexts(tags?.deprecated?.note)) {
			mint(text);
		}
	};
	/** a member's own heading, then any headings its notice and prose contain */
	const member = (name: string, id: string, doc: string | undefined, tags?: Badges) => {
		// the bare name, which is what the heading's code span slugifies to: a
		// nested section's heading is "### `fromGamma`", so a name in two
		// sections collides and the second takes the `-1` suffix
		mint(name, id);
		deprecation(tags);
		for (const text of proseHeadingTexts(doc)) {
			mint(text);
		}
	};

	for (const step of pageSteps(page)) {
		switch (step.kind) {
			case "title":
				mint(page.title, PAGE_ANCHOR);
				deprecation(page.tags);
				break;
			case "sectionHeading":
				mint(step.section.name, step.section.id);
				deprecation(step.section.tags);
				break;
			case "heading":
				mint(step.text, step.id);
				break;
			case "prose":
				for (const text of proseHeadingTexts(step.doc)) {
					mint(text);
				}
				break;
			case "type":
				member(step.ty.name, step.ty.id, step.ty.doc, step.ty.tags);
				break;
			case "prop":
				member(step.prop.name, step.prop.id, step.prop.doc, step.prop.tags);
				break;
			case "fn":
				member(step.fn.name, step.fn.id, step.fn.doc, step.fn.tags);
				break;
			case "constructors":
				break; // a bold line of links, no heading
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
	 * How a member is spelled for a reader (`Flux.compute`), qualified by the
	 * container it renders under. Members only: nothing labels a type or a class.
	 */
	name?: string;
}

/**
 * Doc-model ids and human reference spellings -> page + anchor. Anchors are
 * read out of `PageModel.anchors`, never rebuilt from a name: only
 * `mintAnchors` knows which spelling won a collision.
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
		for (const page of pages) {
			moduleSlug.set(page.moduleId, page.slug);
		}

		// alias modules resolve to their target's page, through the resolver
		// buildPages already built rather than a second chain walk
		for (const module of model.modules) {
			if (module.aliasOf !== undefined) {
				const target = moduleSlug.get(resolveAlias(module.id));
				if (target) {
					moduleSlug.set(module.id, target);
				}
			}
		}

		// Names register in tiers, and ambiguity (with its warning) exists only
		// within one tier. The value surface (pages, sections, members) owns a
		// spelling outright; exported types take what is left, since a module
		// and its same-named type read as one entity to a reader; and a pure
		// re-spelling alias
		// (`export type Log = Util.Log`) answers only to its qualified name,
		// pointing the bare one at the origin declaration it re-spells.
		for (const page of pages) {
			this.registerName(page.title, { page: page.slug }, warnings);
			for (const section of page.sections) {
				const containerName = section.container;
				if (section.name !== "" && section.id !== undefined) {
					this.registerName(
						section.name,
						{ page: page.slug, anchor: page.anchors[section.id] },
						warnings,
					);
				}
				for (const member of section.members) {
					const target = {
						page: page.slug,
						anchor: page.anchors[member.id],
						name: `${containerName}.${member.name}`,
					};
					this.byId.set(member.id, target);
					this.registerName(target.name, target, warnings);
					// methods also answer to the colon spelling, a distinct name,
					// so it collides with nothing registered above
					if (member.kind === "method") {
						this.registerName(`${containerName}:${member.name}`, target, warnings);
					}
				}
			}
		}

		const valueNames = new Set(this.byName.keys());
		const aliases: Array<{ name: string; target: SymbolTarget; refId: string }> = [];
		for (const page of pages) {
			for (const ty of page.types) {
				const target = { page: page.slug, anchor: page.anchors[ty.id] };
				this.byId.set(ty.id, target);
				const qualified = `${page.title}.${ty.name}`;
				if (!valueNames.has(qualified)) {
					this.registerName(qualified, target, warnings);
				}
				// only exported types answer to the bare name: an unexported
				// one is unnameable from outside its module, so registering it
				// would only make a resolving name ambiguous
				if (!ty.exported || valueNames.has(ty.name)) {
					continue;
				}
				const refId = pureAliasRef(ty);
				if (refId === undefined) {
					this.registerName(ty.name, target, warnings);
				} else {
					aliases.push({ name: ty.name, target, refId });
				}
			}
		}

		const typeNames = new Set(this.byName.keys());
		for (const alias of aliases) {
			if (!typeNames.has(alias.name)) {
				// the origin may render no anchor of its own (an unexported or
				// suppressed declaration); the alias's anchor is the fallback
				this.registerName(alias.name, this.byId.get(alias.refId) ?? alias.target, warnings);
			}
		}

		// class entries resolve to their section heading (primary class -> page);
		// ids of members on skipped pages resolve nowhere, which is fine
		const pageByModule = new Map(pages.map((page) => [page.moduleId, page]));
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
			// one spelling, two equal-standing targets (two modules both named
			// Defaults, or Config.get on two pages): linking either would be a
			// coin flip, so link neither, naming both so a reader can qualify
			this.ambiguous.add(name);
			this.byName.delete(name);
			warnings.push(
				`ambiguous reference name dropped from link table: ${name} (${this.url(existing)} vs ${this.url(target)})`,
			);
		}
	}

	/** Member/type ids first; module ids resolve to their page (follows aliases). */
	linkForId(id: string): string | undefined {
		const target = this.byId.get(id);
		if (target) {
			return this.url(target);
		}
		const slug = this.moduleSlug.get(id);
		return slug ? apiHref(slug) : undefined;
	}

	/** A member id's reader-facing spelling; see SymbolTarget.name. */
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
 * --------------------------------------------------------------------- fences
 */

/**
 * Appending a ref segment records its link span at the current length, so
 * joining the display and computing the offsets are one act.
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
			this.spans.push([this.body.length, this.body.length + seg.text.length, href]);
		}
		return this.text(seg.text);
	}

	segs(segs: Inline): this {
		for (const seg of segs) {
			this.seg(seg);
		}
		return this;
	}

	/**
	 * The info string carries the link table (JSON with no whitespace, so the
	 * runtime transformer can end it at the next space) only when something
	 * resolved; a linkless signature is a plain `luau` fence.
	 */
	render(): string {
		const info =
			this.spans.length > 0 ? `luau ${LINKS_TOKEN}${JSON.stringify(this.spans)}` : "luau";
		return ["```" + info, this.body, "```"].join("\n");
	}
}

/** Flattens a field doc into a single comment line, markdown syntax stripped. */
function commentText(doc: string): string {
	return stripLinks(unwrap(doc))
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.trim();
}

/**
 * Splices each documented field's doc as a `-- comment` line above the field.
 * Placement is pure lookup: `field.line` is the extractor's 1-based index into
 * these same lines. Fields with no line (or whose line another field claimed)
 * come back as leftovers, to render as prose rather than a guessed placement.
 */
function spliceFieldDocs(
	definition: Inline[],
	fields: TypeField[],
): { lines: Inline[]; leftovers: TypeField[] } {
	const comments = new Map<number, string>();
	const claimed = new Set<number>();
	const leftovers: TypeField[] = [];
	for (const field of fields) {
		// line 1 shares its rendered line with the `type X = ` head, so it can
		// take no comment above it
		const index = field.line !== undefined && field.line > 1 ? field.line - 1 : -1;
		// every field claims its line, undocumented ones included: the comment
		// sits *above* the line, so claiming only for documented fields would
		// let `b` in `a: string, b: number,` hang its doc off `a`
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
	// the callee joins in as plain text, so a member's own name is
	// structurally unlinkable
	return new Fence(options).text(fn.signature.callee).segs(fn.signature.segs).render();
}

/**
 * Lua's reserved words (`continue` is contextual, so not here). Mirrors
 * LUAU_KEYWORDS in extractor/model/members.luau, which spells callees the
 * same way.
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

/** How source reaches a member: dot for an identifier name, brackets otherwise. */
function memberAccess(container: string, name: string): string {
	if (/^[A-Za-z_]\w*$/.test(name) && !LUAU_KEYWORDS.has(name)) {
		return `${container}.${name}`;
	}
	return `${container}[${JSON.stringify(name)}]`;
}

/** `Container.name: <type>`, the callee prefix included in the join walk. */
function propFence(prop: PageProp, containerName: string, options: RenderOptions): string {
	const fence = new Fence(options).text(memberAccess(containerName, prop.name));
	if (prop.type) {
		fence.text(": ").segs(prop.type);
	}
	return fence.render();
}

/** `<T, U... = D>` as plain text, for the head positions that record no links. */
function genericsText(generics: Generic[]): string {
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

/** `type Name<generics> = <definition>`, links recorded as the parts join. */
function typeFence(
	ty: PageType,
	options: RenderOptions,
): { fence: string; leftovers: TypeField[] } {
	// a type function is called like a function, so its fence carries the
	// parameter list; the body stays behind the source link
	if (ty.kind === "typefunction") {
		const fence = new Fence(options).text(
			`type function ${ty.name}${genericsText(ty.generics)}`,
		);
		if (ty.params) {
			fence.segs(ty.params);
		}
		return { fence: fence.render(), leftovers: [] };
	}

	const fence = new Fence(options).text(`type ${ty.name}`);
	if (ty.generics.length > 0) {
		fence.text("<");
		for (const [index, generic] of ty.generics.entries()) {
			if (index > 0) {
				fence.text(", ");
			}
			fence.text(`${generic.name}${generic.isPack ? "..." : ""}`);
			if (generic.default) {
				// a generic default is a type position, so its refs link
				fence.text(" = ").segs(generic.default);
			}
		}
		fence.text(">");
	}

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
	// a tag-declared type with no type expression: its fields *are* the
	// declaration, so the table is rebuilt from them, docs as comments
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
	return sourceLinkAnchor(`${repoFileUrl(repo, toPosix(span.file))}${lines}`);
}

/** A `|` would end the cell, and a newline the row: escape one, `<br />` the other. */
function cellText(text: string | undefined): string {
	return text ? text.replace(/\|/g, "\\|").replace(/\n+/g, "<br />") : "";
}

/** Flattens a doc string into a single list-item line, resolving prose refs. */
function itemText(doc: string, options: RenderOptions): string {
	return unwrap(linkifyProse(doc, options).trim());
}

/**
 * Every heading the emitter writes, H1 title to member.
 *
 * No explicit `{#id}`: VitePress mints the id from the heading's token text and
 * `mintAnchors` predicts exactly that, so everything appended here must
 * contribute no text. A self-closing <Badge text="..."> and the empty
 * source-link anchor render as markup only, so "### `Connect` <Badge .../>"
 * still mints `connect`; a badge in SLOT form would fold its content into the
 * slug.
 */
function heading(level: number, name: string, badges: string, source: string): string {
	return `${"#".repeat(level)} ${name}${badges ? ` ${badges}` : ""}${source ? ` ${source}` : ""}`;
}

/**
 * "Module" for whole-module mounts, "from X" for members defined in module X.
 *
 * The link WRAPS the badge rather than sitting in its slot: slot content is
 * heading text, so `<Badge>[from Foo](...)</Badge>` mints `connect-from-foo`
 * instead of `connect`. `ignore-header` is then load-bearing, not decorative:
 * VitePress's outline skips a heading's direct children carrying it, and
 * wrapping moves the link into that position.
 */
function reexportBadge(re: ReexportInfo | undefined, options: RenderOptions): string {
	if (!re) {
		return "";
	}
	const text = re.module ? "Module" : re.from ? `from ${re.from}` : "Re-export";
	const url = re.targetId ? options.symbols.linkForId(re.targetId) : undefined;
	if (url) {
		return `<a href="${url}" class="badge-link ignore-header">${badge("info", text)}</a>`;
	}
	// a Module badge promises a page; with none to link (an opaque module,
	// say one returning a built Instance) the entry reads as a plain property.
	// Provenance badges still say something unlinked, so they stay.
	return re.module ? "" : badge("info", text);
}

/**
 * A member heading's name, as a code span: these are identifiers, and one that
 * spells markdown (`__index`, a generic's `<T>`) would otherwise render as
 * emphasis or be eaten as a tag. The span costs no anchor drift: slugify strips
 * backticks, and markdown-it-anchor reads a code span's content, so `` `state` ``
 * and `state` both mint `state` (which is what `mintAnchors` mints from).
 */
function memberName(name: string): string {
	return `\`${name}\``;
}

/** Every member renders the same way: heading, deprecation, signature, prose. */
interface MemberBlock {
	name: string;
	badges: string[];
	tags: Badges | undefined;
	source: SourceSpan | undefined;
	fence: string;
	doc: string | undefined;
}

function memberBlock(member: MemberBlock, options: RenderOptions, extra: string[] = []): string {
	return [
		heading(
			3,
			memberName(member.name),
			member.badges.filter(Boolean).join(" "),
			sourceLink(member.source, options),
		),
		deprecationNotice(member.tags, options),
		member.fence,
		member.doc ? linkifyProse(member.doc, options) : "",
		...extra,
	]
		.filter(Boolean)
		.join("\n\n");
}

/** A labelled block under a member, or "" for one with no rows (memberBlock
 * filters the empties out). */
function section(label: string, rows: string[], header: string[] = []): string {
	return rows.length > 0 ? [`**${label}**`, "", ...header, ...rows].join("\n") : "";
}

function renderFn(fn: PageFn, options: RenderOptions): string {
	const extra = [
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
			fn.errors.map((err) => `| \`${cellText(err.type)}\` | ${cellText(err.doc)} |`),
			["| Type | Description |", "| :-- | :-- |"],
		),
	];

	return memberBlock(
		{
			name: fn.name,
			badges: [badgeMarkup(fn.tags, fn.visibility), reexportBadge(fn.reexport, options)],
			tags: fn.tags,
			source: fn.source,
			fence: fnFence(fn, options),
			doc: fn.doc,
		},
		options,
		extra,
	);
}

function renderProp(prop: PageProp, containerName: string, options: RenderOptions): string {
	return memberBlock(
		{
			name: prop.name,
			badges: [
				badgeMarkup(prop.tags, prop.visibility),
				prop.readonly ? badge("info", "Read Only") : "",
				reexportBadge(prop.reexport, options),
			],
			tags: prop.tags,
			source: prop.source,
			fence: propFence(prop, containerName, options),
			doc: prop.doc,
		},
		options,
	);
}

const KIND_LABEL = {
	alias: "type",
	interface: "interface",
	typefunction: "type function",
} as const;

function renderType(ty: PageType, options: RenderOptions): string {
	const { fence, leftovers } = typeFence(ty, options);
	const extra = [
		section(
			"Fields",
			leftovers.map((field) => `- \`${field.name}\`: ${itemText(field.doc!, options)}`),
		),
	];
	return memberBlock(
		{
			name: ty.name,
			badges: [
				badge("info", KIND_LABEL[ty.kind]),
				badgeMarkup(ty.tags, ty.visibility),
				reexportBadge(ty.reexport, options),
			],
			tags: ty.tags,
			source: ty.source,
			fence,
			doc: ty.doc,
		},
		options,
		extra,
	);
}

/**
 * Constructors commonly live on another module's page (a factory), so the
 * symbol table answers both where each one landed and what to call it. One that
 * resolves nowhere is dropped rather than rendered as bare text.
 */
function constructorLinks(section: PageSection, options: RenderOptions): string {
	const links = section.constructors
		.map((id) => {
			const url = options.symbols.linkForId(id);
			const label = options.symbols.nameForId(id);
			return url && label ? `[\`${label}\`](${url})` : undefined;
		})
		.filter(Boolean);
	return links.length > 0 ? `**Constructors:** ${links.join(" · ")}` : "";
}

function renderPage(page: PageModel, options: RenderOptions): string {
	const parts: string[] = [
		generatedFrontmatter(displayTitle(page), ["outline: [2, 3]"]),
		// informational only; nothing parses this comment
		`<!-- generated by luaudocs from ${page.moduleId} -->`,
	];

	// region markers around every heading block and every member, named by the
	// slug that block's heading mints
	let openBlock: string | undefined;
	const closeBlock = () => {
		const marker = region(openBlock, true);
		openBlock = undefined;
		return marker;
	};
	// the outermost region: the title, the module's description and every block
	// below them, so one embed carries the page as it renders
	const pageRegion = page.anchors[PAGE_ANCHOR];
	parts.push(region(pageRegion));

	for (const step of pageSteps(page)) {
		// a heading block runs to the next heading of any kind, or the page end
		if (step.kind === "heading" || step.kind === "sectionHeading" || step.kind === "title") {
			parts.push(closeBlock());
		}
		if (step.kind === "heading") {
			openBlock = page.anchors[step.id];
			parts.push(region(openBlock));
		}
		const member =
			step.kind === "type"
				? page.anchors[step.ty.id]
				: step.kind === "prop"
					? page.anchors[step.prop.id]
					: step.kind === "fn"
						? page.anchors[step.fn.id]
						: undefined;
		parts.push(region(member));
		switch (step.kind) {
			case "title":
				parts.push(
					heading(
						1,
						page.title,
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
						step.section.name,
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
	/** "Slug.md" -> page markdown; the API index page is `apiIndex`, not in here */
	pages: Map<string, string>;
	/**
	 * The same keys, plus the index page's -> what sits above that page inside
	 * the API, the index first. The site prepends its own root and bakes these
	 * for the trail the page heads with.
	 */
	trails: Map<string, TrailSegment[]>;
	/** api/index.md markdown; absent when the model produced no pages */
	apiIndex?: string;
	/** the one generated sidebar shape */
	sidebar: SidebarItem[];
	/** the organized models, anchor predictions included (llms and the anchors test read these) */
	pageModels: PageModel[];
	warnings: string[];
}

/** Doc-model -> rendered markdown, driven entirely by the validated config. */
export function emitDocs(model: DocModel, config: LuauDocsConfig): EmitResult {
	const { pages, warnings, resolveAlias } = buildPages(model, config);
	// anchors before the symbol table: the table reads them, never re-derives
	for (const page of pages) {
		page.anchors = mintAnchors(page);
	}
	const symbols = new SymbolTable(model, pages, warnings, resolveAlias);
	const options: RenderOptions = { symbols, config, externals: model.externals };

	// one tree for the page trails, the API index, and the sidebar
	const tree = buildAccessTree(pages);
	const trails = apiTrails(tree);

	const rendered = new Map<string, string>();
	for (const page of pages) {
		rendered.set(apiPageFile(page.slug), renderPage(page, options));
	}

	return {
		pages: rendered,
		trails,
		// a project with no modules gets no index: an API index of nothing,
		// linked from a nav entry, is worse than none
		apiIndex:
			pages.length > 0
				? renderApiIndex(tree, (markdown) => linkifyProse(markdown, options))
				: undefined,
		sidebar: apiSidebar(pages, tree),
		pageModels: pages,
		warnings,
	};
}

/** The same, from extractor JSON: the seam the renderer tests drive. */
export function emitDocsFromJson(jsonText: string, config: LuauDocsConfig): EmitResult {
	return emitDocs(parseDocModel(jsonText), config);
}

/**
 * Markdown text utilities used by the emitter. The fence splitter and HTML
 * escaper live in the synced VitePress runtime (which cannot import from src/)
 * and are re-exported here.
 */
import { splitFences } from "../templates/runtime/markup";
import { ANNOTATION_PATTERN } from "../templates/runtime/inline-highlight";
import { LINKS_TOKEN } from "../templates/runtime/signature-links";

export { escapeHtml, REWRITTEN_COMPONENTS, splitFences } from "../templates/runtime/markup";

/**
 * VitePress's heading slugifier, vendored from @mdit-vue/shared instead of
 * depended on: ten lines against a whole package. The anchors test asserts
 * against the real VitePress, so a drift from this copy fails loudly.
 *
 * The MIT License (MIT), Copyright (c) 2022-present, mdit-vue Contributors.
 */
const rControl = /[\u0000-\u001f]/g;
const rSpecial = /[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'\u201c\u201d\u2018\u2019<>,.?/]+/g;
const rCombining = /[\u0300-\u036F]/g;

export function headingSlug(str: string): string {
	return str
		.normalize("NFKD")
		.replace(rCombining, "")
		.replace(rControl, "")
		.replace(rSpecial, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/^(\d)/, "_$1")
		.toLowerCase();
}

/**
 * `transform` applied outside fenced code, fences left verbatim. Index 0 is
 * splitFences's outside-fences slot.
 */
export function mapOutsideFences(text: string, transform: (segment: string) => string): string {
	return splitFences(text)
		.map((segment, index) => (index % 2 === 0 ? transform(segment) : segment))
		.join("");
}

export function outsideFences(text: string): string[] {
	return splitFences(text).filter((_, index) => index % 2 === 0);
}

// a code span, double-backtick form first: `` `x` `` is one span that may
// contain single backticks, not an empty span followed by prose
export const CODE_SPAN = /(``(?:[^`\n]|`(?!`))*``|`[^`\n]*`)/;

/** `transform` applied outside inline code spans, so a span that *mentions* a
 * path, link, or tag keeps the mention verbatim. */
export function mapOutsideCodeSpans(text: string, transform: (segment: string) => string): string {
	return text
		.split(CODE_SPAN)
		.map((part, index) => (index % 2 === 0 ? transform(part) : part))
		.join("");
}

export function outsideCodeSpans(text: string): string[] {
	return text.split(CODE_SPAN).filter((_, index) => index % 2 === 0);
}

/**
 * Where a target was found, for a `convert` whose answer depends on it:
 * `image`/`src` render inline where `link`/`href` navigate, and VitePress
 * bases a `link` itself while every other slot reaches the browser as written.
 */
export type TargetSlot = "link" | "image" | "href" | "src";

// a markdown destination. The image form comes first so `[![alt](img)](link)`
// reads its inner target as the image it is; brackets are out of the alt text
// so the outer `[` cannot open that alternative.
const MARKDOWN_TARGET = /(!\[[^[\]\n]*\]\(\s*|\]\(\s*)(<[^<>\n]*>|[^()\s]+)/g;
const REFERENCE_TARGET = /^([ \t]{0,3}\[[^\]\n]+\]:[ \t]*)(\S+)/gm;
const ATTRIBUTE_TARGET = /((href|src)\s*=\s*)(["'])([^"'\n]*)\3/gi;

// every spelling of an image REFERENCE: the label is the second bracket pair
// when there is one (`![alt][label]`) and the first when there is not
// (`![label][]`, `![label]`). The lookahead excludes an inline image.
const IMAGE_REFERENCE = /!\[([^[\]\n]*)\](?:\[([^[\]\n]*)\]|(?!\())/g;

/** A reference label as matching compares them: folded and space-collapsed. */
function foldLabel(label: string): string {
	return label.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The labels every image reference in `text` names. A reference DEFINITION
 * carries no `!` of its own, so the references using its label are the only
 * thing that says what slot it is.
 */
export function imageReferenceLabels(text: string): Set<string> {
	const labels = new Set<string>();
	for (const [, alt, label] of text.matchAll(IMAGE_REFERENCE)) {
		labels.add(foldLabel(label !== undefined && label !== "" ? label : alt!));
	}
	return labels;
}

const EMPTY_LABELS: ReadonlySet<string> = new Set();

/**
 * `convert` applied in every prose context that names a link target (inline
 * links and images, reference definitions, raw HTML href/src). Scoping the
 * rewrite to targets keeps prose that merely *mentions* a path intact.
 *
 * `imageLabels` is what lets a reference definition reach `convert` in the slot
 * its references use; omitting it reads every definition as a `link`.
 */
export function rewriteTargets(
	segment: string,
	convert: (target: string, slot: TargetSlot) => string,
	imageLabels: ReadonlySet<string> = EMPTY_LABELS,
): string {
	return segment
		.replace(MARKDOWN_TARGET, (_, pre: string, target: string) => {
			// `<>` around a destination is syntax (the form that allows spaces)
			const angled = target.startsWith("<") && target.endsWith(">");
			const inner = angled ? target.slice(1, -1) : target;
			const converted = convert(inner, pre.startsWith("!") ? "image" : "link");
			return pre + (angled ? `<${converted}>` : converted);
		})
		.replace(REFERENCE_TARGET, (_, pre: string, target: string) => {
			const label = foldLabel(pre.slice(pre.indexOf("[") + 1, pre.lastIndexOf("]")));
			return pre + convert(target, imageLabels.has(label) ? "image" : "link");
		})
		.replace(
			ATTRIBUTE_TARGET,
			(_, pre: string, name: string, quote: string, target: string) =>
				pre +
				quote +
				convert(target, name.toLowerCase() === "src" ? "src" : "href") +
				quote,
		);
}

/**
 * A target reaching into .moonwave/static/ keeps only the part below it: the
 * moonwave conversion copies that tree into public/, served from the site root.
 */
export function moonwaveStaticTarget(target: string): string | undefined {
	const below = target.replace(/^.*\.moonwave\/static\//, "/");
	return below === target ? undefined : below;
}

/**
 * Flattens hard-wrapped prose onto one line, for single-line slots (list items,
 * table cells, index summaries) where a raw newline would break out.
 */
export function unwrap(text: string): string {
	return text.replace(/\s*\n\s*/g, " ");
}

/**
 * The lead sentence of a flattened paragraph, for summary slots (the API index,
 * llms.txt) where the whole paragraph would not fit.
 */
function firstSentence(text: string): string {
	return text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;
}

export function stripLinks(text: string): string {
	return text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}

// blocks that read as fragments once they are lifted out of the page: headings,
// containers, HTML, tables, setext underlines, and list items
const NOT_PROSE = /^(?:#|>|:::|<|\||={2,}|-{2,}|(?:[*+-]|\d+[.)])\s)/;

/**
 * The lead sentence of the first real paragraph, unwrapped (docs are often
 * hard-wrapped, so a raw first line would cut off mid-sentence). The one
 * summarizer every slot goes through.
 */
export function summarize(text: string): string | undefined {
	// comments strip per fence-outside segment, as plainMarkdown does: a
	// global pass could pair a prose `<!--` with a `-->` inside a later fence
	for (const segment of outsideFences(stripFrontmatter(text))) {
		for (const block of segment.replace(HTML_COMMENT_INLINE, "").split(/\r?\n[ \t]*\r?\n/)) {
			const trimmed = block.trim();
			if (trimmed !== "" && !NOT_PROSE.test(trimmed)) {
				return firstSentence(unwrap(trimmed));
			}
		}
	}
	return undefined;
}

/** `summarize` for the doc-model slots, where an absent doc reads as "". */
export function docSummary(doc: string | undefined): string {
	return doc ? (summarize(doc) ?? "") : "";
}

/** One CRLF-tolerant spelling for every reader. */
const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---/;

/** The block's inner text, or "" for a page without one. */
export function frontmatter(text: string): string {
	return text.match(FRONTMATTER_BLOCK)?.[1] ?? "";
}

/** The block itself, delimiters included, for callers that slice around it. */
export function frontmatterBlock(text: string): string | undefined {
	return text.match(FRONTMATTER_BLOCK)?.[0];
}

/** The page body, blank lines after the block removed too. */
export function stripFrontmatter(text: string): string {
	const block = frontmatterBlock(text);
	return block === undefined ? text : text.slice(block.length).replace(/^\r?\n+/, "");
}

/**
 * A scalar out of frontmatter, unquoted. `key` is a regex alternation, so a
 * key's aliases stay one pattern; `indent` reaches nested keys, defaulting to
 * blank so a top-level read cannot match a nested one.
 */
export function frontmatterField(block: string, key: string, indent = ""): string | undefined {
	const raw = block.match(new RegExp(`^${indent}(?:${key}):\\s*(.+)$`, "m"))?.[1]?.trim();
	if (raw === undefined) {
		return undefined;
	}
	// a quoted scalar ends at its closing quote and an unquoted one at the first
	// ` #`, so `title: "Setup" # draft` reads the way VitePress's own YAML
	// parser reads it instead of folding the comment in
	const quoted = raw.match(/^"([^"]*)"|^'([^']*)'/);
	if (quoted) {
		return quoted[1] ?? quoted[2];
	}
	const value = raw.replace(/^#.*$|\s+#.*$/, "").trim();
	return value === "" ? undefined : value;
}

/**
 * The presentation-only source link pinned to a heading: an empty anchor whose
 * glyph is CSS. `<Badge>` is not stripped alongside it: "Deprecated",
 * "Private" and "Yields" are API semantics, not chrome.
 */
const SOURCE_LINK_CLASS = "source-link ignore-header";
export function sourceLinkAnchor(href: string): string {
	return (
		`<a class="${SOURCE_LINK_CLASS}" href="${href}" ` +
		`target="_blank" rel="noopener noreferrer" aria-label="View source"></a>`
	);
}
const SOURCE_LINK = new RegExp(`<a class="${SOURCE_LINK_CLASS}"[^>]*></a>`);
// a tag alone on its line takes the line with it, so unwrapping leaves no
// blank gaps where the wrapper used to be
const SOURCE_LINK_LINE = new RegExp(`^[ \\t]*${SOURCE_LINK.source}[ \\t]*\\r?\\n`, "gm");
const SOURCE_LINK_INLINE = new RegExp(SOURCE_LINK.source, "g");
// a `{...}` suffix on the code span it decorates, broader than the plugin that
// consumes it: every such suffix is noise in a plain-text dump
const INLINE_ANNOTATION = new RegExp(`(\`[^\`\\n]*\`)${ANNOTATION_PATTERN}`, "g");

// a signature fence's link table, which is markup for the runtime transformer
// that renders it. The fence itself stays: the code inside it is the declaration.
const SIGNATURE_INFO = new RegExp(`^([ \\t]{0,3}\`{3,}\\S*)[ \\t]+${LINKS_TOKEN}.*$`, "gm");

// HTML comments are invisible in rendered output by definition, so the whole
// family (the generated-by note, region markers, include directives) strips as
// one class. A comment alone on its line takes the line with it.
const HTML_COMMENT = /<!--[\s\S]*?-->/;
const HTML_COMMENT_LINE = new RegExp(`^[ \\t]*${HTML_COMMENT.source}[ \\t]*\\r?\\n`, "gm");
/** Exported for the moonwave converter, which scans prose for leftover JSX and
 * must not read a tag inside a comment as one. */
export const HTML_COMMENT_INLINE = new RegExp(HTML_COMMENT.source, "g");

/**
 * One VitePress file-inclusion region marker, or "" for a block with no anchor
 * to name. Inclusion looks for a region before it falls back to slicing by
 * heading, and a region keeps the heading (with its badges) that a heading
 * slice drops, so `@include: @/api/Flux.md#properties` embeds the section as it
 * renders.
 */
export function region(name: string | undefined, end = false): string {
	return name === undefined ? "" : `<!-- #${end ? "end" : ""}region ${name} -->`;
}

/**
 * Page markdown reduced to what a model should read. Fenced code is left
 * verbatim: the guides document this very syntax, and rewriting an example
 * would document a syntax that does not exist.
 */
export function plainMarkdown(page: string): string {
	const body = stripFrontmatter(page).replace(SIGNATURE_INFO, "$1");
	return mapOutsideFences(body, (segment) =>
		segment
			.replace(HTML_COMMENT_LINE, "")
			.replace(HTML_COMMENT_INLINE, "")
			.replace(SOURCE_LINK_LINE, "")
			.replace(SOURCE_LINK_INLINE, "")
			.replace(INLINE_ANNOTATION, "$1")
			.replace(/[ \t]+$/gm, ""),
	).trim();
}

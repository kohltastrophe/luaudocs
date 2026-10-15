/**
 * Markdown text utilities used by the emitter. The fence splitter and HTML
 * escaper live in `templates/runtime/markup.ts` (which is synced into user
 * sites and cannot import from `src/`) and are re-exported here.
 */
import { splitFences } from "../templates/runtime/markup";
import { ANNOTATION_PATTERN } from "../templates/runtime/inline-highlight";
import { LINKS_TOKEN } from "../templates/runtime/signature-links";

export {
	encodeHref,
	escapeHtml,
	escapeMarkdown,
	linkDestination,
	REWRITTEN_COMPONENTS,
	splitFences,
} from "../templates/runtime/markup";

/**
 * VitePress's heading slugifier, vendored from `@mdit-vue/shared` to avoid an
 * extra dependency for a ten-line function. `test/anchors.test.ts` asserts
 * against VitePress's actual renderer so any drift fails in CI.
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

/*
 * ------------------------------------------------------------- prose headings
 */

/** A heading written in prose Markdown, as `markdown-it-anchor` reads it. */
export interface ProseHeading {
	/** Heading text from which the slug is derived. */
	text: string;
	/** Explicit `{#id}` attribute when provided by the author (used verbatim by VitePress). */
	id?: string;
}

// VitePress uses `@mdit-vue/plugin-component`'s HTML block rule rather than
// CommonMark's: any tag not on the standard inline list is treated as a Vue
// component and opens an HTML block just like `<div>` does. Below are its block
// and inline tag sets (with Vue's built-in `template` and `slot` excluded from inline).
const HTML_BLOCK_TAGS = new Set(
	(
		"address article aside base basefont blockquote body caption center col colgroup dd " +
		"details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 " +
		"h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav " +
		"noframes ol optgroup option p param search section summary table tbody td tfoot th " +
		"thead title tr track ul"
	).split(" "),
);
const HTML_INLINE_TAGS = new Set(
	(
		"a abbr acronym audio b bdi bdo big br button canvas cite code data datalist del dfn " +
		"em embed i iframe img input ins kbd label map mark meter noscript object output " +
		"picture progress q ruby s samp script select small span strong sub sup svg " +
		"textarea time u tt var video wbr"
	).split(" "),
);
// `markdown-it`'s HTML tag grammar (`lib/common/html_re.mjs`).
const TAG_ATTRIBUTE =
	"(?:\\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\\s*=\\s*(?:[^\"'=<>`\\x00-\\x20]+|'[^']*'|\"[^\"]*\"))?)";
const OPEN_TAG = `<[A-Za-z][A-Za-z0-9-]*${TAG_ATTRIBUTE}*\\s*\\/?>`;
const CLOSE_TAG = "<\\/[A-Za-z][A-Za-z0-9-]*\\s*>";
const TAG_NAME = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?=\s|\/?>|$)/;
const LONE_TAG = new RegExp(`^(?:${OPEN_TAG}|${CLOSE_TAG})\\s*$`);
const SELF_CLOSING_TAG = new RegExp(`^<[A-Za-z][A-Za-z0-9-]*${TAG_ATTRIBUTE}*\\s*\\/>`);
const SAME_LINE_ELEMENT = new RegExp(
	`^<([A-Za-z][A-Za-z0-9-]*)${TAG_ATTRIBUTE}*\\s*>.*<\\/\\1\\s*>`,
);
const INLINE_HTML = new RegExp(`${OPEN_TAG}|${CLOSE_TAG}|<!--[\\s\\S]*?-->`, "g");

/** Matches the blank line that closes an HTML block. */
const TO_BLANK = /^[ \t]*$/;

/**
 * Detects whether `line` opens an HTML block: returns the closing-line regex
 * for a multi-line block, `"line"` for a single-line Vue component (self-closing
 * or closed on the same line, which VitePress treats as inline), or `undefined`.
 * `inParagraph` guards CommonMark type-7 lone tags, which cannot interrupt an
 * open paragraph.
 */
function htmlBlock(line: string, inParagraph: boolean): RegExp | "line" | undefined {
	const text = line.replace(/^ {0,3}/, "");
	if (!text.startsWith("<")) {
		return undefined;
	}
	if (text.startsWith("<!--")) {
		return /-->/;
	}
	if (/^<(?:script|pre|style)(?=\s|>|$)/i.test(text)) {
		return /<\/(?:script|pre|style)>/i;
	}
	const name = TAG_NAME.exec(text)?.[1];
	if (name !== undefined && HTML_BLOCK_TAGS.has(name.toLowerCase())) {
		return TO_BLANK;
	}
	// Match inline tags case-sensitively so PascalCase tags (`<B>`) are treated as Vue components.
	if (name !== undefined && !HTML_INLINE_TAGS.has(name)) {
		return SELF_CLOSING_TAG.test(text) || SAME_LINE_ELEMENT.test(text) ? "line" : TO_BLANK;
	}
	return !inParagraph && LONE_TAG.test(text) ? TO_BLANK : undefined;
}

/** Leading blockquote markers (`> `, `>> `): headings inside blockquotes still mint anchors. */
const BLOCKQUOTE_MARKERS = /^(?: {0,3}> ?)+/;
/** Leading list item markers (`- ## Name` is a heading inside a list item). */
const LIST_MARKERS = /^(?: {0,3}(?:[*+-]|\d{1,9}[.)])[ \t]+)+/;
/** ATX heading pattern; closing `#` runs require a preceding space so `## C#` keeps `#`. */
const ATX_HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
/** Setext heading underline (`===` or `---` alone on a line). */
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
/**
 * Block openers that interrupt a paragraph so a following `===` or `---` line
 * cannot turn it into a setext heading: list items, table rows, thematic breaks,
 * and link reference definitions.
 */
const NOT_PARAGRAPH =
	/^ {0,3}(?:[*+-]\s|\d{1,9}[.)]\s|\||([-*_])(?:[ \t]*\1){2,}[ \t]*$|\[[^\]\n]+\]:)/;
const REFERENCE_DEFINITION = /^[ \t]*(?:>[ \t]?)*[ \t]{0,3}\[([^\]\n]+)\]:/gm;

/**
 * Extracts every heading written in prose Markdown (outside fenced code blocks)
 * in document order. Prose headings mint anchor IDs in VitePress and therefore
 * claim slugs before any following member headings with the same name.
 *
 * Because `markdown-it-anchor` hooks `heading_open` tokens regardless of syntax,
 * this matches ATX headings (`## Name`), ATX headings inside blockquotes or list
 * items (`> ## Name`, `- ## Name`), and setext headings (`Name` underlined with
 * `===` or `---` at the same blockquote depth), while skipping content inside
 * HTML blocks.
 */
export function proseHeadings(markdown: string | undefined): ProseHeading[] {
	if (!markdown) {
		return [];
	}
	const labels = new Set(
		[...markdown.matchAll(REFERENCE_DEFINITION)].map((match) => foldLabel(match[1]!)),
	);
	const headings: ProseHeading[] = [];
	const push = (raw: string) => headings.push(headingText(raw, labels));
	for (const part of outsideFences(markdown)) {
		// Track the entire accumulated paragraph for setext headings, not just
		// its final line: `markdown-it` represents line breaks as `softbreak`
		// tokens with `content: ""`, so a multi-line setext heading slugifies
		// all of its lines concatenated together without spaces.
		let paragraph: { text: string; depth: number } | undefined;
		// Open HTML block state (`markdown-it` mints no heading anchors inside HTML blocks).
		let html: { until: RegExp; depth: number } | undefined;
		for (const rawLine of part.split("\n")) {
			const markers = BLOCKQUOTE_MARKERS.exec(rawLine)?.[0] ?? "";
			const depth = markers.split(">").length - 1;
			const line = rawLine.slice(markers.length);
			// HTML blocks do not support lazy continuation, so shallower quote depth closes the block.
			if (html !== undefined && depth >= html.depth) {
				if (html.until.test(line)) {
					html = undefined;
				}
				paragraph = undefined;
				continue;
			}
			html = undefined;
			const opened = htmlBlock(line, paragraph !== undefined);
			if (opened !== undefined) {
				// A comment or raw HTML block may close on the same line it opens.
				if (opened !== "line" && !opened.test(line.trimStart().slice(1))) {
					html = { until: opened, depth };
				}
				paragraph = undefined;
				continue;
			}
			const atx = ATX_HEADING.exec(line.replace(LIST_MARKERS, ""));
			if (atx) {
				push(atx[1]!);
				paragraph = undefined;
				continue;
			}
			// Increasing blockquote depth opens a nested blockquote and interrupts any open paragraph.
			if (paragraph !== undefined && depth > paragraph.depth) {
				paragraph = undefined;
			}
			if (paragraph !== undefined && SETEXT_UNDERLINE.test(line)) {
				if (depth === paragraph.depth) {
					push(paragraph.text);
					paragraph = undefined;
				} else if (line.includes("=")) {
					paragraph.text += line.trim();
				} else {
					paragraph = undefined;
				}
				continue;
			}
			if (/^[ \t]*$/.test(line) || NOT_PARAGRAPH.test(line)) {
				paragraph = undefined;
			} else if (paragraph !== undefined) {
				paragraph.text += line.trim();
			} else if (/^ {0,3}\S/.test(line)) {
				paragraph = { text: line.trim(), depth };
			}
		}
	}
	return headings;
}

// Park backslash-escaped ASCII punctuation in the Unicode Private Use Area
// while stripping inline Markdown constructs, then restore the literal characters.
const ESCAPED = /\\([!-/:-@[-`{-~])/g;
const PARKED = /[\ue000-\ue07f]/g;
// Inline links and images contribute only their bracketed label text to the slug.
const LINK_DESTINATION = /\]\([^()\n]*(?:\([^()\n]*\)[^()\n]*)*\)/g;
const REFERENCE_LINK = /\[([^[\]]*)\]\[([^[\]]*)\]/g;
const AUTOLINK = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[^\s@<>]+@[^\s@<>]+)>/g;
// `markdown-it-emoji` `:shortcode:` syntax (unknown shortcode names remain literal
// text in VitePress, which cannot be distinguished without the full emoji table).
const EMOJI_SHORTCODE = /:[a-z0-9_+-]+:/g;
// `markdown-it-attrs` trailing `{...}` block, stripped from the heading text.
const TRAILING_ATTRS = /(?<!\\)\{([^{}]+)(?<!\\)\}[ \t]*$/;

/**
 * Extracts a heading's text the way VitePress's `getTokensText` joins inline
 * tokens: HTML tags and `:shortcode:` emoji contribute nothing, links contribute
 * their label text, and code spans contribute their unquoted content. A trailing
 * `{#id}` attribute sets the explicit anchor `id`.
 */
function headingText(raw: string, labels: ReadonlySet<string>): ProseHeading {
	const parts = raw.split(CODE_SPAN);
	let id: string | undefined;
	const last = parts.length - 1;
	parts[last] = parts[last]!.replace(TRAILING_ATTRS, (_match, attrs: string) => {
		id = [...attrs.matchAll(/(?:^|\s)#(\S+)/g)].pop()?.[1];
		return "";
	});
	const text = parts
		.map((part, index) =>
			index % 2 === 1
				? codeSpanContent(part)
				: part
						.replace(ESCAPED, (_match, char: string) =>
							String.fromCharCode(0xe000 + char.charCodeAt(0)),
						)
						.replace(LINK_DESTINATION, "]")
						.replace(REFERENCE_LINK, (match, text: string, label: string) =>
							labels.has(foldLabel(label === "" ? text : label))
								? `[${text}]`
								: match,
						)
						.replace(AUTOLINK, "$1")
						.replace(INLINE_HTML, "")
						.replace(EMOJI_SHORTCODE, "")
						.replace(PARKED, (char) =>
							String.fromCharCode(char.charCodeAt(0) - 0xe000),
						),
		)
		.join("");
	return id === undefined ? { text } : { text, id };
}

/** Strips outer backticks from a code span and removes one symmetric leading/trailing space per CommonMark. */
function codeSpanContent(span: string): string {
	const inner = span.replace(/^(`+)([\s\S]*)\1$/, "$2");
	return /^ .*[^ ].* $/.test(inner) ? inner.slice(1, -1) : inner;
}

function mapEven(parts: string[], transform: (segment: string) => string): string {
	return parts.map((part, index) => (index % 2 === 0 ? transform(part) : part)).join("");
}

function filterEven(parts: string[]): string[] {
	return parts.filter((_, index) => index % 2 === 0);
}

/**
 * Applies `transform` to prose segments outside fenced code blocks, leaving
 * fenced code untouched (even indices in `splitFences` are outside fences).
 */
export function mapOutsideFences(text: string, transform: (segment: string) => string): string {
	return mapEven(splitFences(text), transform);
}

export function outsideFences(text: string): string[] {
	return filterEven(splitFences(text));
}

// Match double-backtick spans before single-backtick spans so `` `x` `` is
// matched as one span rather than an empty span followed by prose.
export const CODE_SPAN = /(``(?:[^`\n]|`(?!`))*``|`[^`\n]*`)/;

/**
 * Applies `transform` outside inline code spans so code spans that mention a
 * file path, bracket reference, or HTML tag stay verbatim.
 */
export function mapOutsideCodeSpans(text: string, transform: (segment: string) => string): string {
	return mapEven(text.split(CODE_SPAN), transform);
}

export function outsideCodeSpans(text: string): string[] {
	return filterEven(text.split(CODE_SPAN));
}

/**
 * Identifies which syntax slot a link target occupies: `image` and `src` render
 * inline assets whereas `link` and `href` navigate, and VitePress prefixes the
 * site `base` onto Markdown `link` targets automatically while leaving raw HTML
 * `href` attributes as written.
 */
export type TargetSlot = "link" | "image" | "href" | "src";

// Match Markdown link and image destinations. The image branch (`![alt](...)`)
// comes first so `[![alt](img)](link)` classifies the inner target as `"image"`.
const MARKDOWN_TARGET = /(!\[[^[\]\n]*\]\(\s*|\]\(\s*)(<[^<>\n]*>|[^()\s]+)/g;
const REFERENCE_TARGET = /^([ \t]{0,3}\[[^\]\n]+\]:[ \t]*)(\S+)/gm;
const ATTRIBUTE_TARGET = /((href|src)\s*=\s*)(["'])([^"'\n]*)\3/gi;

// Matches every image reference (`![alt][label]`, `![label][]`, `![label]`),
// using a negative lookahead to exclude inline images (`![alt](url)`).
const IMAGE_REFERENCE = /!\[([^[\]\n]*)\](?:\[([^[\]\n]*)\]|(?!\())/g;

/** Normalizes a Markdown reference label for case-insensitive, whitespace-collapsed matching. */
function foldLabel(label: string): string {
	return label.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Collects the normalized labels of every image reference in `text`. Because a
 * `[label]: url` definition has no `!` prefix of its own, checking whether its
 * label appears in this set is how `rewriteTargets` tells image definitions
 * apart from link definitions.
 */
export function imageReferenceLabels(text: string): Set<string> {
	return new Set(
		[...text.matchAll(IMAGE_REFERENCE)].map(([, alt, label]) => foldLabel(label || alt!)),
	);
}

const EMPTY_LABELS: ReadonlySet<string> = new Set();

/**
 * Applies `convert` to every link and asset target in `segment` (inline Markdown
 * links and images, reference definitions, and raw HTML `href`/`src` attributes)
 * without touching prose that merely mentions a path.
 *
 * Pass `imageLabels` (from `imageReferenceLabels`) when `convert` needs to
 * distinguish image reference definitions from link reference definitions.
 */
export function rewriteTargets(
	segment: string,
	convert: (target: string, slot: TargetSlot) => string,
	imageLabels: ReadonlySet<string> = EMPTY_LABELS,
): string {
	return segment
		.replace(MARKDOWN_TARGET, (_, pre: string, target: string) => {
			// Preserve `<...>` delimiters around destinations that allow spaces.
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
 * Rewrites a path into `.moonwave/static/` to its root-relative `/...` path
 * (`init --from-moonwave` copies `.moonwave/static/*` into `public/`).
 */
export function moonwaveStaticTarget(target: string): string | undefined {
	const below = target.replace(/^.*\.moonwave\/static\//, "/");
	return below === target ? undefined : below;
}

/**
 * Flattens hard-wrapped prose onto a single line for single-line contexts
 * (list items, table cells, and index summaries).
 */
export function unwrap(text: string): string {
	return text.replace(/\s*\n\s*/g, " ");
}

/** Extracts the first sentence from an unwrapped paragraph for summary listings. */
function firstSentence(text: string): string {
	return text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;
}

export function stripLinks(text: string): string {
	return text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}

// Block starts that are not prose paragraphs: headings, blockquotes, containers,
// HTML tags, tables, setext underlines, and list items.
const NOT_PROSE = /^(?:#|>|:::|<|\||={2,}|-{2,}|(?:[*+-]|\d+[.)])\s)/;

/**
 * Extracts the lead sentence of the first prose paragraph in `text`, unwrapping
 * hard line breaks first so wrapped sentences are not cut off mid-thought.
 */
export function summarize(text: string): string | undefined {
	// Strip HTML comments per fence-outside segment (just like `plainMarkdown`)
	// so a `<!--` in prose cannot pair with a `-->` inside a later code fence.
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

/** Wrapper around `summarize` for doc-model fields, returning `""` when absent. */
export function docSummary(doc: string | undefined): string {
	return doc ? (summarize(doc) ?? "") : "";
}

/** Matches a leading YAML frontmatter block across LF and CRLF line endings. */
const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---/;

/** Returns the YAML text inside the frontmatter block, or `""` when absent. */
export function frontmatter(text: string): string {
	return text.match(FRONTMATTER_BLOCK)?.[1] ?? "";
}

/** Returns the complete frontmatter block including `---` delimiters, or `undefined`. */
export function frontmatterBlock(text: string): string | undefined {
	return text.match(FRONTMATTER_BLOCK)?.[0];
}

/** Strips the frontmatter block and any immediately following blank lines. */
export function stripFrontmatter(text: string): string {
	const block = frontmatterBlock(text);
	return block === undefined ? text : text.slice(block.length).replace(/^\r?\n+/, "");
}

/**
 * Reads a scalar field from a YAML frontmatter block, unquoting string values.
 * `key` may be a regex alternation (`"sidebar_label|title"`), and `indent`
 * selects nested keys while defaulting to `""` so top-level lookups never match
 * nested keys.
 */
export function frontmatterField(block: string, key: string, indent = ""): string | undefined {
	// Match horizontal whitespace (`[ \t]*`) after `:` so a blank key cannot
	// consume the next line as its value.
	const raw = block.match(new RegExp(`^${indent}(?:${key}):[ \\t]*(.+)$`, "m"))?.[1]?.trim();
	if (raw === undefined) {
		return undefined;
	}
	// Strip quotes from quoted scalars and trailing `#` comments from unquoted
	// scalars, matching how VitePress's YAML parser reads `title: "Setup" # draft`.
	const quoted = raw.match(/^"([^"]*)"|^'([^']*)'/);
	if (quoted) {
		return quoted[1] ?? quoted[2];
	}
	return raw.replace(/(?:^|\s+)#.*$/, "").trim() || undefined;
}

/**
 * Renders the presentation-only source link pinned to member headings: an empty
 * `<a>` whose `</>` glyph comes from CSS. `<Badge>` tags are intentionally kept
 * in `plainMarkdown` because `"Deprecated"`, `"Private"`, and `"Yields"` carry
 * API semantics rather than decorative chrome.
 */
const SOURCE_LINK_CLASS = "source-link ignore-header";
export function sourceLinkAnchor(href: string): string {
	return (
		`<a class="${SOURCE_LINK_CLASS}" href="${href}" ` +
		`target="_blank" rel="noopener noreferrer" aria-label="View source"></a>`
	);
}
const SOURCE_LINK = new RegExp(`<a class="${SOURCE_LINK_CLASS}"[^>]*></a>`);
const wholeLine = (pattern: RegExp) => new RegExp(`^[ \\t]*${pattern.source}[ \\t]*\\r?\\n`, "gm");

/**
 * `markdown-it-attrs` class suffix attached to linked badges (see `reexportBadge`
 * in `src/render.ts`). Stripped in plain-text dumps.
 */
export const BADGE_LINK_ATTRS = "{.badge-link .ignore-header}";
// When a source-link anchor sits alone on its own line, remove the whole line
// so stripping it leaves no extra blank line behind.
const SOURCE_LINK_LINE = wholeLine(SOURCE_LINK);
const SOURCE_LINK_INLINE = new RegExp(SOURCE_LINK.source, "g");
// Strips `{lang}` / `{.class}` suffixes attached to inline code spans in plain-text output.
const INLINE_ANNOTATION = new RegExp(`(\`[^\`\\n]*\`)${ANNOTATION_PATTERN}`, "g");

// Strips `luaudocs-links=[...]` from signature fence info strings while keeping the code fence itself.
const SIGNATURE_INFO = new RegExp(`^([ \\t]{0,3}\`{3,}\\S*)[ \\t]+${LINKS_TOKEN}.*$`, "gm");

// HTML comments (generated-by notes, region markers, and `@include` directives)
// are invisible in rendered output and stripped from plain-text output.
const HTML_COMMENT = /<!--[\s\S]*?-->/;
const HTML_COMMENT_LINE = wholeLine(HTML_COMMENT);
/** Exported for the Moonwave converter so JSX scans ignore tags inside HTML comments. */
export const HTML_COMMENT_INLINE = new RegExp(HTML_COMMENT.source, "g");

/**
 * Formats a VitePress `#region` / `#endregion` comment marker, or `""` when
 * `name` is `undefined`. VitePress checks region markers before falling back to
 * heading slices on `<!--@include: @/api/Flux.md#properties-->`, allowing an
 * include to keep the section's heading and badges.
 */
export function region(name: string | undefined, end = false): string {
	return name === undefined ? "" : `<!-- #${end ? "end" : ""}region ${name} -->`;
}

/**
 * Reduces rendered page Markdown to clean Markdown for `llms-full.txt`. Leaves
 * fenced code blocks untouched so examples documenting LuauDocs syntax keep
 * their literal source.
 */
export function plainMarkdown(page: string): string {
	const body = stripFrontmatter(page).replace(SIGNATURE_INFO, "$1");
	return mapOutsideFences(body, (segment) =>
		segment
			.replace(HTML_COMMENT_LINE, "")
			.replace(HTML_COMMENT_INLINE, "")
			.replace(SOURCE_LINK_LINE, "")
			.replace(SOURCE_LINK_INLINE, "")
			.replaceAll(BADGE_LINK_ATTRS, "")
			.replace(INLINE_ANNOTATION, "$1")
			.replace(/[ \t]+$/gm, ""),
	).trim();
}

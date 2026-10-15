/**
 * Generates `llms.txt` for two audiences:
 *
 * 1. **Published site (`<docs>/public/llms.txt` + `llms-full.txt`)**: written by
 *    `luaudocs build` so AI tools can read the published documentation without
 *    scraping HTML. Guides come before API pages because a model can derive the
 *    API surface from source code, whereas prose guides carry usage intent that
 *    only exists in the docs. The changelog is listed under the `## Optional`
 *    section and omitted from `llms-full.txt`. Setting `[docs] llms = false`
 *    opts out and leaves any existing files untouched. If a build produces no
 *    guides, API pages, or changelog, both files are removed so a site that
 *    emptied its docs does not keep serving a stale index.
 *
 * 2. **Repository checkout (`llms.txt` at the project root)**: written by
 *    `luaudocs llms` for coding agents working in a local clone (typically
 *    referenced from `AGENTS.md` or `CLAUDE.md`). Uses the same `llms.txt`
 *    structure, but links to local paths and lists every API member individually,
 *    linking each signature to the exact `file#Lstart-Lend` lines that declare
 *    it. Reads only committed inputs (Luau sources, guides, and root
 *    `CHANGELOG.md`), never build artifacts, so every clone produces identical
 *    bytes and CI can verify the committed copy with `luaudocs llms --check`.
 *    Because it sits at the project root, `luaudocs llms` only overwrites a file
 *    that carries the generated marker, and `build` / `dev` never touch it.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import pkg from "../package.json";
import {
	renderProject,
	syncFile,
	writeIfChanged,
	type BuildContext,
	type RenderedModel,
} from "./build";
import type { SourceSpan } from "./docmodel";
import { docSummary, plainMarkdown, unwrap } from "./markdown";
import { buildAccessTree, type TreeNode } from "./nav";
import {
	apiHref,
	apiPageFile,
	displayTitle,
	GENERATED_COMMENT_MARK,
	isGeneratedFile,
	memberAccess,
	toPosix,
	type PageMember,
	type PageModel,
	type PageSection,
	type PageType,
	type ReexportInfo,
} from "./pages";
import {
	badgeLabels,
	genericsText,
	inlineText,
	MEMBER_HEADINGS,
	READ_ONLY_LABEL,
	reexportLabel,
	type BadgeLabel,
	type EmitResult,
} from "./render";
import {
	collectGuides,
	flattenGuides,
	readDocPage,
	readHomePage,
	type DocPage,
	type GuideItem,
} from "./site";

interface Section {
	heading: string;
	entries: string[];
}

/**
 * Formats an `llms.txt` index shared by both outputs: H1 title, optional
 * blockquote summary, optional intro paragraphs, and one H2 section per entry list.
 */
function llmsIndex(
	title: string,
	summary: string | undefined,
	info: string[],
	sections: Section[],
): string {
	const lines = [`# ${title}`, ""];
	if (summary) {
		lines.push(`> ${summary}`, "");
	}
	for (const paragraph of info) {
		lines.push(paragraph, "");
	}
	for (const section of sections) {
		lines.push(`## ${section.heading}`, "", ...section.entries, "");
	}
	return lines.join("\n").trimEnd() + "\n";
}

/*
 * ------------------------------------------------------------------- the site
 */

/** Prepends an H1 title when a page body does not already start with one, since `llms-full.txt` concatenates pages into a single stream. */
function titled(body: string, title: string): string {
	return body.startsWith("# ") ? body : `# ${title}\n\n${body}`;
}

export function syncLlms(context: BuildContext, guides: GuideItem[], result: EmitResult): void {
	const config = context.config;
	if (!config.docs.llms) {
		return;
	}
	const siteUrl = config.docs.url ?? "";
	const entry = (page: { title: string; link: string; description?: string }) =>
		`- [${page.title}](${siteUrl}${page.link})${page.description ? `: ${page.description}` : ""}`;
	const sections: Section[] = [];
	const bodies: string[] = [];

	// A `layout: home` hero page contributes its tagline rather than a page entry (`readHomePage`).
	const home = readHomePage(context.docsDir);
	const guidePages = [...(home?.page ? [home.page] : []), ...flattenGuides(guides)];
	if (guidePages.length > 0) {
		sections.push({ heading: "Guides", entries: guidePages.map(entry) });
		for (const guide of guidePages) {
			bodies.push(titled(plainMarkdown(guide.text), guide.title));
		}
	}

	if (result.pageModels.length > 0) {
		const entries: string[] = [];
		for (const page of result.pageModels) {
			entries.push(
				entry({
					title: page.title,
					link: apiHref(page.slug),
					// Use the same lead sentence summary as the API overview page.
					description: docSummary(page.doc) || undefined,
				}),
			);
			const rendered = result.pages.get(apiPageFile(page.slug));
			if (rendered !== undefined) {
				bodies.push(plainMarkdown(rendered));
			}
		}
		sections.push({ heading: "API Reference", entries });
	}

	// Read `changelog.md` from disk rather than checking `changelogEnabled` so a
	// hand-written `<docs>/changelog.md` (without the generated marker) is indexed too.
	const changelog = readDocPage(join(context.docsDir, "changelog.md"), "/changelog");
	if (changelog) {
		sections.push({ heading: "Optional", entries: [entry(changelog)] });
	}

	const publicDir = join(context.docsDir, "public");
	// Passing `undefined` removes the file if it exists on disk.
	const write = (name: string, content: string | undefined) =>
		syncFile(join(publicDir, name), content);

	if (sections.length === 0) {
		write("llms.txt", undefined);
		write("llms-full.txt", undefined);
		return;
	}
	const summary = config.description ?? home?.tagline;
	write("llms.txt", llmsIndex(config.title, summary, [], sections));
	// A changelog-only site has an `llms.txt` index but no page bodies for `llms-full.txt`.
	write("llms-full.txt", bodies.length > 0 ? bodies.join("\n\n") + "\n" : undefined);
}

/*
 * --------------------------------------------------------------- the checkout
 */

/** Default output filename for `luaudocs llms` under the project root. */
export const LOCAL_LLMS_FILE = "llms.txt";

/**
 * Wraps `text` in a CommonMark code span that survives embedded backticks
 * (fencing with one more backtick than the longest run inside `text`, and
 * padding with spaces when `text` starts or ends with a backtick).
 */
function codeSpan(text: string): string {
	const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(longest + 1);
	const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
	return `${fence}${pad}${text}${pad}${fence}`;
}

/** Escapes square brackets in plain link text so they cannot close the Markdown link early. */
function escapeBrackets(text: string): string {
	return text.replace(/[[\]]/g, "\\$&");
}

/**
 * Formats a single list entry, wrapping the destination in `<...>` when it
 * contains spaces or parentheses as required by CommonMark.
 */
function entry(title: string, target: string, notes: string): string {
	const destination = /[\s()<>]/.test(target)
		? `<${target.replace(/[<>]/g, encodeURIComponent)}>`
		: target;
	return `- [${title}](${destination})${notes ? `: ${notes}` : ""}`;
}

/** Renders a doc string's lead sentence as a single line of plain Markdown without site chrome. */
function summaryText(doc: string | undefined): string {
	return plainMarkdown(docSummary(doc));
}

/**
 * Formats a badge as a bracketed prefix (`[Yields]`, `[Deprecated since v2: ...]`).
 * Deprecation badges inline their note because `llms.txt` has no separate notice
 * block. Inner brackets (`[Tagged.create]`) are left unescaped: the file defines
 * no link reference definitions, and no badge label is followed by `(`, so
 * Markdown parsers keep them as literal brackets.
 */
function labelText(label: BadgeLabel): string {
	const note = label.note ? unwrap(plainMarkdown(label.note)) : "";
	return `[${note ? `${label.text}: ${note}` : label.text}]`;
}

/** Joins an entry's bracketed badge labels and trailing prose summary. */
function notes(labels: Array<BadgeLabel | string | undefined>, ...texts: string[]): string {
	const bracketed = labels
		.filter((label) => label !== undefined)
		.map((label) => (typeof label === "string" ? `[${label}]` : labelText(label)));
	return [...bracketed, ...texts].filter(Boolean).join(" ");
}

function reexportText(re: ReexportInfo | undefined): string | undefined {
	return re ? reexportLabel(re) : undefined;
}

/** Link-formatting helpers scoped to the target file's directory. */
interface Linker {
	/** Formats a project-relative file path relative to the output file. */
	file: (path: string) => string;
	/** Formats a source span as `path#Lstart-Lend` relative to the output file. */
	span: (span: SourceSpan) => string;
	/** Maps member id -> callee display name for constructor lists. */
	callees: Map<string, string>;
}

function typeEntry(ty: PageType, link: Linker): string {
	let head: string;
	if (ty.kind === "typefunction") {
		head = `type function ${ty.name}${genericsText(ty.generics)}${inlineText(ty.params ?? [])}`;
	} else {
		head = `type ${ty.name}${genericsText(ty.generics)}`;
		// Inline a single-line definition directly in the heading; multi-line
		// definitions (or lines containing a `--` field comment) stay behind the source link.
		const line = ty.definition?.length === 1 ? inlineText(ty.definition[0]!) : undefined;
		if (line !== undefined && !line.includes("--")) {
			head += ` = ${line}`;
		}
	}
	return entry(
		codeSpan(head),
		link.span(ty.source),
		notes(
			[...badgeLabels(ty.tags, ty.visibility), reexportText(ty.reexport)],
			summaryText(ty.doc),
		),
	);
}

function memberEntry(
	page: PageModel,
	section: PageSection,
	member: PageMember,
	link: Linker,
): string {
	if (member.kind === "prop") {
		const type = member.type ? `: ${inlineText(member.type)}` : "";
		return entry(
			codeSpan(`${memberAccess(section.container, member.name)}${type}`),
			// A whole-module mount links to the mounted module's file rather than a line span.
			member.reexport?.module ? link.file(member.source.file) : link.span(member.source),
			notes(
				[
					...badgeLabels(member.tags, member.visibility),
					member.readonly ? READ_ONLY_LABEL : undefined,
					reexportText(member.reexport),
				],
				summaryText(member.doc),
			),
		);
	}
	// Omit the member summary when a callable module's own call member repeats
	// the module summary (matching the deduplication on rendered API pages).
	const repeat = member.doc === page.doc && member.signature.callee === page.title;
	return entry(
		codeSpan(`${member.signature.callee}${inlineText(member.signature.segs)}`),
		link.span(member.source),
		notes(
			[...badgeLabels(member.tags, member.visibility), reexportText(member.reexport)],
			repeat ? "" : summaryText(member.doc),
		),
	);
}

/** Formats `"Constructors: `A.new`, `B.from`."` for sections with resolved constructors. */
function constructorText(section: PageSection | undefined, link: Linker): string {
	const names = (section?.constructors ?? [])
		.map((id) => link.callees.get(id))
		.filter((name) => name !== undefined);
	return names.length > 0 ? `Constructors: ${names.map(codeSpan).join(", ")}.` : "";
}

/** Lists a section's members, grouped by kind in page heading order. */
function memberEntries(page: PageModel, section: PageSection, link: Linker): string[] {
	return MEMBER_HEADINGS.flatMap(({ kind }) =>
		section.members
			.filter((member) => member.kind === kind)
			.map((member) => memberEntry(page, section, member, link)),
	);
}

/** Lists a module entry, its types, its primary members, and each nested class with its members. */
function moduleEntries(page: PageModel, link: Linker): string[] {
	const [primary, ...nested] = page.sections;
	const entries = [
		entry(
			escapeBrackets(page.title),
			link.file(page.source.file),
			notes(
				badgeLabels(page.tags),
				// Use the module's own doc summary, falling back to the primary
				// class doc when a factory module documents the class block instead.
				summaryText(page.doc) || summaryText(primary?.doc),
				constructorText(primary, link),
			),
		),
		...page.types.map((ty) => typeEntry(ty, link)),
	];
	if (primary) {
		entries.push(...memberEntries(page, primary, link));
	}
	for (const section of nested) {
		entries.push(
			entry(
				codeSpan(section.container),
				section.source ? link.span(section.source) : link.file(page.source.file),
				notes(
					badgeLabels(section.tags),
					summaryText(section.doc),
					constructorText(section, link),
				),
			),
			...memberEntries(page, section, link),
		);
	}
	return entries;
}

/**
 * Builds one section per module in depth-first access-tree order (matching the
 * API overview page), each headed by its public access path.
 */
function apiSections(pages: PageModel[], link: Linker): Section[] {
	const sections: Section[] = [];
	const walk = (node: TreeNode) => {
		sections.push({
			heading: node.access ?? displayTitle(node.page),
			entries: moduleEntries(node.page, link),
		});
		node.children.forEach(walk);
	};
	buildAccessTree(pages).forEach(walk);
	return sections;
}

/** Quotes a shell argument only when it contains characters outside `[\w./@-]`. */
function shellWord(word: string): string {
	return /^[\w./@-]+$/.test(word) ? word : JSON.stringify(word);
}

/**
 * Formats the exact command that regenerates `target` when run from `target`'s
 * parent directory (the project root by default). Pins the CLI version so coding
 * agents reproduce the committed output rather than pulling an incompatible release.
 */
function regenerateCommand(root: string, target: string): string {
	const words = ["npx", `luaudocs@${pkg.version}`, "llms"];
	const dir = toPosix(relative(dirname(target), root));
	if (dir !== "") {
		words.push(shellWord(dir));
	}
	if (dir !== "" || basename(target) !== LOCAL_LLMS_FILE) {
		words.push("--out", shellWord(basename(target)));
	}
	return words.join(" ");
}

/**
 * Renders the checkout `llms.txt` for `target`, with every link relative to
 * `dirname(target)`.
 */
export function renderLocalLlms(
	context: BuildContext,
	guides: GuideItem[],
	result: EmitResult,
	target: string,
): string {
	const { config, root, docsDir } = context;
	const local = (abs: string) => toPosix(relative(dirname(target), abs));
	const file = (path: string) => local(join(root, path));
	const callees = new Map(
		result.pageModels.flatMap((page) =>
			page.sections.flatMap((section) =>
				section.members.flatMap((m) =>
					m.kind !== "prop" ? [[m.id, m.signature.callee] as const] : [],
				),
			),
		),
	);
	const link: Linker = {
		file,
		span: (span) =>
			`${file(span.file)}#L${span.line}${span.endLine ? `-L${span.endLine}` : ""}`,
		callees,
	};
	const listed = (page: DocPage) =>
		entry(escapeBrackets(page.title), local(page.file), page.description ?? "");

	// Ignore a build-generated `index.md` because a fresh clone does not have
	// it, and `luaudocs llms` must produce identical output on a clean checkout.
	const found = readHomePage(docsDir);
	const home = found?.generated ? undefined : found;
	const guidePages = [...(home?.page ? [home.page] : []), ...flattenGuides(guides)];
	const api = apiSections(result.pageModels, link);

	const sections: Section[] = [];
	if (guidePages.length > 0) {
		sections.push({ heading: "Guides", entries: guidePages.map(listed) });
	}
	sections.push(...api);
	// Read the root `CHANGELOG.md` directly (`<docs>/changelog.md` is build-generated).
	const changelog = readDocPage(join(root, "CHANGELOG.md"), "/changelog");
	if (changelog) {
		sections.push({ heading: "Optional", entries: [listed(changelog)] });
	}

	const covers = [
		guidePages.length > 0 ? "its guides" : undefined,
		api.length > 0 ? "every module, type, and member its Luau source exposes" : undefined,
	].filter((part) => part !== undefined);
	const info = [
		`This file indexes the project for coding agents reading a local copy of it, in the llms.txt format${
			covers.length > 0 ? `: ${covers.join(", then ")}` : ""
		}. Links are relative to this file${
			api.length > 0
				? ", and each API entry links the lines that declare it, directly below its doc comment"
				: ""
		}.`,
		`Keep it current: after changing the public surface, a doc comment, or a guide, run \`${regenerateCommand(
			root,
			target,
		)}\` in this directory and commit the result. When nothing listed here changed, the command leaves the file as it is.`,
	];
	return (
		`${GENERATED_COMMENT_MARK}: edits here are lost the next time \`luaudocs llms\` runs. -->\n` +
		llmsIndex(config.title, config.description ?? home?.tagline, info, sections)
	);
}

export interface LocalLlmsOptions {
	/** Absolute path of the file to write. */
	target: string;
	/** Compare only: report a missing or stale file instead of writing it. */
	check?: boolean;
	/** Pre-rendered model (used by tests), reported the same way as a fresh extraction. */
	rendered?: RenderedModel;
}

export type LocalLlmsOutcome =
	| { status: "written" | "unchanged" | "missing" | "stale" }
	| { status: "failed"; errors: number };

/**
 * Runs `luaudocs llms`: refuses to overwrite a user-owned file, extracts and
 * renders the project, and writes (or compares under `--check`) the target file.
 * Extraction errors abort without writing so a broken file never shrinks the
 * committed API index. Normalizes CRLF when comparing so Windows checkouts
 * neither fail `--check` nor have their line endings flipped.
 */
export async function runLocalLlms(
	context: BuildContext,
	options: LocalLlmsOptions,
): Promise<LocalLlmsOutcome> {
	const { target } = options;
	const previous = existsSync(target) ? readFileSync(target, "utf8") : undefined;
	// Check ownership before spawning anything: without the generated marker,
	// `target` belongs to the user.
	if (previous !== undefined && !isGeneratedFile(previous)) {
		throw new Error(
			`${target} was not written by luaudocs, so it is left alone; pass --out to write the index somewhere else`,
		);
	}
	// Walk guides first, as in `runBuild`, so a malformed `_category_` sidecar
	// throws before spawning the extractor.
	const guides = collectGuides(context.docsDir);
	const { result, counts } = await renderProject(context, options.rendered);
	if (counts.errors > 0) {
		return { status: "failed", errors: counts.errors };
	}
	const content = renderLocalLlms(context, guides, result, target);
	if (previous?.replace(/\r\n/g, "\n") === content) {
		return { status: "unchanged" };
	}
	if (options.check) {
		return { status: previous === undefined ? "missing" : "stale" };
	}
	writeIfChanged(target, content);
	return { status: "written" };
}

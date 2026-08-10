/**
 * The doc model: the wire contract with the Lute extractor (schema v1,
 * documented in extractor/model/init.luau).
 *
 * No runtime field-by-field validator, deliberately: the sole producer is this
 * repo's own extractor, and `regen:docmodels --check` pins both captures
 * byte-for-byte in CI. What a user can hit is a stale model or the wrong file
 * entirely, and that is what parseDocModel checks.
 */

/**
 * One piece of a rendered type or signature display. `id` names a project
 * declaration; an object without one is a candidate the renderer may resolve
 * by text (the @external map, then the Roblox name lists). Joining every
 * piece's text reproduces the display verbatim.
 */
export type Seg = string | { text: string; id?: string };

/** An inline type position: params, returns, prop types, field types, generic defaults. */
export type Inline = Seg[];

/** A type-alias definition: an array of display LINES (no segment contains a newline). */
export type Block = Seg[][];

export interface SourceSpan {
	file: string;
	line: number;
	endLine?: number;
}

export interface Badges {
	custom: string[];
	deprecated?: { version?: string; note?: string };
	since?: string;
	yields?: boolean;
	unreleased?: boolean;
	realm?: Array<"server" | "client" | "plugin">;
}

type Visibility = "public" | "private";

export interface Param {
	name: string;
	type?: Inline;
	doc?: string;
}

export interface Return {
	type?: Inline;
	doc?: string;
}

export interface Signature {
	/** How it is called (`Flux.compute`, `State:Connect`); the display follows it. */
	callee: string;
	/** Everything after the callee (`<T>(x: T): T`), as segments. */
	segs: Inline;
	params: Param[];
	returns: Return[];
}

export interface Fn {
	id: string;
	name: string;
	kind: "function" | "method" | "metamethod";
	doc?: string;
	tags: Badges;
	visibility: Visibility;
	signature: Signature;
	errors: Array<{ type: string; doc?: string }>;
	source: SourceSpan;
}

export interface Prop {
	id: string;
	name: string;
	kind: "prop";
	type?: Inline;
	doc?: string;
	tags: Badges;
	visibility: Visibility;
	readonly: boolean;
	source: SourceSpan;
}

export type Member = Fn | Prop;

export interface Generic {
	name: string;
	isPack: boolean;
	default?: Inline;
}

export interface TypeField {
	name: string;
	type?: Inline;
	doc?: string;
	/** 1-based index into `definition`'s lines; absent when the definition spells no line for it. */
	line?: number;
	/** The line already carries a source comment, so the renderer must not inject the doc again. */
	docInDisplay?: boolean;
}

export interface TypeDecl {
	id: string;
	name: string;
	exported: boolean;
	kind: "alias" | "interface" | "typefunction";
	generics: Generic[];
	/** Absent for tag-declared types with no expression and for `type function`s. */
	definition?: Block;
	/** A `type function`'s parenthesized parameter display, that kind only. */
	params?: Inline;
	fields?: TypeField[];
	doc?: string;
	tags: Badges;
	visibility: Visibility;
	source: SourceSpan;
}

export interface Class {
	id: string;
	name: string;
	doc?: string;
	tags: Badges;
	constructors: string[];
	members: Member[];
	within?: string;
	source: SourceSpan;
}

export interface Reexport {
	/** Doc-model id the inlined member (and its anchor) is keyed on. */
	id: string;
	name: string;
	targetModule: string;
	/** Names something inside targetModule rather than the module itself. */
	targetMember?: string;
	/** The id of what it names there; absent when that module documents no such member. */
	targetId?: string;
	doc?: string;
}

export interface Module {
	/** Project-relative posix path; stable, used in symbol ids and source links. */
	id: string;
	name: string;
	/** Instance path, root-first (rojo tree, else folder layout). */
	instancePath: string[];
	doc?: string;
	/** Marks a passthrough (`return require(X)`): callers are sent to X's page. */
	aliasOf?: string;
	classes: Class[];
	members: Member[];
	types: TypeDecl[];
	reexports: Reexport[];
	source: SourceSpan;
}

export interface Diagnostic {
	severity: "error" | "warning" | "info";
	code: string;
	message: string;
	file?: string;
	line?: number;
}

export interface DocModel {
	schemaVersion: number;
	project: { entryPoints: string[] };
	modules: Module[];
	/** @external-declared type names to docs URLs; absent when no module declares any. */
	externals?: Record<string, string>;
	diagnostics: Diagnostic[];
}

const SCHEMA_VERSION = 1;

/** Parses extractor output, rejecting anything that is not a current model. */
export function parseDocModel(jsonText: string): DocModel {
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch (error) {
		throw new Error(
			`doc model is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("doc model is not a JSON object");
	}
	const version = (parsed as { schemaVersion?: unknown }).schemaVersion;
	if (version !== SCHEMA_VERSION) {
		throw new Error(
			`doc model schemaVersion is ${String(version)}, expected ${SCHEMA_VERSION}; ` +
				"regenerate it with the luaudocs build that will consume it",
		);
	}
	return parsed as DocModel;
}

/**
 * The model as `build --model` writes it. Keys are sorted the way
 * `extractor/emit.luau` sorts them, so a dump diffs against the checked-in
 * captures on content rather than on key order; it is not byte-identical to
 * one, since emit also compacts leaf objects.
 */
export function formatDocModel(model: DocModel): string {
	const sorted = (_key: string, value: unknown): unknown =>
		typeof value !== "object" || value === null || Array.isArray(value)
			? value
			: Object.fromEntries(
					Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
						a < b ? -1 : 1,
					),
				);
	return `${JSON.stringify(model, sorted, "\t")}\n`;
}

/**
 * The doc model: the JSON wire contract with the Lute extractor (`schemaVersion: 1`,
 * documented in `extractor/model/init.luau`).
 *
 * Intentionally omits a field-by-field runtime schema validator: the sole
 * producer is this repo's own extractor, and `regen:docmodels --check` pins both
 * fixture captures byte-for-byte in CI. `parseDocModel` validates what a user
 * can actually hit in practice: invalid JSON, a non-object payload, or a
 * mismatched `schemaVersion`.
 */

/**
 * One segment of a rendered type or signature display. `id` names a declaration
 * in the project; an object without `id` is an unresolved type-position
 * identifier that the renderer may link by text (`@external` mappings first,
 * then Roblox engine types). Concatenating every segment's text reproduces the
 * display string verbatim.
 */
export type Seg = string | { text: string; id?: string };

/** An inline type position: parameters, returns, property types, field types, and generic defaults. */
export type Inline = Seg[];

/** A type-alias definition: an array of display lines (no individual segment contains a newline). */
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
	/** Call prefix (`Flux.compute`, `State:Connect`); `segs` follows immediately after it. */
	callee: string;
	/** Everything after `callee` (`<T>(x: T): T`), as segments. */
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
	/** 1-based line index into `definition`; absent when the definition has no dedicated line for this field. */
	line?: number;
	/** True when the definition line already includes an inline `--` source comment, so the renderer must not splice `doc` above it again. */
	docInDisplay?: boolean;
}

export interface TypeDecl {
	id: string;
	name: string;
	exported: boolean;
	kind: "alias" | "interface" | "typefunction";
	generics: Generic[];
	/** Absent for tag-declared types with no type expression and for `type function` declarations. */
	definition?: Block;
	/** Parenthesized parameter display, present only on `typefunction` declarations. */
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
	/** Doc-model id for the inlined member and its heading anchor. */
	id: string;
	name: string;
	/** Enclosing nested container (`Flux.Clock`, `KA.Shared`) when the re-export lives inside a nested table. */
	within?: string;
	targetModule: string;
	/** Member name inside `targetModule`; absent when mounting the entire module. */
	targetMember?: string;
	/** Target member or class id in `targetModule`; absent when the target module documents no matching member. */
	targetId?: string;
	/** External docs URL for a runtime alias (`[source] aliases`), where `targetModule` is the require path (`@lute/fs`) and `targetId` is absent. */
	url?: string;
	/** Realm where the re-export exists, from a realm guard (`RunService:IsServer() and require(X)`) or a realm tag on its doc comment. */
	realm?: Badges["realm"];
	doc?: string;
}

export interface Module {
	/** Project-relative POSIX file path; stable, used in symbol ids and source links. */
	id: string;
	name: string;
	/** Instance path, root-first (from the Rojo project tree, or folder layout without one). */
	instancePath: string[];
	doc?: string;
	/** Target module id for a passthrough module (`return require(X)`); references resolve to `X`'s page. */
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

/**
 * A name reached through a runtime alias (`[source] aliases`): either a whole
 * runtime module mount (`@lute/fs`) or a type accessed on one (`fs.File`).
 * `alias` and `path` record the require target (`lute`, `fs`), `name` is the
 * exported type name when referencing a type, and `url` is the module page URL
 * derived from the alias's base URL. If the alias also provides a published doc
 * model, the renderer resolves this reference to the exact declaration anchor.
 */
export interface ExternalRef {
	url?: string;
	alias: string;
	path: string;
	name?: string;
}

export interface DocModel {
	schemaVersion: number;
	project: { entryPoints: string[] };
	modules: Module[];
	/**
	 * External names linked by text: `@external` declarations map directly to a
	 * URL string, while runtime-alias references map to an `ExternalRef`.
	 * Absent when empty.
	 */
	externals?: Record<string, string | ExternalRef>;
	diagnostics: Diagnostic[];
}

const SCHEMA_VERSION = 1;

/** Parses extractor JSON output, rejecting anything that is not a current doc model. */
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
 * Formats the doc model for `build --model` and `public/docmodel.json`. Sorts
 * object keys alphabetically like `extractor/emit.luau` so dumps diff cleanly
 * by content rather than key order (though `emit.luau` also compacts leaf objects
 * onto single lines).
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

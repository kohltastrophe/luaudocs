--- Doc-model assembly: combines the module graph, evaluated surfaces, doc
--- blocks, and tags into the doc model in two passes (`./build` per module,
--- then `./finalize` across the whole model).
---
--- Schema v1 (the contract with the TypeScript renderer; versioned so a
--- persisted `doc-model.json` from an older schema fails cleanly on the version
--- check rather than on a missing field):
---   { schemaVersion: 1, project: {entryPoints}, modules: [Module],
---     externals?: {[name]: url | ExternalRef}, diagnostics: [Diagnostic] }
---   externals maps external names that the renderer links by text (omitted when
---     empty): an `@external` declaration maps to its URL string, while a
---     runtime alias (`--alias`), such as a require spelling (`@lute/fs`) or a
---     type reached through one (`fs.File`), maps to an `ExternalRef`
---     `{ url?, alias, path, name? }`.
---   Module { id, name, instancePath: [string], doc?,
---            aliasOf?, classes: [Class], members: [Fn | Prop], types: [TypeDecl],
---            reexports: [Reexport], source }
---     `aliasOf` marks a passthrough module (`return require(X)`): it names `X`,
---     and this module gets no page of its own (callers link to `X`'s page).
---     A module carries top-level `members` just like a class; each member's
---     `kind` (`"prop" | "function" | "method" | "metamethod"`) selects its
---     section heading.
---   Class  { id, name, doc?, tags, constructors: [fnId], members: [Fn | Prop],
---            within?, source }
---   Fn     { id, name, kind, doc?, tags, visibility,
---            signature: {callee, segs, params, returns}, errors, source }
---     `callee` is how the function is called (`Flux.compute`, `State:Connect`);
---     `segs` holds everything after the callee (`<T>(x: T): T`). Concatenating
---     the two reproduces the full signature.
---   Prop   { id, name, kind: "prop", type?, doc?, tags, visibility, readonly, source }
---   Reexport { id, name, targetModule, targetMember?, targetId?, url?,
---              realm?, doc? }
---     Represents a field on a module's surface that came from another module.
---     `targetModule` is the final module after resolving require chains and
---     aliases; `targetMember` names a member inside that module (omitted for a
---     whole-module mount); and `targetId` is that definition's doc-model ID
---     (omitted when the target is undocumented).
---     For a runtime alias (`--alias`), `targetModule` is the require string
---     (`@lute/fs`), `targetId` is omitted, and `url` is the alias's docs URL.
---     `realm` carries any realm badges from a guard (`IsServer() and require(X)`)
---     or an explicit realm tag on the mount's doc block.
---   TypeDecl { id, name, exported, kind: "alias"|"interface"|"typefunction",
---              generics: [Generic], definition?: [[Seg]], params?: [Seg],
---              fields?: [TypeField], doc?, tags, visibility, source }
---     `params` is a `type function`'s parenthesized parameter display (present
---     only when `kind == "typefunction"`).
---     `id` is unique across the model (derived from module ID + AST code name,
---     and deduplicated in `finalize`). Display `name`s can repeat if a placing
---     tag renames a declaration.
---     `definition` is omitted for tag-only types without a type expression
---     (`@interface X` or bare `@type X`), for `@interface` blocks attached to
---     `typeof(...)` aliases (where the `@field` list defines the table shape),
---     and for `type function` declarations.
---   TypeField { name, type?, doc?, line?, docInDisplay? }
---     `line` is a 1-based index into `definition` lines (omitted when `@field`
---     names a field not present in `definition`). `docInDisplay` is `true` when
---     that line in `definition` already contains a source comment, preventing
---     the renderer from splicing the field doc a second time.
---   Seg (every type position): a plain string or `{ text, id? }`. Joining the
---     text of every segment reproduces the type display verbatim. `definition`
---     is an array of lines of `Seg` (no segment contains a newline) so field
---     comments can be spliced by line index. `id` names a project declaration
---     (`TypeDecl`, `Class`, or `Module`); a reference segment without `id`
---     names an external or engine type that the renderer links by text.
---   Generic { name, isPack, default?: [Seg] }.
---   Fn's `signature.params`: `[{ name, type?: [Seg], doc? }]`,
---     `signature.returns`: `[{ type?: [Seg], doc? }]`, and
---     `errors`: `[{ type, doc? }]`.
---   `tags`: `Badges { custom: [string], deprecated?: {version?, note?},
---     since?, yields?, unreleased?, realm?: ["server"|"client"|"plugin"] }`.
---   `visibility`: `"public" | "private"`.
---   `source`: `SourceSpan { file, line, endLine? }`, where `file` is the module ID.
---   `Diagnostic`: `{ severity: "error"|"warning"|"info", code, message, file?, line? }`.
--- Ordering: modules in BFS graph order, members in source order (deterministic).

local graphMod = require("./graph")
local util = require("./util")
local buildPass = require("@self/build")
local finalizePass = require("@self/finalize")
local members = require("@self/members")

type Graph = graphMod.Graph
type Collector = util.Collector

local model = {}

function model.assemble(g: Graph, diag: Collector, opts: { entryPoints: { string }, reportUndocumented: boolean? }): any
	local ctx = members.newCtx(diag)
	ctx.graph = g
	for _, mod in g.modules do
		buildPass.run(ctx, mod)
	end
	finalizePass.run(ctx, g, { reportUndocumented = opts.reportUndocumented })

	-- `emit.encode` automatically skips `__`-prefixed scratch keys, so no
	-- separate stripping pass is needed here.

	return {
		schemaVersion = 1,
		project = { entryPoints = opts.entryPoints },
		modules = ctx.modules,
		-- Omit `externals` when empty so `emit.encode` does not serialize `{}` as `[]`.
		externals = if next(ctx.externals) ~= nil then ctx.externals else nil,
		diagnostics = diag.list,
	}
end

return model

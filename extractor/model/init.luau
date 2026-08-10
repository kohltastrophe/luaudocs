--- Doc-model assembly: graph + surfaces + doc blocks + tags -> the doc model,
--- in two passes (./build per module, then ./finalize over the whole model).
---
--- Schema v1 (the contract with the TS renderer). The version exists so a
--- persisted model that outlives the build that wrote it fails on the version
--- rather than on a field it never carried:
---   { schemaVersion: 1, project: {entryPoints},
---     modules: [Module], externals?: {[name]: url}, diagnostics: [Diagnostic] }
---   externals maps @external-declared type names to docs URLs.
---   Module { id, name, instancePath: [string], doc?,
---            aliasOf?, classes: [Class], members: [Fn | Prop], types: [TypeDecl],
---            reexports: [Reexport], source }
---     aliasOf marks a passthrough (`return require(X)`): it names X, and this
---     module gets no page of its own -- callers are sent to X's.
---     a module carries members like a class does; each member's `kind`
---     ("prop" | "function" | "method" | "metamethod") picks its heading.
---   Class  { id, name, doc?, tags, constructors: [fnId], members: [Fn | Prop],
---            within?, source }
---   Fn     { id, name, kind, doc?, tags, visibility,
---            signature: {callee, segs, params, returns}, errors, source }
---     callee is how it is called (`Flux.compute`, `State:Connect`); segs spell
---     everything after it (`<T>(x: T): T`); concatenate for the full signature.
---   Prop   { id, name, kind: "prop", type?, doc?, tags, visibility, readonly, source }
---   Reexport { id, name, targetModule, targetMember?, targetId?, doc? }: one
---     field of a module's surface that came from another module. targetModule
---     is where the chain ends, alias- and hop-resolved; targetMember names
---     something inside it (absent for a whole-module mount); targetId is that
---     definition's id, absent when the module documents no such member.
---   TypeDecl { id, name, exported, kind: "alias"|"interface"|"typefunction",
---              generics: [Generic], definition?: [[Seg]], params?: [Seg],
---              fields?: [TypeField], doc?, tags, visibility, source }
---     params is a `type function`'s parenthesized parameter display, present
---     only on that kind: it is called like a function, so its fence spells
---     one; the body stays behind the source link.
---     ids are unique model-wide: they derive from the module + CODE name, and
---     finalize's dedupe drops (and diagnoses) extra declarations sharing one.
---     Names are not deduped: a placing tag that renames a decl can spell one
---     name on two ids, each emitted with its own entry.
---     definition is absent for a tag-declared type with no type expression
---     (`@interface X`, bare `@type X`; its fields are the declaration), for an
---     `@interface` whose real declaration spells none of its fields (a
---     `typeof(...)` alias; the dot-fields are the shape there too), and for
---     a `type function`, whose name binds to no type expression at all.
---   TypeField { name, type?, doc?, line?, docInDisplay? }: line is a 1-based
---     index into definition's lines, absent when the definition spells no line
---     for the field (`@field` naming nothing it shows). docInDisplay marks a
---     field whose line already carries a source comment there, so the renderer
---     does not inject its doc a second time.
---   Seg (every type position): a plain string, or { text, id? }. Joining every
---     piece's text reproduces the display verbatim; a definition is an array
---     of LINES of Seg (no segment contains a newline), so injecting a field
---     doc is a line splice. `id` names a project declaration, usually a
---     TypeDecl but sometimes a Class or Module. An object with no id is a name
---     the project does not declare: the renderer may link it by text
---     (@external map, then Roblox names) but never re-resolves it against
---     project symbols, because resolution is the extractor's half of the tool.
---   Generic { name, isPack, default?: [Seg] }.
---   Fn's signature.params: [{ name, type?: [Seg], doc? }], signature.returns:
---     [{ type?: [Seg], doc? }], and errors: [{ type, doc? }].
---   tags is everywhere Badges { custom: [string], deprecated?: {version?, note?},
---     since?, yields?, unreleased?, realm?: ["server"|"client"|"plugin"] }.
---   visibility is "public" | "private". source is SourceSpan { file, line,
---     endLine? }, file being the module id.
---   Diagnostic { severity: "error"|"warning"|"info", code, message, file?, line? }.
--- Ordering: modules in graph (BFS) order, members in source order; deterministic.

local graphMod = require("./graph")
local util = require("./util")
local buildPass = require("@self/build")
local finalizePass = require("@self/finalize")
local members = require("@self/members")

type Graph = graphMod.Graph
type Collector = util.Collector

local model = {}

function model.assemble(g: Graph, diag: Collector, opts: { entryPoints: { string } }): any
	local ctx = members.newCtx(diag)
	ctx.graph = g
	for _, mod in g.modules do
		buildPass.run(ctx, mod)
	end
	finalizePass.run(ctx, g)

	-- no stripping pass: emit.encode drops every `__`-prefixed key, so no
	-- assembly-internal field can reach the wire

	return {
		schemaVersion = 1,
		project = { entryPoints = opts.entryPoints },
		modules = ctx.modules,
		-- omitted when empty: an empty Lua table would encode as [] on the wire
		externals = if next(ctx.externals) ~= nil then ctx.externals else nil,
		diagnostics = diag.list,
	}
end

return model

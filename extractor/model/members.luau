--- Shared assembly context + member building: the Ctx every pass threads, the
--- small builders they all share (ids, spans, badges, visibility, memoized
--- doc-block parsing), and the member builders (signatures assembled from
--- segments, functions, props, containers, the recursive walk over a table
--- SymValue's fields).
---
--- The context lives here because build and finalize both need it and Luau
--- requires may not cycle: the shared floor sits below both.

local comments = require("../comments")
local detectMod = require("../detect")
local emitMod = require("../emit")
local graphMod = require("../graph")
local inferMod = require("../infer")
local segs = require("../segs")
local surfaceMod = require("../surface")
local tagsMod = require("../tags")
local util = require("../util")

type Collector = util.Collector
export type ParsedDoc = tagsMod.ParsedDoc
export type ModuleData = graphMod.ModuleData
type Seg = segs.Seg

local members = {}

local EMPTY_DOC: ParsedDoc = tagsMod.parse({})
members.EMPTY_DOC = EMPTY_DOC

export type Ctx = {
	diag: Collector,
	modules: { any }, -- doc-model Module entries, parallel to g.modules
	containersByName: { [string]: any }, -- class/module name -> container entry
	containerOfSym: { [any]: any }, -- class table SymValue -> class entry
	classByTypeId: { [string]: any }, -- classType type-id -> class entry
	-- module id -> (type name -> the decl id a ref naming one resolves to). Ids
	-- rather than a presence flag: dedupe settles which declaration owns a name
	-- two of them spell, and every ref reads that decision from here.
	typesByModule: { [string]: { [string]: string } },
	externals: { [string]: string }, -- @external name -> docs url, first declaration wins
	-- a member without `__valueSym` is a tag-declared stub (no code behind
	-- it), which may always merge into an existing member; a code member may
	-- only merge into another name for the same value (see finalize's moves).
	-- `targetContainer` pins a move to a specific container object: a floating
	-- member with no @within belongs to its OWN module's container, not
	-- another module's same-named one.
	pendingMoves: {
		{
			member: any,
			targetName: string,
			fromModule: string,
			targetContainer: any?,
		}
	},
	docCache: { [any]: ParsedDoc }, -- doc block -> its ParsedDoc
	forwardedBlocks: { [any]: boolean }, -- blocks whose tag diagnostics already reported
	-- the module graph, set by model.assemble: detect resolves calls across
	-- modules through it. Absent (policy tests), detection stops at requires.
	graph: any?,
}

function members.newCtx(diag: Collector): Ctx
	return {
		diag = diag,
		modules = {},
		containersByName = {},
		containerOfSym = {},
		classByTypeId = {},
		typesByModule = {},
		externals = {},
		pendingMoves = {},
		docCache = {},
		forwardedBlocks = {},
	}
end

function members.span(modId: string, s: any): any
	if s == nil then
		return { file = modId, line = 1 }
	end
	return { file = modId, line = s.beginLine, endLine = if s.endLine ~= s.beginLine then s.endLine else nil }
end

function members.buildBadges(doc: ParsedDoc): any
	-- cloned: undocumented members all share EMPTY_DOC, and the overlay below
	-- mutates badges.custom in place
	local badges: any = { custom = table.clone(doc.customTags) }
	if doc.deprecated ~= nil then
		badges.deprecated = { version = doc.deprecated.version, note = doc.deprecated.desc }
		if next(badges.deprecated) == nil then
			-- a bare @deprecated still reaches the wire as an object
			emitMod.record(badges.deprecated)
		end
	end
	if doc.since ~= nil then
		badges.since = doc.since
	end
	if doc.flags.yields then
		badges.yields = true
	end
	if doc.flags.unreleased then
		badges.unreleased = true
	end
	badges.realm = tagsMod.realmList(doc.flags)
	return badges
end

--- Merges tag-declared badges into code-discovered ones: first-wins except
--- `custom`, which is unioned. The keys are spelled out because `deprecated`
--- and `realm` are a record and a list, so a generic walk would have to guess
--- which shape it is merging. Beside the builder on purpose: the two spell one
--- vocabulary, and a badge added to only one of them silently goes missing on
--- every @within-merged member.
function members.overlayBadges(into: any, from: any)
	into.deprecated = into.deprecated or from.deprecated
	into.since = into.since or from.since
	into.yields = into.yields or from.yields
	into.unreleased = into.unreleased or from.unreleased
	into.realm = into.realm or from.realm
	for _, tag in from.custom do
		if table.find(into.custom, tag) == nil then
			table.insert(into.custom, tag)
		end
	end
end

--- The `_`-prefix privacy convention, in one place. `@private` always wins.
--- `exempt` overrides the prefix in two cases: an explicit `export`, and a
--- `__`-named *function*, which is a documented metamethod. Metamethod-ness
--- stays a call-site test because only the function paths may claim it: a
--- `__`-named data property is plumbing.
function members.visibilityOf(name: string, doc: ParsedDoc, exempt: boolean?): string
	if doc.flags.private then
		return "private"
	end
	if exempt == true then
		return "public"
	end
	return if name:sub(1, 1) == "_" then "private" else "public"
end

--- Doc-model id: `<moduleId>#<kind>.<qualified name>`, where the qualified name
--- is `Container.member` for members and the bare name for classes and types.
--- Every id is built here, so an `@within` move rebuilds rather than rewrites.
function members.memberId(modId: string, kind: string, container: string?, name: string): string
	local qualified = if container ~= nil and container ~= "" then container .. "." .. name else name
	return modId .. "#" .. kind .. "." .. qualified
end

--- Lua's reserved words (`continue` is contextual, so not here): `T.end` is a
--- parse error, `T["end"]` is how source reaches it. Mirrors LUAU_KEYWORDS in
--- src/render.ts, which spells prop fences the same way.
local LUAU_KEYWORDS: { [string]: boolean } = {}
for _, word in
	{
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
	}
do
	LUAU_KEYWORDS[word] = true
end

local function isIdentName(name: string): boolean
	return name:match("^[%a_][%w_]*$") ~= nil and LUAU_KEYWORDS[name] == nil
end

--- How a member is called (`Flux.compute`, `State:Connect`), bare for a
--- callable module. Signature assembly and finalize's @within retarget must
--- spell it the same way. A name no identifier can spell (`["12187368317"]`, `["end"]`) gets bracket
--- access; the colon accessor keeps the plain join, since a method cannot
--- carry such a name.
function members.callee(container: string, accessor: string, name: string): string
	if container == "" then
		return name
	end
	if accessor == "." and not isIdentName(name) then
		return string.format("%s[%q]", container, name)
	end
	return container .. accessor .. name
end

--- Identity key for container bookkeeping. A cast clones a SymValue but shares
--- its `fields` (tables) or `fnNode` (functions), so those are the identity:
--- two SymValues sharing one are two names for one thing.
function members.symKey(value: any): any
	if value == nil then
		return value
	end
	if value.fields ~= nil then
		return value.fields
	end
	if value.fnNode ~= nil then
		return value.fnNode
	end
	return value
end

--- Every member a module entry owns, its own plus each class's, with the
--- container it landed on. A module carries members like a class does (a
--- `function M:method`, a documented `__call`, an `@within` move landing
--- there).
function members.eachMember(entry: any, visit: (member: any, owner: any) -> ())
	for _, member in entry.members do
		visit(member, entry)
	end
	for _, class in entry.classes do
		for _, member in class.members do
			visit(member, class)
		end
	end
end

--- Registers a container under a name for `@within` targeting. First one wins:
--- a later same-named container must not capture moves aimed at the first.
function members.registerContainer(ctx: Ctx, name: string, container: any)
	if ctx.containersByName[name] == nil then
		ctx.containersByName[name] = container
	end
end

function members.mergeDescs(primary: string?, secondary: string?): string?
	if primary == nil or primary == "" then
		return if secondary ~= nil and secondary ~= "" then secondary else nil
	end
	if secondary == nil or secondary == "" or secondary == primary then
		return primary
	end
	return primary .. "\n\n" .. secondary
end

--- The block's prose merged with the trailing ` -- desc` on the @type line, so
--- a floating declaration cannot drop what the code-backed path keeps.
function members.placingDoc(doc: ParsedDoc): string?
	return members.mergeDescs(if doc.desc ~= "" then doc.desc else nil, doc.placingDesc)
end

function members.forwardTagDiagnostics(ctx: Ctx, modId: string, block: any, doc: ParsedDoc)
	-- once per block, not once per reader: several members may share one block
	-- (aliased exports fall back to the same defDoc)
	if ctx.forwardedBlocks[block] then
		return
	end
	ctx.forwardedBlocks[block] = true
	for _, d in doc.diagnostics do
		-- contentLine, not span.beginLine: `--[=[ ]=]` openers and leading
		-- blanks are stripped from content, so offsets are content-relative
		local line = block.contentLine + d.lineOffset - 1
		if d.severity == "info" then
			ctx.diag:info(d.code, d.message, modId, line)
		else
			ctx.diag:warn(d.code, d.message, modId, line)
		end
	end
end

--- One parse per block serves every pass: ParsedDoc is immutable once
--- tags.parse returns.
function members.parseTags(ctx: Ctx, block: any): ParsedDoc
	local cached = ctx.docCache[block]
	if cached == nil then
		cached = tagsMod.parse(block.content)
		ctx.docCache[block] = cached
	end
	return cached
end

function members.parseBlock(ctx: Ctx, modId: string, block: any?): ParsedDoc
	if block == nil then
		return EMPTY_DOC
	end
	local doc = members.parseTags(ctx, block)
	members.forwardTagDiagnostics(ctx, modId, block, doc)
	return doc
end

--- segs.fromTag with the nil-display convention every tag position shares.
function members.tagType(display: string?, generics: { [string]: boolean }?): { Seg }?
	return if display ~= nil then segs.fromTag(display, generics) else nil
end

--- The type nodes a function annotates itself returning, in order. Lute spells
--- the annotation three ways (a parenthesized list, a variadic, or the one type
--- on its own) and an unhandled shape silently drops the return, so the three
--- live here rather than in each caller that has to read them.
function members.returnNodes(fnNode: any?): { any }
	local returnAnnotation = if fnNode ~= nil then fnNode.returnAnnotation else nil
	if returnAnnotation == nil then
		return {}
	end
	local nodes: { any } = {}
	if returnAnnotation.tag == "explicit" and returnAnnotation.types ~= nil then
		for _, pair in returnAnnotation.types do
			if pair.node ~= nil then
				table.insert(nodes, pair.node)
			end
		end
	elseif returnAnnotation.tag == "variadic" then
		table.insert(nodes, returnAnnotation.type)
	else
		table.insert(nodes, returnAnnotation)
	end
	return nodes
end

local function buildSignature(
	ctx: Ctx,
	mod: ModuleData,
	containerName: string,
	name: string,
	accessor: string,
	fnNode: any?,
	doc: ParsedDoc,
	memberLine: number?
): any
	local qualified = if containerName == "" then name else containerName .. "." .. name
	local parsedFile = mod.parsed :: any
	local generics: { any } = {}
	local genericNames: { [string]: boolean } = {}
	if fnNode ~= nil then
		generics, genericNames = segs.generics(parsedFile, fnNode.generics, fnNode.genericPacks)
	end

	local params: { any } = {}
	local paramLines: { [number]: number } = {}
	if fnNode ~= nil then
		params, paramLines = segs.paramEntries(parsedFile, fnNode, genericNames)
		-- a trailing comment on a parameter's own line documents it, the way
		-- prop and type-field trailers do. The signature's opening line is
		-- excluded (a comment there reads as the function's), so is the line
		-- the return annotation starts on (it reads as the return's), and a
		-- line several parameters share documents only the last of them.
		local sigLine = if fnNode.location ~= nil then fnNode.location.beginLine else nil
		local ra = fnNode.returnAnnotation
		local retLine = if ra ~= nil and ra.location ~= nil then ra.location.beginLine else nil
		for i, param in params do
			local line = paramLines[i]
			if line ~= nil and line ~= sigLine and line ~= retLine and (i == #params or paramLines[i + 1] ~= line) then
				param.doc = comments.trailingText(mod.trailingIndex :: any, line)
			end
		end
	end

	local returnAnnotation = if fnNode ~= nil then fnNode.returnAnnotation else nil
	local returns: { any } = {}
	for _, node in members.returnNodes(fnNode) do
		table.insert(returns, { type = segs.inline(parsedFile, node, genericNames) })
	end

	-- merge @param tags by name; an explicit type overrides, and an unknown name
	-- appends when there is no code signature, otherwise warns
	for _, tagParam in doc.params do
		local found: any = nil
		for _, p in params do
			if p.name == tagParam.name then
				found = p
				break
			end
		end
		if found ~= nil then
			-- the tag wins; a type-only @param must not erase a trailing doc
			found.doc = tagParam.desc or found.doc
			if tagParam.type ~= nil then
				found.type = members.tagType(tagParam.type, genericNames)
			end
		elseif fnNode == nil then
			table.insert(params, {
				name = tagParam.name,
				type = members.tagType(tagParam.type, genericNames),
				doc = tagParam.desc,
			})
		else
			ctx.diag:warn(
				"param-mismatch",
				string.format("@param %s does not match any parameter of %s", tagParam.name, qualified),
				mod.id,
				memberLine
			)
		end
	end

	-- merge @return tags positionally; append beyond inferred when unannotated
	for i, tagReturn in doc.returns do
		local target = returns[i]
		if target ~= nil then
			target.doc = tagReturn.desc
			if tagReturn.type ~= nil then
				target.type = members.tagType(tagReturn.type, genericNames)
			end
		elseif #returns == 0 or returnAnnotation == nil then
			local row: any = {
				type = members.tagType(tagReturn.type, genericNames),
				doc = tagReturn.desc,
			}
			if next(row) == nil then
				-- a bare @return holds its position as an object on the wire
				emitMod.record(row)
			end
			table.insert(returns, row)
		else
			ctx.diag:warn(
				"return-count-mismatch",
				string.format("@return #%d exceeds the annotated returns of %s", i, qualified),
				mod.id,
				memberLine
			)
		end
	end

	-- the whole annotation, not the per-return types: `): (Widget, string)` is
	-- one slice, and `returns` splits it into entries that spell no parentheses
	local returnTail = if returnAnnotation ~= nil then segs.inline(parsedFile, returnAnnotation, genericNames) else nil
	local sig = segs.signature(generics, params, returnTail)
	-- callee and display stay apart: a re-export renames the function, so the
	-- renderer swaps the callee and leaves the display untouched
	return {
		callee = members.callee(containerName, accessor, name),
		segs = segs.canonical(sig),
		params = params,
		returns = returns,
	}
end

--- Routes tag-declared and callable-module members through buildFn/buildProp,
--- the same path code-discovered members take, so the two cannot drift.
function members.pseudoField(name: string, value: any, isColonMethod: boolean, span: any): any
	return { name = name, value = value, isColonMethod = isColonMethod, keySpan = span, defSpan = span }
end

--- The CST local binding behind `setmetatable(x, Class)`'s second argument when
--- it is a plain local reference: the class-table shape both the constructor
--- and classType idioms match on.
function members.setmetatableClassLocal(callNode: any): any?
	if callNode == nil or callNode.tag ~= "call" then
		return nil
	end
	local func = callNode.func
	if func == nil or func.tag ~= "global" or func.name.text ~= "setmetatable" then
		return nil
	end
	local args = callNode.arguments
	local second = args and args[2]
	if second == nil or second.node == nil or second.node.tag ~= "local" then
		return nil
	end
	return second.node["local"]
end

--- Detects `return setmetatable(_, Class)` constructors (same module).
local function constructedSym(mod: ModuleData, fnNode: any): any?
	if fnNode == nil or fnNode.body == nil or fnNode.body.statements == nil then
		return nil
	end
	local stats = fnNode.body.statements
	local last = stats[#stats]
	if last == nil or last.tag ~= "return" or last.expressions == nil then
		return nil
	end
	local first = last.expressions[1]
	if first == nil or first.node == nil then
		return nil
	end
	local classLocal = members.setmetatableClassLocal(first.node)
	if classLocal == nil then
		return nil
	end
	local env = (mod.surface :: any).env
	return env[classLocal]
end

function members.buildFn(
	ctx: Ctx,
	mod: ModuleData,
	containerName: string,
	field: any,
	doc: ParsedDoc,
	secondaryDesc: string?,
	ownerSym: any?
): any
	local name = field.name
	local isColon = field.isColonMethod
	local isMetamethod = surfaceMod.isMetamethod(name)
	local placingKind = if doc.placing ~= nil then doc.placing.kind else nil
	local kind = "function"
	if isMetamethod then
		kind = "metamethod"
	elseif isColon or placingKind == "method" then
		kind = "method"
	end
	if placingKind == "function" then
		kind = "function"
	end
	local accessor = if kind == "method" then ":" else "."
	local fnNode = field.value.fnNode
	local memberLine = field.defSpan and field.defSpan.beginLine
	local visibility = members.visibilityOf(name, doc, isMetamethod)

	local fn = {
		id = members.memberId(mod.id, "fn", containerName, name),
		name = name,
		kind = kind,
		doc = members.mergeDescs(doc.desc, secondaryDesc),
		tags = members.buildBadges(doc),
		visibility = visibility,
		signature = buildSignature(ctx, mod, containerName, name, accessor, fnNode, doc, memberLine),
		errors = {},
		source = members.span(mod.id, field.defSpan),
	}
	for _, err in doc.errors do
		table.insert(fn.errors, { type = err.type, doc = err.desc })
	end
	-- code-signal badges fill only what the block left unsaid: an explicit
	-- realm tag overrides detection, @yields simply agrees with it, and a
	-- slot the block already filled skips its walk entirely
	if fn.tags.yields ~= true and detectMod.yields(ctx.graph, mod, fnNode, ownerSym) then
		fn.tags.yields = true
	end
	if fn.tags.realm == nil then
		fn.tags.realm = detectMod.realm(ctx.graph, mod, fnNode, ownerSym)
	end
	local sym = constructedSym(mod, fnNode)
	if sym ~= nil then
		fn.__constructsSym = sym
	end
	return fn
end

--- A value this model already documents as a container, named as its own type.
--- `Z.boolean = Z.bool` is one table under two names; only the first became the
--- section, and the second renders bare beside it unless typed as the link.
--- (Across modules that is a re-export, which names the hop it crossed.)
---
--- By id, not by name: a container's is minted once in newContainer and never
--- re-minted, where two modules may spell one name.
local function containerType(ctx: Ctx, value: any): { Seg }?
	if value.kind ~= "table" then
		return nil
	end
	local container = ctx.containerOfSym[members.symKey(value)]
	return if container ~= nil then { { text = container.name, id = container.id } } else nil
end

function members.buildProp(
	ctx: Ctx,
	mod: ModuleData,
	containerName: string,
	field: any,
	doc: ParsedDoc,
	secondaryDesc: string?,
	ownerSym: any?
): any
	local name = field.name
	local visibility = members.visibilityOf(name, doc)
	local parsedFile = mod.parsed :: any

	-- a `@prop x Widget` type is tag-authored like any other and resolves the
	-- same way; failing every declaration, the value itself is asked
	local typeNode = field.declaredType or field.value.castType or field.value.annotation
	local typeSegs: { Seg }? = nil
	local inferred = false
	if doc.placingType ~= nil then
		typeSegs = members.tagType(doc.placingType, nil)
	elseif typeNode ~= nil then
		typeSegs = segs.inline(parsedFile, typeNode, nil)
	else
		typeSegs = containerType(ctx, field.value) or inferMod.fromValue(field.value)
		inferred = typeSegs ~= nil
	end

	local desc = members.mergeDescs(doc.desc, secondaryDesc)
	if desc == nil and field.trailingDesc ~= nil then
		desc = field.trailingDesc
	end
	desc = members.mergeDescs(desc, doc.placingDesc)

	local badges = members.buildBadges(doc)
	-- as in buildFn: the code signal fills only the slot the block left unsaid
	local mountRealm = false
	if badges.realm == nil then
		badges.realm = detectMod.propRealm(field.value)
		mountRealm = badges.realm ~= nil
	end

	return {
		id = members.memberId(mod.id, "prop", containerName, name),
		name = name,
		kind = "prop",
		type = typeSegs,
		doc = desc,
		tags = badges,
		visibility = visibility,
		readonly = doc.flags.readonly == true or detectMod.propReadonly(mod, ownerSym, name),
		source = members.span(mod.id, field.defSpan),
		-- the weakest of the three: a floating `@prop x T` merging in later
		-- outranks whatever the value happens to be made of
		__inferred = if inferred then true else nil,
		-- a call this pass cannot see across: finalize types it from what the
		-- callee returns. Unguarded, since `IsServer and Registry.new()` keeps
		-- its callee under the guard; finalize unguards the same way.
		__inferCall = if typeSegs == nil and surfaceMod.unguard(field.value).calleeValue ~= nil
			then field.value
			else nil,
		-- detected, not authored: finalize withdraws it if the callee turns out
		-- to return a boolean, which makes the guard a predicate rather than a
		-- mount. A `@server` the author wrote stands either way.
		__mountRealm = if mountRealm then true else nil,
	}
end

function members.newContainer(
	ctx: Ctx,
	mod: ModuleData,
	name: string,
	doc: ParsedDoc,
	sourceSpan: any,
	within: string?
): any
	local class = {
		-- a nested class's id carries the qualified spelling, so same-named
		-- tables under different parents cannot collide
		id = members.memberId(mod.id, "class", within, name),
		name = name,
		doc = if doc.desc ~= "" then doc.desc else nil,
		tags = members.buildBadges(doc),
		constructors = {},
		members = {},
		within = within,
		source = members.span(mod.id, sourceSpan),
	}
	members.registerContainer(ctx, name, class)
	if within ~= nil then
		-- `@within Color.Oklab` must resolve as readily as `@within Oklab`
		members.registerContainer(ctx, within .. "." .. name, class)
	end
	return class
end

--- Members land on the container itself; classes and re-exports always belong
--- to the module, wherever they are discovered, so a class passes those on.
function members.sinks(container: any, from: any): any
	return {
		members = container.members,
		classes = from.classes,
		reexports = from.reexports,
	}
end

--- By priority: a later `function M.f` definition, the table field, then the
--- value's own definition (`local function f` exported as `return { f = f }`).
function members.docBlockOf(field: any): any?
	return field.defDoc or field.fieldDoc or (field.value :: any).defDoc
end

--- `ownerSym` overrides which table the members' `self` (and readonly signal)
--- resolves against: metamethods iterate the metatable's fields but run with
--- `self` bound to the table it is attached to.
function members.buildMembers(ctx: Ctx, mod: ModuleData, containerName: string, sym: any, out: any, ownerSym: any?)
	local owner = ownerSym or sym
	for _, field in sym.fields do
		-- a dotted name can only come from a string key (`M["A.b"]`), and dots
		-- join the id grammar: an id for it would collide with a nested
		-- container's member (`M.A.b`)
		if field.name:find(".", 1, true) ~= nil then
			continue
		end
		local block = members.docBlockOf(field)
		local doc = members.parseBlock(ctx, mod.id, block)
		local secondaryDesc: string? = nil
		if field.defDoc ~= nil and field.fieldDoc ~= nil then
			local fieldParsed = members.parseBlock(ctx, mod.id, field.fieldDoc)
			secondaryDesc = fieldParsed.desc
		end
		if doc.flags.ignore then
			continue
		end

		local member: any = nil
		local value = field.value

		if value.kind == "require" or value.kind == "import" then
			-- a member import re-exports through its require's target module.
			-- One whose target never resolved is no re-export, so it falls
			-- through to the plain-prop tail below like any other value.
			local base = if value.kind == "import" then value.base else value
			local targetModule = if base ~= nil then mod.requireTargets[base] else nil
			if targetModule ~= nil then
				table.insert(out.reexports, {
					id = members.memberId(mod.id, "reexport", nil, field.name),
					name = field.name,
					targetModule = targetModule,
					targetMember = if value.kind == "import" then table.concat(value.path :: any, ".") else nil,
					doc = if doc.desc ~= "" then doc.desc else nil,
					-- as segments: splitting targetMember back apart would give
					-- the path two spellings
					__path = if value.kind == "import" then value.path else nil,
					__line = field.keySpan.beginLine,
				})
				continue
			end
		end

		if value.kind == "function" then
			if block == nil and surfaceMod.isMetamethod(field.name) then
				continue -- undocumented metamethods are noise
			end
			member = members.buildFn(ctx, mod, containerName, field, doc, secondaryDesc, owner)
		elseif
			value.kind == "table"
			and field.declaredType == nil
			and value.castType == nil
			and value.annotation == nil
			and #value.fields > 0
			-- already a container elsewhere (including cyclic references, which
			-- would recurse forever): document as a plain prop instead
			and ctx.containerOfSym[members.symKey(value)] == nil
			-- a class entry carries no visibility, so a private table would
			-- become a section with public members; a prop keeps the
			-- `_`-prefix and @private rule working
			and members.visibilityOf(field.name, doc) == "public"
		then
			local nestedName = containerName .. "." .. field.name
			local nested = members.newContainer(ctx, mod, field.name, doc, field.defSpan, containerName)
			ctx.containerOfSym[members.symKey(value)] = nested
			members.buildMembers(ctx, mod, nestedName, value, members.sinks(nested, out))
			table.insert(out.classes, nested)
			continue
		else
			member = members.buildProp(ctx, mod, containerName, field, doc, secondaryDesc, owner)
		end

		-- the value is the member's identity: an alias (`Target.run = Impl.run`)
		-- binds a second name to one value, which the finalize moves must tell
		-- apart from two members landing on one name
		member.__valueSym = members.symKey(value)

		if doc.within ~= nil and doc.within ~= containerName then
			table.insert(ctx.pendingMoves, { member = member, targetName = doc.within, fromModule = mod.id })
			continue
		end

		table.insert(out.members, member)
	end
end

return members

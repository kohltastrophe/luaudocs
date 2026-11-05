--- Shared assembly context and member builders. Holds the `Ctx` threaded through
--- every pass, shared helpers (IDs, source spans, badges, visibility, and
--- memoized doc-block parsing), and the member builders (signatures, functions,
--- properties, containers, and the recursive walk over a table `SymValue`'s fields).
---
--- `Ctx` lives here because both `build` and `finalize` depend on it and Luau
--- requires cannot cycle.

local comments = require("../comments")
local detectMod = require("../detect")
local emitMod = require("../emit")
local graphMod = require("../graph")
local inferMod = require("../infer")
local parseMod = require("../parse")
local segs = require("../segs")
local surfaceMod = require("../surface")
local tagsMod = require("../tags")
local util = require("../util")

type Collector = util.Collector
export type ParsedDoc = tagsMod.ParsedDoc
export type ModuleData = graphMod.ModuleData
type Seg = segs.Seg
type DocBlock = comments.DocBlock
type Span = parseMod.Span
type SymValue = surfaceMod.SymValue
type SymField = surfaceMod.SymField

export type SourceSpan = {
	file: string,
	line: number,
	endLine: number?,
}

export type Badges = {
	custom: { string },
	deprecated: { version: string?, note: string? }?,
	since: string?,
	yields: boolean?,
	unreleased: boolean?,
	realm: { string }?,
}

export type ParamEntry = {
	name: string,
	type: { Seg }?,
	doc: string?,
}

export type ReturnEntry = {
	type: { Seg }?,
	doc: string?,
}

export type Signature = {
	callee: string,
	segs: { Seg },
	params: { ParamEntry },
	returns: { ReturnEntry },
	__generics: { segs.Generic }?,
	__genericNames: { [string]: boolean }?,
	__annotationTail: { Seg }?,
	__tagReturns: boolean?,
	__hasCodeParams: boolean?,
	__accessor: string?,
}

export type FnMember = {
	id: string,
	name: string,
	kind: string,
	doc: string?,
	tags: Badges,
	visibility: string,
	signature: Signature,
	errors: { { type: string?, doc: string? } },
	source: SourceSpan,
	__valueSym: SymValue?,
	__constructsSym: SymValue?,
	__returnedRequire: string?,
}

export type PropMember = {
	id: string,
	name: string,
	kind: string,
	type: { Seg }?,
	doc: string?,
	tags: Badges,
	visibility: string,
	readonly: boolean,
	source: SourceSpan,
	__valueSym: SymValue?,
	__inferred: boolean?,
	__inferCall: SymValue?,
	__mountRealm: boolean?,
}

export type Member = FnMember | PropMember

export type ClassEntry = {
	id: string,
	name: string,
	doc: string?,
	tags: Badges,
	constructors: { string },
	members: { any },
	within: string?,
	source: SourceSpan,
	__kind: string?,
	__moduleId: string?,
	__valueSym: SymValue?,
}

local members = {}

local EMPTY_DOC: ParsedDoc = tagsMod.parse({})
members.EMPTY_DOC = EMPTY_DOC

export type ExternalEntry = string | { url: string?, alias: string, path: string, name: string? }

export type Ctx = {
	diag: Collector,
	modules: { any }, -- doc-model Module entries, parallel to g.modules
	containersByName: { [string]: any }, -- class/module name -> container entry
	containerOfSym: { [any]: ClassEntry }, -- class table SymValue -> class entry
	classByTypeId: { [string]: ClassEntry }, -- classType type-id -> class entry
	-- module id -> (type name -> declaration id). Stores the resolved declaration
	-- id rather than a boolean so `finalize`'s type deduplication can settle
	-- which declaration owns a duplicate name in one place.
	typesByModule: { [string]: { [string]: string } },
	-- Ambient `.d.luau` class names -> declaration id (resolved across `.d.luau` files without `require`).
	ambientTypes: { [string]: string },
	-- Unresolved external names -> `@external` URL string or runtime-alias ExternalRef (first wins).
	externals: { [string]: ExternalEntry },
	-- Pending `@within` relocations. A member without `__valueSym` is a
	-- tag-declared stub (with no backing code) that can merge into any existing
	-- member of the same name, whereas a code-backed member can only merge into an alias
	-- of the same `SymValue`. `targetContainer` pins a floating member without
	-- `@within` to its own module's root container rather than a same-named
	-- container in another module.
	pendingMoves: {
		{
			member: any,
			targetName: string,
			fromModule: string,
			targetContainer: any?,
		}
	},
	forwardedBlocks: { [DocBlock]: boolean }, -- blocks whose tag diagnostics have already been reported
	-- Module graph set by `model.assemble` so `detect` can follow calls across
	-- modules (absent in isolated unit tests).
	graph: graphMod.Graph?,
}

function members.newCtx(diag: Collector): Ctx
	return {
		diag = diag,
		modules = {},
		containersByName = {},
		containerOfSym = {},
		classByTypeId = {},
		typesByModule = {},
		ambientTypes = {},
		externals = {},
		pendingMoves = {},
		forwardedBlocks = {},
	}
end

function members.span(modId: string, s: Span?): SourceSpan
	if s == nil then
		return { file = modId, line = 1 }
	end
	return { file = modId, line = s.beginLine, endLine = if s.endLine ~= s.beginLine then s.endLine else nil }
end

function members.buildBadges(doc: ParsedDoc): Badges
	-- Clone `customTags` because undocumented members share `EMPTY_DOC`, and
	-- `overlayBadges` mutates `badges.custom` in place.
	local badges: Badges = { custom = table.clone(doc.customTags) }
	if doc.deprecated ~= nil then
		local dep = { version = doc.deprecated.version, note = doc.deprecated.desc }
		if next(dep) == nil then
			-- Mark bare `@deprecated` tables so `emit` encodes `{}` instead of `[]`.
			emitMod.record(dep)
		end
		badges.deprecated = dep
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

--- Merges tag-declared badges into code-discovered badges (first-wins, except
--- `custom`, which is unioned). Kept adjacent to `buildBadges` so any new badge
--- field is updated in both functions together.
function members.overlayBadges(into: Badges, from: Badges)
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

--- Applies the `_`-prefix privacy rule in one place. `@private` always wins.
--- `exempt` overrides the `_` prefix for explicit `export type` declarations
--- and `__`-prefixed metamethod functions (whereas `__`-prefixed data properties
--- like `__index` remain private).
function members.visibilityOf(name: string, doc: ParsedDoc, exempt: boolean?): string
	if doc.flags.private then
		return "private"
	end
	if exempt == true then
		return "public"
	end
	return if name:sub(1, 1) == "_" then "private" else "public"
end

--- Formats a doc-model ID (`<moduleId>#<kind>.<qualified name>`), where the
--- qualified name is `Container.member` for members and the bare name for
--- classes and types.
function members.memberId(modId: string, kind: string, container: string?, name: string): string
	local qualified = if container ~= nil and container ~= "" then container .. "." .. name else name
	return modId .. "#" .. kind .. "." .. qualified
end

--- Luau reserved keywords (`continue` is contextual, so it is excluded).
--- `T.end` is a syntax error, so bracket access `T["end"]` is required.
--- Mirrors `LUAU_KEYWORDS` in `src/pages.ts`.
local LUAU_KEYWORDS = parseMod.LUAU_KEYWORDS

local function isIdentName(name: string): boolean
	return name:match("^[%a_][%w_]*$") ~= nil and LUAU_KEYWORDS[name] == nil
end

--- Formats a member's callee prefix (`Flux.compute`, `State:Connect`, or bare
--- `name` for a callable module). Non-identifier property names (`"12187368317"`,
--- `"end"`) use bracket syntax `Container["name"]`.
function members.callee(container: string, accessor: string, name: string): string
	if container == "" then
		return name
	end
	if accessor == "." and not isIdentName(name) then
		return string.format("%s[%q]", container, name)
	end
	return container .. accessor .. name
end

--- Returns the identity key for a `SymValue`. Because type casts clone a
--- `SymValue` while sharing its `fields` table or `fnNode`, keying by `fields`
--- or `fnNode` treats cast clones as the same underlying value.
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

--- Visits every member owned by a module entry (both top-level module members
--- and class members), passing the member and its owning container.
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

--- Registers a container by name for `@within` resolution (first registration wins).
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

--- Merges a doc block's body prose with any trailing `-- desc` on its placing
--- tag line (`@type`, `@interface`).
function members.placingDoc(doc: ParsedDoc): string?
	return members.mergeDescs(if doc.desc ~= "" then doc.desc else nil, doc.placingDesc)
end

function members.byName(list: { any }, name: string): any?
	for _, entry in list do
		if entry.name == name then
			return entry
		end
	end
	return nil
end

--- Converts `segs.fields` output (`desc`) into doc-model `TypeField` entries (`doc`).
function members.toModelFields(fields: { segs.Field }?): { any }?
	if fields == nil then
		return nil
	end
	local out = {}
	for _, f in fields do
		table.insert(out, {
			name = f.name,
			type = f.type,
			doc = f.desc,
			line = f.line,
			docInDisplay = f.docInDisplay,
		})
	end
	return out
end

--- Merges `@field` tags into table-type fields. Tag types and descriptions
--- override AST ones, and `@field` entries absent from the AST walk append to
--- the end (matching `lineFacts` when the field exists in the display).
function members.mergeTypeFieldTags(
	fields: { any }?,
	tyDoc: ParsedDoc,
	lineFacts: { [string]: any },
	genericNames: { [string]: boolean }?
): { any }?
	if #tyDoc.fields == 0 then
		return fields
	end
	local merged: { any } = fields or {}
	for _, f in tyDoc.fields do
		local existing = members.byName(merged, f.name)
		if existing ~= nil then
			existing.desc = f.desc or existing.desc
			if f.type ~= nil then
				existing.type = members.tagType(f.type, genericNames)
			end
		else
			local at = lineFacts[f.name]
			table.insert(merged, {
				name = f.name,
				type = members.tagType(f.type, genericNames),
				desc = f.desc,
				line = if at ~= nil then at.line else nil,
				docInDisplay = if at ~= nil and at.docInDisplay then true else nil,
			})
		end
	end
	return merged
end

function members.forwardTagDiagnostics(ctx: Ctx, modId: string, block: any, doc: ParsedDoc)
	-- Report diagnostics at most once per doc block, even when multiple aliased
	-- exports share the same `defDoc`.
	if ctx.forwardedBlocks[block] then
		return
	end
	ctx.forwardedBlocks[block] = true
	for _, d in doc.diagnostics do
		-- `d.lineOffset` is relative to `block.contentLine` (after stripping
		-- `--[=[` openers and leading blank lines), not `block.span.beginLine`.
		local line = block.contentLine + d.lineOffset - 1
		if d.severity == "info" then
			ctx.diag:info(d.code, d.message, modId, line)
		else
			ctx.diag:warn(d.code, d.message, modId, line)
		end
	end
end

--- Parses and caches a doc block's tags (`ParsedDoc` is immutable once parsed).
function members.parseTags(_ctx: Ctx, block: any): ParsedDoc
	return tagsMod.parseBlock(block)
end

function members.parseBlock(ctx: Ctx, modId: string, block: any?): ParsedDoc
	if block == nil then
		return EMPTY_DOC
	end
	local doc = tagsMod.parseBlock(block)
	members.forwardTagDiagnostics(ctx, modId, block, doc)
	return doc
end

function members.tagType(display: string?, generics: { [string]: boolean }?): { Seg }?
	return if display ~= nil then segs.fromTag(display, generics) else nil
end

--- Extracts the return-type AST nodes from a function node in order, handling
--- all three shapes Lute's parser produces (`explicit` parenthesized list,
--- `variadic`, or a single bare type node).
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

--- Builds the return-type tail after `: ` in a function signature. Uses the AST
--- return annotation verbatim unless a `@return` tag supplied a type override,
--- in which case the tail is rebuilt from `sig.returns` (`T` for one return, or
--- `(A, B)` for multiple) so the signature fence matches the **Returns** list.
local function returnTail(sig: any): { Seg }?
	local rows = sig.returns
	if not sig.__tagReturns or #rows == 0 then
		return sig.__annotationTail
	end
	for _, row in rows do
		if row.type == nil then
			return sig.__annotationTail
		end
	end
	if #rows == 1 then
		return rows[1].type
	end
	-- Copy segment tables by reference so `finalize`'s reference resolution
	-- populates `.id` on both the signature display and the return row at once.
	local tail: { Seg } = { "(" }
	for i, row in rows do
		if i > 1 then
			table.insert(tail, ", ")
		end
		table.move(row.type, 1, #row.type, #tail + 1, tail)
	end
	table.insert(tail, ")")
	return tail
end

--- Assembles a signature's `segs` display from its generics, parameters, and
--- return tail (called by both `buildSignature` and `finalize.mergeSignature`).
function members.signatureSegs(sig: any): { Seg }
	return segs.canonical(segs.signature(sig.__generics or {}, sig.params, returnTail(sig)))
end

local function resolveTagType(rawType: any, genericNames: { [string]: boolean }?): { Seg }?
	return if type(rawType) == "string" then members.tagType(rawType, genericNames) else rawType
end

--- Merges `@param` tags (or a tag stub's `signature.params`) into `params` by
--- parameter name. Tag types override AST types when `overrideType` is true
--- (or fill `nil` parameter types when merging a `@within` stub), and unmatched
--- `@param` tags append when `hasCodeParams` is false or emit `param-mismatch`.
function members.mergeParamTags(
	params: { any },
	paramTags: { any },
	hasCodeParams: boolean,
	fnName: string,
	file: string,
	line: number?,
	diag: Collector,
	overrideType: boolean,
	genericNames: { [string]: boolean }?,
	fnNode: any?
)
	local overloadParams = if fnNode ~= nil then fnNode.overloadParams else nil
	local isSecondary = fnNode ~= nil and fnNode.isSecondaryOverload
	for _, tagParam in paramTags do
		local docText = tagParam.desc or tagParam.doc
		local found = members.byName(params, tagParam.name)
		if found ~= nil then
			-- Keep any trailing comment doc when `@param` only supplies a type override.
			found.doc = docText or found.doc
			if tagParam.type ~= nil and (overrideType or found.type == nil) then
				found.type = resolveTagType(tagParam.type, genericNames)
			end
		elseif not hasCodeParams then
			table.insert(params, {
				name = tagParam.name,
				type = resolveTagType(tagParam.type, genericNames),
				doc = docText,
			})
		elseif not (overloadParams ~= nil and (overloadParams[tagParam.name] or isSecondary)) then
			diag:warn(
				"param-mismatch",
				string.format("@param %s does not match any parameter of %s", tagParam.name, fnName),
				file,
				line
			)
		end
	end
end

--- Merges `@return` tags (or a tag stub's `signature.returns`) by position.
--- Appends extra `@return` tags when the function has no return annotation, or
--- warns on `return-count-mismatch`.
function members.mergeReturnTags(
	returns: { any },
	returnTags: { any },
	hasReturnAnnotation: boolean,
	fnName: string,
	file: string,
	line: number?,
	diag: Collector,
	overrideType: boolean?,
	genericNames: { [string]: boolean }?
): boolean
	local tagReturns = false
	for i, tagReturn in returnTags do
		local docText = tagReturn.desc or tagReturn.doc
		local target = returns[i]
		if target ~= nil then
			target.doc = docText or target.doc
			if tagReturn.type ~= nil and (overrideType or target.type == nil) then
				target.type = resolveTagType(tagReturn.type, genericNames)
				tagReturns = true
			end
		elseif #returns == 0 or not hasReturnAnnotation then
			local row: any = {
				type = resolveTagType(tagReturn.type, genericNames),
				doc = docText,
			}
			if next(row) == nil then
				-- Mark empty `@return` rows so `emit` encodes `{}` instead of `[]`.
				emitMod.record(row)
			end
			table.insert(returns, row)
			if tagReturn.type ~= nil then
				tagReturns = true
			end
		else
			diag:warn(
				"return-count-mismatch",
				string.format("@return #%d exceeds the annotated returns of %s", i, fnName),
				file,
				line
			)
		end
	end
	return tagReturns
end

local function buildSignature(
	ctx: Ctx,
	mod: ModuleData,
	containerName: string,
	name: string,
	accessor: string,
	fnNode: any?,
	doc: ParsedDoc,
	memberLine: number?,
	dropSelf: boolean?
): Signature
	local qualified = if containerName == "" then name else containerName .. "." .. name
	local parsedFile: any = mod.parsed
	local trailingIndex: any = mod.trailingIndex
	local generics: { any } = {}
	local genericNames: { [string]: boolean } = {}
	if fnNode ~= nil then
		generics, genericNames = segs.generics(parsedFile, fnNode.generics, fnNode.genericPacks)
	end

	local params: { any } = {}
	local paramLines: { [number]: number } = {}
	if fnNode ~= nil then
		params, paramLines = segs.paramEntries(parsedFile, fnNode, genericNames)
		-- Attach a trailing `-- comment` on a parameter's line as its doc,
		-- excluding the signature's opening line and the return annotation's
		-- line (when multiple parameters share a line, only the last claims it).
		local sigLine = if fnNode.location ~= nil then fnNode.location.beginLine else nil
		local ra = fnNode.returnAnnotation
		local retLine = if ra ~= nil and ra.location ~= nil then ra.location.beginLine else nil
		for i, param in params do
			local line = paramLines[i]
			if line ~= nil and line ~= sigLine and line ~= retLine and (i == #params or paramLines[i + 1] ~= line) then
				param.doc = comments.trailingText(trailingIndex, line)
			end
		end
		if dropSelf and params[1] ~= nil and params[1].name == "self" then
			table.remove(params, 1)
		end
	end

	local returnAnnotation = if fnNode ~= nil then fnNode.returnAnnotation else nil
	local returns: { any } = {}
	for _, node in members.returnNodes(fnNode) do
		table.insert(returns, { type = segs.inline(parsedFile, node, genericNames) })
	end

	members.mergeParamTags(
		params,
		doc.params,
		fnNode ~= nil,
		qualified,
		mod.id,
		memberLine,
		ctx.diag,
		true,
		genericNames,
		fnNode
	)
	local tagReturns = members.mergeReturnTags(
		returns,
		doc.returns,
		returnAnnotation ~= nil,
		qualified,
		mod.id,
		memberLine,
		ctx.diag,
		true,
		genericNames
	)

	-- Keep `callee` separate from `segs` so re-exports can swap the callee name
	-- without rebuilding the parameter/return display.
	local sig = {
		callee = members.callee(containerName, accessor, name),
		params = params,
		returns = returns,
		-- Slice the full return annotation (including outer parentheses on
		-- multi-returns like `(Widget, string)`) for `signatureSegs`.
		__generics = generics,
		__annotationTail = if returnAnnotation ~= nil
			then segs.inline(parsedFile, returnAnnotation, genericNames)
			else nil,
		__tagReturns = if tagReturns then true else nil,
	}
	sig.segs = members.signatureSegs(sig)
	return sig
end

--- Constructs a synthetic field descriptor so tag-declared and callable-module
--- members go through `buildFn` / `buildProp` just like AST-discovered fields.
function members.pseudoField(name: string, value: any, isColonMethod: boolean, span: any): any
	return { name = name, value = value, isColonMethod = isColonMethod, keySpan = span, defSpan = span }
end

--- Returns the CST local binding for the second argument of `setmetatable(x, Class)`
--- when it is a local variable reference.
local function setmetatableClassLocal(callNode: any): any?
	callNode = parseMod.unwrapExpr(callNode, true)
	if callNode == nil or callNode.tag ~= "call" then
		return nil
	end
	local func = parseMod.unwrapExpr(callNode.func, true)
	if func == nil or func.tag ~= "global" or func.name.text ~= "setmetatable" then
		return nil
	end
	local args = callNode.arguments
	local second = if args ~= nil and args[2] ~= nil then parseMod.unwrapExpr(args[2].node, true) else nil
	if second == nil or second.tag ~= "local" then
		return nil
	end
	return second["local"]
end

--- Returns the class local referenced by a metatable type alias in either
--- `typeof(setmetatable(_, Class))` or `setmetatable<_, typeof(Class)>`.
function members.setmetatableTypeClassLocal(typeNode: any): any?
	typeNode = parseMod.unwrapType(typeNode)
	if typeNode == nil then
		return nil
	end
	if typeNode.tag == "typeof" then
		return setmetatableClassLocal(typeNode.expression)
	end
	if typeNode.tag ~= "reference" or typeNode.prefix ~= nil or typeNode.name == nil then
		return nil
	end
	if typeNode.name.text ~= "setmetatable" or typeNode.parameters == nil then
		return nil
	end
	local second = typeNode.parameters[2]
	local arg = if second ~= nil then parseMod.unwrapType(second.node) else nil
	local expr = if arg ~= nil and arg.tag == "typeof" then parseMod.unwrapExpr(arg.expression, true) else nil
	if expr == nil or expr.tag ~= "local" then
		return nil
	end
	return expr["local"]
end

--- Detects same-module constructors returning `setmetatable(_, Class)` directly
--- or via `local self = setmetatable(_, Class); ...; return self`.
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
	local retExpr = parseMod.unwrapExpr(first.node, true)
	local classLocal = setmetatableClassLocal(retExpr)
	if classLocal == nil and retExpr ~= nil and retExpr.tag == "local" then
		for _, stat in stats do
			if stat.tag == "local" and stat.values ~= nil then
				for i, varPair in stat.variables do
					if varPair.node == retExpr["local"] and stat.values[i] ~= nil then
						classLocal = setmetatableClassLocal(stat.values[i].node)
						break
					end
				end
			end
		end
	end
	if classLocal == nil or mod.surface == nil then
		return nil
	end
	return mod.surface.env[classLocal]
end

function members.buildFn(
	ctx: Ctx,
	mod: ModuleData,
	containerName: string,
	field: SymField,
	doc: ParsedDoc,
	secondaryDesc: string?,
	ownerSym: SymValue?
): FnMember
	local name = field.name
	local isColon = field.isColonMethod
	local isMetamethod = surfaceMod.isMetamethod(name)
	local placingKind = if doc.placing ~= nil then doc.placing.kind else nil
	local fnNode = field.value.fnNode
	local isSelf = not isColon and surfaceMod.isSelfMethod(fnNode)
	local kind = "function"
	if isMetamethod then
		kind = "metamethod"
	elseif isColon or placingKind == "method" or isSelf then
		kind = "method"
	end
	if placingKind == "function" then
		kind = "function"
	end
	local accessor = if kind == "method" then ":" else "."
	-- Dot-defined methods with an explicit `self` parameter (`function T.f(self: T, ...)`)
	-- display with `:` syntax (`T:f(...)`) and omit `self` from the parameter list.
	local dropSelf = kind == "method" and isSelf
	local memberLine = field.defSpan and field.defSpan.beginLine
	local visibility = members.visibilityOf(name, doc, isMetamethod)

	local fn = {
		id = members.memberId(mod.id, "fn", containerName, name),
		name = name,
		kind = kind,
		doc = members.mergeDescs(doc.desc, secondaryDesc),
		tags = members.buildBadges(doc),
		visibility = visibility,
		signature = buildSignature(ctx, mod, containerName, name, accessor, fnNode, doc, memberLine, dropSelf),
		errors = {},
		source = members.span(mod.id, field.defSpan),
	}
	if fn.tags.deprecated == nil then
		local depAttr = parseMod.extractDeprecationAttr(mod.parsed, fnNode)
		if depAttr ~= nil then
			fn.tags.deprecated = { note = depAttr.note }
			if next(fn.tags.deprecated) == nil then
				emitMod.record(fn.tags.deprecated)
			end
		end
	end
	for _, err in doc.errors do
		table.insert(fn.errors, { type = err.type, doc = err.desc })
	end
	-- Fill `yields` and `realm` from AST body signals only when the doc block
	-- did not set them explicitly.
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
	if field.value.returnedRequire ~= nil then
		fn.__returnedRequire = mod.requireTargets[field.value.returnedRequire]
	end
	return fn
end

--- If `value` is a table already registered as a container (e.g., an alias
--- `Z.boolean = Z.bool` where `Z.bool` became the nested section), returns a
--- reference segment linking to that container's ID.
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
	field: SymField,
	doc: ParsedDoc,
	secondaryDesc: string?,
	ownerSym: SymValue?
): PropMember
	local name = field.name
	local visibility = members.visibilityOf(name, doc)
	local parsedFile: any = mod.parsed

	-- Prefer `@prop` tag types, then explicit AST type annotations/casts (falling
	-- back to the owning table's type annotation when unannotated or cast to a
	-- placeholder `any`), and finally literal/constructor value inference.
	local typeNode = field.declaredType or field.value.castType or field.value.annotation
	local isAny = typeNode ~= nil
		and typeNode.tag == "reference"
		and typeNode.prefix == nil
		and typeNode.name ~= nil
		and typeNode.name.text == "any"
	local ownerEntry = if typeNode == nil or isAny then detectMod.ownerFieldEntry(mod, ownerSym, name) else nil
	if ownerEntry ~= nil and ownerEntry.value ~= nil then
		typeNode = ownerEntry.value
	end
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
		readonly = doc.flags.readonly == true or field.readonly == true or detectMod.propReadonly(mod, ownerSym, name),
		source = members.span(mod.id, field.defSpan),
		-- Mark value-inferred types so a later `@prop x T` tag stub can override them.
		__inferred = if inferred then true else nil,
		-- Record unresolved call expressions (`IsServer and Registry.new()`) so
		-- `finalize` can infer the property type from the callee's return annotation.
		__inferCall = if typeSegs == nil and surfaceMod.unguard(field.value).calleeValue ~= nil
			then field.value
			else nil,
		-- Mark guard-detected realms so `finalize` can clear them if the guarded
		-- call turns out to return a boolean predicate rather than a realm mount.
		__mountRealm = if mountRealm then true else nil,
	}
end

function members.newContainer(
	ctx: Ctx,
	mod: ModuleData,
	name: string,
	doc: ParsedDoc,
	sourceSpan: Span?,
	within: string?
): ClassEntry
	local class = {
		-- Qualify nested class IDs with `within` so same-named nested tables
		-- under different parents do not collide.
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
		-- Register both the short name (`Oklab`) and qualified name (`Color.Oklab`) for `@within`.
		members.registerContainer(ctx, within .. "." .. name, class)
	end
	return class
end

--- Routes members to `container.members` while forwarding discovered classes
--- and re-exports to the enclosing module's lists.
function members.sinks(container: any, from: any, within: string?): any
	return {
		members = container.members,
		classes = from.classes,
		reexports = from.reexports,
		within = within,
	}
end

--- Returns the highest-priority doc block for a field: a later `function M.f`
--- definition block, the table field's own block, or the assigned local's block.
function members.docBlockOf(field: any): any?
	return field.defDoc or field.fieldDoc or field.value.defDoc
end

local function tryAddReexport(
	ctx: Ctx,
	mod: ModuleData,
	containerName: string,
	field: any,
	doc: ParsedDoc,
	secondaryDesc: string?,
	owner: any,
	out: any,
	mounted: any
): boolean
	if mounted.kind ~= "require" and mounted.kind ~= "import" then
		return false
	end
	-- Emit a re-export when the target module resolved (or matched a
	-- configured runtime alias), or fall through to `buildProp`.
	local isImport = mounted.kind == "import"
	local base = if isImport then mounted.base else mounted
	local targetModule = if base ~= nil then mod.requireTargets[base] else nil
	local external = if base ~= nil then mod.externalRequires[base] else nil
	if external == nil and targetModule == nil then
		return false
	end
	local value = field.value
	table.insert(out.reexports, {
		id = members.memberId(mod.id, "reexport", out.within, field.name),
		name = field.name,
		within = out.within,
		targetModule = if external ~= nil then external.spelling else targetModule,
		targetMember = if isImport then table.concat(mounted.path or {}, ".") else nil,
		url = if external ~= nil then external.url else nil,
		doc = if doc.desc ~= "" then doc.desc else nil,
		realm = tagsMod.realmList(doc.flags) or detectMod.propRealm(value),
		__external = if external ~= nil then true else nil,
		__path = if external == nil and isImport then mounted.path else nil,
		__line = if external == nil then field.keySpan.beginLine else nil,
		__sink = if external == nil and isImport then out.members else nil,
		__prop = if external == nil and isImport
			then members.buildProp(ctx, mod, containerName, field, doc, secondaryDesc, owner)
			else nil,
	})
	if external ~= nil and ctx.externals[external.spelling] == nil then
		ctx.externals[external.spelling] = { url = external.url, alias = external.alias, path = external.path }
	end
	return true
end

local function resolveFieldDoc(
	ctx: Ctx,
	mod: ModuleData,
	owner: any,
	field: any,
	mounted: any,
	out: any?
): (ParsedDoc?, string?, any?)
	local block = members.docBlockOf(field)
	local value = field.value
	if out == nil then
		if block == nil then
			return nil, nil, nil
		end
		local sidecarDoc = members.parseTags(ctx, block)
		if sidecarDoc.within == nil then
			return nil, nil, nil
		end
		if
			not sidecarDoc.flags.ignore
			and value.kind ~= "function"
			and (value.kind == "table" or mounted.kind == "require" or mounted.kind == "import")
		then
			return nil, nil, nil
		end
	end
	local doc = members.parseBlock(ctx, mod.id, block)
	if block == nil and mod.claimIndex ~= nil then
		local ownerEntry = detectMod.ownerFieldEntry(mod, owner, field.name)
		local entryBlock = if ownerEntry ~= nil and ownerEntry.key ~= nil
			then mod.claimIndex[ownerEntry.key.location.beginLine]
			else nil
		if entryBlock ~= nil then
			doc = members.parseBlock(ctx, mod.id, entryBlock)
		end
	end
	local secondaryDesc: string? = nil
	if out ~= nil and field.defDoc ~= nil and field.fieldDoc ~= nil then
		local fieldParsed = members.parseBlock(ctx, mod.id, field.fieldDoc)
		secondaryDesc = fieldParsed.desc
	end
	if doc.flags.ignore then
		return nil, nil, nil
	end
	return doc, secondaryDesc, block
end

local function isNestedContainer(ctx: Ctx, field: any, value: any, doc: ParsedDoc, out: any?): boolean
	return out ~= nil
		and value.kind == "table"
		and field.declaredType == nil
		and value.castType == nil
		and value.annotation == nil
		and #value.fields > 0
		-- Tables already registered as containers (including cyclic references)
		-- render as plain properties linking to the existing container.
		and ctx.containerOfSym[members.symKey(value)] == nil
		-- Keep `_`-prefixed and `@private` tables as properties so they can
		-- carry `visibility = "private"` instead of becoming public sections.
		and members.visibilityOf(field.name, doc) == "public"
		-- A non-`@class` placing tag (`@prop Defaults { size: number }`) or
		-- `@readonly` marks the table as a single property rather than a namespace section.
		and (doc.placing == nil or doc.placing.kind == "class")
		and not doc.flags.readonly
end

--- Builds members from `sym.fields` into `out` (or queues only `@within`
--- members into `ctx.pendingMoves` when `out` is `nil` for a non-surfaced
--- sidecar module). `ownerSym` overrides the table that `self` and readonly
--- detection resolve against (used when harvesting metamethods from a
--- metatable attached to `ownerSym`).
function members.buildMembers(ctx: Ctx, mod: ModuleData, containerName: string, sym: any, out: any?, ownerSym: any?)
	local owner = ownerSym or sym
	local overloadCounts: { [string]: number } = {}
	for _, field in sym.fields or {} do
		-- Skip string keys containing dots (`M["A.b"]`), which would collide
		-- with nested container member IDs (`M.A.b`), unless it is a `[K]` indexer.
		if not (field.name:sub(1, 1) == "[" and field.name:sub(-1) == "]") and field.name:find(".", 1, true) ~= nil then
			continue
		end
		local value = field.value
		-- Unwrap realm-guarded mounts (`IsServer() and require(X)`) so they
		-- emit as re-exports with a realm badge.
		local mounted = surfaceMod.unguard(value)
		local doc, secondaryDesc, block = resolveFieldDoc(ctx, mod, owner, field, mounted, out)
		if doc == nil then
			continue
		end

		if out ~= nil and tryAddReexport(ctx, mod, containerName, field, doc, secondaryDesc, owner, out, mounted) then
			continue
		end

		local member: any = nil
		if value.kind == "function" then
			if
				block == nil
				and surfaceMod.isMetamethod(field.name)
				and not (field.isDeclared and field.name ~= "__index" and field.name ~= "__newindex")
			then
				continue -- skip undocumented metamethods (`__index`, `__newindex`, etc.)
			end
			member = members.buildFn(ctx, mod, containerName, field, doc, secondaryDesc, owner)
			local count = (overloadCounts[member.id] or 0) + 1
			overloadCounts[member.id] = count
			if count > 1 then
				member.id = member.id .. ":" .. tostring(count)
			end
		elseif isNestedContainer(ctx, field, value, doc, out) then
			local nestedName = containerName .. "." .. field.name
			local nested = members.newContainer(ctx, mod, field.name, doc, field.defSpan, containerName)
			ctx.containerOfSym[members.symKey(value)] = nested
			members.buildMembers(ctx, mod, nestedName, value, members.sinks(nested, out, nestedName))
			table.insert(out.classes, nested)
			continue
		else
			member = members.buildProp(ctx, mod, containerName, field, doc, secondaryDesc, owner)
		end

		-- Record the underlying `SymValue` key so `finalize` can distinguish
		-- aliases of the same value from collisions between two distinct definitions.
		member.__valueSym = members.symKey(value)

		if doc.within ~= nil and (out == nil or doc.within ~= containerName) then
			table.insert(ctx.pendingMoves, { member = member, targetName = doc.within, fromModule = mod.id })
			continue
		end

		if out ~= nil then
			table.insert(out.members, member)
		end
	end
end

return members

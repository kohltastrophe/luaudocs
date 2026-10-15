--- Pass 1 (per module in graph order): builds the `Module` entry, its root
--- container and members, type declarations (`@field` merging, `@interface`
--- enrichment, and the `classType` idiom), orphan classes, floating placing
--- blocks (Moonwave manual mode), and `@external` declarations. Also registers
--- per-module type names in `ctx.typesByModule` before cross-module resolution
--- runs in `finalize`.

local graphMod = require("../graph")
local comments = require("../comments")
local segs = require("../segs")
local surfaceMod = require("../surface")
local tagsMod = require("../tags")
local members = require("./members")

type Ctx = members.Ctx
type ModuleData = members.ModuleData
type ParsedDoc = members.ParsedDoc

local build = {}

--- Scans every doc block in the module for `@external` declarations (including
--- blocks attached to classes or the module itself).
local function collectExternals(ctx: Ctx, mod: ModuleData)
	for _, block in (mod.blocks or {}) :: any do
		if block.doc then
			local doc = members.parseTags(ctx, block)
			for _, ext in doc.externals do
				local existing = ctx.externals[ext.name]
				if existing ~= nil and existing ~= ext.url then
					ctx.diag:warn(
						"duplicate-external",
						string.format(
							"@external %s: already mapped to %s; this one is ignored",
							ext.name,
							tostring(existing)
						),
						mod.id,
						block.contentLine + ext.lineOffset - 1
					)
				elseif existing == nil then
					ctx.externals[ext.name] = ext.url
				end
			end
		end
	end
end

--- Builds a synthetic `TypeDecl` for a floating `@interface` or `@type` block
--- that has no backing Luau `type` declaration. For `@interface`, `definition`
--- is omitted so the renderer synthesizes a table type from `fields`.
local function interfaceDecl(ctx: Ctx, mod: ModuleData, doc: ParsedDoc, sourceSpan: any): any
	local placing = doc.placing :: tagsMod.Placing
	local name = placing.name
	local fields = {}
	for _, f in doc.fields do
		table.insert(fields, { name = f.name, type = members.tagType(f.type, nil), doc = f.desc })
	end
	local id = members.memberId(mod.id, "type", nil, name)
	ctx.typesByModule[mod.id][name] = id
	local display = members.tagType(doc.placingType, nil)
	return {
		id = id,
		name = name,
		exported = true,
		kind = if placing.kind == "interface" then "interface" else "alias",
		generics = {},
		definition = if display ~= nil then { display } else nil,
		fields = if #fields > 0 then fields else nil,
		doc = members.placingDoc(doc),
		tags = members.buildBadges(doc),
		visibility = members.visibilityOf(name, doc, true),
		source = members.span(mod.id, sourceSpan),
		__within = doc.within,
	}
end

--- Builds a floating tag-declared class, type, or member. `rootContainer` is
--- this module's root container (the module entry or its primary class), which
--- pins floating members without an explicit `@within` to this module rather
--- than a same-named container in another module.
local function buildFloatingMember(
	ctx: Ctx,
	mod: ModuleData,
	entry: any,
	block: any,
	doc: ParsedDoc,
	rootContainer: any?
)
	local placing = doc.placing :: tagsMod.Placing
	local targetName = doc.within

	if placing.kind == "class" then
		if ctx.containersByName[placing.name] == nil then
			local class = members.newContainer(ctx, mod, placing.name, doc, block.span, nil)
			table.insert(entry.classes, class)
		else
			-- If a container with this name already exists anywhere in the
			-- model, ignore the floating `@class` and emit an `info` diagnostic.
			ctx.diag:info(
				"duplicate-class",
				string.format("@class %s already exists; this declaration is ignored", placing.name),
				mod.id,
				if block.span ~= nil then block.span.beginLine else nil
			)
		end
		return
	end

	if placing.kind == "interface" or placing.kind == "type" then
		table.insert(entry.types, interfaceDecl(ctx, mod, doc, block.span))
		return
	end

	-- Default to `entry.name` (which reflects any root `@class` rename) when `@within` is omitted.
	local container = targetName or entry.name
	local pseudoField = members.pseudoField(
		placing.name,
		{ kind = if placing.kind == "prop" then "opaque" else "function" },
		placing.kind == "method",
		block.span
	)
	-- `@method __tostring` becomes a metamethod by name, whereas an explicit
	-- `@function __tostring` stays a function.
	local member = if placing.kind == "prop"
		then members.buildProp(ctx, mod, container, pseudoField, doc, nil)
		else members.buildFn(ctx, mod, container, pseudoField, doc, nil)
	table.insert(ctx.pendingMoves, {
		member = member,
		targetName = container,
		fromModule = mod.id,
		targetContainer = if targetName == nil then rootContainer else nil,
	})
end

--- Builds `TypeDecl` entries for the module. `rootInterfaceDoc` is an
--- `@interface` or `@type` block that was attached to the module's `return`
--- statement; it enriches the matching type declaration or becomes a synthetic
--- declaration if no AST type matches.
local function buildTypeDecls(
	ctx: Ctx,
	mod: ModuleData,
	entry: any,
	fullProcessing: boolean,
	rootInterfaceDoc: ParsedDoc?
)
	local surface = mod.surface :: any
	local parsedFile = mod.parsed :: any

	-- Track which type names actually emit a `TypeDecl` so skipped declarations
	-- can be pruned from `ctx.typesByModule` after the loop.
	local emitted: { [string]: boolean } = {}

	for _, ty in surface.types do
		-- Ignore blocks above a type alias that place a non-type (`@class`,
		-- `@function`, `@prop`) so the root-class check or floating sweep can
		-- claim them instead.
		local tyDoc = members.EMPTY_DOC
		if ty.doc ~= nil then
			local placing = members.parseTags(ctx, ty.doc).placing
			if placing == nil or placing.kind == "type" or placing.kind == "interface" then
				tyDoc = members.parseBlock(ctx, mod.id, ty.doc)
			end
		end
		if tyDoc.flags.ignore then
			continue
		end
		if not fullProcessing and tyDoc.within == nil and tyDoc.placing == nil then
			continue
		end
		local generics, genericNames = segs.generics(parsedFile, ty.stat.generics, ty.stat.genericPacks)
		local typeName = if tyDoc.placing ~= nil
				and (tyDoc.placing.kind == "type" or tyDoc.placing.kind == "interface")
			then tyDoc.placing.name
			else ty.name
		local enrich = if rootInterfaceDoc ~= nil and (rootInterfaceDoc.placing :: any).name == typeName
			then rootInterfaceDoc
			else nil
		if enrich ~= nil then
			rootInterfaceDoc = nil
			if tyDoc == members.EMPTY_DOC or (#tyDoc.fields == 0 and #enrich.fields > 0) then
				tyDoc = enrich
			end
		end
		local fields, lineFacts, displayBlock = segs.fields(
			parsedFile,
			ty.stat.type,
			mod.claimIndex :: any,
			mod.trailingIndex :: any,
			genericNames,
			if ty.stat.location ~= nil then ty.stat.location.beginLine else nil
		)
		local isTypeofAlias = ty.stat.type ~= nil and ty.stat.type.tag == "typeof"
		-- Merge `@field` tags into table-type fields: tag types/descriptions
		-- override AST ones, and `@field` entries not found in the AST walk are
		-- appended (matching `lineFacts` when the field exists in the display).
		if #tyDoc.fields > 0 then
			local merged: { any } = (fields :: any) or {}
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
			fields = merged
		end
		-- For a `type function`, extract its parameter list for the signature
		-- fence instead of slicing `stat.type` (which is the `type` keyword token).
		local typefnParams: any = nil
		if ty.kind == "typefunction" and ty.stat.body ~= nil then
			local parts: { any } = {}
			segs.pushParamList(parts, (segs.paramEntries(parsedFile, ty.stat.body, genericNames)))
			typefnParams = parts
		end
		local definition: any = nil
		if ty.kind ~= "typefunction" then
			definition = displayBlock or { { "unknown" } }
			-- When an `@interface` with `@field` tags is bound to a `typeof(...)`
			-- alias, clear `definition` so the renderer synthesizes a table type
			-- from `fields` instead of printing `typeof(...)`.
			if isTypeofAlias and #tyDoc.fields > 0 and tyDoc.placing ~= nil and tyDoc.placing.kind == "interface" then
				definition = nil
			end
		end
		local decl = {
			-- Mint the ID from the AST name (`ty.name`) so type references
			-- resolve even when a `@type` / `@interface` tag renames the display.
			id = members.memberId(mod.id, "type", nil, ty.name),
			name = typeName,
			exported = ty.exported,
			kind = if ty.kind ~= "typefunction"
					and tyDoc.placing ~= nil
					and tyDoc.placing.kind == "interface"
				then "interface"
				else ty.kind,
			generics = generics,
			definition = definition,
			params = typefnParams,
			fields = members.toModelFields(fields),
			doc = members.placingDoc(tyDoc),
			tags = members.buildBadges(tyDoc),
			visibility = members.visibilityOf(typeName, tyDoc, ty.exported),
			source = members.span(mod.id, ty.stat.location),
			__within = tyDoc.within,
		}
		table.insert(entry.types, decl)
		emitted[ty.name] = true

		-- `classType` idiom: `export type X<T> = typeof(setmetatable({} :: D, ClassTable))`
		-- or `setmetatable<D, typeof(ClassTable)>`.
		local classLocal = members.setmetatableTypeClassLocal(ty.stat.type)
		if classLocal ~= nil then
			local sym = surface.env[classLocal]
			local class = if sym ~= nil then ctx.containerOfSym[members.symKey(sym)] else nil
			if class ~= nil and class.__classType == nil then
				class.__classType = true
				ctx.classByTypeId[decl.id] = class
			end
		end
	end

	for _, ty in surface.types do
		if not emitted[ty.name] then
			ctx.typesByModule[mod.id][ty.name] = nil
		end
	end

	if not fullProcessing then
		return
	end

	if rootInterfaceDoc ~= nil then
		table.insert(entry.types, interfaceDecl(ctx, mod, rootInterfaceDoc, nil))
	end
end

--- Builds `mod`'s `Module` entry and appends it to `ctx.modules`.
function build.run(ctx: Ctx, mod: ModuleData)
	-- Pre-populate `ctx.typesByModule[mod.id]`; `buildTypeDecls` prunes any
	-- declarations it skips.
	local types: { [string]: string } = {}
	if mod.surface ~= nil then
		for _, ty in (mod.surface :: any).types do
			types[ty.name] = members.memberId(mod.id, "type", nil, ty.name)
		end
	end
	ctx.typesByModule[mod.id] = types

	-- Collect `@external` declarations before the early return so modules with
	-- failed surface evaluation still contribute their `@external` mappings.
	collectExternals(ctx, mod)

	local entry: any = {
		id = mod.id,
		name = mod.name,
		instancePath = mod.instancePath,
		doc = nil,
		classes = {},
		members = {},
		types = {},
		reexports = {},
		source = members.span(mod.id, nil),
	}
	table.insert(ctx.modules, entry)

	if mod.parsed == nil or mod.surface == nil then
		return
	end
	local surface = mod.surface :: any
	local result = surface.result

	-- A floating `@class X` names the module's root container (Moonwave style)
	-- when the returned table does not carry its own `@class` doc block.
	local rootHasOwnClass = result ~= nil
		and (result :: any).defDoc ~= nil
		and tagsMod.className(members.parseTags(ctx, (result :: any).defDoc)) ~= nil
	local floatingClassDoc: ParsedDoc? = nil
	local floatingClassSpan: any = nil
	if not rootHasOwnClass then
		local block = graphMod.floatingClassBlock(mod, function(b)
			return members.parseTags(ctx, b)
		end)
		if block ~= nil then
			floatingClassDoc = members.parseTags(ctx, block)
			floatingClassSpan = block.span
			block.claimed = true
			members.forwardTagDiagnostics(ctx, mod.id, block, floatingClassDoc :: ParsedDoc)
		end
	end

	-- Modules reached only via local `require`s (`not mod.surfaced`) contribute
	-- `@within` declarations and types to other pages without getting a page of their own.
	local fullProcessing = mod.surfaced

	if fullProcessing and result ~= nil then
		if result.kind == "require" then
			local ext = mod.externalRequires[result]
			entry.aliasOf = mod.requireTargets[result] or (if ext ~= nil then ext.spelling else nil)
		elseif result.kind == "opaque" then
			ctx.diag:info(
				"surface-opaque",
				"module return value could not be statically analyzed",
				mod.id,
				result.span and result.span.beginLine
			)
		end
	end

	local rootDoc = if fullProcessing and result ~= nil
		then members.parseBlock(ctx, mod.id, result.defDoc)
		else members.EMPTY_DOC
	local moduleDoc: ParsedDoc? = nil
	if fullProcessing then
		local moduleDocBlock = comments.moduleDoc(mod.blocks :: any, surface.firstStatLine)
		if moduleDocBlock ~= nil then
			local parsedModuleDoc = members.parseBlock(ctx, mod.id, moduleDocBlock)
			if parsedModuleDoc.placing == nil then
				moduleDoc = parsedModuleDoc
				moduleDocBlock.claimed = true
			end
		end
	end

	-- An `@interface` or `@type` block attached to the returned statement
	-- documents a type declaration rather than the module container.
	local rootIsInterfaceDoc = rootDoc.placing ~= nil
		and (rootDoc.placing.kind == "interface" or rootDoc.placing.kind == "type")

	local rootClassName = tagsMod.className(rootDoc)
	local classDoc: ParsedDoc = if rootClassName ~= nil
		then rootDoc
		elseif floatingClassDoc ~= nil then floatingClassDoc
		else members.EMPTY_DOC
	local className = tagsMod.className(classDoc)
	local hasClassTag = className ~= nil
	if fullProcessing then
		entry.doc = if moduleDoc ~= nil and moduleDoc.desc ~= ""
			then moduleDoc.desc
			elseif classDoc.desc ~= "" then classDoc.desc
			elseif rootDoc.desc ~= "" and not rootIsInterfaceDoc then rootDoc.desc
			else nil
	end

	local rootContainer: any = entry

	--- Harvests documented metamethod functions from `setmetatable(root, MT)`.
	local function harvestMetamethods(sym: any, containerName: string, sink: any)
		local mt = (sym :: any).metatable
		-- Skip self-metatables (`setmetatable(M, M)`), whose fields were already
		-- walked on `M`.
		if mt ~= nil and mt.kind == "table" and members.symKey(mt) ~= members.symKey(sym) then
			local mtView = { kind = "table", span = mt.span, fields = {} }
			for _, f in mt.fields do
				if surfaceMod.isMetamethod(f.name) and f.value.kind == "function" then
					table.insert(mtView.fields, f)
				end
			end
			if #mtView.fields > 0 then
				-- Pass `sym` as `ownerSym` because `self` inside a metamethod
				-- refers to the table the metatable is attached to.
				members.buildMembers(ctx, mod, containerName, mtView, sink, sym)
			end
		end
	end

	if fullProcessing and result ~= nil and result.kind == "table" then
		local rootName = className or mod.name
		entry.name = rootName
		local containerDoc = classDoc
		if not hasClassTag and not rootIsInterfaceDoc then
			containerDoc = rootDoc
		end
		if surfaceMod.classify(result, hasClassTag) then
			local class = members.newContainer(ctx, mod, rootName, containerDoc, result.span, nil)
			ctx.containerOfSym[members.symKey(result)] = class
			rootContainer = class
			local sinks = members.sinks(class, entry)
			members.buildMembers(ctx, mod, rootName, result, sinks)
			harvestMetamethods(result, rootName, sinks)
			table.insert(entry.classes, 1, class)
		else
			members.registerContainer(ctx, rootName, entry)
			ctx.containerOfSym[members.symKey(result)] = entry
			local out = members.sinks(entry, entry)
			members.buildMembers(ctx, mod, rootName, result, out)
			harvestMetamethods(result, rootName, out)
		end
	elseif fullProcessing and result ~= nil and result.kind == "function" then
		-- Pass `""` as `containerName` for callable modules so the member ID
		-- and callee use the bare module name rather than `Mod.Mod`.
		local fn =
			members.buildFn(ctx, mod, "", members.pseudoField(mod.name, result, false, result.span), rootDoc, nil)
		table.insert(entry.members, fn)
		members.registerContainer(ctx, mod.name, entry)
	elseif fullProcessing then
		members.registerContainer(ctx, mod.name, entry)
	end

	--- Declares a class on `entry.classes`, warning and dropping same-module
	--- duplicates that would mint the exact same `<mod>#class.<name>` ID.
	local function declareClass(name: string, doc: ParsedDoc, span: any): any?
		if members.byName(entry.classes, name) ~= nil then
			ctx.diag:warn(
				"duplicate-class",
				string.format("@class %s is already declared in this module; ignoring the duplicate", name),
				mod.id,
				if span ~= nil then span.beginLine else nil
			)
			return nil
		end
		local class = members.newContainer(ctx, mod, name, doc, span, nil)
		table.insert(entry.classes, class)
		return class
	end

	-- Register a root or floating `@class` on a callable/non-table module so
	-- `@within` members targeting that class have a container to land on.
	if fullProcessing and className ~= nil and (result == nil or result.kind ~= "table") then
		declareClass(className, classDoc, floatingClassSpan or (if result ~= nil then (result :: any).span else nil))
	end

	-- In a non-surfaced sidecar module, any code members carrying `@within` are
	-- built and queued in `ctx.pendingMoves` to relocate onto their target page.
	if not fullProcessing and result ~= nil and result.kind == "table" then
		for _, field in (result :: any).fields do
			local block = members.docBlockOf(field)
			local doc: ParsedDoc? = if block ~= nil then members.parseTags(ctx, block) else nil
			if doc ~= nil and doc.within ~= nil and not doc.flags.ignore then
				local value = field.value
				local mounted = surfaceMod.unguard(value)
				local member: any = nil
				if value.kind == "function" then
					member = members.buildFn(ctx, mod, entry.name, field, doc, nil, result)
				elseif mounted.kind ~= "require" and mounted.kind ~= "import" and value.kind ~= "table" then
					member = members.buildProp(ctx, mod, entry.name, field, doc, nil, result)
				end
				if member ~= nil then
					member.__valueSym = members.symKey(value)
					members.forwardTagDiagnostics(ctx, mod.id, block, doc)
					table.insert(ctx.pendingMoves, {
						member = member,
						targetName = doc.within :: string,
						fromModule = mod.id,
					})
				end
			end
		end
	end

	-- Discover local class tables that were not returned directly on the module
	-- surface (e.g., `local Signal = {}` when the module returns a constructor
	-- function or a table of constructors):
	--   1. Local tables with an explicit `--- @class` doc block.
	--   2. Implicit classes: self-indexing local tables (`Impl.__index = Impl`)
	--      attached by a constructor (`return setmetatable(_, Impl)`) or by a
	--      metatable type alias (`typeof(setmetatable(_, Impl))` or
	--      `setmetatable<_, typeof(Impl)>`), named after the first matching type
	--      alias or the local variable.
	if fullProcessing then
		-- symKey -> naming type alias (string), or `false` for constructor-only attachment
		local attached: { [any]: any } = {}
		members.eachMember(entry, function(member, _owner)
			local sym = member.__constructsSym
			local key = members.symKey(sym)
			if key ~= nil and attached[key] == nil then
				attached[key] = false
			end
		end)
		for _, ty in surface.types do
			local classLocal = members.setmetatableTypeClassLocal(ty.stat.type)
			local sym = if classLocal ~= nil then surface.env[classLocal] else nil
			local key = members.symKey(sym)
			if key ~= nil and not attached[key] then
				attached[key] = ty.name
			end
		end

		local resultKey = members.symKey(result)
		local orphanClasses = {}
		for cstLocal, value in surface.env do
			local key = members.symKey(value)
			if value.kind == "table" and key ~= resultKey and ctx.containerOfSym[key] == nil then
				local doc = if value.defDoc ~= nil then members.parseTags(ctx, value.defDoc) else members.EMPTY_DOC
				local orphanName = tagsMod.className(doc)
				local naming = attached[key]
				if orphanName == nil and naming ~= nil and surfaceMod.isSelfIndexing(value) then
					orphanName = if naming ~= false then naming else cstLocal.name.text
				end
				if orphanName ~= nil then
					table.insert(orphanClasses, { value = value, doc = doc, name = orphanName })
				end
			end
		end
		-- Sort by source line (and name on ties) before deduplicating `SymValue`
		-- keys so iteration order over `surface.env` never affects the output.
		table.sort(orphanClasses, function(a, b)
			local la = if a.value.span ~= nil then a.value.span.beginLine else 0
			local lb = if b.value.span ~= nil then b.value.span.beginLine else 0
			if la ~= lb then
				return la < lb
			end
			return a.name < b.name
		end)
		local seenSyms = {}
		-- Track `SymValue` keys of members owned by an orphan class so top-level
		-- re-exposures (`return { new = Impl.new }`) can be deduplicated below.
		local orphanOwned: { [any]: boolean } = {}
		for _, orphan in orphanClasses do
			local key = members.symKey(orphan.value)
			if seenSyms[key] then
				continue
			end
			seenSyms[key] = true
			-- Re-check `containerOfSym` in case an earlier orphan's `buildMembers`
			-- registered this table as a nested class (`Outer.Widget = Inner`).
			if ctx.containerOfSym[key] ~= nil then
				continue
			end
			local class = declareClass(orphan.name, orphan.doc, orphan.value.span)
			if orphan.value.defDoc ~= nil then
				members.forwardTagDiagnostics(ctx, mod.id, orphan.value.defDoc, orphan.doc)
			end
			if class == nil then
				continue
			end
			ctx.containerOfSym[key] = class
			if ctx.containersByName[orphan.name] == entry then
				ctx.containersByName[orphan.name] = class
			end
			members.buildMembers(ctx, mod, orphan.name, orphan.value, members.sinks(class, entry))
			for _, member in class.members do
				orphanOwned[member.__valueSym] = true
			end
		end
		-- Remove module-level members that merely re-expose a function already
		-- owned by an orphan class (`return { new = Impl.new }`).
		for i = #entry.members, 1, -1 do
			local key = entry.members[i].__valueSym
			if key ~= nil and orphanOwned[key] then
				table.remove(entry.members, i)
			end
		end
	end

	buildTypeDecls(ctx, mod, entry, fullProcessing, if rootIsInterfaceDoc then rootDoc else nil)

	for _, block in mod.blocks :: any do
		-- Visit unclaimed doc blocks, as well as blocks claimed by unexported
		-- local statements whose tag diagnostics were never forwarded (e.g.,
		-- `--- @function f` above a local helper that never joined the surface).
		if block.doc and (not block.claimed or not ctx.forwardedBlocks[block]) then
			local doc = members.parseTags(ctx, block)
			if doc.placing ~= nil then
				members.forwardTagDiagnostics(ctx, mod.id, block, doc)
				buildFloatingMember(ctx, mod, entry, block, doc, rootContainer)
			elseif not block.claimed and (#doc.params > 0 or doc.within ~= nil) then
				ctx.diag:info(
					"orphaned-doc-block",
					"doc block is not attached to any statement",
					mod.id,
					block.span.beginLine
				)
			end
		end
	end
end

return build

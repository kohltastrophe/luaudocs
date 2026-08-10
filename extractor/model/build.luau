--- Pass 1, per module in graph order: the Module entry, its root container and
--- members, type declarations (@field merging, @interface enrichment, the
--- classType idiom), orphan classes, floating placing blocks (moonwave manual
--- mode), and @external declarations. Type names register here too (nothing
--- reads another module's registry until finalize, so per-module registration
--- and cross-module resolution never race).

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

--- Every block, not just the unclaimed ones the floating sweep walks: an
--- `@external` declaration usually rides along in a class or module doc block
--- another pass has claimed. Reaching a block only from here forwards no tag
--- diagnostics.
local function collectExternals(ctx: Ctx, mod: ModuleData)
	for _, block in (mod.blocks or {}) :: any do
		if block.doc then
			local doc = members.parseTags(ctx, block)
			for _, ext in doc.externals do
				local existing = ctx.externals[ext.name]
				if existing ~= nil and existing ~= ext.url then
					ctx.diag:warn(
						"duplicate-external",
						string.format("@external %s: already mapped to %s; this one is ignored", ext.name, existing),
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

--- Synthetic TypeDecl for an `@interface`/`@type` block with no typealias
--- behind it: the fields come from the tags. `@interface` supplies no type
--- expression, so `definition` is absent and the renderer builds the table
--- from the fields rather than sniffing a placeholder display. Everything but
--- the span comes off the block itself, which named the decl and so spells its
--- kind, display, and @within too.
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
		-- a tag display is one line, so the definition is a one-line block
		definition = if display ~= nil then { display } else nil,
		fields = if #fields > 0 then fields else nil,
		doc = members.placingDoc(doc),
		tags = members.buildBadges(doc),
		-- exported unconditionally above, so the `_`-prefix rule cannot apply
		visibility = members.visibilityOf(name, doc, true),
		source = members.span(mod.id, sourceSpan),
		__within = doc.within,
	}
end

--- `rootContainer` is this module's own container (the entry, or its root
--- class), pinning members with no @within here rather than to a same-named
--- container elsewhere.
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
			-- an existing container (in any module) keeps the name: this block
			-- then declares nothing, which must never happen silently. Global
			-- where declareClass checks per module: a floating class has no
			-- code identity, so "already exists anywhere" makes it redundant
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

	-- the module entry's own name, not mod.name: a root `@class X` renames the
	-- container, and `containersByName` only ever knew it under that name
	local container = targetName or entry.name
	local pseudoField = members.pseudoField(
		placing.name,
		{ kind = if placing.kind == "prop" then "opaque" else "function" },
		placing.kind == "method",
		block.span
	)
	-- `@method __tostring` becomes a metamethod: the tag vocabulary has no
	-- metamethod kind, so buildFn lets the name decide
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

--- `interfaceEnrich` maps type names to @interface/@type docs claimed by
--- another statement: a matching decl consumes its entry, and the leftovers
--- become synthetic decls.
local function buildTypeDecls(
	ctx: Ctx,
	mod: ModuleData,
	entry: any,
	fullProcessing: boolean,
	interfaceEnrich: { [string]: ParsedDoc }
)
	local surface = mod.surface :: any
	local parsedFile = mod.parsed :: any

	-- a decl that is never emitted must not resolve refs to a dangling id, but
	-- decls share the by-name registry entry with any same-named sibling, so
	-- pruning waits until the loop knows no decl under the name was emitted
	local emitted: { [string]: boolean } = {}

	for _, ty in surface.types do
		local tyDoc = members.parseBlock(ctx, mod.id, ty.doc)
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
		local enrich = interfaceEnrich[typeName]
		if enrich ~= nil then
			interfaceEnrich[typeName] = nil
			if tyDoc == members.EMPTY_DOC then
				tyDoc = enrich
			elseif #tyDoc.fields == 0 and #enrich.fields > 0 then
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
		-- merge @field tags into table-type fields: the tag overrides, and a
		-- tag field the table walk missed still names a display line
		if #tyDoc.fields > 0 then
			local merged: { any } = (fields :: any) or {}
			for _, f in tyDoc.fields do
				local found = false
				for _, existing in merged do
					if existing.name == f.name then
						existing.desc = f.desc or existing.desc
						if f.type ~= nil then
							existing.type = members.tagType(f.type, genericNames)
						end
						found = true
						break
					end
				end
				if not found then
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
		local modelFields: any = nil
		if fields ~= nil then
			modelFields = {}
			for _, f in fields do
				table.insert(modelFields, {
					name = f.name,
					type = f.type,
					doc = f.desc,
					-- absent for @field tags naming no field the definition spells
					line = f.line,
					docInDisplay = f.docInDisplay,
				})
			end
		end
		-- a `type function` binds its name to no type expression: `stat.type` is
		-- the `type` KEYWORD token there, so slicing spells `type Widen = type`.
		-- It is called like a function, so its fence carries the parameter list
		-- (the body stays behind the source link).
		local typefnParams: any = nil
		if ty.kind == "typefunction" and ty.stat.body ~= nil then
			local parts: { any } = {}
			segs.pushParamList(parts, (segs.paramEntries(parsedFile, ty.stat.body, genericNames)))
			typefnParams = parts
		end
		local definition: any = nil
		if ty.kind ~= "typefunction" then
			definition = displayBlock or { { "unknown" } }
			-- an @interface bound to a `typeof(...)` alias, which spells none
			-- of its fields: the dot-fields are the shape, so the definition
			-- cedes and the renderer rebuilds the table. Other field-less
			-- spellings (an intersection, an indexer-only table) keep their
			-- definition: the expression itself is the shape there
			if isTypeofAlias and #tyDoc.fields > 0 and tyDoc.placing ~= nil and tyDoc.placing.kind == "interface" then
				definition = nil
			end
		end
		local decl = {
			-- the id keeps the CODE name: registration used `ty.name`, so type
			-- refs resolve to this id even when a placing tag renames the decl
			id = members.memberId(mod.id, "type", nil, ty.name),
			name = typeName,
			exported = ty.exported,
			-- the CST reports only "alias"/"typefunction", so an `@interface`
			-- tag decides the kind. A `type function` is exempt: it computes
			-- a type rather than being one.
			kind = if ty.kind ~= "typefunction"
					and tyDoc.placing ~= nil
					and tyDoc.placing.kind == "interface"
				then "interface"
				else ty.kind,
			generics = generics,
			definition = definition,
			params = typefnParams,
			fields = modelFields,
			doc = members.placingDoc(tyDoc),
			tags = members.buildBadges(tyDoc),
			visibility = members.visibilityOf(typeName, tyDoc, ty.exported),
			source = members.span(mod.id, ty.stat.location),
			__within = tyDoc.within,
		}
		table.insert(entry.types, decl)
		-- registration keys the CODE name (see the id comment above)
		emitted[ty.name] = true

		-- classType idiom: export type X<T> = typeof(setmetatable({} :: D, ClassTable))
		local tnode = ty.stat.type
		if tnode ~= nil and tnode.tag == "typeof" then
			local classLocal = members.setmetatableClassLocal(tnode.expression)
			if classLocal ~= nil then
				local sym = surface.env[classLocal]
				local class = if sym ~= nil then ctx.containerOfSym[members.symKey(sym)] else nil
				-- scratch, not wire: the marker exists so the FIRST matching
				-- type wins, and only classByTypeId below is ever read
				if class ~= nil and class.__classType == nil then
					class.__classType = true
					ctx.classByTypeId[decl.id] = class
				end
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

	-- interface docs that matched no typealias become synthetic type decls;
	-- the block's @within relocates one like any other decl
	for _, enrich in interfaceEnrich do
		table.insert(entry.types, interfaceDecl(ctx, mod, enrich, nil))
	end
end

--- Builds `mod`'s Module entry and appends it to ctx.modules.
function build.run(ctx: Ctx, mod: ModuleData)
	-- before anything else: buildTypeDecls prunes the entries it skips, and
	-- nothing reads another module's registry until finalize
	local types: { [string]: string } = {}
	if mod.surface ~= nil then
		for _, ty in (mod.surface :: any).types do
			types[ty.name] = members.memberId(mod.id, "type", nil, ty.name)
		end
	end
	ctx.typesByModule[mod.id] = types

	-- above the early return below: a module whose surface evaluation failed
	-- still has doc blocks, and an @external in one still binds
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

	-- a floating `@class X` names the module's root container (moonwave style:
	-- the declaration need not sit on the table statement), but only when the
	-- root declares no class of its own; otherwise it is a separate manual
	-- class left for the floating pass below
	local rootHasOwnClass = result ~= nil
		and (result :: any).defDoc ~= nil
		and tagsMod.className(members.parseTags(ctx, (result :: any).defDoc)) ~= nil
	local floatingClassDoc: ParsedDoc? = nil
	local floatingClassSpan: any = nil
	if not rootHasOwnClass then
		for _, block in mod.blocks :: any do
			if block.doc and not block.claimed then
				local parsedFloating = members.parseTags(ctx, block)
				if parsedFloating.placing ~= nil and parsedFloating.placing.kind == "class" then
					floatingClassDoc = parsedFloating
					floatingClassSpan = block.span
					block.claimed = true
					members.forwardTagDiagnostics(ctx, mod.id, block, parsedFloating)
					break
				end
			end
		end
	end

	-- tags-only modules (reached via require-locals, not the public surface)
	-- contribute moonwave manual declarations but no page of their own,
	-- unless they explicitly declare a @class
	local fullProcessing = mod.surfaced or floatingClassDoc ~= nil or rootHasOwnClass

	-- a page granted by @class must also surface the requires it failed to
	-- resolve; graph drains these only on a surfaced upgrade
	if fullProcessing and not mod.surfaced then
		graphMod.drainRequireFailures(mod, ctx.diag)
	end

	-- what the module returns decides two things only: a `require` makes it a
	-- passthrough, and a value the evaluator could not read is worth reporting.
	-- Every other shape is described by the member lists that follow.
	if fullProcessing and result ~= nil then
		if result.kind == "require" then
			entry.aliasOf = mod.requireTargets[result]
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

	-- a claimed block whose placing is @interface/@type documents a TYPE,
	-- not the container: route it to the matching TypeDecl instead
	local interfaceEnrich: { [string]: ParsedDoc } = {}
	local rootIsInterfaceDoc = false
	if rootDoc.placing ~= nil and (rootDoc.placing.kind == "interface" or rootDoc.placing.kind == "type") then
		interfaceEnrich[rootDoc.placing.name] = rootDoc
		rootIsInterfaceDoc = true
	end

	local rootClassName = tagsMod.className(rootDoc)
	local classDoc: ParsedDoc = if rootClassName ~= nil
		then rootDoc
		elseif floatingClassDoc ~= nil then floatingClassDoc
		else members.EMPTY_DOC
	-- classDoc IS whichever block declared the class, so its @class name is the
	-- one the container takes; EMPTY_DOC spells none, which is the no-tag case
	local className = tagsMod.className(classDoc)
	local hasClassTag = className ~= nil
	if fullProcessing then
		entry.doc = if moduleDoc ~= nil and moduleDoc.desc ~= ""
			then moduleDoc.desc
			elseif classDoc.desc ~= "" then classDoc.desc
			elseif rootDoc.desc ~= "" and not rootIsInterfaceDoc then rootDoc.desc
			else nil
	end

	-- the module's own container object, pinning floating members with no
	-- @within (see buildFloatingMember)
	local rootContainer: any = entry

	--- Documented metamethods off `setmetatable(root, MT)`. Both branches share
	--- it, so class-ness does not decide whether a documented `__call` survives.
	local function harvestMetamethods(sym: any, containerName: string, sink: any)
		local mt = (sym :: any).metatable
		-- setmetatable(M, M): the main walk already built M's fields, and a
		-- second pass over the same table would duplicate every documented
		-- metamethod
		if mt ~= nil and mt.kind == "table" and members.symKey(mt) ~= members.symKey(sym) then
			local mtView = { kind = "table", span = mt.span, fields = {} }
			for _, f in mt.fields do
				if surfaceMod.isMetamethod(f.name) and f.value.kind == "function" then
					table.insert(mtView.fields, f)
				end
			end
			if #mtView.fields > 0 then
				-- the attached table is the owner: `self` in a metamethod is
				-- the table the metatable hangs on, not the metatable
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
		-- the empty container is what "callable module" means to the member
		-- builders: the id and callee spell the bare name, not `Mod.Mod`
		local fn =
			members.buildFn(ctx, mod, "", members.pseudoField(mod.name, result, false, result.span), rootDoc, nil)
		table.insert(entry.members, fn)
		members.registerContainer(ctx, mod.name, entry)
	elseif fullProcessing then
		members.registerContainer(ctx, mod.name, entry)
	end

	--- A same-module duplicate would mint a second class with the SAME id (ids
	--- qualify by module + name), which the renderer's symbol table cannot
	--- hold, so it is dropped and reported. Cross-module duplicates are fine:
	--- each keeps its own id.
	local function declareClass(name: string, doc: ParsedDoc, span: any): any?
		for _, class in entry.classes do
			if class.name == name then
				ctx.diag:warn(
					"duplicate-class",
					string.format("@class %s is already declared in this module; ignoring the duplicate", name),
					mod.id,
					if span ~= nil then span.beginLine else nil
				)
				return nil
			end
		end
		local class = members.newContainer(ctx, mod, name, doc, span, nil)
		table.insert(entry.classes, class)
		return class
	end

	-- a floating/root @class on a module that exports no table still declares
	-- the container (factory/callable modules): without registration the class
	-- and every @within member aimed at it silently drop
	if fullProcessing and className ~= nil and (result == nil or result.kind ~= "table") then
		declareClass(className, classDoc, floatingClassSpan or (if result ~= nil then (result :: any).span else nil))
	end

	-- code members documented @within in a tags-only module still relocate.
	-- Built solely to join pendingMoves: nothing lands on this page.
	--
	-- Not buildMembers, though it classifies fields the same way: that one
	-- registers containers, emits re-exports, and forwards tag diagnostics for
	-- every block it walks, none of which may happen for a module with no page.
	-- A classification rule added there has to be considered here too.
	if not fullProcessing and result ~= nil and result.kind == "table" then
		for _, field in (result :: any).fields do
			local block = members.docBlockOf(field)
			local doc: ParsedDoc? = if block ~= nil then members.parseTags(ctx, block) else nil
			if doc ~= nil and doc.within ~= nil and not doc.flags.ignore then
				local value = field.value
				local member: any = nil
				if value.kind == "function" then
					member = members.buildFn(ctx, mod, entry.name, field, doc, nil, result)
				elseif value.kind ~= "require" and value.kind ~= "import" and value.kind ~= "table" then
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

	-- @class blocks claimed by locals that never joined the public surface
	-- (factory pattern: `--- @class Signal` on `local Signal = {}` while the
	-- module returns a constructor) still declare a class, moonwave-style
	if fullProcessing then
		local orphanClasses = {}
		for _, value in surface.env do
			if
				value.kind == "table"
				and members.symKey(value) ~= members.symKey(result)
				and value.defDoc ~= nil
				and ctx.containerOfSym[members.symKey(value)] == nil
			then
				local doc = members.parseTags(ctx, value.defDoc)
				local className = tagsMod.className(doc)
				if className ~= nil then
					table.insert(orphanClasses, { value = value, doc = doc, name = className })
				end
			end
		end
		-- env iteration order is nondeterministic; sort BEFORE the same-sym
		-- dedup below so which clone survives is a source-order fact rather
		-- than a hash accident
		table.sort(orphanClasses, function(a, b)
			local la = if a.value.span ~= nil then a.value.span.beginLine else 0
			local lb = if b.value.span ~= nil then b.value.span.beginLine else 0
			if la ~= lb then
				return la < lb
			end
			return a.name < b.name
		end)
		local seenSyms = {}
		for _, orphan in orphanClasses do
			if seenSyms[members.symKey(orphan.value)] then
				continue
			end
			seenSyms[members.symKey(orphan.value)] = true
			-- re-checked here, not only at collection: an earlier orphan's
			-- buildMembers may have registered this table as a nested class
			-- (`Outer.Widget = Inner`), and emitting it again would document
			-- one table under two ids
			if ctx.containerOfSym[members.symKey(orphan.value)] ~= nil then
				continue
			end
			local class = declareClass(orphan.name, orphan.doc, orphan.value.span)
			if class == nil then
				-- the duplicate was just diagnosed; forwarding still reports the
				-- block's own tag diagnostics and marks it so the floating pass
				-- does not visit it a second time
				members.forwardTagDiagnostics(ctx, mod.id, orphan.value.defDoc, orphan.doc)
				continue
			end
			members.forwardTagDiagnostics(ctx, mod.id, orphan.value.defDoc, orphan.doc)
			ctx.containerOfSym[members.symKey(orphan.value)] = class
			members.buildMembers(ctx, mod, orphan.name, orphan.value, members.sinks(class, entry))
		end
	end

	buildTypeDecls(ctx, mod, entry, fullProcessing, interfaceEnrich)

	for _, block in mod.blocks :: any do
		-- claimed blocks are visited too when nothing forwarded them: a claim
		-- by a statement whose value never joined the surface (`@function f`
		-- above an unexported `local function f`) was read by no pass, and a
		-- placing tag is an explicit request for a member. Blocks without one
		-- stay silent: a documented private local is not a lost member.
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

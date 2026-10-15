--- Pass 2 across the whole model, executed in five ordered phases:
---
---   1. moves      -- `@within` relocations (types first, then pending members,
---                    merging tag-declared stubs into code-backed members).
---   2. dedupe     -- type IDs are name-derived, so duplicate declarations in
---                    the same module share an ID; picks the winner before any
---                    reference resolves to it. Member IDs are deduplicated
---                    after `@within` moves re-mint them.
---   3. reexports  -- resolves re-export chains to their final module and member
---                    IDs (requires final member IDs from phases 1 and 2).
---   4. call types -- infers property types from cross-module function return
---                    annotations before reference segments are resolved.
---   5. resolve + constructors -- resolves every reference segment to its target
---                    ID and links class constructors using those resolved IDs.

local graphMod = require("../graph")
local inferMod = require("../infer")
local segs = require("../segs")
local surfaceMod = require("../surface")
local members = require("./members")

type Ctx = members.Ctx
type Graph = graphMod.Graph

local finalize = {}

--- Emits an `orphaned-within` warning when `@within` names a non-existent container.
local function warnOrphan(ctx: Ctx, within: string, file: string, line: number?)
	ctx.diag:warn("orphaned-within", string.format("@within %s: no class or module with that name", within), file, line)
end

--- Relocates `@within`-tagged type declarations onto the module that owns their
--- target class or container (e.g., a `@within Registry @type X` in `Types.luau`
--- moves onto `Registry`'s page).
local function moveTypes(ctx: Ctx)
	local entryOfContainer: { [any]: any } = {}
	for _, entry in ctx.modules do
		entryOfContainer[entry] = entry
		for _, class in entry.classes do
			entryOfContainer[class] = entry
		end
	end
	local typeMoves = {}
	for _, entry in ctx.modules do
		for _, decl in entry.types do
			local within = decl.__within
			if within == nil then
				continue
			end
			local target = ctx.containersByName[within]
			if target == nil then
				warnOrphan(ctx, within, entry.id, decl.source.line)
				continue
			end
			local destEntry = entryOfContainer[target]
			if destEntry ~= nil and destEntry ~= entry then
				table.insert(typeMoves, { decl = decl, from = entry, to = destEntry })
			end
		end
	end
	for _, move in typeMoves do
		local idx = table.find(move.from.types, move.decl)
		if idx ~= nil then
			table.remove(move.from.types, idx)
		end
		table.insert(move.to.types, move.decl)
	end
end

--- Re-mints `member.id` and `member.signature.callee` for `targetName` after an
--- `@within` move.
local function retarget(member: any, fromModule: string, targetName: string)
	member.id = members.memberId(fromModule, if member.kind == "prop" then "prop" else "fn", targetName, member.name)
	if member.signature ~= nil then
		member.signature.callee = members.callee(targetName, if member.kind == "method" then ":" else ".", member.name)
	end
end

--- Returns the full container name (`Color.Oklab` for a nested class, even if
--- `@within` targeted its short name `Oklab`).
local function canonicalName(target: any): string
	return if target.within ~= nil then target.within .. "." .. target.name else target.name
end

--- Merges a tag-declared stub's parameters and returns into a code-backed member,
--- then rebuilds `sig.segs`. Parameters match by name (tag docs win; tag types
--- fill unannotated slots) and returns match by position, warning at the stub's
--- source line on any mismatch.
local function mergeSignature(ctx: Ctx, into: any, from: any)
	local sig = into.signature
	local hasCode = into.__valueSym ~= nil
	for _, tagParam in from.signature.params do
		local found = members.byName(sig.params, tagParam.name)
		if found ~= nil then
			found.doc = tagParam.doc or found.doc
			if found.type == nil then
				found.type = tagParam.type
			end
		elseif not hasCode then
			table.insert(sig.params, tagParam)
		else
			ctx.diag:warn(
				"param-mismatch",
				string.format("@param %s does not match any parameter of %s", tagParam.name, sig.callee),
				from.source.file,
				from.source.line
			)
		end
	end
	for ri, tagReturn in from.signature.returns do
		local r = sig.returns[ri]
		if r ~= nil then
			r.doc = tagReturn.doc or r.doc
			if r.type == nil and tagReturn.type ~= nil then
				r.type = tagReturn.type
				sig.__tagReturns = true
			end
		elseif #sig.returns == 0 or sig.__annotationTail == nil then
			table.insert(sig.returns, tagReturn)
			if tagReturn.type ~= nil then
				sig.__tagReturns = true
			end
		else
			ctx.diag:warn(
				"return-count-mismatch",
				string.format("@return #%d exceeds the annotated returns of %s", ri, sig.callee),
				from.source.file,
				from.source.line
			)
		end
	end
	sig.segs = members.signatureSegs(sig)
end

local function applyPending(ctx: Ctx)
	for _, move in ctx.pendingMoves do
		local target = move.targetContainer or ctx.containersByName[move.targetName]
		if target == nil then
			warnOrphan(ctx, move.targetName, move.fromModule, move.member.source.line)
			continue
		end
		local member = move.member
		local existing = members.byName(target.members, member.name)
		-- `findExisting` matches by member name alone. Aliases of the same
		-- `SymValue` and tag-declared stubs (`__valueSym == nil`) merge into the
		-- existing entry; two distinct code-backed members (`existing.__valueSym ~= member.__valueSym`)
		-- cannot merge, so keep the first and emit `duplicate-within` for the second.
		if
			existing ~= nil
			and member.__valueSym ~= nil
			and existing.__valueSym ~= nil
			and existing.__valueSym ~= member.__valueSym
		then
			local kept = string.format("%s:%d", existing.source.file, existing.source.line)
			local message = string.format(
				"@within %s: a different %s is already declared there (%s); this one is dropped",
				move.targetName,
				member.name,
				kept
			)
			ctx.diag:warn("duplicate-within", message, move.fromModule, member.source.line)
			continue
		end
		if existing ~= nil then
			-- Usually `existing` is the code-backed member and `member` is the
			-- incoming tag stub. If a tag stub arrived first (due to require
			-- order), promote the incoming code-backed member into the slot and
			-- merge the stub into it.
			local into, from = existing, member
			if existing.__valueSym == nil and member.__valueSym ~= nil then
				retarget(member, move.fromModule, canonicalName(target))
				local idx = table.find(target.members, existing)
				if idx ~= nil then
					target.members[idx] = member
				end
				into, from = member, existing
			end
			-- Tag docs and badges overlay onto the code member; explicit AST
			-- types win over tag types, but tag types override inferred types
			-- (e.g., `@prop x { Command }` over `x = {}`).
			into.doc = from.doc or into.doc
			members.overlayBadges(into.tags, from.tags)
			if from.type ~= nil and (into.type == nil or into.__inferred) then
				into.type = from.type
				into.__inferred = nil
			end
			if from.readonly then
				into.readonly = true
			end
			if from.visibility == "private" then
				into.visibility = "private"
			end
			if from.signature ~= nil and into.signature ~= nil then
				mergeSignature(ctx, into, from)
			end
			if from.errors ~= nil and into.errors ~= nil and #into.errors == 0 then
				for _, e in from.errors do
					table.insert(into.errors, e)
				end
			end
			continue
		end
		retarget(member, move.fromModule, canonicalName(target))
		table.insert(target.members, member)
	end
end

--- Deduplicates type declarations sharing the same `<mod>#type.<name>` ID (e.g.,
--- a redeclared `type T` or a floating `@interface T` alongside a real `type T`).
--- An `export type` beats an unexported `type`; ties go to the first declaration.
local function dedupeTypes(ctx: Ctx)
	local winners: { [string]: any } = {}
	local losers: { any } = {}
	for _, entry in ctx.modules do
		for _, decl in entry.types do
			local held = winners[decl.id]
			if held == nil then
				winners[decl.id] = decl
			elseif decl.exported and not held.exported then
				winners[decl.id] = decl
				table.insert(losers, held)
			else
				table.insert(losers, decl)
			end
		end
	end
	if #losers == 0 then
		return
	end
	for _, loser in losers do
		ctx.diag:warn(
			"duplicate-type",
			string.format(
				"%s is declared more than once; documenting the %s declaration",
				loser.name,
				if winners[loser.id].exported then "exported" else "first"
			),
			loser.source.file,
			loser.source.line
		)
	end
	for _, entry in ctx.modules do
		local kept = {}
		for _, decl in entry.types do
			if winners[decl.id] == decl then
				table.insert(kept, decl)
			end
		end
		entry.types = kept
	end
end

--- Ensures every member ID across the model is unique, dropping and warning on
--- any duplicate IDs that remain after `@within` moves.
local function dedupeMembers(ctx: Ctx)
	local held: { [string]: any } = {}
	local function sweep(container: any)
		for i = 1, #container.members do
			local member = container.members[i]
			local first = held[member.id]
			if first == nil then
				held[member.id] = member
			else
				ctx.diag:warn(
					"duplicate-member",
					string.format(
						"%s is documented more than once (first at %s:%d); this one is dropped",
						member.id,
						first.source.file,
						first.source.line
					),
					member.source.file,
					member.source.line
				)
				container.members[i] = false
			end
		end
		for i = #container.members, 1, -1 do
			if container.members[i] == false then
				table.remove(container.members, i)
			end
		end
	end
	for _, entry in ctx.modules do
		sweep(entry)
		for _, class in entry.classes do
			sweep(class)
		end
	end
end

--- Maximum require/field steps before a re-export chain is treated as a cycle.
local MAX_STEPS = 256

--- Follows a require/field path starting in `moduleId` (or from `from` when
--- given a `SymValue` in hand) and returns `{ moduleId, value? }`, where `value`
--- is `nil` when the path resolves to a whole module. Returns `nil` if any hop
--- is unresolved or exceeds `MAX_STEPS`.
local function resolvePath(g: Graph, moduleId: string, path: { string }?, from: any?): any?
	local modId = moduleId
	local rest: { string } = if path ~= nil then table.clone(path) else {}
	-- `value == nil` means the current module's root return value; `indexed`
	-- tracks whether we have stepped into a member field.
	local value: any = from
	local indexed = from ~= nil
	for _ = 1, MAX_STEPS do
		local mod = g.byId[modId]
		if mod == nil or mod.surface == nil then
			return nil
		end
		if value == nil then
			value = (mod.surface :: any).result
			if value == nil then
				return nil
			end
		end
		local mounted = surfaceMod.unguard(value)
		if mounted.kind == "require" then
			if mod.externalRequires[mounted] ~= nil and #rest > 0 then
				return { moduleId = modId, opaque = true, base = mounted, rest = rest }
			end
			modId = mod.requireTargets[mounted]
			if modId == nil then
				return nil
			end
			value, indexed = nil, false
			continue
		end
		if mounted.kind == "import" then
			if mod.externalRequires[mounted.base] ~= nil then
				return { moduleId = modId, opaque = true, base = mounted.base, rest = rest }
			end
			modId = mod.requireTargets[mounted.base]
			if modId == nil then
				return nil
			end
			local spliced = table.clone(mounted.path :: { string })
			table.move(rest, 1, #rest, #spliced + 1, spliced)
			value, indexed, rest = nil, false, spliced
			continue
		end
		if #rest == 0 then
			return { moduleId = modId, value = if indexed then value else nil }
		end
		if mounted.kind ~= "table" then
			return if mounted.kind == "opaque"
				then { moduleId = modId, opaque = true, base = mounted, rest = rest }
				else nil
		end
		local field = surfaceMod.fieldOf(mounted, rest[1])
		if field == nil then
			return nil
		end
		value = field.value
		indexed = true
		table.remove(rest, 1)
	end
	return nil
end

--- Indexes every code-backed member across the model by its `SymValue` key
--- (first registration wins).
local function membersByValue(ctx: Ctx): { [any]: any }
	local bySym: { [any]: any } = {}
	for _, entry in ctx.modules do
		members.eachMember(entry, function(member)
			local key = member.__valueSym
			if key ~= nil and bySym[key] == nil then
				bySym[key] = member
			end
		end)
	end
	return bySym
end

--- Resolves each re-export's `targetModule` to the final module in its chain
--- and sets `targetId` to the target definition's ID (clearing `targetMember`
--- when a chain ends on a whole module).
local function resolveReexports(ctx: Ctx, g: Graph)
	local bySym = membersByValue(ctx)
	for _, entry in ctx.modules do
		local kept = {}
		for _, reexport in entry.reexports do
			-- Runtime alias mounts (`@lute/fs`) already carry their spelling and URL.
			if reexport.__external then
				reexport.__external = nil
				table.insert(kept, reexport)
				continue
			end
			local path, line = reexport.__path, reexport.__line
			local sink, prop = reexport.__sink, reexport.__prop
			reexport.__path, reexport.__line, reexport.__sink, reexport.__prop = nil, nil, nil, nil
			local landed = resolvePath(g, reexport.targetModule, path)
			if landed ~= nil and landed.opaque then
				-- Indexing into an opaque value (`Util.Service.Players.LocalPlayer`
				-- or an opaque package link) is a runtime property expression
				-- rather than a module re-export.
				if prop ~= nil and sink ~= nil then
					if
						prop.type == nil
						and landed.base ~= nil
						and landed.base.service == "Players"
						and #landed.rest == 1
						and landed.rest[1] == "LocalPlayer"
					then
						prop.type = { segs.ref("Player", "Player") }
					end
					table.insert(sink, prop)
				end
				continue
			end
			if landed ~= nil then
				reexport.targetModule = landed.moduleId
				if landed.value == nil then
					reexport.targetMember = nil
					table.insert(kept, reexport)
					continue
				end
				local key = members.symKey(landed.value)
				local target = ctx.containerOfSym[key] or bySym[key]
				if target ~= nil then
					reexport.targetId = target.id
					table.insert(kept, reexport)
					continue
				end
			end
			table.insert(kept, reexport)
			local named = if reexport.targetMember ~= nil
				then reexport.targetModule .. "." .. reexport.targetMember
				else reexport.targetModule
			ctx.diag:info(
				"unresolved-reexport",
				string.format("%s re-exports %s, which is not documented there", reexport.name, named),
				entry.id,
				line
			)
		end
		entry.reexports = kept
	end
end

--- Looks up `typeName` in the module bound to `localName` in `mod.localModules`.
local function typeIdIn(ctx: Ctx, mod: any, localName: string, typeName: string): string?
	local targetMod = mod.localModules[localName]
	local types = if targetMod ~= nil then ctx.typesByModule[targetMod] else nil
	return if types ~= nil then types[typeName] else nil
end

--- Resolves reference segments in `list` against the defining module's scope.
--- Unresolved segments keep only their `text` (since `__` keys are stripped on
--- emit), allowing the renderer to link `@external` and Roblox types by text.
--- `landed` is the container the member renders under, which tag references can
--- always name directly.
local function resolveList(ctx: Ctx, g: Graph, modId: string, list: { any }?, landed: any?)
	if list == nil then
		return
	end
	for _, seg in list do
		if type(seg) ~= "table" then
			continue
		end
		-- Call-inferred return types carry `__scope` set to the callee's module
		-- so their type references resolve in the callee's file scope.
		local scope: string = seg.__scope or modId
		local mod = g.byId[scope]
		if seg.__prefix ~= nil then
			seg.id = if mod ~= nil then typeIdIn(ctx, mod, seg.__prefix, seg.__name) else nil
			-- If `seg.__prefix` is a required runtime alias (`fs.File`), record
			-- an `ExternalRef` in `ctx.externals` so the renderer can link it.
			local external = if mod ~= nil and seg.id == nil then mod.localExternals[seg.__prefix] else nil
			if external ~= nil and ctx.externals[seg.text] == nil then
				ctx.externals[seg.text] =
					{ url = external.url, alias = external.alias, path = external.path, name = seg.__name }
			end
			continue
		end
		if seg.__name == nil then
			continue
		end
		local ownTypes = ctx.typesByModule[scope]
		if ownTypes ~= nil and ownTypes[seg.__name] ~= nil then
			seg.id = ownTypes[seg.__name]
			continue
		end
		-- Moonwave tag convention: a bare `@return Widget` in a tag can name a
		-- required module's same-named type (`Widget.Widget`) or a class defined,
		-- required, or targeted (`landed`) by this module.
		if not seg.__tag then
			continue
		end
		seg.id = if mod ~= nil then typeIdIn(ctx, mod, seg.__name, seg.__name) else nil
		if seg.id ~= nil then
			continue
		end
		if landed ~= nil and landed.name == seg.__name then
			seg.id = landed.id
			continue
		end
		local container = ctx.containersByName[seg.__name]
		if container == nil then
			continue
		end
		local containerMod = if container.source ~= nil then container.source.file else nil
		local linked = containerMod == scope
		if not linked and mod ~= nil then
			for _, requiredId in mod.requireTargets do
				if requiredId == containerMod then
					linked = true
					break
				end
			end
		end
		if linked then
			seg.id = container.id
		end
	end
end

local function resolveBlock(ctx: Ctx, g: Graph, modId: string, lines: { { any } }?)
	if lines == nil then
		return
	end
	for _, line in lines do
		resolveList(ctx, g, modId, line)
	end
end

--- Extracts a function's first return type annotation as segments. Returns `nil`
--- when the function has no return annotation or when the return type mentions
--- one of the function's own generic type parameters (e.g., `Node<T>` on
--- `computed<T>(fn: () -> T): Node<T>`, where `T` is unbound at the call site).
local function annotatedReturn(parsedFile: any, fnNode: any): { any }?
	local node = members.returnNodes(fnNode)[1]
	if node == nil then
		return nil
	end
	local list = segs.inline(parsedFile, node, nil)
	if list == nil then
		return nil
	end
	if fnNode.generics ~= nil or fnNode.genericPacks ~= nil then
		local _, genericNames = segs.generics(parsedFile, fnNode.generics, fnNode.genericPacks)
		for _, seg in list do
			if type(seg) == "table" and genericNames[seg.__name] then
				return nil
			end
		end
	end
	return list
end

--- Stamps `__scope = scope` onto every reference segment in `list`.
local function stampScopeList(list: { any }?, scope: string)
	if list == nil then
		return
	end
	for _, seg in list do
		if type(seg) == "table" and seg.__scope == nil then
			seg.__scope = scope
		end
	end
end

--- Infers property types for properties initialized with a function call
--- (`M.x = otherMod.make()`) by following the callee to its return annotation.
local function inferCallTypes(ctx: Ctx, g: Graph)
	for _, entry in ctx.modules do
		members.eachMember(entry, function(member)
			local value = member.__inferCall
			member.__inferCall = nil
			if value == nil or member.type ~= nil then
				return
			end
			local call, guarded = surfaceMod.unguard(value)
			local found = resolvePath(g, member.source.file, nil, call.calleeValue)
			local callee = if found ~= nil then found.value else nil
			if callee == nil or callee.kind ~= "function" then
				return
			end
			local mod = g.byId[found.moduleId]
			local list = if mod ~= nil then annotatedReturn(mod.parsed, callee.fnNode) else nil
			if list == nil then
				return
			end
			stampScopeList(list, found.moduleId)
			member.type = if guarded then inferMod.optional(list) else list
			-- If a realm-guarded call (`IsServer and check()`) returns `boolean`,
			-- the expression is a boolean predicate rather than a realm-only mount,
			-- so clear the guard-detected realm badge.
			if guarded and member.__mountRealm and inferMod.isBoolean(list) then
				member.tags.realm = nil
			end
		end)
	end
end

--- Returns the resolved ID when `list` is a single reference segment optionally
--- followed by `<...>` type arguments (`Widget` or `State<T>`), or `nil` for
--- optional/union/table wrappers (`Widget?`, `{ Widget }`, `Promise<Widget>`).
local function exactClassRef(list: { any }?): string?
	local head = if list ~= nil then list[1] else nil
	if type(head) ~= "table" or head.id == nil then
		return nil
	end
	local rest = segs.text(list :: { any }, 2)
	if rest == "" then
		return head.id
	end
	if rest:sub(1, 1) ~= "<" then
		return nil
	end
	local depth = 0
	for i = 1, #rest do
		local c = rest:sub(i, i)
		if c == "<" then
			depth += 1
		elseif c == ">" and rest:sub(i - 1, i - 1) ~= "-" then
			depth -= 1
			if depth == 0 then
				return if i == #rest then head.id else nil
			end
		end
	end
	return nil
end

--- Returns the single prefixed reference segment if `def` is `Prefix.Name` or
--- `Prefix.Name<...>`, or `nil` otherwise.
local function respelledSeg(def: { { any } }?): any?
	local line = if def ~= nil and #def == 1 then def[1] else nil
	local head = if line ~= nil then line[1] else nil
	if type(head) ~= "table" or head.__prefix == nil then
		return nil
	end
	if #line == 1 then
		return head
	end
	return if #line == 2 and type(line[2]) == "string" and line[2]:sub(1, 1) == "<" then head else nil
end

--- Expands `export type X = Sub.Y` declarations whose `Sub` is a non-surfaced
--- module (`not targetMod.surfaced`), inlining `Y`'s definition, fields, and doc
--- onto `X` and registering `X.id` in `ctx.typesByModule[Sub.id][Y]` so all
--- references to `Sub.Y` link to `X`.
local function expandRespelledTypes(ctx: Ctx, g: Graph)
	for _, entry in ctx.modules do
		for _, decl in entry.types do
			local seg = respelledSeg(decl.definition)
			local writer = if seg ~= nil then g.byId[decl.source.file] else nil
			local targetId = if writer ~= nil then writer.localModules[seg.__prefix] else nil
			local targetMod = if targetId ~= nil then g.byId[targetId] else nil
			if
				targetMod == nil
				or targetMod.surfaced
				or targetMod.surface == nil
				or targetMod.parsed == nil
				or ctx.typesByModule[targetId :: string][seg.__name] ~= nil
			then
				continue
			end
			local ty = members.byName((targetMod.surface :: any).types, seg.__name)
			if ty ~= nil and ty.stat ~= nil and ty.stat.type ~= nil then
				ctx.typesByModule[targetId :: string][ty.name] = decl.id
				local _, genericNames = segs.generics(targetMod.parsed, ty.stat.generics, ty.stat.genericPacks)
				local fields, _, displayBlock = segs.fields(
					targetMod.parsed,
					ty.stat.type,
					targetMod.claimIndex :: any,
					targetMod.trailingIndex :: any,
					genericNames,
					if ty.stat.location ~= nil then ty.stat.location.beginLine else nil
				)
				if displayBlock ~= nil then
					for _, line in displayBlock do
						stampScopeList(line, targetMod.id)
					end
					decl.definition = displayBlock
				end
				if decl.fields == nil and fields ~= nil then
					for _, f in fields do
						stampScopeList(f.type, targetMod.id)
					end
					decl.fields = members.toModelFields(fields)
				end
				if decl.doc == nil and ty.doc ~= nil then
					decl.doc = members.placingDoc(members.parseBlock(ctx, targetMod.id, ty.doc))
				end
			end
		end
	end
end

local function resolveRefsAndConstructors(ctx: Ctx, g: Graph)
	-- Map both `classType` declaration IDs and direct `Class` IDs to their class
	-- entries so constructor detection works with or without a `classType` alias.
	local classOfRefId: { [string]: any } = {}
	for id, class in ctx.classByTypeId do
		classOfRefId[id] = class
	end
	local entryById: { [string]: any } = {}
	for _, entry in ctx.modules do
		entryById[entry.id] = entry
		for _, class in entry.classes do
			classOfRefId[class.id] = class
		end
	end

	local function detectConstructor(fn: any)
		local class: any = nil
		local sym = fn.__constructsSym
		if sym ~= nil then
			class = ctx.containerOfSym[members.symKey(sym)]
			fn.__constructsSym = nil
		end
		-- Fall back to return-type matching only for dot-called functions (so
		-- fluent methods like `function Widget:withSize(): Widget` are not
		-- mistaken for constructors).
		if class == nil and fn.kind == "function" then
			local firstReturn = fn.signature.returns[1]
			local head = if firstReturn ~= nil then exactClassRef(firstReturn.type) else nil
			if head ~= nil then
				class = classOfRefId[head]
			end
		end
		if class ~= nil and class.constructors ~= nil and table.find(class.constructors, fn.id) == nil then
			table.insert(class.constructors, fn.id)
		end
	end

	local function resolveMember(member: any, landed: any)
		-- Resolve against `member.source.file` (the defining module, preserved
		-- across `@within` moves).
		local modId = member.source.file
		if member.kind == "prop" then
			resolveList(ctx, g, modId, member.type, landed)
		else
			local reqTargetId = member.__returnedRequire
			member.__returnedRequire = nil
			local reqEntry = if reqTargetId ~= nil then entryById[reqTargetId] else nil
			if reqEntry ~= nil and #member.signature.returns <= 1 then
				local ret = member.signature.returns[1]
				local retText = if ret ~= nil and ret.type ~= nil then segs.text(ret.type) else ""
				if retText == "" or retText:find("^typeof%(require%(") ~= nil then
					local refSeg = { text = reqEntry.name, id = reqEntry.id }
					if ret ~= nil then
						ret.type = { refSeg }
					else
						member.signature.returns[1] = { type = { refSeg } }
					end
					member.signature.__tagReturns = true
					member.signature.segs = members.signatureSegs(member.signature)
				end
			end
			resolveList(ctx, g, modId, member.signature.segs, landed)
			for _, p in member.signature.params do
				resolveList(ctx, g, modId, p.type, landed)
			end
			for _, r in member.signature.returns do
				resolveList(ctx, g, modId, r.type, landed)
			end
			detectConstructor(member)
		end
	end
	for _, entry in ctx.modules do
		members.eachMember(entry, resolveMember)
		for _, decl in entry.types do
			local modId = decl.source.file
			for _, gp in decl.generics do
				resolveList(ctx, g, modId, gp.default)
			end
			resolveBlock(ctx, g, modId, decl.definition)
			for _, f in decl.fields or {} do
				resolveList(ctx, g, modId, f.type)
			end
		end
	end
end

--- Emits an `unreached-types` info diagnostic when a non-surfaced module exports
--- types that are neither relocated via `@within` nor re-exported (`export type
--- Hook = types.Hook`) by a surfaced module.
local function reportUnreachedTypes(ctx: Ctx, g: Graph)
	local emitted: { [string]: boolean } = {}
	for _, entry in ctx.modules do
		for _, decl in entry.types do
			emitted[decl.id] = true
		end
	end
	for _, mod in g.modules do
		local types = ctx.typesByModule[mod.id]
		if mod.surfaced or mod.surface == nil or types == nil then
			continue
		end
		local names: { string } = {}
		local line: number? = nil
		for _, ty in (mod.surface :: any).types do
			local id = types[ty.name]
			if not ty.exported or (id ~= nil and emitted[id]) then
				continue
			end
			table.insert(names, ty.name)
			if line == nil and ty.stat.location ~= nil then
				line = ty.stat.location.beginLine
			end
		end
		if #names == 0 then
			continue
		end
		local shown = table.concat(names, ", ", 1, math.min(#names, 3)) .. (if #names > 3 then ", ..." else "")
		ctx.diag:info(
			"unreached-types",
			string.format(
				"exports %d type%s the public surface never reaches (%s); list the module in [source] entries or re-export them",
				#names,
				if #names == 1 then "" else "s",
				shown
			),
			mod.id,
			line
		)
	end
end

--- Opt-in (`--report-undocumented`): warns on any public class, member, or
--- exported type without a doc comment (skipping re-exports, module intros,
--- local type aliases, and private members).
local function reportUndocumented(ctx: Ctx)
	local function report(what: string, label: string, item: any)
		if item.doc == nil and item.visibility ~= "private" then
			ctx.diag:warn(
				"undocumented",
				string.format("%s %s has no doc comment", what, label),
				item.source.file,
				item.source.line
			)
		end
	end
	for _, entry in ctx.modules do
		for _, class in entry.classes do
			report("class", class.name, class)
		end
		members.eachMember(entry, function(member, owner)
			if member.kind == "prop" then
				report("property", if owner.name ~= "" then owner.name .. "." .. member.name else member.name, member)
			else
				report(member.kind, member.signature.callee, member)
			end
		end)
		for _, decl in entry.types do
			if decl.exported then
				report("type", decl.name, decl)
			end
		end
	end
end

function finalize.run(ctx: Ctx, g: Graph, opts: { reportUndocumented: boolean? }?)
	moveTypes(ctx)
	applyPending(ctx)
	dedupeTypes(ctx)
	dedupeMembers(ctx)
	resolveReexports(ctx, g)
	inferCallTypes(ctx, g)
	expandRespelledTypes(ctx, g)
	resolveRefsAndConstructors(ctx, g)
	reportUnreachedTypes(ctx, g)
	if opts ~= nil and opts.reportUndocumented then
		reportUndocumented(ctx)
	end
end

return finalize

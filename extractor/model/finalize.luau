--- Pass 2, over the whole model, in five phases whose order is the point:
---
---   1. moves    -- @within relocations (types first, then pending members,
---                  which merge tag-declared stubs into code members)
---   2. dedupe   -- type ids are name-derived, so two declarations of one name
---                  arrive sharing an id; the winner is settled before anything
---                  resolves a ref to it. Runs after moves because a relocated
---                  decl keeps the id it was minted with.
---   3. reexports -- identity resolution needs every member id final, hence
---                  after moves.
---   4. call types -- props assigned a call take the callee's annotated return,
---                  which needs every module's surface. Before resolve, so the
---                  segments it mints are resolved in the same walk.
---   5. resolve + constructors -- one walk: every ref segment gets its id
---                  (registration is complete, dedupe has settled winners), and
---                  constructor detection consumes exactly those resolved ids.

local graphMod = require("../graph")
local inferMod = require("../infer")
local segs = require("../segs")
local surfaceMod = require("../surface")
local members = require("./members")

type Ctx = members.Ctx
type Graph = graphMod.Graph

local finalize = {}

--- The one spelling of "@within names nothing", for both move halves below.
local function warnOrphan(ctx: Ctx, within: string, file: string, line: number?)
	ctx.diag:warn("orphaned-within", string.format("@within %s: no class or module with that name", within), file, line)
end

--- Relocates @within-tagged type declarations onto the page that owns their
--- class, so a `@within Registry @type X` in a shared Type.luau renders on the
--- Registry page.
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

--- Both are minted fresh: `mod#fn.Color.Oklab.toRGB` @within Palette becomes
--- `mod#fn.Palette.toRGB`, however many segments the previous container had.
local function retarget(member: any, fromModule: string, targetName: string)
	member.id = members.memberId(fromModule, if member.kind == "prop" then "prop" else "fn", targetName, member.name)
	if member.signature ~= nil then
		member.signature.callee = members.callee(targetName, if member.kind == "method" then ":" else ".", member.name)
	end
end

--- A nested class registers under both `Oklab` and `Color.Oklab`, so a member
--- moved there via the short name must still mint the id/callee its future
--- siblings carry. Composed from the container's fields, never parsed back out
--- of its id.
local function canonicalName(target: any): string
	return if target.within ~= nil then target.within .. "." .. target.name else target.name
end

local function findExisting(target: any, name: string): any?
	for _, member in target.members do
		if member.name == name then
			return member
		end
	end
	return nil
end

local function applyPending(ctx: Ctx)
	for _, move in ctx.pendingMoves do
		local target = move.targetContainer or ctx.containersByName[move.targetName]
		if target == nil then
			warnOrphan(ctx, move.targetName, move.fromModule, move.member.source.line)
			continue
		end
		local member = move.member
		local existing = findExisting(target, member.name)
		-- findExisting matches on the name alone, so an alias (one value under
		-- two names) looks just like a collision; the shared SymValue settles
		-- it. Aliases and tag-declared stubs (members with no `__valueSym`)
		-- merge. Two genuinely different CODE members cannot: merging would
		-- publish one's docs under the other's signature, so the first in
		-- source order keeps the name and the second is reported.
		if
			existing ~= nil
			and member.__valueSym ~= nil
			and existing.__valueSym ~= nil
			and existing.__valueSym ~= member.__valueSym
		then
			local kept = string.format("%s:%d", existing.source.file, existing.source.line)
			-- "a different", not "already documented": the survivor holds the
			-- name but need not carry prose of its own
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
			-- normally the arriving member is the tag side and the resident has
			-- the code; a tag stub applied earlier (require order) inverts that,
			-- so the code member takes the stub's slot and the roles swap
			local into, from = existing, member
			if existing.__valueSym == nil and member.__valueSym ~= nil then
				retarget(member, move.fromModule, canonicalName(target))
				local idx = table.find(target.members, existing)
				if idx ~= nil then
					target.members[idx] = member
				end
				into, from = member, existing
			end
			-- merge: the tag block's docs win, DECLARED types/signatures are
			-- kept. An inferred one yields, since `@prop x { Command }` over a
			-- `x = {}` is the author naming what the empty table is for.
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
				for _, tagParam in from.signature.params do
					for _, p in into.signature.params do
						if p.name == tagParam.name then
							p.doc = tagParam.doc or p.doc
							if p.type == nil then
								p.type = tagParam.type
							end
						end
					end
				end
				for ri, tagReturn in from.signature.returns do
					local r = into.signature.returns[ri]
					if r ~= nil then
						r.doc = tagReturn.doc or r.doc
					end
				end
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

--- Ids are name-derived, so a name declared twice (a redeclared `type T`, or a
--- floating `@interface T` beside a real one) arrives sharing one. The extras
--- are dropped rather than disambiguated: an id is what every ref resolves to.
--- An explicit `export` wins, failing that the first in assembly order.
local function dedupeTypes(ctx: Ctx)
	-- the winner is chosen over the whole model before anything is removed: the
	-- @within moves can leave two declarations sharing an id on two entries
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
		-- reported at the loser's line: this is the declaration the reader
		-- cannot find in the docs
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

--- How many steps one re-export path may take before it is called a cycle.
--- Each require hop and each consumed segment counts.
local MAX_STEPS = 256

--- Where a path starting in `moduleId` lands: `{ moduleId, value? }`, `value`
--- absent when the path names the module itself. Nil when it names nothing
--- surfaced. Requires are followed as they are met, so a chain
--- (`M.Remote = Util.Remote`) resolves past the middleman to the definer.
--- `from` starts the walk at a value already in hand rather than at the
--- module's returned one, which is how a callee is followed to its definition.
local function resolvePath(g: Graph, moduleId: string, path: { string }?, from: any?): any?
	local modId = moduleId
	local rest: { string } = if path ~= nil then table.clone(path) else {}
	-- nil means "the module's own returned value", not "nothing": it is what a
	-- fresh module is entered with, and `indexed` tells the two apart
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
		if value.kind == "require" then
			modId = mod.requireTargets[value]
			if modId == nil then
				return nil
			end
			value, indexed = nil, false
			continue
		end
		if value.kind == "import" then
			-- a member of a module required elsewhere: re-enter it with the
			-- import's own path ahead of whatever is still to walk
			modId = mod.requireTargets[value.base]
			if modId == nil then
				return nil
			end
			local spliced = table.clone(value.path :: { string })
			table.move(rest, 1, #rest, #spliced + 1, spliced)
			value, indexed, rest = nil, false, spliced
			continue
		end
		if #rest == 0 then
			return { moduleId = modId, value = if indexed then value else nil }
		end
		if value.kind ~= "table" then
			return nil
		end
		local field = surfaceMod.fieldOf(value, rest[1])
		if field == nil then
			return nil
		end
		value = field.value
		indexed = true
		table.remove(rest, 1)
	end
	return nil
end

--- Every member the build pass made from a surfaced value, by that value's
--- identity key. Flat across modules and first-wins: two names for one value
--- can only occur within a single module, and there they are one member to
--- everything downstream.
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

--- Rewrites each re-export's `targetModule` to the module its chain ends in and
--- fills `targetId` with what it names there. `targetMember` is cleared when a
--- chain turns out to end on a whole module.
local function resolveReexports(ctx: Ctx, g: Graph)
	local bySym = membersByValue(ctx)
	for _, entry in ctx.modules do
		for _, reexport in entry.reexports do
			local path, line = reexport.__path, reexport.__line
			reexport.__path, reexport.__line = nil, nil
			local landed = resolvePath(g, reexport.targetModule, path)
			if landed ~= nil then
				reexport.targetModule = landed.moduleId
				if landed.value == nil then
					reexport.targetMember = nil
					continue
				end
				local key = members.symKey(landed.value)
				-- a class is registered by its table's identity rather than as
				-- a member, so both maps are asked before giving up
				local target = ctx.containerOfSym[key] or bySym[key]
				if target ~= nil then
					-- `targetMember` stays: the renderer still says "re-exported
					-- from X" for a member whose definition it cannot see
					reexport.targetId = target.id
					continue
				end
			end
			-- reported: the page still shows the name, but only as a bare entry
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
	end
end

--- The id of `typeName` as declared by the module `localName` binds to. Both
--- ways a ref can name another module's type (an `M.T` prefix, and the
--- bare-`T`-names-module-`T` tag convention) ask this one question.
local function typeIdIn(ctx: Ctx, mod: any, localName: string, typeName: string): string?
	local targetMod = mod.localModules[localName]
	local types = if targetMod ~= nil then ctx.typesByModule[targetMod] else nil
	return if types ~= nil then types[typeName] else nil
end

--- Resolves every ref segment in `list` against the defining module's scope.
--- An unresolved ref keeps only its text on the wire (the `__` keys never
--- emit), telling the renderer "type position; try externals/Roblox by text".
--- `landed` is the container the referencing member renders under, which its
--- refs may always name (moonwave manual mode: a sidecar file's `@return
--- Widget` names the class its member moved into).
local function resolveList(ctx: Ctx, g: Graph, modId: string, list: { any }?, landed: any?)
	if list == nil then
		return
	end
	for _, seg in list do
		if type(seg) ~= "table" then
			continue
		end
		-- an inferred return type was spelled in the callee's file, so it
		-- resolves in the callee's scope, not the referencing member's
		local scope: string = seg.__scope or modId
		local mod = g.byId[scope]
		if seg.__prefix ~= nil then
			seg.id = if mod ~= nil then typeIdIn(ctx, mod, seg.__prefix, seg.__name) else nil
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
		-- moonwave convention: a bare `@return Widget` names the class in the
		-- required module of the same name. A real annotation could never spell
		-- that, so only tag refs try it. Failing the type tables, the name may be
		-- a container itself (a classType-less class, a floating @class), but
		-- only one this module defines, requires, or landed the member in:
		-- matched globally, an unrelated module's class shadows an engine name.
		if not seg.__tag then
			continue
		end
		seg.id = if mod ~= nil then typeIdIn(ctx, mod, seg.__name, seg.__name) else nil
		if seg.id ~= nil then
			continue
		end
		if landed ~= nil and landed.name == seg.__name then
			-- the member's own container is always nameable, even when another
			-- module registered the name first
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
			-- every require this module makes, not just the ones bound to a
			-- local: `Flux = require(...)` straight into a table field is as much
			-- a require. Keyed by SymValue, so scan the values.
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

--- The single type a function annotates itself returning, as segments cut from
--- the file that spells it. Multiple returns are the first one, which is what a
--- one-value assignment keeps; an unannotated function is nothing at all.
---
--- So is a return mentioning the function's own generics: `Node<T>` is true of
--- `computed<T>(fn: () -> T): Node<T>` and meaningless at a call site, where
--- nothing binds `T` and a reader cannot tell it from a declared type.
local function annotatedReturn(parsedFile: any, fnNode: any): { any }?
	local node = members.returnNodes(fnNode)[1]
	if node == nil then
		return nil
	end
	-- built without the demotion the signature builder applies, so the
	-- generics are still spelled as references and can be recognized
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

--- Types a prop assigned a call from what the callee returns. Pass 1 cannot do
--- it: the callee is usually another module's function, and only here does
--- every surface exist to walk to it.
local function inferCallTypes(ctx: Ctx, g: Graph)
	for _, entry in ctx.modules do
		members.eachMember(entry, function(member)
			local value = member.__inferCall
			member.__inferCall = nil
			-- a floating `@prop` merged in above already said what this is
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
			for _, seg in list do
				if type(seg) == "table" then
					seg.__scope = found.moduleId
				end
			end
			member.type = if guarded then inferMod.optional(list) else list
			-- pass 1 badged the guard as a mount because it could not see this
			-- far: a boolean the other realm reads as false is a predicate, so
			-- the realm it detected has to come back off
			if guarded and member.__mountRealm and inferMod.isBoolean(list) then
				member.tags.realm = nil
			end
		end)
	end
end

local function resolveRefsAndConstructors(ctx: Ctx, g: Graph)
	-- both spellings of "returns the class" answer through one lookup, so a
	-- class that never declares a classType (moonwave manual mode) still gets
	-- its constructors grouped
	local classOfRefId: { [string]: any } = {}
	for id, class in ctx.classByTypeId do
		classOfRefId[id] = class
	end
	for _, entry in ctx.modules do
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
		-- the type fallback is for dot-called functions only. `setmetatable(_,
		-- Class)` above says what the body builds, true of a method as much as
		-- a function; "first return is the class type" is not, since a fluent
		-- `function Widget:withSize(): Widget` returns it and constructs nothing.
		if class == nil and fn.kind == "function" then
			local firstReturn = fn.signature.returns[1]
			if firstReturn ~= nil and firstReturn.type ~= nil then
				for _, seg in firstReturn.type do
					if type(seg) == "table" and seg.id ~= nil and classOfRefId[seg.id] ~= nil then
						class = classOfRefId[seg.id]
						break
					end
				end
			end
		end
		if class ~= nil and class.constructors ~= nil then
			table.insert(class.constructors, fn.id)
		end
	end

	local function resolveMember(member: any, landed: any)
		-- `source.file` is the defining module, and it survives @within
		-- moves, so it recovers the resolution scope (localModules, own
		-- types) the member was written in
		local modId = member.source.file
		if member.kind == "prop" then
			resolveList(ctx, g, modId, member.type, landed)
		else
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

function finalize.run(ctx: Ctx, g: Graph)
	moveTypes(ctx)
	applyPending(ctx)
	dedupeTypes(ctx)
	resolveReexports(ctx, g)
	inferCallTypes(ctx, g)
	resolveRefsAndConstructors(ctx, g)
end

return finalize

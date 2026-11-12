--!strict
--- Inspects source code for behavioral badge signals (`@yields`, `@readonly`,
--- and realm tags) when a doc block does not state them explicitly. Functions
--- are inspected via their AST body. Properties derive their realm from any
--- guard expression (`IsServer() and ...`) and their readonly flag from the
--- container's frozen state or `read` type modifier.
---
--- All detection rules are conservative. A false badge is worse than a missing
--- badge, so only unambiguous signals count and mixed signals stay unbadged.
---
--- The two AST walks treat nested closures differently:
---   * `yields` skips nested closures because `task.wait` inside a callback
---     yields the thread that invokes the callback, not the outer caller.
---   * `realm` descends into nested closures because a handler connected to
---     `OnServerEvent` still marks the enclosing function as server code.
--- Both walks follow statically resolvable calls across locals, surfaced table
--- fields, `self` methods, `__call` metatables, `pcall`/`xpcall` arguments, and
--- cross-module requires. A resolved target's body takes precedence over naming conventions.

local engineMod = require("./engine")
local inferMod = require("./infer")
local parseMod = require("./parse")
local surfaceMod = require("./surface")
local tagsMod = require("./tags")

local detect = {}

--- Generated Roblox API name lists (`nil` when `bun run generate` has not run,
--- in which case detection falls back to the built-in naming conventions below).
local ENGINE = engineMod.lists

--- Global call paths that yield the calling thread wherever they appear.
local YIELDING_CALLS: { [string]: boolean } = {
	["wait"] = true,
	["task.wait"] = true,
	["coroutine.yield"] = true,
}

--- Returns true for method names that yield (core engine methods, `*Async`
--- methods, or names listed in `ENGINE.yieldingMethods`).
local function isYieldingMethod(name: string): boolean
	if name == "Wait" or name == "WaitForChild" or name == "InvokeServer" or name == "InvokeClient" then
		return true
	end
	if ENGINE ~= nil and ENGINE.yieldingMethods[name] == true then
		return true
	end
	return #name > 5 and name:sub(-5) == "Async"
end

--- Services restricted to a single realm. Kept strictly to services that cannot
--- legitimately be referenced from working code in the other realm.
local SERVICE_REALM: { [string]: string } = {
	ServerScriptService = "server",
	ServerStorage = "server",
	DataStoreService = "server",
	MessagingService = "server",
	MemoryStoreService = "server",
	UserInputService = "client",
	ContextActionService = "client",
	GuiService = "client",
	HapticService = "client",
	VRService = "client",
}

--- Member names that identify which side of the client/server boundary the
--- surrounding code runs on.
local MEMBER_REALM: { [string]: string } = {
	FireServer = "client",
	InvokeServer = "client",
	OnClientEvent = "client",
	OnClientInvoke = "client",
	LocalPlayer = "client",
	FireClient = "server",
	FireAllClients = "server",
	InvokeClient = "server",
	OnServerEvent = "server",
	OnServerInvoke = "server",
}

--- Follows `require`, `import`, and passthrough chains to a local `SymValue`.
--- Stops at the module boundary when `world` is `nil`. Returns `(value, owningModule)`.
local function resolveAcross(world: any?, mod: any, value: any): (any, any)
	local seen: { [any]: boolean } = {}
	while value ~= nil do
		value = surfaceMod.unguard(value)
		if value.kind == "require" then
			if world == nil or seen[value] then
				return nil, nil
			end
			seen[value] = true
			local targetId = mod.requireTargets[value]
			local target = if targetId ~= nil then world.byId[targetId] else nil
			local targetSurface = if target ~= nil then target.surface else nil
			if targetSurface == nil then
				return nil, nil
			end
			mod = target
			value = targetSurface.result
		elseif value.kind == "import" then
			-- Guard `import` nodes in `seen` as well so two modules re-exporting
			-- each other's fields cannot loop forever.
			if world == nil or seen[value] then
				return nil, nil
			end
			seen[value] = true
			local baseValue, baseMod = resolveAcross(world, mod, value.base)
			local resolved = baseValue
			for _, seg in value.path :: { string } do
				if resolved == nil or resolved.kind ~= "table" then
					return nil, nil
				end
				local field = surfaceMod.fieldOf(resolved, seg)
				resolved = if field ~= nil then field.value else nil
			end
			if resolved == nil then
				return nil, nil
			end
			mod = baseMod
			value = resolved
		else
			return value, mod
		end
	end
	return nil, nil
end

--- Returns the CST local definition node for `fnNode`'s `self` receiver (either
--- the implicit colon-method `self` or an explicit first parameter named `self`).
--- Comparing CST binding identity ensures a local `local self = ...` inside the
--- body is not mistaken for the method receiver.
local function selfDefOf(fnNode: any): any
	if fnNode == nil then
		return nil
	end
	if fnNode.self ~= nil then
		return fnNode.self
	end
	return if surfaceMod.isSelfMethod(fnNode) then fnNode.parameters[1].node else nil
end

--- Resolves an expression to `(symValue, owningModule)` across top-level locals,
--- `self` (resolved to `ownerSym`), field chains, and cross-module requires.
local function resolveValue(world: any?, mod: any, ownerSym: any, selfDef: any, expr: any): (any, any)
	expr = parseMod.unwrapExpr(expr, true)
	local surface = if mod ~= nil then mod.surface else nil
	if expr == nil or surface == nil then
		return nil, nil
	end
	if expr.tag == "local" then
		local bound = surface.env[expr["local"]]
		if bound == nil and selfDef ~= nil and expr["local"] == selfDef then
			bound = ownerSym
		end
		return resolveAcross(world, mod, bound)
	end
	if expr.tag == "indexname" then
		local base, baseMod = resolveValue(world, mod, ownerSym, selfDef, expr.expression)
		if base ~= nil and base.kind == "table" then
			local field = surfaceMod.fieldOf(base, expr.index.text)
			if field ~= nil then
				return resolveAcross(world, baseMod, field.value)
			end
		end
	end
	return nil, nil
end

--- Resolves a call's callee expression to `(fnNode, ownerSym, module)` when
--- statically known. Checks body-local helper functions (`localFns`) before
--- module-level bindings, and unwraps tables with a `__call` metamethod to that
--- metamethod with the table itself as `ownerSym`.
local function resolveCallTarget(
	world: any?,
	mod: any,
	ownerSym: any,
	selfDef: any,
	localFns: { [any]: any }?,
	funcExpr: any
): (any, any, any)
	funcExpr = parseMod.unwrapExpr(funcExpr, true)
	if funcExpr ~= nil and funcExpr.tag == "local" and localFns ~= nil then
		local localFn = localFns[funcExpr["local"]]
		if localFn ~= nil then
			return localFn, nil, mod
		end
	end
	local value: any, valueMod: any, owner: any = nil, nil, nil
	if funcExpr ~= nil and funcExpr.tag == "indexname" then
		-- Resolve `base` once: it serves as both `owner` and the field lookup root.
		local base, baseMod = resolveValue(world, mod, ownerSym, selfDef, funcExpr.expression)
		if base ~= nil and base.kind == "table" then
			local field = surfaceMod.fieldOf(base, funcExpr.index.text)
			if field ~= nil then
				value, valueMod = resolveAcross(world, baseMod, field.value)
				owner = base
			end
		end
	else
		value, valueMod = resolveValue(world, mod, ownerSym, selfDef, funcExpr)
	end
	if value == nil then
		return nil, nil, nil
	end
	if value.kind == "function" then
		return value.fnNode, owner, valueMod
	end
	local mt = value.metatable
	if value.kind == "table" and mt ~= nil and mt.kind == "table" then
		local field = surfaceMod.fieldOf(mt, "__call")
		if field ~= nil and field.value.kind == "function" then
			return field.value.fnNode, value, valueMod
		end
	end
	return nil, nil, nil
end

--- Returns the first argument passed to `pcall` or `xpcall` (which executes
--- synchronously on the calling thread), or `nil` for any other call.
local function protectedCallee(callNode: any, path: string?): any
	if path ~= "pcall" and path ~= "xpcall" then
		return nil
	end
	local args = callNode.arguments
	local first = if args ~= nil and args[1] ~= nil then args[1].node else nil
	return first
end

--- Both caches are keyed by `(fnNode, ownerSym)` because `self` resolves
--- against `ownerSym`, so a single function value shared between two containers
--- can produce different results under each.
local WEAK_KEYS = { __mode = "k" }
local NO_OWNER = {} -- sentinel owner key for functions with no owning table

local function weakTable(): any
	return setmetatable({}, WEAK_KEYS)
end

local yieldCache: { [any]: { [any]: boolean } } = weakTable()
local realmCache: { [any]: { [any]: { [string]: boolean } } } = weakTable()

local function cacheGet(cache: { [any]: any }, fnNode: any, ownerSym: any): any
	local byOwner = cache[fnNode]
	return if byOwner ~= nil then byOwner[ownerSym or NO_OWNER] else nil
end

local function cachePut(cache: { [any]: any }, fnNode: any, ownerSym: any, answer: any)
	local byOwner = cache[fnNode]
	if byOwner == nil then
		byOwner = weakTable()
		cache[fnNode] = byOwner
	end
	byOwner[ownerSym or NO_OWNER] = answer
end

type Callee = { expr: any, namedYield: boolean? }
type MemberRealmSignal = { baseExpr: any, realm: string }
type FnSummary = {
	yields: boolean,
	realms: { [string]: boolean },
	memberRealms: { MemberRealmSignal },
	yieldCallees: { Callee },
	realmCallees: { Callee },
	localFns: { [any]: any },
}

type WalkState = {
	world: any?,
	visited: { [any]: { [any]: boolean } },
	hitCycle: boolean,
}

local SKIP_AST_KEYS: { [any]: boolean } = {
	location = true,
	annotation = true,
	returnAnnotation = true,
	typeArguments = true,
	generics = true,
	genericPacks = true,
}

local summaryCache: { [any]: FnSummary } = weakTable()

local function combineLocalFns(parent: { [any]: any }?, own: { [any]: any }): { [any]: any }?
	if next(own) == nil then
		return parent
	end
	if parent == nil then
		return own
	end
	local merged = table.clone(parent)
	for k, v in own do
		merged[k] = v
	end
	return merged
end

local function mergeSubSummary(summary: FnSummary, sub: FnSummary, inClosure: boolean)
	if not inClosure and sub.yields then
		summary.yields = true
	end
	for r in sub.realms do
		summary.realms[r] = true
	end
	for _, mr in sub.memberRealms do
		table.insert(summary.memberRealms, mr)
	end
	for _, c in sub.yieldCallees do
		if not inClosure then
			table.insert(summary.yieldCallees, c)
		end
	end
	for _, c in sub.realmCallees do
		table.insert(summary.realmCallees, c)
	end
	for k, fn in sub.localFns do
		summary.localFns[k] = fn
	end
end

local function recordNodeRealms(mod: any, summary: FnSummary, node: any)
	local tag = node.tag
	if tag == "indexname" then
		local name = if node.index ~= nil then node.index.text else nil
		if name ~= nil then
			local baseExpr = node.expression
			local realm = MEMBER_REALM[name]
			if realm ~= nil then
				table.insert(summary.memberRealms, { baseExpr = baseExpr, realm = realm })
			end
			if ENGINE ~= nil and ENGINE.pluginMembers[name] == true then
				table.insert(summary.memberRealms, { baseExpr = baseExpr, realm = "plugin" })
			end
			if baseExpr ~= nil and baseExpr.tag == "global" and baseExpr.name.text == "game" then
				local svc = SERVICE_REALM[name]
				if svc ~= nil then
					summary.realms[svc] = true
				end
			end
		end
	elseif tag == "local" and node["local"] ~= nil then
		local surface = mod.surface
		local bound = if surface ~= nil then surface.env[node["local"]] else nil
		local svc = if bound ~= nil and bound.service ~= nil then SERVICE_REALM[bound.service :: string] else nil
		if svc ~= nil then
			summary.realms[svc] = true
		end
	elseif tag == "global" and node.name ~= nil and node.name.text == "plugin" then
		summary.realms.plugin = true
	end
end

local function recordLocalVarFns(summary: FnSummary, stat: any)
	local values = stat.values
	if stat.variables == nil or values == nil then
		return
	end
	for i, varPair in stat.variables do
		local valPair = values[i]
		local valExpr: any = if valPair ~= nil then parseMod.unwrapExpr(valPair.node, true) else nil
		if varPair.node ~= nil and valExpr ~= nil and valExpr.tag == "function" then
			summary.localFns[varPair.node] = valExpr
		end
	end
end

local function recordGetServiceRealm(summary: FnSummary, callNode: any)
	local args = callNode.arguments
	local first = if args ~= nil and args[1] ~= nil then args[1].node else nil
	if first ~= nil and first.tag == "string" then
		local svc = SERVICE_REALM[first.token.text]
		if svc ~= nil then
			summary.realms[svc] = true
		end
	end
end

--- Walks `fnNode.body` once to collect direct yield/realm signals, body-local
--- helper functions, and callee expressions, partitioning callees inside nested
--- closures (which contribute to `realm` but not `yields`).
local function summarizeFn(mod: any, fnNode: any): FnSummary
	local cached = summaryCache[fnNode]
	if cached ~= nil then
		return cached
	end
	local summary: FnSummary = {
		yields = false,
		realms = {},
		memberRealms = {},
		yieldCallees = {},
		realmCallees = {},
		localFns = {},
	}
	if fnNode.body == nil then
		summaryCache[fnNode] = summary
		return summary
	end

	-- Inline closures passed directly as an IIFE callee or to `pcall`/`xpcall`
	-- are summarized synchronously via `checkCall`; skip re-walking their AST
	-- subtrees when `walkBody` iterates child fields of the enclosing call node.
	local summarizedClosures: { [any]: boolean } = {}

	local function checkCall(expr: any, path: string?, asValue: boolean?, inClosure: boolean)
		expr = parseMod.unwrapExpr(expr, true)
		if expr == nil then
			return
		end
		if expr.tag == "function" then
			summarizedClosures[expr] = true
			mergeSubSummary(summary, summarizeFn(mod, expr), inClosure)
			return
		end
		if path == nil then
			path = surfaceMod.calleePath(expr)
		end
		if not inClosure then
			if path ~= nil and YIELDING_CALLS[path] then
				summary.yields = true
			end
			local namedYield = expr.tag == "indexname"
				and (asValue == true or expr.accessor.text == ":")
				and isYieldingMethod(expr.index.text)
			table.insert(summary.yieldCallees, { expr = expr, namedYield = namedYield })
		end
		table.insert(summary.realmCallees, { expr = expr })
	end

	local function walkBody(node: any, inClosure: boolean)
		if node.kind == "token" or summarizedClosures[node] then
			return
		end
		local tag = node.tag
		if tag == "typealias" or tag == "typefunction" then
			return
		end
		if tag == "function" then
			inClosure = true
		elseif tag == "localfunction" then
			if node.name ~= nil and node.func ~= nil then
				summary.localFns[node.name] = node.func
			end
			inClosure = true
		elseif tag == "local" and node.variables ~= nil then
			recordLocalVarFns(summary, node)
		elseif tag == "call" then
			local func = node.func
			local path = if func ~= nil then surfaceMod.calleePath(func) else nil
			if path == "game:GetService" then
				recordGetServiceRealm(summary, node)
			end
			checkCall(func, path, nil, inClosure)
			checkCall(protectedCallee(node, path), nil, true, inClosure)
		elseif tag ~= nil then
			recordNodeRealms(mod, summary, node)
		end
		for key, v in node do
			if not SKIP_AST_KEYS[key] and type(v) == "table" then
				walkBody(v, inClosure)
			end
		end
	end

	walkBody(fnNode.body, false)
	summaryCache[fnNode] = summary
	return summary
end

local function visitFnYields(
	state: WalkState,
	curMod: any,
	curFn: any,
	curOwner: any,
	outerLocalFns: { [any]: any }?
): boolean
	local hit = cacheGet(yieldCache, curFn, curOwner)
	if hit ~= nil then
		return hit
	end
	if cacheGet(state.visited, curFn, curOwner) then
		state.hitCycle = true
		return false
	end
	cachePut(state.visited, curFn, curOwner, true)

	local summary = summarizeFn(curMod, curFn)
	if summary.yields then
		cachePut(yieldCache, curFn, curOwner, true)
		return true
	end
	local selfDef = selfDefOf(curFn)
	local localFns = combineLocalFns(outerLocalFns, summary.localFns)
	for _, c in summary.yieldCallees do
		local target, targetOwner, targetMod =
			resolveCallTarget(state.world, curMod, curOwner, selfDef, localFns, c.expr)
		if target ~= nil then
			local nextLocals = if targetMod == curMod then localFns else nil
			if visitFnYields(state, targetMod, target, targetOwner, nextLocals) then
				cachePut(yieldCache, curFn, curOwner, true)
				return true
			end
		elseif c.namedYield then
			cachePut(yieldCache, curFn, curOwner, true)
			return true
		end
	end
	if not state.hitCycle then
		cachePut(yieldCache, curFn, curOwner, false)
	end
	return false
end

--- Detects whether `fnNode` yields. `world` is the module graph (`nil` in
--- single-file tests, stopping resolution at `require` boundaries). `ownerSym`
--- is the surfaced table that owns `fnNode` and is what `self` resolves against.
function detect.yields(world: any?, mod: any, fnNode: any, ownerSym: any): boolean
	if mod == nil or mod.surface == nil or fnNode == nil then
		return false
	end
	local cached = cacheGet(yieldCache, fnNode, ownerSym)
	if cached ~= nil then
		return cached
	end
	local state: WalkState = { world = world, visited = {}, hitCycle = false }
	local ans = visitFnYields(state, mod, fnNode, ownerSym, nil)
	cachePut(yieldCache, fnNode, ownerSym, ans)
	return ans
end

--- RunService methods that pin a realm when used as the left-hand guard of
--- `guard and value`. Intentionally separate from `MEMBER_REALM` because shared
--- code in either realm may call `IsServer()` or `IsClient()` inside a branch.
local GUARD_REALM: { [string]: string } = { IsServer = "server", IsClient = "client" }

--- Maximum `and`-chain depth inspected when collecting guard realms.
local GUARD_DEPTH = 8

--- Collects every realm test guarding `value`, recursing into compound guards
--- (`Tools = Server and Server:WaitForChild("Tools")`).
local function guardRealms(value: any, found: { [string]: boolean }, depth: number)
	if value == nil or depth > GUARD_DEPTH then
		return
	end
	local realm = if value.engineMethod ~= nil then GUARD_REALM[value.engineMethod] else nil
	if realm ~= nil then
		found[realm] = true
	end
	guardRealms(value.guard, found, depth + 1)
	guardRealms(value.guarded, found, depth + 1)
end

--- Detects realm badges for a documented property from its `guard and value`
--- mount expression.
---
--- Only guards that gate whether a non-trivial value exists count as realm
--- mounts. Guarding a literal (`IsServer() and 5`) or a boolean expression
--- (`IsServer() and IsStudio()`) is a runtime value or predicate readable from
--- either realm, so neither receives a realm badge.
function detect.propRealm(value: any): { string }?
	if value == nil or value.guard == nil then
		return nil
	end
	local mounted = surfaceMod.unguard(value)
	if mounted.kind == "literal" then
		return nil
	end
	if inferMod.isBoolean(inferMod.fromValue(mounted)) then
		return nil
	end
	local found: { [string]: boolean } = {}
	local cur: any = value
	local layer = 0
	while cur ~= nil and cur.guard ~= nil and layer <= GUARD_DEPTH do
		guardRealms(cur.guard, found, layer)
		cur = cur.guarded
		layer += 1
	end
	if found.server and found.client then
		-- Guarded by both `IsServer` and `IsClient`: not locked to a single realm.
		return nil
	end
	return tagsMod.realmList(found)
end

local NO_TABLE_ENTRIES: { [string]: any } = {}
local tableEntriesCache: { [any]: { [string]: any } } = weakTable()

--- Returns the map of property entries in the container's own table type
--- annotation or cast (following at most one same-module type alias hop, such
--- as `:: Config` or `: KA`). Memoized per `typeNode`.
local function ownerTableEntries(mod: any, typeNode: any): { [string]: any }
	if typeNode == nil then
		return NO_TABLE_ENTRIES
	end
	local cached = tableEntriesCache[typeNode]
	if cached ~= nil then
		return cached
	end
	local out: { [string]: any } = {}
	local surface = if mod ~= nil then mod.surface else nil
	local tbl = surfaceMod.unwrapTableType(typeNode, if surface ~= nil then surface.types else nil)
	if tbl ~= nil then
		for _, entry in tbl.entries do
			if parseMod.isTypeProperty(entry) and entry.key ~= nil then
				out[entry.key.text] = entry
			end
		end
	end
	tableEntriesCache[typeNode] = out
	return out
end

--- Looks up a property entry on `ownerSym`'s table type annotation or cast.
function detect.ownerFieldEntry(mod: any, ownerSym: any, name: string): any
	if ownerSym == nil then
		return nil
	end
	return ownerTableEntries(mod, ownerSym.annotation or ownerSym.castType)[name]
end

--- Detects whether property `name` on `ownerSym` is readonly (either `ownerSym`
--- was frozen with `table.freeze` or `name` is marked `read` in `ownerSym`'s type).
function detect.propReadonly(mod: any, ownerSym: any, name: string): boolean
	if ownerSym == nil then
		return false
	end
	if ownerSym.frozen == true then
		return true
	end
	local entry = detect.ownerFieldEntry(mod, ownerSym, name)
	return entry ~= nil and entry.access ~= nil and entry.access.text == "read"
end

local visitFnRealms: (
	state: WalkState,
	curMod: any,
	curFn: any,
	curOwner: any,
	outerLocalFns: { [any]: any }?
) -> { [string]: boolean }?

local function collectDirectRealms(
	world: any?,
	curMod: any,
	curOwner: any,
	selfDef: any,
	summary: FnSummary
): { [string]: boolean }
	local curRealms: { [string]: boolean } = {}
	for r in summary.realms do
		curRealms[r] = true
	end
	for _, mr in summary.memberRealms do
		-- Skip engine member-realm attribution when the receiver resolves
		-- to a project table (`self` or a local/required module table).
		local base = resolveValue(world, curMod, curOwner, selfDef, mr.baseExpr)
		if base == nil or base.kind ~= "table" then
			curRealms[mr.realm] = true
		end
	end
	return curRealms
end

local function collectCalleeRealms(
	state: WalkState,
	curMod: any,
	curOwner: any,
	selfDef: any,
	localFns: { [any]: any }?,
	summary: FnSummary,
	curRealms: { [string]: boolean }
)
	for _, c in summary.realmCallees do
		local target, targetOwner, targetMod =
			resolveCallTarget(state.world, curMod, curOwner, selfDef, localFns, c.expr)
		if target == nil then
			continue
		end
		local nextLocals = if targetMod == curMod then localFns else nil
		local subRealms = visitFnRealms(state, targetMod, target, targetOwner, nextLocals)
		if subRealms ~= nil then
			for r in subRealms do
				curRealms[r] = true
			end
		end
	end
end

visitFnRealms = function(
	state: WalkState,
	curMod: any,
	curFn: any,
	curOwner: any,
	outerLocalFns: { [any]: any }?
): { [string]: boolean }?
	local hit = cacheGet(realmCache, curFn, curOwner)
	if hit ~= nil then
		return hit
	end
	if cacheGet(state.visited, curFn, curOwner) then
		state.hitCycle = true
		return nil
	end
	cachePut(state.visited, curFn, curOwner, true)

	local summary = summarizeFn(curMod, curFn)
	local selfDef = selfDefOf(curFn)
	local localFns = combineLocalFns(outerLocalFns, summary.localFns)
	local curRealms = collectDirectRealms(state.world, curMod, curOwner, selfDef, summary)
	collectCalleeRealms(state, curMod, curOwner, selfDef, localFns, summary, curRealms)
	if not state.hitCycle then
		cachePut(realmCache, curFn, curOwner, curRealms)
	end
	return curRealms
end

--- Detects realm badges for `fnNode`, using the same parameters as `detect.yields`.
function detect.realm(world: any?, mod: any, fnNode: any, ownerSym: any): { string }?
	if mod == nil or mod.surface == nil or fnNode == nil then
		return nil
	end
	local raw = cacheGet(realmCache, fnNode, ownerSym)
	if raw == nil then
		local state: WalkState = { world = world, visited = {}, hitCycle = false }
		raw = visitFnRealms(state, mod, fnNode, ownerSym, nil) or {}
		cachePut(realmCache, fnNode, ownerSym, raw)
	end
	-- Clone `raw` before clearing `server`/`client` so the cached set retains
	-- both signals for any caller that inspects it transitively.
	local found = table.clone(raw)
	if found.server and found.client then
		-- Contains both server and client signals (typically a `RunService:IsServer()` branch).
		found.server = nil
		found.client = nil
	end
	return tagsMod.realmList(found)
end

return detect

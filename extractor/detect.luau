--- Code-signal badge detection: inspects source code for signals a doc block
--- did not state explicitly, so `@yields`, `@readonly`, and the realm tags are
--- only needed when the code itself gives no signal. Functions are inspected via
--- their AST body; properties have no body, so their realm comes from any guard
--- expression they are mounted behind (`IsServer() and ...`) and their readonly
--- flag comes from the container's frozen state or `read` type modifier.
---
--- All detection rules are intentionally conservative: a false badge is worse
--- than a missing badge, so only unambiguous signals count and anything mixed
--- or uncertain stays unbadged.
---
--- The two AST walks treat nested closures differently:
---   * `yields` skips nested closures: a `task.wait` inside a callback yields
---     whatever thread invokes the callback, not the caller of the outer function.
---   * `realm` descends into nested closures: a handler connected to
---     `OnServerEvent` still marks the enclosing function as server code.
--- Both walks follow statically resolvable calls: top-level locals, fields of
--- surfaced tables, `self` methods on the owning class table, `__call`
--- metatables, the function passed to `pcall`/`xpcall`, and (when the module
--- graph is available) requires, member imports, and passthroughs into other
--- modules. A resolved target's body takes precedence over naming conventions.

local engineMod = require("./engine")
local inferMod = require("./infer")
local parseMod = require("./parse")
local surfaceMod = require("./surface")
local tagsMod = require("./tags")

type SymValue = surfaceMod.SymValue

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

--- Returns true for method names that yield: core engine methods (`Wait`,
--- `WaitForChild`, `InvokeServer`, and `InvokeClient`), methods ending in
--- `Async`, or methods listed in `ENGINE.yieldingMethods`.
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

--- Follows `require`, `import`, and passthrough chains until reaching a local
--- `SymValue`. `world` is the module graph; without it, resolution stops at the
--- module boundary. Returns `(value, owningModule)`.
local function resolveAcross(world: any?, mod: any, value: any): (any, any)
	local seen: { [any]: boolean } = {}
	while value ~= nil do
		if value.kind == "require" then
			if world == nil or seen[value] then
				return nil, nil
			end
			seen[value] = true
			local targetId = mod.requireTargets[value]
			local target = if targetId ~= nil then world.byId[targetId] else nil
			if target == nil or target.surface == nil then
				return nil, nil
			end
			mod = target
			value = (target.surface :: any).result
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

--- Returns the CST local definition node for `fnNode`'s `self` receiver: either
--- the implicit colon-method `self` or an explicit first parameter named `self`.
--- Comparing CST binding identity ensures a local `local self = ...` inside the
--- body is not mistaken for the method receiver.
local function selfDefOf(fnNode: any): any
	if fnNode == nil then
		return nil
	end
	if fnNode.self ~= nil then
		return fnNode.self
	end
	local first = if fnNode.parameters ~= nil and fnNode.parameters[1] ~= nil then fnNode.parameters[1].node else nil
	if first ~= nil and first.name ~= nil and first.name.text == "self" then
		return first
	end
	return nil
end

--- Resolves an expression to `(symValue, owningModule)`: a top-level local, the
--- function's `self` parameter (resolved to `ownerSym`), or a field chain off
--- either, following cross-module requires along the way.
local function resolveValue(world: any?, mod: any, ownerSym: any, selfDef: any, expr: any): (any, any)
	expr = parseMod.unwrapExpr(expr, true)
	if expr == nil or mod == nil or mod.surface == nil then
		return nil, nil
	end
	if expr.tag == "local" then
		local bound = (mod.surface :: any).env[expr["local"]]
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
--- statically known. A table with a `__call` metamethod resolves to that
--- metamethod with the table itself as `ownerSym`.
local function resolveCallTarget(world: any?, mod: any, ownerSym: any, selfDef: any, funcExpr: any): (any, any, any)
	funcExpr = parseMod.unwrapExpr(funcExpr, true)
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
	if value.kind == "table" and value.metatable ~= nil and (value.metatable :: any).kind == "table" then
		local mt = value.metatable :: any
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
local NO_OWNER = {} -- sentinel owner key for functions with no owning table
local yieldCache: { [any]: { [any]: boolean } } = setmetatable({}, { __mode = "k" }) :: any
local realmCache: { [any]: { [any]: { [string]: boolean } } } = setmetatable({}, { __mode = "k" }) :: any

local function cacheGet(cache: { [any]: any }, fnNode: any, ownerSym: any): any
	local byOwner = cache[fnNode]
	return if byOwner ~= nil then byOwner[ownerSym or NO_OWNER] else nil
end

local function cachePut(cache: { [any]: any }, fnNode: any, ownerSym: any, answer: any)
	local byOwner = cache[fnNode]
	if byOwner == nil then
		byOwner = setmetatable({}, { __mode = "k" }) :: any
		cache[fnNode] = byOwner
	end
	byOwner[ownerSym or NO_OWNER] = answer
end

type Callee = { expr: any, asValue: boolean? }
type FnSummary = {
	yields: boolean,
	realms: { [string]: boolean },
	yieldCallees: { Callee },
	realmCallees: { Callee },
}

local summaryCache: { [any]: FnSummary } = setmetatable({}, { __mode = "k" }) :: any

--- Walks `fnNode.body` once to collect direct yield/realm signals and callee
--- expressions, partitioning callees inside nested closures (which contribute to
--- `realm` but not `yields`).
local function summarizeFn(mod: any, fnNode: any): FnSummary
	local cached = summaryCache[fnNode]
	if cached ~= nil then
		return cached
	end
	local summary: FnSummary = {
		yields = false,
		realms = {},
		yieldCallees = {},
		realmCallees = {},
	}
	if fnNode.body == nil then
		summaryCache[fnNode] = summary
		return summary
	end

	local function checkCall(expr: any, path: string?, asValue: boolean?, inClosure: boolean)
		expr = parseMod.unwrapExpr(expr, true)
		if expr == nil then
			return
		end
		if expr.tag == "function" then
			local sub = summarizeFn(mod, expr)
			if not inClosure and sub.yields then
				summary.yields = true
			end
			for r in sub.realms do
				summary.realms[r] = true
			end
			for _, c in sub.yieldCallees do
				if not inClosure then
					table.insert(summary.yieldCallees, c)
				end
			end
			for _, c in sub.realmCallees do
				table.insert(summary.realmCallees, c)
			end
			return
		end
		if path == nil then
			path = surfaceMod.calleePath(expr)
		end
		if not inClosure then
			if path ~= nil and YIELDING_CALLS[path] then
				summary.yields = true
			elseif
				expr.tag == "indexname"
				and (asValue == true or expr.accessor.text == ":")
				and isYieldingMethod(expr.index.text)
			then
				summary.yields = true
			end
			table.insert(summary.yieldCallees, { expr = expr, asValue = asValue })
		end
		table.insert(summary.realmCallees, { expr = expr, asValue = asValue })
	end

	local seen: { [any]: boolean } = {}
	local function walk(node: any, inClosure: boolean)
		if type(node) ~= "table" or seen[node] or node.kind == "token" then
			return
		end
		seen[node] = true
		local tag = node.tag
		if tag == "function" or tag == "localfunction" then
			inClosure = true
		elseif tag == "indexname" then
			local name = if node.index ~= nil then node.index.text else nil
			if name ~= nil then
				local realm = MEMBER_REALM[name]
				if realm ~= nil then
					summary.realms[realm] = true
				end
				if ENGINE ~= nil and ENGINE.pluginMembers[name] == true then
					summary.realms.plugin = true
				end
				local baseExpr = node.expression
				if baseExpr ~= nil and baseExpr.tag == "global" and baseExpr.name.text == "game" then
					local svc = SERVICE_REALM[name]
					if svc ~= nil then
						summary.realms[svc] = true
					end
				end
			end
		elseif tag == "local" and node["local"] ~= nil then
			local bound = (mod.surface :: any).env[node["local"]]
			local svc = if bound ~= nil and bound.service ~= nil then SERVICE_REALM[bound.service :: string] else nil
			if svc ~= nil then
				summary.realms[svc] = true
			end
		elseif tag == "global" and node.name ~= nil and node.name.text == "plugin" then
			summary.realms.plugin = true
		elseif tag == "call" then
			local func = node.func
			local path = if func ~= nil then surfaceMod.calleePath(func) else nil
			if path == "game:GetService" then
				local args = node.arguments
				local first = if args ~= nil and args[1] ~= nil then args[1].node else nil
				if first ~= nil and first.tag == "string" then
					local svc = SERVICE_REALM[first.token.text]
					if svc ~= nil then
						summary.realms[svc] = true
					end
				end
			end
			checkCall(func, path, nil, inClosure)
			checkCall(protectedCallee(node, path), nil, true, inClosure)
		end
		for key, v in node do
			if key ~= "location" and type(v) == "table" then
				walk(v, inClosure)
			end
		end
	end

	walk(fnNode.body, false)
	summaryCache[fnNode] = summary
	return summary
end

--- Detects whether `fnNode` yields. `world` is the module graph (`nil` in
--- single-file tests, stopping resolution at `require` boundaries); `ownerSym`
--- is the surfaced table that owns `fnNode` and is what `self` resolves against.
function detect.yields(world: any?, mod: any, fnNode: any, ownerSym: any): boolean
	if mod == nil or mod.surface == nil or fnNode == nil then
		return false
	end
	local cached = cacheGet(yieldCache, fnNode, ownerSym)
	if cached ~= nil then
		return cached
	end
	local visited: { [any]: { [any]: boolean } } = {}
	local function visit(curMod: any, curFn: any, curOwner: any): boolean
		local hit = cacheGet(yieldCache, curFn, curOwner)
		if hit ~= nil then
			return hit
		end
		if cacheGet(visited, curFn, curOwner) then
			return false
		end
		cachePut(visited, curFn, curOwner, true)

		local summary = summarizeFn(curMod, curFn)
		if summary.yields then
			cachePut(yieldCache, curFn, curOwner, true)
			return true
		end
		local selfDef = selfDefOf(curFn)
		for _, c in summary.yieldCallees do
			local target, targetOwner, targetMod = resolveCallTarget(world, curMod, curOwner, selfDef, c.expr)
			if target ~= nil and visit(targetMod, target, targetOwner) then
				cachePut(yieldCache, curFn, curOwner, true)
				return true
			end
		end
		return false
	end
	local ans = visit(mod, fnNode, ownerSym)
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
	guardRealms(value.guard, found, 0)
	if found.server and found.client then
		-- Guarded by both `IsServer` and `IsClient`: not locked to a single realm.
		return nil
	end
	return tagsMod.realmList(found)
end

local NO_TABLE_ENTRIES: { [string]: any } = {}
local tableEntriesCache: { [any]: { [string]: any } } = setmetatable({}, { __mode = "k" }) :: any

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
	local tbl = surfaceMod.unwrapTableType(
		typeNode,
		if mod ~= nil and mod.surface ~= nil then (mod.surface :: any).types else nil
	)
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

--- Detects realm badges for `fnNode`; parameters match `detect.yields`.
function detect.realm(world: any?, mod: any, fnNode: any, ownerSym: any): { string }?
	if mod == nil or mod.surface == nil or fnNode == nil then
		return nil
	end
	local raw = cacheGet(realmCache, fnNode, ownerSym)
	if raw == nil then
		raw = {}
		local visited: { [any]: { [any]: boolean } } = {}
		local function visit(curMod: any, curFn: any, curOwner: any)
			local hit = cacheGet(realmCache, curFn, curOwner)
			if hit ~= nil then
				for r in hit do
					raw[r] = true
				end
				return
			end
			if cacheGet(visited, curFn, curOwner) then
				return
			end
			cachePut(visited, curFn, curOwner, true)

			local summary = summarizeFn(curMod, curFn)
			for r in summary.realms do
				raw[r] = true
			end
			local selfDef = selfDefOf(curFn)
			for _, c in summary.realmCallees do
				local target, targetOwner, targetMod = resolveCallTarget(world, curMod, curOwner, selfDef, c.expr)
				if target ~= nil then
					visit(targetMod, target, targetOwner)
				end
			end
		end
		visit(mod, fnNode, ownerSym)
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

--- Code-signal badge detection: reads the code for what a doc block did not
--- say, so `@yields`, `@readonly`, and the realm tags are only needed where
--- code shows nothing. A function answers from its body; a property has none,
--- so its realm comes from the guard it is mounted behind and its readonly
--- from the container's own type. Everything here is conservative by design: a
--- wrong badge costs more than a missing one, so only conclusive signals
--- count, and anything ambiguous stays unbadged (a `RunService:IsServer()`
--- branch, a call the resolver cannot follow, a body that fires both realms).
---
--- The two walks treat nested closures differently, deliberately:
---   * yields skips them: a callback's `task.wait` blocks whatever thread
---     runs the callback, not the caller of the function that wired it up.
---   * realm descends into them: a handler bound to `OnServerEvent` makes
---     the surrounding function server code all the same.
--- Both follow calls they can resolve statically: top-level locals, fields of
--- surfaced tables, `self` against the owning class table, `__call`
--- metatables, the argument `pcall`/`xpcall` run on the calling thread, and
--- (when the module graph is available) requires, member imports, and
--- passthroughs into other modules' surfaces. A wrapper inherits what its
--- helper does wherever that helper lives, and a resolved body outranks the
--- name conventions.

local engineMod = require("./engine")
local inferMod = require("./infer")
local parseMod = require("./parse")
local surfaceMod = require("./surface")
local tagsMod = require("./tags")

type SymValue = surfaceMod.SymValue

local detect = {}

--- The generated engine name lists, absent in a checkout that never installed:
--- detection then runs on the convention signals below alone.
local ENGINE = engineMod.lists

--- Global call paths that yield the calling thread wherever they appear.
local YIELDING_CALLS: { [string]: boolean } = {
	["wait"] = true,
	["task.wait"] = true,
	["coroutine.yield"] = true,
}

--- Called member names that yield: by API contract (`RBXScriptSignal:Wait`,
--- `Instance:WaitForChild`, remote invokes), by the `-Async` suffix
--- convention every engine method follows, or by the generated engine list.
local function isYieldingMethod(name: string): boolean
	if name == "Wait" or name == "WaitForChild" or name == "InvokeServer" or name == "InvokeClient" then
		return true
	end
	if ENGINE ~= nil and ENGINE.yieldingMethods[name] == true then
		return true
	end
	return #name > 5 and name:sub(-5) == "Async"
end

--- Services only one realm can use. Deliberately short: an entry is wrong the
--- moment working code in the other realm could name it.
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

--- Member names that pin which side of the client-server boundary the
--- surrounding code runs on. The name alone decides: a hand-written
--- `FireClient` wrapper is still server code.
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

--- Follows requires, member imports, and passthrough chains until the value
--- is something local. `world` is the module graph; without one, resolution
--- stops at the module boundary. Returns (value, owning module).
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
			-- imports guard `seen` too: two modules re-exporting each other's
			-- fields would otherwise alternate here forever
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

--- The definition node the function's own `self` references point at: the
--- implicit colon-method local, or an explicit first parameter spelled
--- `self`. Only references to THAT node resolve against the owner; a
--- body-local of the same name holds some other value entirely.
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

--- The (value, owning module) behind an expression: a top-level local, the
--- function's `self` binding (which the env never holds) against the owning
--- class table, or a field chain off either, requires followed throughout.
local function resolveValue(world: any?, mod: any, ownerSym: any, selfDef: any, expr: any): (any, any)
	if expr == nil or mod == nil or mod.surface == nil then
		return nil, nil
	end
	if expr.tag == "group" then
		return resolveValue(world, mod, ownerSym, selfDef, expr.expression)
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

--- A called function's (fnNode, ownerSym, module) when the callee resolves
--- statically. A table with a `__call` metamethod counts as its metamethod
--- (callable modules included), owned by the table itself.
local function resolveCallTarget(world: any?, mod: any, ownerSym: any, selfDef: any, funcExpr: any): (any, any, any)
	local value: any, valueMod: any, owner: any = nil, nil, nil
	if funcExpr ~= nil and funcExpr.tag == "indexname" then
		-- the base is resolved once: it is both the owner and the lookup root
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

--- The expression `pcall`/`xpcall` will call on the current thread, when
--- `path` (the callee's path, already computed by every caller) names one of
--- those; every other callee returns nil.
local function protectedCallee(callNode: any, path: string?): any
	if path ~= "pcall" and path ~= "xpcall" then
		return nil
	end
	local args = callNode.arguments
	local first = if args ~= nil and args[1] ~= nil then args[1].node else nil
	return first
end

--- parse.walkNodes over the function's body. Function statements and function
--- expressions share the closure boundary: skipping either skips its body.
local function walkBody(fnNode: any, intoClosures: boolean, visit: (node: any) -> ())
	if fnNode == nil or fnNode.body == nil then
		return
	end
	parseMod.walkNodes(fnNode.body, function(node)
		if not intoClosures and (node.tag == "function" or node.tag == "localfunction") then
			return false
		end
		visit(node)
		return true
	end)
end

--- Both caches key by (function node, owner): `self` resolves against the
--- owner, so one function value shared by two containers can answer
--- differently under each.
local NO_OWNER = {} -- owner slot for a function detected with no owning table
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

--- (yields, clean): `clean` is false when the answer leaned on a call cycle
--- still being computed. A "yes" is monotone (more analysis never retracts
--- it) so it always caches; a cycle-tainted "no" must not, except at the
--- entry point (detect.yields), where the walk started with no cycle open.
local function yieldsOf(
	world: any?,
	mod: any,
	fnNode: any,
	ownerSym: any,
	visiting: { [any]: boolean }
): (boolean, boolean)
	local cached = cacheGet(yieldCache, fnNode, ownerSym)
	if cached ~= nil then
		return cached, true
	end
	if visiting[fnNode] then
		return false, false
	end
	visiting[fnNode] = true
	local found = false
	local clean = true
	local selfDef = selfDefOf(fnNode)

	--- One callee expression, called: an inline closure literal runs on this
	--- thread, a resolved target answers for its own body, and the name
	--- conventions apply only to callees resolution cannot follow (engine
	--- surface). `path` is calleePath(expr) when the caller already computed it;
	--- `asValue` marks a function passed as a value (a pcall argument), where a
	--- method reference can only be spelled with a dot.
	local function checkCallee(expr: any, path: string?, asValue: boolean?)
		if found or expr == nil then
			return
		end
		if expr.tag == "function" then
			local yields, subClean = yieldsOf(world, mod, expr, ownerSym, visiting)
			found = found or yields
			clean = clean and subClean
			return
		end
		local target, targetOwner, targetMod = resolveCallTarget(world, mod, ownerSym, selfDef, expr)
		if target ~= nil then
			local yields, subClean = yieldsOf(world, targetMod, target, targetOwner, visiting)
			found = found or yields
			clean = clean and subClean
			return
		end
		if path == nil then
			path = surfaceMod.calleePath(expr)
		end
		if path ~= nil and YIELDING_CALLS[path] then
			found = true
			return
		end
		-- colon calls (and value references, dot by necessity) only: the name
		-- convention comes from engine method calls
		if
			expr.tag == "indexname"
			and (asValue == true or expr.accessor.text == ":")
			and isYieldingMethod(expr.index.text)
		then
			found = true
		end
	end

	walkBody(fnNode, false, function(node)
		if found or node.tag ~= "call" then
			return
		end
		local path = surfaceMod.calleePath(node.func)
		checkCallee(node.func, path)
		-- pcall/xpcall run their first argument on this same thread
		checkCallee(protectedCallee(node, path), nil, true)
	end)
	visiting[fnNode] = nil
	if found or clean then
		cachePut(yieldCache, fnNode, ownerSym, found)
	end
	return found, clean
end

local function realmOf(
	world: any?,
	mod: any,
	fnNode: any,
	ownerSym: any,
	visiting: { [any]: boolean }
): ({ [string]: boolean }, boolean)
	local cached = cacheGet(realmCache, fnNode, ownerSym)
	if cached ~= nil then
		return cached, true
	end
	if visiting[fnNode] then
		return {}, false
	end
	visiting[fnNode] = true
	local found: { [string]: boolean } = {}
	local clean = true
	local selfDef = selfDefOf(fnNode)

	local function followCallee(expr: any)
		local target, targetOwner, targetMod = resolveCallTarget(world, mod, ownerSym, selfDef, expr)
		if target ~= nil then
			local sub, subClean = realmOf(world, targetMod, target, targetOwner, visiting)
			for realm in sub do
				found[realm] = true
			end
			clean = clean and subClean
		end
	end

	walkBody(fnNode, true, function(node)
		local tag = node.tag
		if tag == "indexname" then
			local name = if node.index ~= nil then node.index.text else nil
			if name == nil then
				return
			end
			local realm = MEMBER_REALM[name]
			if realm ~= nil then
				found[realm] = true
			end
			-- Studio-flavored member names from the generated engine list
			-- (`CreateToolbar`, `AddBreakpoint`); the `plugin` global covers
			-- chains rooted there, this covers stored toolbars and widgets
			if ENGINE ~= nil and ENGINE.pluginMembers[name] == true then
				found.plugin = true
			end
			-- `game.ServerStorage`-style direct access
			local baseExpr = node.expression
			if baseExpr ~= nil and baseExpr.tag == "global" and baseExpr.name.text == "game" then
				local svc = SERVICE_REALM[name]
				if svc ~= nil then
					found[svc] = true
				end
			end
		elseif tag == "local" and node["local"] ~= nil then
			local bound = (mod.surface :: any).env[node["local"]]
			local svc = if bound ~= nil and bound.service ~= nil then SERVICE_REALM[bound.service :: string] else nil
			if svc ~= nil then
				found[svc] = true
			end
		elseif tag == "global" and node.name ~= nil and node.name.text == "plugin" then
			found.plugin = true
		elseif tag == "call" then
			local func = node.func
			local path = if func ~= nil then surfaceMod.calleePath(func) else nil
			-- `game:GetService("X")` spelled inline in the body: exactly the
			-- receiver the evaluator accepts, so a framework's own
			-- `Registry:GetService` cannot pin a realm
			if path == "game:GetService" then
				local args = node.arguments
				local first = if args ~= nil and args[1] ~= nil then args[1].node else nil
				if first ~= nil and first.tag == "string" then
					local svc = SERVICE_REALM[first.token.text]
					if svc ~= nil then
						found[svc] = true
					end
				end
			end
			followCallee(func)
			followCallee(protectedCallee(node, path))
		end
	end)
	visiting[fnNode] = nil
	if clean then
		cachePut(realmCache, fnNode, ownerSym, found)
	end
	return found, clean
end

--- Yields detection for one documented function, so a caller whose doc block
--- already says `@yields` can skip the walk entirely. `world` is the module
--- graph (nil when a caller has no whole-project view: resolution then stops
--- at requires); `ownerSym` is the surfaced table the function is a field of,
--- when known, and is what `self` resolves against.
function detect.yields(world: any?, mod: any, fnNode: any, ownerSym: any): boolean
	if mod == nil or mod.surface == nil or fnNode == nil then
		return false
	end
	local found, clean = yieldsOf(world, mod, fnNode, ownerSym, {})
	if not clean then
		-- entered with no cycle open, so a tainted answer is already the full
		-- cluster fixpoint: cache what the inner frames could not
		cachePut(yieldCache, fnNode, ownerSym, found)
	end
	return found
end

--- The two engine tests that pin a realm when they GUARD a value. Not in
--- `MEMBER_REALM`, and must not be: either realm may call `IsServer()` to ask.
--- Only `IsServer() and X` says anything, and it says it about X.
local GUARD_REALM: { [string]: string } = { IsServer = "server", IsClient = "client" }

--- Nested `and`s deep enough to stop reading as one conditional mount. A guard
--- chain is nested expression nodes and cannot cycle, so a bound is all the
--- walk below needs.
local GUARD_DEPTH = 8

--- Every realm test guarding `value`, following a guard that is itself guarded
--- (`Tools = Server and Server:WaitForChild("Tools")`, where Server is already
--- server-only).
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

--- Realm detection for a documented PROPERTY, whose value carries no body to
--- walk: a conditional mount is all the evidence there is.
---
--- Only a guard deciding whether the value EXISTS says where it can be
--- reached. Guarding something the other realm can simply read and find false
--- is a predicate, so neither a literal (`IsServer() and 5`) nor anything
--- inference types boolean (`IsServer() and IsStudio()`) badges.
function detect.propRealm(value: any): { string }?
	-- nothing guarded is nothing mounted: answered before the inference below
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
		-- guarded both ways: whatever this is, it is not realm-locked
		return nil
	end
	return tagsMod.realmList(found)
end

local NO_READ_FIELDS: { [string]: boolean } = {}
local readFieldsCache: { [any]: { [string]: boolean } } = setmetatable({}, { __mode = "k" }) :: any

--- Field names the container's own type marks `read`: an explicit code-level
--- readonly declaration. The type is the table's annotation or cast; a bare
--- reference follows one hop to a same-module alias (`:: Config`), and
--- anything further (imported types, intersections) stays out. Memoized per
--- annotation node: every prop of a container asks about the same one.
local function readModifiedFields(mod: any, typeNode: any): { [string]: boolean }
	if typeNode == nil then
		return NO_READ_FIELDS
	end
	local cached = readFieldsCache[typeNode]
	if cached ~= nil then
		return cached
	end
	local key = typeNode
	if typeNode.tag == "reference" and typeNode.name ~= nil and typeNode.prefix == nil and mod.surface ~= nil then
		for _, ty in (mod.surface :: any).types do
			if ty.name == typeNode.name.text and ty.stat ~= nil then
				typeNode = ty.stat.type
				break
			end
		end
	end
	local out: { [string]: boolean } = {}
	if typeNode ~= nil and typeNode.tag == "table" and typeNode.entries ~= nil then
		for _, entry in typeNode.entries do
			if
				parseMod.isTypeProperty(entry)
				and entry.access ~= nil
				and entry.access.text == "read"
				and entry.key ~= nil
			then
				out[entry.key.text] = true
			end
		end
	end
	readFieldsCache[key] = out
	return out
end

--- Readonly detection for a documented PROPERTY: a frozen container cannot be
--- assigned through, and a `read` field in the container's own type says so per
--- prop. Tag-first like the rest, so `@readonly` is only needed where the code
--- shows nothing.
function detect.propReadonly(mod: any, ownerSym: any, name: string): boolean
	if ownerSym == nil then
		return false
	end
	if ownerSym.frozen == true then
		return true
	end
	return readModifiedFields(mod, ownerSym.annotation or ownerSym.castType)[name] == true
end

--- Realm detection for one documented function; parameters as in `yields`.
function detect.realm(world: any?, mod: any, fnNode: any, ownerSym: any): { string }?
	if mod == nil or mod.surface == nil or fnNode == nil then
		return nil
	end
	local raw, clean = realmOf(world, mod, fnNode, ownerSym, {})
	if not clean then
		-- as in detect.yields: the entry point's tainted answer is final
		cachePut(realmCache, fnNode, ownerSym, raw)
	end
	-- cloned: the cache keeps the raw union, and the both-realms rule below
	-- must not edit what a transitive caller will read
	local found = table.clone(raw)
	if found.server and found.client then
		-- fires both ways: realm-branching shared code, not realm-locked
		found.server = nil
		found.client = nil
	end
	return tagsMod.realmList(found)
end

return detect

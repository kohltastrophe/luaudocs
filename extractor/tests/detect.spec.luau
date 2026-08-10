local t = require("./harness")
local paths = require("./paths")
local util = require("../util")
local detect = require("../detect")
local model = require("../model")
local surface = require("../surface")

local eval = t.eval

--- Detection for a field of the returned table, owned by that table (what
--- buildMembers passes), so `self` resolves the way it does in the pipeline.
--- No graph: these cases stay inside one module on purpose.
local function detected(res: any, name: string): { yields: boolean, realm: { string }? }
	local root = res.result :: any
	local field = surface.fieldOf(root, name) :: any
	local mod = { surface = res, requireTargets = {} }
	return {
		yields = detect.yields(nil, mod, field.value.fnNode, root),
		realm = detect.realm(nil, mod, field.value.fnNode, root),
	}
end

return function()
	t.suite("detect: yields from direct calls")

	local res = eval(table.concat({
		"local M = {}",
		"function M.pop()",
		"\ttask.wait()",
		"end",
		"function M.linger()",
		"\twait(1)",
		"end",
		"function M.emit(value)",
		"\tcoroutine.yield(value)",
		"end",
		"function M.peek()",
		"\treturn 1",
		"end",
		"return M",
	}, "\n"))
	t.eq(detected(res, "pop").yields, true, "task.wait")
	t.eq(detected(res, "linger").yields, true, "legacy wait")
	t.eq(detected(res, "emit").yields, true, "coroutine.yield")
	t.eq(detected(res, "peek").yields, false, "plain body")

	t.suite("detect: yields from method names")

	res = eval(table.concat({
		"local M = {}",
		"function M.await(signal)",
		"\treturn signal:Wait()",
		"end",
		"function M.read(store, key)",
		"\treturn store:GetAsync(key)",
		"end",
		"function M.grab(signal)",
		"\treturn signal.Wait",
		"end",
		"return M",
	}, "\n"))
	t.eq(detected(res, "await").yields, true, ":Wait()")
	t.eq(detected(res, "read").yields, true, "Async-suffixed method")
	t.eq(detected(res, "grab").yields, false, "reading .Wait without calling it")

	-- generated engine list, with the names drawn from the list itself: the
	-- dump is unpinned, so a hard-coded name could vanish from the list (an
	-- upstream twin with the other behavior drops it) and fail the suite with
	-- no change in this repo. Absent list (a checkout that never installed):
	-- nothing to prove, the convention cases above already ran.
	local engineLists = require("../engine").lists
	if engineLists ~= nil then
		local yieldName: string? = nil
		for name in engineLists.yieldingMethods do
			-- convention-free, so the case proves list membership and not the
			-- Wait/Async name signals
			local isAsync = #name > 5 and name:sub(-5) == "Async"
			if name ~= "Wait" and name ~= "WaitForChild" and name ~= "InvokeServer" and not isAsync then
				yieldName = name
				break
			end
		end
		if yieldName ~= nil then
			res = eval(table.concat({
				"local M = {}",
				"function M.price(svc, id)",
				"\treturn svc:" .. yieldName .. "(id)",
				"end",
				"return M",
			}, "\n"))
			t.eq(detected(res, "price").yields, true, "an engine-list method with no convention signal")
		end
		local pluginName = next(engineLists.pluginMembers)
		if pluginName ~= nil then
			res = eval(table.concat({
				"local M = {}",
				"function M.dock(p, info)",
				"\treturn p:" .. pluginName .. "(info)",
				"end",
				"return M",
			}, "\n"))
			t.eq(detected(res, "dock").realm, { "plugin" }, "a Studio-flavored member badges plugin")
		end
	end

	t.suite("detect: yields through same-module calls")

	res = eval(table.concat({
		"local M = {}",
		"local function settle()",
		"\tcoroutine.yield()",
		"end",
		"function M.drain()",
		"\tsettle()",
		"end",
		"function M:flush()",
		"\tself:_step()",
		"end",
		"function M:_step()",
		"\ttask.wait()",
		"end",
		"function M.run()",
		"\tM.drain()",
		"end",
		"return M",
	}, "\n"))
	t.eq(detected(res, "drain").yields, true, "local helper")
	t.eq(detected(res, "flush").yields, true, "self method")
	t.eq(detected(res, "run").yields, true, "module-table call, two hops")

	t.suite("detect: yields stops at closures")

	res = eval(table.concat({
		"local M = {}",
		"function M.schedule()",
		"\ttask.spawn(function()",
		"\t\ttask.wait()",
		"\tend)",
		"end",
		"function M.build()",
		"\tlocal function idle()",
		"\t\ttask.wait()",
		"\tend",
		"\treturn idle",
		"end",
		"return M",
	}, "\n"))
	t.eq(detected(res, "schedule").yields, false, "a spawned callback waits on its own thread")
	t.eq(detected(res, "build").yields, false, "defining a waiting closure is not waiting")

	-- the poisoning order: a's walk reaches b while a is still open, so b's
	-- "no" is cycle-tainted and must not stick once a turns out to yield
	res = eval(table.concat({
		"local M = {}",
		"function M.a()",
		"\tM.b()",
		"\ttask.wait()",
		"end",
		"function M.b()",
		"\tM.a()",
		"end",
		"return M",
	}, "\n"))
	t.eq(detected(res, "a").yields, true, "yields beside a call cycle")
	t.eq(detected(res, "b").yields, true, "a cycle-tainted no is not cached")

	t.suite("detect: pcall and __call")

	res = eval(table.concat({
		"local M = {}",
		"local function slow()",
		"\ttask.wait()",
		"end",
		"local runner = setmetatable({}, {",
		"\t__call = function()",
		"\t\ttask.wait()",
		"\tend,",
		"})",
		"function M.try(store, key)",
		"\treturn pcall(store.GetAsync, store, key)",
		"end",
		"function M.retry()",
		"\treturn xpcall(slow, warn)",
		"end",
		"function M.go()",
		"\trunner()",
		"end",
		"function M.guard()",
		"\ttask.spawn(slow)",
		"end",
		"return M",
	}, "\n"))
	t.eq(detected(res, "try").yields, true, "a pcall'd Async method runs on this thread")
	t.eq(detected(res, "retry").yields, true, "an xpcall'd local function too")
	t.eq(detected(res, "go").yields, true, "calling a table follows its __call")
	t.eq(detected(res, "guard").yields, false, "a task.spawn'd function still waits elsewhere")

	t.suite("detect: realm from remote members")

	res = eval(table.concat({
		"local M = {}",
		"function M.push(remote, payload)",
		"\tremote:FireServer(payload)",
		"end",
		"function M.broadcast(remote, payload)",
		"\tremote:FireAllClients(payload)",
		"end",
		"function M.bind(remote, handler)",
		"\tremote.OnServerEvent:Connect(handler)",
		"end",
		"function M.relay(remote, payload)",
		"\tremote:FireServer(payload)",
		"\tremote:FireClient(payload)",
		"end",
		"function M.mount(remote)",
		"\ttask.spawn(function()",
		"\t\tremote:FireAllClients(true)",
		"\tend)",
		"end",
		"return M",
	}, "\n"))
	t.eq(detected(res, "push").realm, { "client" }, "FireServer runs on the client")
	t.eq(detected(res, "broadcast").realm, { "server" }, "FireAllClients runs on the server")
	t.eq(detected(res, "bind").realm, { "server" }, "connecting OnServerEvent")
	t.eq(detected(res, "relay").realm, nil, "firing both ways is realm-branching, not realm-locked")
	t.eq(detected(res, "mount").realm, { "server" }, "realm descends into closures")

	t.suite("detect: realm from services")

	res = eval(table.concat({
		'local DataStoreService = game:GetService("DataStoreService")',
		"local M = {}",
		"function M.load(key)",
		"\treturn DataStoreService:GetAsync(key)",
		"end",
		"function M.input()",
		'\treturn game:GetService("UserInputService"):IsKeyDown(key)',
		"end",
		"function M.stash(item)",
		"\titem.Parent = game.ServerStorage",
		"end",
		"return M",
	}, "\n"))
	t.eq(detected(res, "load").realm, { "server" }, "a local bound to a server-only service")
	t.eq(detected(res, "load").yields, true, "GetAsync yields too")
	t.eq(detected(res, "input").realm, { "client" }, "inline GetService")
	t.eq(detected(res, "stash").realm, { "server" }, "game.X service access")

	t.suite("detect: realm from a conditional mount")

	--- propRealm reads the value, not a body: the prop cases take the field's
	--- SymValue straight, where the function cases above take its fnNode.
	local function propRealm(source: { string }, name: string): { string }?
		local surfaced = eval(table.concat(source, "\n"))
		local field = surface.fieldOf(surfaced.result :: any, name) :: any
		return detect.propRealm(field.value)
	end

	local mounts = {
		'local Run = game:GetService("RunService")',
		'local Server = Run:IsServer() and script:WaitForChild("Server")',
		"local M = {}",
		"M.Server = Server",
		'M.Tools = Server and Server:WaitForChild("Tools")',
		"M.UI = Run:IsClient() and script.UI",
		'M.plain = script:WaitForChild("Plain")',
		'M.isPrivate = Run:IsServer() and game.PrivateServerId ~= ""',
		"M.inStudio = Run:IsServer() and Run:IsStudio()",
		"M.both = Run:IsServer() and Run:IsClient() and script.Odd",
		"return M",
	}
	t.eq(propRealm(mounts, "Server"), { "server" }, "an IsServer guard mounts on the server")
	t.eq(propRealm(mounts, "Tools"), { "server" }, "a guard that is itself guarded carries the realm")
	t.eq(propRealm(mounts, "UI"), { "client" }, "an IsClient guard mounts on the client")
	t.eq(propRealm(mounts, "plain"), nil, "an unguarded value pins no realm")
	-- the property is a boolean everywhere; a client reads it and finds false,
	-- so warning it off a server-only API would be wrong
	t.eq(propRealm(mounts, "isPrivate"), nil, "a guard over a literal is a predicate, not a mount")
	-- the same predicate spelled as an engine call rather than a comparison:
	-- what settles it is the type, which is why inference is what answers. The
	-- type comes from the generated dump, so a checkout without one has nothing
	-- to prove here; the comparison case above it is the built-in signal.
	if require("../engine").lists ~= nil then
		t.eq(propRealm(mounts, "inStudio"), nil, "a guard over an engine boolean is a predicate too")
	end
	t.eq(propRealm(mounts, "both"), nil, "guarded both ways is not realm-locked")

	t.suite("detect: realm from LocalPlayer and plugin")

	res = eval(table.concat({
		"local Players = game.Players",
		"local M = {}",
		"function M.me()",
		"\treturn Players.LocalPlayer",
		"end",
		"function M.toolbar()",
		'\treturn plugin:CreateToolbar("Widgets")',
		"end",
		"function M.passthrough(plugin)",
		"\treturn plugin.Name",
		"end",
		"return M",
	}, "\n"))
	t.eq(detected(res, "me").realm, { "client" }, "LocalPlayer")
	t.eq(detected(res, "toolbar").realm, { "plugin" }, "the plugin global")
	t.eq(detected(res, "passthrough").realm, nil, "a plugin PARAMETER is not the global")

	t.suite("detect: realm through same-module calls")

	res = eval(table.concat({
		"local M = {}",
		"local function fanout(remote)",
		"\tremote:FireAllClients(0)",
		"end",
		"function M.sync(remote)",
		"\tfanout(remote)",
		"end",
		"return M",
	}, "\n"))
	t.eq(detected(res, "sync").realm, { "server" }, "a wrapper inherits its helper's realm")

	t.suite("detect: readonly from the container type")

	--- The container itself is the owner, as buildProp passes it.
	local function readonlyOf(src: string, name: string): boolean
		local evaluated = eval(src)
		return detect.propReadonly({ surface = evaluated }, evaluated.result, name)
	end

	local cast = table.concat({
		"local M = {",
		'\tversion = "1.0.0",',
		"\tcount = 0,",
		"} :: { read version: string, count: number }",
		"return M",
	}, "\n")
	t.eq(readonlyOf(cast, "version"), true, "a `read` field in the cast marks its prop")
	t.eq(readonlyOf(cast, "count"), false, "an unmodified field stays writable")

	local aliased = table.concat({
		"type Shape = { read locked: boolean }",
		"local M = { locked = false } :: Shape",
		"return M",
	}, "\n")
	t.eq(readonlyOf(aliased, "locked"), true, "a cast to a same-module alias follows one hop")

	t.suite("detect: across modules")

	local root = util.joinPath(paths.fixtures, "detect")
	local g, diag = t.buildGraph(root, "main.luau")
	local doc = model.assemble(g, diag, { entryPoints = { "main.luau" } })
	t.eq(#diag.list, 0, "the detect fixture assembles clean")

	local main = t.byId(doc.modules, "main.luau")
	local function member(name: string): any
		return t.byName(main.members, name)
	end
	t.eq(member("drain").tags.yields, true, "a require-local helper's wait is the caller's")
	t.eq(member("sync").tags.realm, { "server" }, "realm follows the module boundary")
	t.eq(member("exec").tags.yields, true, "a callable module resolves through its __call")
	t.eq(member("quick").tags.yields, true, "a member import resolves to its definition")
	t.eq(member("relay").tags.yields, true, "a passthrough hop resolves")
	t.eq(member("attempt").tags.yields, true, "pcall runs its argument on this thread")
end

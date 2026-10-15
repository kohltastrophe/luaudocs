local t = require("./harness")
local paths = require("./paths")
local util = require("../util")
local detect = require("../detect")
local model = require("../model")
local surface = require("../surface")

local eval = t.eval

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
	t.suite("detect: yields from direct calls and method names")

	local res = eval(table.concat({
		"local M = {}",
		"function M.pop() task.wait() end",
		"function M.linger() wait(1) end",
		"function M.emit(value) coroutine.yield(value) end",
		"function M.peek() return 1 end",
		"function M.await(signal) return signal:Wait() end",
		"function M.read(store, key) return store:GetAsync(key) end",
		"function M.grab(signal) return signal.Wait end",
		"return M",
	}, "\n"))
	t.eq({
		detected(res, "pop").yields,
		detected(res, "linger").yields,
		detected(res, "emit").yields,
		detected(res, "peek").yields,
		detected(res, "await").yields,
		detected(res, "read").yields,
		detected(res, "grab").yields,
	}, { true, true, true, false, true, true, false }, "direct calls and method names")

	local engineLists = require("../engine").lists
	if engineLists ~= nil then
		local yieldName: string? = nil
		for name in engineLists.yieldingMethods do
			local isAsync = #name > 5 and name:sub(-5) == "Async"
			if name ~= "Wait" and name ~= "WaitForChild" and name ~= "InvokeServer" and not isAsync then
				yieldName = name
				break
			end
		end
		if yieldName ~= nil then
			res = eval("local M = {}\nfunction M.price(svc, id) return svc:" .. yieldName .. "(id) end\nreturn M")
			t.eq(detected(res, "price").yields, true, "engine-list yielding method")
		end
		local pluginName = next(engineLists.pluginMembers)
		if pluginName ~= nil then
			res = eval("local M = {}\nfunction M.dock(p, info) return p:" .. pluginName .. "(info) end\nreturn M")
			t.eq(detected(res, "dock").realm, { "plugin" }, "engine-list plugin member")
		end
	end

	t.suite("detect: yields and realm through same-module calls, closures, and cycles")

	res = eval(table.concat({
		"local M = {}",
		"local function settle() coroutine.yield() end",
		"function M.drain() settle() end",
		"function M:flush() self:_step() end",
		"function M:_step() task.wait() end",
		"function M.run() M.drain() end",
		"function M.schedule() task.spawn(function() task.wait() end) end",
		"function M.build() local function idle() task.wait() end return idle end",
		"return M",
	}, "\n"))
	t.eq({
		detected(res, "drain").yields,
		detected(res, "flush").yields,
		detected(res, "run").yields,
		detected(res, "schedule").yields,
		detected(res, "build").yields,
	}, { true, true, true, false, false }, "same-module calls yield; nested closures do not")

	-- Mutual recursion cycle (`f` calls `g`, `g` calls `f` with `task.wait()` and server signal)
	-- terminates cleanly and propagates both `yields` and `realm`.
	res = eval(table.concat({
		"local M = {}",
		"function M.f(remote)",
		"\tM.g(remote)",
		"end",
		"function M.g(remote)",
		"\tM.f(remote)",
		"\ttask.wait()",
		"\tremote:FireAllClients()",
		"end",
		"function M.spinA() M.spinB() end",
		"function M.spinB() M.spinA() end",
		"return M",
	}, "\n"))
	t.eq(detected(res, "f"), { yields = true, realm = { "server" } }, "mutual recursion f detects yields and realm")
	t.eq(detected(res, "g"), { yields = true, realm = { "server" } }, "mutual recursion g detects yields and realm")
	t.eq(detected(res, "spinA"), { yields = false, realm = nil }, "pure mutual recursion cycle terminates cleanly")

	t.suite("detect: pcall and __call")

	res = eval(table.concat({
		"local M = {}",
		"local function slow() task.wait() end",
		"local runner = setmetatable({}, { __call = function() task.wait() end })",
		"function M.try(store, key) return pcall(store.GetAsync, store, key) end",
		"function M.retry() return xpcall(slow, warn) end",
		"function M.go() runner() end",
		"function M.guard() task.spawn(slow) end",
		"return M",
	}, "\n"))
	t.eq({
		detected(res, "try").yields,
		detected(res, "retry").yields,
		detected(res, "go").yields,
		detected(res, "guard").yields,
	}, { true, true, true, false }, "pcall, xpcall, and __call vs task.spawn")

	t.suite("detect: realm from remotes, services, LocalPlayer, plugin, and instantiation")

	res = eval(table.concat({
		'local DataStoreService = game:GetService("DataStoreService")',
		"local Players = game.Players",
		"local M = {}",
		"local function fanout<T>(remote: T) (remote :: any):FireAllClients(0) end",
		"function M.push(remote, payload) remote:FireServer(payload) end",
		"function M.broadcast(remote, payload) remote:FireAllClients(payload) end",
		"function M.bind(remote, handler) remote.OnServerEvent:Connect(handler) end",
		"function M.relay(remote, payload) remote:FireServer(payload); remote:FireClient(payload) end",
		"function M.mount(remote) task.spawn(function() remote:FireAllClients(true) end) end",
		"function M.load(key) return DataStoreService:GetAsync(key) end",
		'function M.input() return game:GetService("UserInputService"):IsKeyDown(key) end',
		"function M.stash(item) item.Parent = game.ServerStorage end",
		"function M.me() return Players.LocalPlayer end",
		'function M.toolbar() return plugin:CreateToolbar("Widgets") end',
		"function M.passthrough(plugin) return plugin.Name end",
		"function M.sync(remote) fanout<<any>>(remote) end",
		"return M",
	}, "\n"))
	t.eq({
		detected(res, "push").realm,
		detected(res, "broadcast").realm,
		detected(res, "bind").realm,
		detected(res, "relay").realm,
		detected(res, "mount").realm,
		detected(res, "load"),
		detected(res, "input").realm,
		detected(res, "stash").realm,
		detected(res, "me").realm,
		detected(res, "toolbar").realm,
		detected(res, "passthrough").realm,
		detected(res, "sync").realm,
	}, {
		{ "client" },
		{ "server" },
		{ "server" },
		nil,
		{ "server" },
		{ yields = true, realm = { "server" } },
		{ "client" },
		{ "server" },
		{ "client" },
		{ "plugin" },
		nil,
		{ "server" },
	}, "realm detection across remotes, services, LocalPlayer, plugin, and <<T>> calls")

	t.suite("detect: conditional mounts and readonly")

	local mounts = eval(table.concat({
		'local Run = game:GetService("RunService")',
		'local Server = Run:IsServer() and script:WaitForChild("Server")',
		"local M = {",
		"\tServer = Server,",
		'\tTools = Server and Server:WaitForChild("Tools"),',
		"\tUI = Run:IsClient() and script.UI,",
		"\tStrictUI = if Run:IsClient() then script.UI else nil,",
		'\tplain = script:WaitForChild("Plain"),',
		'\tisPrivate = Run:IsServer() and game.PrivateServerId ~= "",',
		"\tinStudio = Run:IsServer() and Run:IsStudio(),",
		"\tboth = Run:IsServer() and Run:IsClient() and script.Odd,",
		"}",
		"return M",
	}, "\n")).result :: any
	local function propRealm(name: string): { string }?
		return detect.propRealm((surface.fieldOf(mounts, name) :: any).value)
	end
	t.eq({
		propRealm("Server"),
		propRealm("Tools"),
		propRealm("UI"),
		propRealm("StrictUI"),
		propRealm("plain"),
		propRealm("isPrivate"),
		propRealm("both"),
	}, { { "server" }, { "server" }, { "client" }, { "client" }, nil, nil, nil }, "conditional mount propRealm")
	if engineLists ~= nil then
		t.eq(propRealm("inStudio"), nil, "guard over engine boolean is predicate")
	end

	local function readonlyOf(src: string, name: string): boolean
		local evaluated = eval(src)
		return detect.propReadonly({ surface = evaluated }, evaluated.result, name)
	end
	local cast = 'local M = { version = "1.0.0", count = 0 } :: { read version: string, count: number }\nreturn M'
	local aliased = "type Shape = ({ read locked: boolean })?\nlocal M = { locked = false } :: Shape\nreturn M"
	t.eq(
		{ readonlyOf(cast, "version"), readonlyOf(cast, "count"), readonlyOf(aliased, "locked") },
		{ true, false, true },
		"readonly from container type and alias"
	)

	t.suite("detect: across modules")

	local root = util.joinPath(paths.fixtures, "detect")
	local g, diag = t.buildGraph(root, "main.luau")
	local doc = model.assemble(g, diag, { entryPoints = { "main.luau" } })
	t.eq(#diag.list, 0, "detect fixture assembles clean")

	local main = t.byId(doc.modules, "main.luau")
	local function member(name: string): any
		return t.byName(main.members, name)
	end
	t.eq({
		member("drain").tags.yields,
		member("sync").tags.realm,
		member("exec").tags.yields,
		member("quick").tags.yields,
		member("relay").tags.yields,
		member("attempt").tags.yields,
	}, { true, { "server" }, true, true, true, true }, "cross-module yields and realm")
end

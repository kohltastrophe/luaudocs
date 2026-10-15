local util = require("../util")
local t = require("./harness")
local paths = require("./paths")
local requiresMod = require("../requires")

local FIXTURES = paths.fixtures

local function buildGraph(fixture: string, entry: string)
	return t.buildGraph(util.joinPath(FIXTURES, fixture), entry)
end

local function moduleIds(g: any): { string }
	local ids = {}
	for _, m in g.modules do
		table.insert(ids, m.id)
	end
	return ids
end

local function instancePaths(g: any, ids: { string }): { [string]: { string } }
	local out = {}
	for _, id in ids do
		out[id] = g.byId[id].instancePath
	end
	return out
end

return function()
	local strings, stringsDiag = buildGraph("strings", "main.luau")
	local instance, instanceDiag = buildGraph("instance", "src")

	t.suite("requires: string semantics")

	t.eq(moduleIds(strings), {
		"main.luau",
		"a.luau",
		"b/init.luau",
		"vendor/thing.luau",
		"cond.luau",
		"promoted.luau",
		"b/inner.luau",
		"leaf.luau",
	}, "BFS module ids")
	t.eq(#stringsDiag.list, 0, "strings fixture resolves cleanly")

	t.eq(strings.byId["main.luau"].localModules, {
		a = "a.luau",
		b = "b/init.luau",
		thing = "vendor/thing.luau",
		promoted = "promoted.luau",
	}, "main require-local map")
	t.eq(strings.byId["b/init.luau"].localModules, {
		a = "a.luau",
		inner = "b/inner.luau",
	}, "init.luau relative and @self requires")

	t.eq({
		strings.byId["cond.luau"].surfaced,
		strings.byId["b/inner.luau"].surfaced,
		strings.byId["promoted.luau"].surfaced,
		strings.byId["leaf.luau"].surfaced,
	}, { true, true, true, true }, "conditional, guarded, @class-promoted, and transitive mounts surface")

	local root = util.joinPath(FIXTURES, "strings")
	local proj = requiresMod.load(root)
	local fromFile = util.joinPath(root, "main.luau")
	t.ok(requiresMod.resolveString(proj, fromFile, "@Pkg/thing").ok == true, "case-insensitive alias lookup")

	t.suite("requires: instance paths + rojo")

	t.eq(moduleIds(instance), {
		"src/init.luau",
		"src/Mod.luau",
		"ext/init.luau",
		"src/Mod/Sub.luau",
		"pkg/lib/init.luau",
		"pkg/extra.luau",
		"wire/impl/init.luau",
		"src/Other.luau",
	}, "instance BFS ids")
	t.eq(#instanceDiag.list, 0, "instance fixture resolves cleanly")

	local init = instance.byId["src/init.luau"]
	t.eq(init.name, "Inst", "root module display name from rojo")
	t.eq(init.localModules, {
		Mod = "src/Mod.luau",
		Ext = "ext/init.luau",
		Deep = "src/Mod/Sub.luau",
		Pkg = "pkg/lib/init.luau",
		Extra = "pkg/extra.luau",
		Wire = "wire/impl/init.luau",
	}, "script children + rojo mount + file-node child dir + nested projects")
	t.eq(instance.byId["ext/init.luau"].localModules, { Mod = "src/Mod.luau" }, "file-mounted init navigates via rojo")
	t.eq(
		instance.byId["src/Mod.luau"].localModules,
		{ Other = "src/Other.luau", Named = "src/Other.luau" },
		"script.Parent + WaitForChild"
	)

	t.eq(
		instancePaths(instance, {
			"src/init.luau",
			"src/Mod.luau",
			"ext/init.luau",
			"src/Mod/Sub.luau",
			"pkg/lib/init.luau",
			"pkg/extra.luau",
			"wire/impl/init.luau",
		}),
		{
			["src/init.luau"] = { "Inst" },
			["src/Mod.luau"] = { "Inst", "Mod" },
			["ext/init.luau"] = { "Inst", "Ext" },
			["src/Mod/Sub.luau"] = { "Inst", "Mod", "Sub" },
			["pkg/lib/init.luau"] = { "Inst", "Pkg" },
			["pkg/extra.luau"] = { "Inst", "Pkg", "Extra" },
			["wire/impl/init.luau"] = { "Inst", "Wire" },
		},
		"rojo instance paths"
	)
	t.eq(instancePaths(strings, { "main.luau", "b/init.luau", "b/inner.luau" }), {
		["main.luau"] = { "main" },
		["b/init.luau"] = { "b" },
		["b/inner.luau"] = { "b", "inner" },
	}, "folder layout fallback instance paths")

	t.suite("requires: failure modes and external aliases")

	for _, info in
		{
			{ kind = "string", text = "./missing" },
			{ kind = "string", text = "@nope/x" },
			{ kind = "string", text = "barename" },
			{ kind = "dynamic" },
		} :: { any }
	do
		local res = requiresMod.resolve(proj, fromFile, info) :: any
		t.eq({ res.ok, res.reason }, { false, "require-unresolved" }, "unresolved: " .. (info.text or info.kind))
	end

	local runtimeProj = requiresMod.load(root, { aliases = { lute = true } })
	local res = requiresMod.resolve(runtimeProj, fromFile, { kind = "string", text = "@lute/fs" }) :: any
	t.eq(
		{ res.ok, res.reason, res.external },
		{ false, "require-external", { spelling = "@lute/fs", alias = "lute", path = "fs" } },
		"runtime alias resolves as require-external"
	)

	-- A `.luaurc` alias targeting a hidden dot-directory (`.sert/pkg/foo`) is
	-- treated as an external package rather than project source.
	proj.luaurcCache[proj.root] = { sert = util.joinPath(proj.root, ".sert/pkg/foo") }
	local hiddenRes = requiresMod.resolve(proj, fromFile, { kind = "string", text = "@sert/bar" }) :: any
	t.eq(
		{ hiddenRes.ok, hiddenRes.reason, hiddenRes.external },
		{ false, "require-external", { spelling = "@sert/bar", alias = "sert", path = "bar" } },
		".luaurc alias into hidden dot-directory resolves as require-external"
	)
end

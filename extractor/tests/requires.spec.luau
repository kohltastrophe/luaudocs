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

return function()
	-- Each fixture is graphed exactly once; every suite below reads from these.
	local strings, stringsDiag = buildGraph("strings", "main.luau")
	local instance, instanceDiag = buildGraph("instance", "src")

	t.suite("requires: string semantics")

	t.eq(
		moduleIds(strings),
		{ "main.luau", "a.luau", "b/init.luau", "vendor/thing.luau", "cond.luau", "b/inner.luau" },
		"BFS module ids (incl. the conditional mount)"
	)
	t.eq(#stringsDiag.list, 0, "strings fixture resolves cleanly")

	local main = strings.byId["main.luau"]
	t.eq(main.localModules, {
		a = "a.luau",
		b = "b/init.luau",
		thing = "vendor/thing.luau",
	}, "main require-local map (incl. @pkg alias; the local-less conditional mount stays out)")

	-- main.luau mounts cond.luau in an if-branch with no require-local (pinned
	-- by the exact map above), so surfaced-ness can only come from the
	-- surfaced-require walk finding the require inside the branch
	t.ok(strings.byId["cond.luau"].surfaced, "conditionally mounted module is surfaced")

	local b = strings.byId["b/init.luau"]
	t.eq(
		b.localModules,
		{ a = "a.luau", inner = "b/inner.luau" },
		"init.luau: ./a is a sibling of b/, @self reaches inside"
	)

	-- the fixture's .luaurc spells `Pkg` while main.luau requires @pkg (pinned
	-- by the graph above); the spelled case must resolve too
	do
		local root = util.joinPath(FIXTURES, "strings")
		local proj = requiresMod.load(root)
		local res = requiresMod.resolveString(proj, util.joinPath(root, "main.luau"), "@Pkg/thing")
		t.ok(res.ok == true, "alias lookup is case-insensitive (@Pkg for a `Pkg` alias)")
	end

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
	-- Extra exists only as a child in pkg's nested tree, and pkg/lib holds no
	-- Extra.luau, so resolving it proves the nested project's children merged
	-- into the outer mount node rather than being found by fs probing
	t.eq(init.localModules, {
		Mod = "src/Mod.luau",
		Ext = "ext/init.luau",
		Deep = "src/Mod/Sub.luau",
		Pkg = "pkg/lib/init.luau",
		Extra = "pkg/extra.luau",
		Wire = "wire/impl/init.luau",
	}, "script children + rojo mount + file-node child dir + nested projects")
	t.eq(init.name, "Inst", "root module display name from rojo")

	local mod = instance.byId["src/Mod.luau"]
	t.eq(mod.localModules, { Other = "src/Other.luau", Named = "src/Other.luau" }, "script.Parent local + WaitForChild")

	t.eq(init.instancePath, { "Inst" }, "instance path: init.luau is its directory's mount")
	t.eq(mod.instancePath, { "Inst", "Mod" }, "instance path: file below a mount")
	t.eq(
		instance.byId["ext/init.luau"].instancePath,
		{ "Inst", "Ext" },
		"instance path: separate mount, not its folder"
	)
	t.eq(
		instance.byId["src/Mod/Sub.luau"].instancePath,
		{ "Inst", "Mod", "Sub" },
		"instance path: nested below a file node"
	)

	t.eq(
		instance.byId["pkg/lib/init.luau"].instancePath,
		{ "Inst", "Pkg" },
		"nested default.project.json mount keeps the outer name, not the nested project's"
	)
	t.eq(
		instance.byId["pkg/extra.luau"].instancePath,
		{ "Inst", "Pkg", "Extra" },
		"child declared only in the nested tree sits under the outer mount"
	)
	t.eq(
		instance.byId["wire/impl/init.luau"].instancePath,
		{ "Inst", "Wire" },
		"$path naming a *.project.json file mounts that project's tree"
	)

	t.eq(
		strings.byId["main.luau"].instancePath,
		{ "main" },
		"instance path falls back to the folder layout without rojo"
	)
	t.eq(strings.byId["b/init.luau"].instancePath, { "b" }, "layout fallback: init.luau is its directory")
	t.eq(strings.byId["b/inner.luau"].instancePath, { "b", "inner" }, "layout fallback: nested file")

	t.suite("requires: failure modes")

	local proj = requiresMod.load(util.joinPath(FIXTURES, "strings"))
	local fromFile = util.joinPath(FIXTURES, "strings", "main.luau")

	-- the reason is asserted too: graph.luau branches on it to pick the
	-- diagnostic severity, which is what --strict gates on
	local res = requiresMod.resolve(proj, fromFile, { kind = "string", text = "./missing" }) :: any
	t.eq(res.ok, false, "missing module unresolved")
	t.eq(res.reason, "require-unresolved", "missing module reason")
	res = requiresMod.resolve(proj, fromFile, { kind = "string", text = "@nope/x" }) :: any
	t.eq(res.ok, false, "unknown alias unresolved")
	t.eq(res.reason, "require-unresolved", "unknown alias reason")
	res = requiresMod.resolve(proj, fromFile, { kind = "string", text = "barename" }) :: any
	t.eq(res.ok, false, "bare require unresolved")
	t.eq(res.reason, "require-unresolved", "bare require reason")
	res = requiresMod.resolve(proj, fromFile, { kind = "dynamic" }) :: any
	t.eq(res.ok, false, "dynamic require unresolved")
	t.eq(res.reason, "require-unresolved", "dynamic require reason")
end

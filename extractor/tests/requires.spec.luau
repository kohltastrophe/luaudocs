local fs = require("@std/fs")
local util = require("../core/util")
local t = require("./harness")
local requiresMod = require("../core/requires")
local graphMod = require("../core/graph")
local modelMod = require("../model")

local FIXTURES = t.fixtures

local function rmTree(p: string)
	local kind = util.pathType(p)
	if kind == "file" then
		pcall(fs.remove, p)
	elseif kind == "dir" then
		local ok, items = pcall(fs.listDirectory, p)
		if ok and type(items) == "table" then
			for _, item in items :: { any } do
				rmTree(util.joinPath(p, item.name))
			end
		end
		pcall(fs.removeDirectory, p)
	end
end

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

	t.suite("requires: .d.luau extensions and directory expansion")

	t.eq({
		util.stem("src/globalTypes.d.luau"),
		util.stem("src/init.d.luau"),
		util.stem("src/data.lua.luau"),
		util.isInitFile("src/init.d.luau"),
		util.isInitFile("src/init.luau"),
		util.isInitFile("src/init.client.luau"),
	}, {
		"globalTypes",
		"init",
		"data.lua",
		true,
		true,
		false,
	}, "util.stem and util.isInitFile handle .d.luau")

	local dluauRoot = util.joinPath(FIXTURES, "dluau")
	local expanded, expandErr = graphMod.expandEntries(dluauRoot, ".")
	local missingEntry, missingErr = graphMod.expandEntries(dluauRoot, "missing")
	local outsideEntry, outsideErr = graphMod.expandEntries(dluauRoot, "../strings")
	t.eq({
		expandErr,
		expanded ~= nil and #expanded or 0,
		expanded ~= nil and util.relPath(dluauRoot, expanded[1]) or "",
		expanded ~= nil and util.relPath(dluauRoot, expanded[2]) or "",
		expanded ~= nil and util.relPath(dluauRoot, expanded[3]) or "",
		missingEntry,
		missingErr ~= nil,
		outsideEntry,
		outsideErr ~= nil,
	}, {
		nil,
		3,
		"alpha.d.luau",
		"beta.d.luau",
		"nested/gamma.d.luau",
		nil,
		true,
		nil,
		true,
	}, "expandEntries collects nested .d.luau files and rejects missing or outside-root entries")

	local dluauProj = requiresMod.load(dluauRoot)
	local dluauDiag = util.diagnostics()
	local dluauGraph = graphMod.build(dluauProj, expanded :: { string }, dluauDiag)
	local dluauModel = modelMod.assemble(dluauGraph, dluauDiag, {
		entryPoints = { "alpha.d.luau", "beta.d.luau", "nested/gamma.d.luau" },
	})
	local gammaMod = t.byId(dluauModel.modules, "nested/gamma.d.luau")
	local gammaCls = t.byName(gammaMod.classes, "Gamma")
	local stepFn = t.byName(gammaCls.members, "Step")
	t.eq({
		#dluauDiag.list,
		#dluauModel.modules,
		stepFn.signature.params[1].type[1].id,
		stepFn.signature.returns[1].type[1].id,
	}, {
		0,
		3,
		"beta.d.luau#class.Beta",
		"alpha.d.luau#class.Alpha",
	}, "graph.build and model.assemble link ambient .d.luau classes across nested directory entries")

	t.suite("requires: JSONC .luaurc, out-of-root aliases, Rojo optional $path, scripts, and @ignore @class")

	local tmpBase =
		util.joinPath(util.dirname(FIXTURES), string.format(".tmp-requires-spec-%d", math.floor(os.clock() * 1000000)))
	local tmpProjRoot = util.joinPath(tmpBase, "proj")
	local tmpOutside = util.joinPath(tmpBase, "outside")
	local okTmp, tmpErr = pcall(function()
		fs.createDirectory(tmpBase)
		fs.createDirectory(tmpOutside)
		fs.createDirectory(tmpProjRoot)
		fs.createDirectory(util.joinPath(tmpProjRoot, "sub"))
		fs.createDirectory(util.joinPath(tmpProjRoot, "opt_present"))

		fs.writeStringToFile(util.joinPath(tmpOutside, "ext.luau"), "return {}")
		fs.writeStringToFile(util.joinPath(tmpProjRoot, "sub", "mod.luau"), "return {}")
		fs.writeStringToFile(util.joinPath(tmpProjRoot, "opt_present", "init.luau"), "return {}")
		fs.writeStringToFile(util.joinPath(tmpProjRoot, "Boot.server.luau"), "print('server')")
		fs.writeStringToFile(util.joinPath(tmpProjRoot, "Hud.client.lua"), "print('client')")
		fs.writeStringToFile(util.joinPath(tmpProjRoot, "server.luau"), "return {}")
		fs.writeStringToFile(util.joinPath(tmpProjRoot, "client.lua"), "return {}")
		fs.writeStringToFile(
			util.joinPath(tmpProjRoot, "ignored_attached.luau"),
			"--- @class IgnoredAttached\n--- @ignore\nlocal C = {}\nreturn C"
		)
		fs.writeStringToFile(
			util.joinPath(tmpProjRoot, "ignored_floating.luau"),
			"--- @class IgnoredFloating\n--- @ignore\n\nlocal M = {}\nreturn M"
		)
		fs.writeStringToFile(
			util.joinPath(tmpProjRoot, "ignored_ambient.d.luau"),
			"--- @ignore\ndeclare class IgnoredAmbient\n\tX: number\nend"
		)
		fs.writeStringToFile(
			util.joinPath(tmpProjRoot, "entry.luau"),
			table.concat({
				'local _a = require("./ignored_attached")',
				'local _b = require("./ignored_floating")',
				'local _c = require("./ignored_ambient")',
				'return { Outside = require("@out/ext") }',
			}, "\n")
		)

		local unnormAbs = tmpProjRoot .. "/sub/../sub"
		fs.writeStringToFile(
			util.joinPath(tmpProjRoot, ".luaurc"),
			table.concat({
				"/* Leading JSONC block comment */",
				"{",
				"\t// Line comment",
				'\t"aliases": {',
				string.format('\t\t"abs": %q, /* inline block comment */', unnormAbs),
				'\t\t"out": "../outside", -- trailing comma + luau comment',
				"\t},",
				"}",
			}, "\n")
		)
		fs.writeStringToFile(
			util.joinPath(tmpProjRoot, "default.project.json"),
			table.concat({
				"{",
				'\t"name": "TmpPkg",',
				'\t"tree": {',
				'\t\t"$className": "Folder",',
				'\t\t"Entry": { "$path": "entry.luau" },',
				'\t\t"Boot": { "$path": "Boot.server.luau" },',
				'\t\t"Hud": { "$path": "Hud.client.lua" },',
				'\t\t"OptPresent": { "$path": { "optional": "opt_present" } },',
				'\t\t"OptMissing": { "$path": { "optional": "opt_missing" } }',
				"\t}",
				"}",
			}, "\n")
		)

		local tmpProj, loadErr = requiresMod.load(tmpProjRoot)
		local entryFile = util.joinPath(tmpProjRoot, "entry.luau")
		local absRes = requiresMod.resolve(tmpProj, entryFile, { kind = "string", text = "@abs/mod" }) :: any
		local outRes = requiresMod.resolve(tmpProj, entryFile, { kind = "string", text = "@out/ext" }) :: any
		local optOk =
			requiresMod.resolve(tmpProj, entryFile, { kind = "ipath", segs = { "Parent", "OptPresent" } }) :: any
		local optMiss =
			requiresMod.resolve(tmpProj, entryFile, { kind = "ipath", segs = { "Parent", "OptMissing" } }) :: any
		local bootInst = requiresMod.resolve(tmpProj, entryFile, { kind = "ipath", segs = { "Parent", "Boot" } }) :: any
		local hudInst = requiresMod.resolve(tmpProj, entryFile, { kind = "ipath", segs = { "Parent", "Hud" } }) :: any
		local bootStr = requiresMod.resolve(tmpProj, entryFile, { kind = "string", text = "./Boot.server" }) :: any
		local plainServer = requiresMod.resolve(tmpProj, entryFile, { kind = "string", text = "./server" }) :: any
		local plainClient = requiresMod.resolve(tmpProj, entryFile, { kind = "string", text = "./client" }) :: any

		t.eq(
			{
				loadErr,
				absRes.ok,
				absRes.absPath,
				outRes.ok,
				optOk.ok,
				requiresMod.instancePath(tmpProj, util.joinPath(tmpProjRoot, "opt_present", "init.luau")),
				optMiss.ok,
				optMiss.reason,
				bootInst.ok,
				bootInst.reason,
				hudInst.ok,
				hudInst.reason,
				bootStr.ok,
				plainServer.ok,
				plainClient.ok,
			},
			{
				nil,
				true,
				util.normPath(util.joinPath(tmpProjRoot, "sub", "mod.luau")),
				true,
				true,
				{ "TmpPkg", "OptPresent" },
				false,
				"require-unresolved",
				false,
				"require-nonmodule",
				false,
				"require-nonmodule",
				false,
				true,
				true,
			},
			"JSONC .luaurc, normalized aliases, out-of-root non-hidden alias, Rojo optional $path, and script exclusions"
		)

		local tmpDiag = util.diagnostics()
		local tmpGraph = graphMod.build(tmpProj, { entryFile }, tmpDiag)
		t.eq({
			#tmpDiag.list,
			tmpDiag.list[1] and tmpDiag.list[1].code,
			tmpGraph.byId["ignored_attached.luau"].surfaced,
			tmpGraph.byId["ignored_floating.luau"].surfaced,
			tmpGraph.byId["ignored_ambient.d.luau"].surfaced,
		}, {
			1,
			"require-unresolved",
			false,
			false,
			false,
		}, "out-of-root alias fails in graph.build and @ignore @class modules are not promoted to surfaced")
	end)
	rmTree(tmpBase)
	assert(okTmp, tostring(tmpErr))
end

local fs = require("@std/fs")
local util = require("../util")
local t = require("./harness")
local paths = require("./paths")
local surface = require("../surface")

local eval = t.eval
local field = surface.fieldOf

local function fieldNames(sym: any): { string }
	local names = {}
	for _, f in sym.fields do
		table.insert(names, f.name)
	end
	return names
end

return function()
	t.suite("surface: module table members and classification")

	local root = eval(
		"local M = {}\n--- doc for f\nfunction M.f(x: number): string return tostring(x) end\nfunction M:g() end\nM.x = 5 -- the x constant\nM.__index = M\nreturn M"
	).result :: any
	t.eq(root.kind, "table", "returns table")
	t.eq(fieldNames(root), { "f", "g", "x" }, "field names in source order (__index excluded)")
	t.eq({
		field(root, "f").isColonMethod,
		field(root, "f").defDoc ~= nil,
		field(root, "g").isColonMethod,
		field(root, "x").value.kind,
		field(root, "x").trailingDesc,
		surface.classify(root, false),
	}, { false, true, true, "literal", "the x constant", true }, "member properties and class classification")

	local selfIdx = eval("local M = {}\nM.__index = M\nfunction M.only() end\nreturn M").result :: any
	local otherIdx = eval("local M = {}\nlocal MT = {}\nM.__index = MT\nreturn M").result :: any
	t.eq({
		surface.classify(selfIdx, false),
		fieldNames(selfIdx),
		surface.isSelfIndexing(selfIdx),
		surface.isSelfIndexing(otherIdx),
	}, { false, { "only" }, true, false }, "self-indexing alone does not classify as class")

	local explicitSelf = eval("local M = {}\nfunction M.f(self: M, n: number) end\nreturn M").result :: any
	local nonFirstSelf = eval("local M = {}\nfunction M.f(n: number, self) end\nreturn M").result :: any
	t.eq({
		surface.isSelfMethod(field(explicitSelf, "f").value.fnNode),
		surface.classify(explicitSelf, false),
		surface.isSelfMethod(field(nonFirstSelf, "f").value.fnNode),
		surface.classify(nonFirstSelf, false),
	}, { true, true, false, false }, "explicit self first parameter classification")

	t.suite("surface: literal fields, quotes, and list items")

	root = eval(table.concat({
		"local SYM = {}",
		"local M = {",
		"\t--- symbol prop",
		"\tClean = table.freeze({ type = 'Symbol' }) :: Symbol,",
		"\t['quoted-key'] = 1,",
		"\t[SYM] = 2,",
		"\t3,",
		"\tinline = function(v: boolean?) end,",
		"}",
		"return M",
	}, "\n")).result :: any
	t.eq(fieldNames(root), { "Clean", "quoted-key", "inline" }, "record + string-general keys only")
	t.eq({
		field(root, "Clean").declaredType ~= nil,
		field(root, "Clean").fieldDoc ~= nil,
		field(root, "Clean").value.kind,
		field(root, "inline").value.kind,
	}, { true, true, "table", "function" }, "cast, field doc, freeze, and inline function")

	root = eval('return { [\'"\'] = 1, ["[[x]]"] = 2 }').result :: any
	t.eq(fieldNames(root), { '"', "[[x]]" }, "quote- and long-bracket-shaped keys preserved")

	local parsed, claimIndex, trailingIndex = t.parseWithComments(
		'local M = {}\nM.presets = {\n\t--- @class Preset\n\t--- One preset.\n\t{ name = "dark" },\n}\nreturn M'
	)
	surface.evaluate(parsed, claimIndex, trailingIndex)
	t.eq(claimIndex[5] and claimIndex[5].claimed, false, "nested list item does not claim doc block")

	t.suite("surface: assignments, requires, and conditional mounts")

	root = eval("local Config\n--- Maximum retries.\nConfig = { maxRetries = 3 }\nreturn Config").result :: any
	t.eq({ root.kind, root.defDoc ~= nil }, { "table", true }, "forward-declared assignment attaches doc")

	root = eval("local a = {}\nlocal b = 1\na, b = b, a\nreturn { x = a, y = b }").result :: any
	t.eq({ field(root, "x").value.kind, field(root, "y").value.kind }, { "literal", "table" }, "parallel assignment")

	local res = eval('local State = require("./State")\nreturn { State = State, raw = State.raw }')
	root = res.result :: any
	t.eq({
		field(root, "State").value.kind,
		field(root, "raw").value.kind,
		field(root, "raw").value.path,
		res.requireLocals["State"] ~= nil,
		(eval('return require("./impl")').result :: any).kind,
	}, { "require", "import", { "raw" }, true, "require" }, "requires, imports, and passthrough")

	root = eval(table.concat({
		"local M = {}",
		'if IS_CLIENT then M.UI = require("./UI")',
		'elseif IS_SERVER then M.Net = require("./Net")',
		'else M.Fallback = require("./Fallback") end',
		"do M.Scoped = 2 end",
		"while IS_CLIENT do M.Skipped = 3 end",
		"return M",
	}, "\n")).result :: any
	t.eq(fieldNames(root), { "UI", "Net", "Fallback", "Scoped" }, "if/elseif/else and do surface; loops skipped")
	t.eq(
		{ field(root, "UI").value.kind, field(root, "Net").value.kind, field(root, "Fallback").value.kind },
		{ "require", "require", "require" },
		"branch require mounts"
	)

	root = eval("--- A function module\nlocal function go() end\nreturn go").result :: any
	t.eq(
		{ root.kind, root.defDoc ~= nil, (eval("return nil").result :: any).valueKind },
		{ "function", true, "nil" },
		"function and nil modules"
	)

	t.suite("surface: freeze, services, metatables, ipaths, and clone")

	t.eq({
		(eval("local M = { limit = 5 }\ntable.freeze(M)\nreturn M").result :: any).frozen,
		(eval("local M = { limit = 5 }\nreturn table.freeze(M)").result :: any).frozen,
		(eval("local M = { limit = 5 }\nreturn M").result :: any).frozen,
	}, { true, true, nil }, "table.freeze tracking")

	root =
		eval('local ds = game:GetService("DataStoreService")\nreturn { ds = ds, players = game.Players }').result :: any
	t.eq(
		{ field(root, "ds").value.service, field(root, "players").value.service },
		{ "DataStoreService", "Players" },
		"service names"
	)

	root = eval("local M = setmetatable({}, { __call = function() end })\nfunction M.f() end\nreturn M").result :: any
	t.eq({ root.metatable ~= nil, fieldNames(root) }, { true, { "f" } }, "setmetatable + fields")

	root = eval(
		'local Shared = script.Parent\nreturn { dep = require(Shared.Mod), found = Shared:FindFirstChild("Mod") }'
	).result :: any
	t.eq(
		{ field(root, "dep").value.kind, field(root, "found").value.segs },
		{ "require", { "Parent", "Mod" } },
		"instance require and FindFirstChild"
	)

	root = eval(
		"local Base = { a = 1 }\nlocal Copy = table.clone(Base)\nCopy.b = 2\nreturn { orig = Base, copy = Copy }"
	).result :: any
	t.eq(
		{ fieldNames(field(root, "copy").value), fieldNames(field(root, "orig").value) },
		{ { "a", "b" }, { "a" } },
		"table.clone isolates fields"
	)

	t.suite("surface: lazy require loaders, __index delegation, and typeof(require) mounts")

	-- Lazy loader functions capture `returnedRequire` from a single `return require(...)` statement.
	root = eval('local M = {}\nfunction M.server()\n\treturn require("@self/Server")\nend\nreturn M').result :: any
	local loader = field(root, "server").value
	t.eq(
		{ loader.kind, loader.returnedRequire and loader.returnedRequire.requireInfo },
		{ "function", { kind = "string", text = "@self/Server" } },
		"returnedRequire captured on lazy loader function"
	)

	-- `__index` delegation copies fields from a prototype table or factory function call.
	root = eval(table.concat({
		"local function make()",
		"\tlocal R = { a = 1, extra = 0 }",
		"\tfunction R.run() end",
		"\treturn R",
		"end",
		"local base = make()",
		"return table.freeze(setmetatable({ extra = 1 }, { __index = base }))",
	}, "\n")).result :: any
	t.eq(
		{ root.frozen, fieldNames(root), field(root, "extra").value.kind, field(root, "run").value.kind },
		{ true, { "extra", "a", "run" }, "literal", "function" },
		"__index factory delegation merges unshadowed prototype fields"
	)

	-- `Key: typeof(require(...))` entries on the returned table's type annotation synthesize module mounts.
	root = eval(table.concat({
		"type Z = {",
		"\t--- Submodule doc",
		'\tSub: typeof(require("@self/Sub")),',
		"\t num: number,",
		"}",
		"local api: Z = { num = 1 } :: any",
		"return api",
	}, "\n")).result :: any
	local subField = field(root, "Sub")
	t.eq(
		{ fieldNames(root), subField.value.kind, subField.value.requireInfo, subField.fieldDoc ~= nil },
		{ { "num", "Sub" }, "require", { kind = "string", text = "@self/Sub" }, true },
		"typeof(require(...)) synthesized from table type annotation"
	)

	t.suite("surface: sample-project modules")

	local SAMPLE = util.joinPath(paths.projectFixtures, "sample-project", "src")
	local function evalFile(name: string)
		return eval(fs.readFileToString(util.joinPath(SAMPLE, name)))
	end

	res = evalFile("init.luau")
	root = res.result :: any
	local names = fieldNames(root)
	t.eq({
		table.find(names, "Clean"),
		(table.find(names, "Color") :: number) > (table.find(names, "Clean") :: number),
		table.find(names, "new") == #names,
		surface.classify(root, false),
		root.defDoc ~= nil,
		field(root, "new").isColonMethod,
		field(root, "new").declaredType ~= nil,
	}, { 1, true, true, false, true, false, true }, "Sample init.luau surface")

	res = evalFile("State.luau")
	root = res.result :: any
	local exportedTypes = {}
	for _, ty in res.types do
		if ty.exported then
			table.insert(exportedTypes, ty.name)
		end
	end
	t.eq({
		surface.classify(root, false),
		field(root, "deferUpdates") ~= nil,
		field(root, "Connect").isColonMethod,
		field(root, "__call").isColonMethod,
		exportedTypes,
	}, { true, true, true, false, { "StateData", "State", "Stateful" } }, "State.luau surface")

	t.eq((evalFile("Interpolate.luau").result :: any).kind, "function", "Interpolate returns function")
	t.eq((evalFile("Type.luau").result :: any).valueKind, "nil", "Type returns nil")

	root = evalFile("Color.luau").result :: any
	t.eq(
		{ fieldNames(root), fieldNames(field(root, "Linear").value) },
		{ { "Linear", "Polar" }, { "fromGamma", "toGamma" } },
		"Color nested sections"
	)
end

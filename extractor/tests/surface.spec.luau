local fs = require("@std/fs")
local util = require("../util")
local t = require("./harness")
local paths = require("./paths")
local surface = require("../surface")

local eval = t.eval

local function fieldNames(sym: any): { string }
	local names = {}
	for _, f in sym.fields do
		table.insert(names, f.name)
	end
	return names
end

local function field(sym: any, name: string): any
	return surface.fieldOf(sym, name)
end

return function()
	t.suite("surface: module table members")

	local res = eval(table.concat({
		"local M = {}",
		"--- doc for f",
		"function M.f(x: number): string",
		"\treturn tostring(x)",
		"end",
		"function M:g() end",
		"M.x = 5 -- the x constant",
		"M.__index = M",
		"return M",
	}, "\n"))
	local root = res.result :: any
	t.eq(root.kind, "table", "returns table")
	t.eq(fieldNames(root), { "f", "g", "x" }, "field names in source order (__index excluded)")
	t.eq(field(root, "f").isColonMethod, false, "dot function")
	t.ok(field(root, "f").defDoc ~= nil, "dot function claimed doc")
	t.eq(field(root, "g").isColonMethod, true, "colon method")
	t.eq(field(root, "x").value.kind, "literal", "prop literal")
	t.eq(field(root, "x").trailingDesc, "the x constant", "trailing desc")
	t.eq(surface.classify(root, false), true, "root with colon methods is a class")

	-- `__index = self` is not a classification rule: it is equally the idiom for
	-- a self-indexing module, and it never reaches the fields either
	res = eval("local M = {}\nM.__index = M\nfunction M.only() end\nreturn M")
	t.eq(surface.classify(res.result :: any, false), false, "__index = self alone does not make a class")
	t.eq(fieldNames(res.result :: any), { "only" }, "__index never surfaces as a field")

	t.suite("surface: literal fields")

	res = eval(table.concat({
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
	}, "\n"))
	root = res.result :: any
	t.eq(fieldNames(root), { "Clean", "quoted-key", "inline" }, "record + string-general keys only")
	t.ok(field(root, "Clean").declaredType ~= nil, "cast type captured")
	t.ok(field(root, "Clean").fieldDoc ~= nil, "field doc claimed")
	t.eq(field(root, "Clean").value.kind, "table", "freeze unwrapped to table")
	t.eq(field(root, "inline").value.kind, "function", "inline function value")

	-- string tokens arrive delimiter-less from the parser, so content that
	-- merely LOOKS quoted must survive as written; general string keys are the
	-- surface's reader of string-token text, so they observe it
	res = eval(table.concat({
		"local M = {",
		"\t['\"'] = 1,",
		'\t["[[x]]"] = 2,',
		"}",
		"return M",
	}, "\n"))
	root = res.result :: any
	t.eq(fieldNames(root), { '"', "[[x]]" }, "quote- and long-bracket-shaped key content is not stripped")

	-- a list item is read for its element type, which a nested table cannot
	-- have: evaluating one anyway would claim the block above its first field,
	-- and the model's floating-declaration sweep only picks up unclaimed blocks
	local parsed, claimIndex, trailingIndex = t.parseWithComments(table.concat({
		"local M = {}",
		"M.presets = {",
		"\t--- @class Preset",
		"\t--- One preset.",
		'\t{ name = "dark" },',
		"}",
		"return M",
	}, "\n"))
	surface.evaluate(parsed, claimIndex, trailingIndex)
	local block = claimIndex[5]
	t.ok(block ~= nil, "the block above the nested table is indexed at its field's line")
	t.eq(block and block.claimed, false, "a nested list item claims no doc block")

	t.suite("surface: forward-declared assignment docs")

	res = eval(table.concat({
		"local Config",
		"--- Maximum retries before giving up.",
		"Config = { maxRetries = 3 }",
		"return Config",
	}, "\n"))
	root = res.result :: any
	t.eq(root.kind, "table", "forward-declared table surfaces")
	t.ok(root.defDoc ~= nil, "the doc above `X = ...` attaches like on `local X = ...`")

	t.suite("surface: requires, imports, passthrough")

	res = eval(table.concat({
		'local State = require("./State")',
		"local M = {",
		"\tState = State,",
		"\traw = State.raw,",
		"}",
		"return M",
	}, "\n"))
	root = res.result :: any
	t.eq(field(root, "State").value.kind, "require", "submodule mount")
	t.eq(field(root, "raw").value.kind, "import", "member import")
	t.eq(field(root, "raw").value.path, { "raw" }, "import path")
	t.ok(res.requireLocals["State"] ~= nil, "require local recorded")

	res = eval('return require("./impl")')
	t.eq((res.result :: any).kind, "require", "passthrough module")

	t.suite("surface: conditional mounts")

	res = eval(table.concat({
		"local M = {}",
		"if IS_CLIENT then",
		'\tM.UI = require("./UI")',
		"elseif IS_SERVER then",
		'\tM.Net = require("./Net")',
		"else",
		'\tM.Fallback = require("./Fallback")',
		"end",
		"do",
		"\tM.Scoped = 2",
		"end",
		"while IS_CLIENT do",
		"\tM.Skipped = 3",
		"end",
		"return M",
	}, "\n"))
	root = res.result :: any
	t.eq(
		fieldNames(root),
		{ "UI", "Net", "Fallback", "Scoped" },
		"if/elseif/else and do bodies surface, loop bodies do not"
	)
	t.eq(field(root, "UI").value.kind, "require", "then-branch require mount")
	t.eq(field(root, "Net").value.kind, "require", "elseif-branch require mount")
	t.eq(field(root, "Fallback").value.kind, "require", "else-branch require mount")

	res = eval("--- A function module\nlocal function go() end\nreturn go")
	root = res.result :: any
	t.eq(root.kind, "function", "function module")
	t.ok(root.defDoc ~= nil, "function module doc")

	res = eval("return nil")
	t.eq((res.result :: any).valueKind, "nil", "nil module")

	t.suite("surface: freeze and services")

	res = eval("local M = { limit = 5 }\ntable.freeze(M)\nreturn M")
	t.eq((res.result :: any).frozen, true, "statement-form freeze marks the table")

	res = eval("local M = { limit = 5 }\nreturn table.freeze(M)")
	t.eq((res.result :: any).frozen, true, "return-form freeze marks the table")

	res = eval("local M = { limit = 5 }\nreturn M")
	t.eq((res.result :: any).frozen, nil, "an unfrozen table stays unmarked")

	res = eval(table.concat({
		'local DataStoreService = game:GetService("DataStoreService")',
		"local Players = game.Players",
		"local M = { ds = DataStoreService, players = Players }",
		"return M",
	}, "\n"))
	root = res.result :: any
	t.eq(field(root, "ds").value.service, "DataStoreService", "GetService records the service name")
	t.eq(field(root, "players").value.service, "Players", "game.X records the service name")

	t.suite("surface: setmetatable and ipaths")

	res = eval("local M = setmetatable({}, { __call = function() end })\nfunction M.f() end\nreturn M")
	root = res.result :: any
	t.ok(root.metatable ~= nil, "metatable captured")
	t.eq(fieldNames(root), { "f" }, "fields after setmetatable")

	res = eval(table.concat({
		"local Shared = script.Parent",
		'local Data = Shared.Data:WaitForChild("Defaults")',
		"local M = { dep = require(Shared.Mod) }",
		"return M",
	}, "\n"))
	root = res.result :: any
	t.eq(field(root, "dep").value.kind, "require", "instance-style require captured")

	-- FindFirstChild extends an instance path exactly as WaitForChild does. Both
	-- reach the same branch, so only one being wired stays invisible until a
	-- project uses the other.
	res = eval(table.concat({
		"local Shared = script.Parent",
		'local M = { found = Shared:FindFirstChild("Mod") }',
		"return M",
	}, "\n"))
	root = res.result :: any
	t.eq(field(root, "found").value.segs, { "Parent", "Mod" }, "FindFirstChild extends the instance path")

	-- table.clone yields a NEW table. Sharing the original's field list would
	-- leak members later defined on the copy back onto the original, reading as
	-- a member on a page that never declared it.
	res = eval(table.concat({
		"local Base = { a = 1 }",
		"local Copy = table.clone(Base)",
		"Copy.b = 2",
		"return { orig = Base, copy = Copy }",
	}, "\n"))
	root = res.result :: any
	t.eq(fieldNames(field(root, "copy").value), { "a", "b" }, "clone carries the original's fields and its own")
	t.eq(fieldNames(field(root, "orig").value), { "a" }, "the original is untouched by members added to the clone")

	t.suite("surface: whole sample-project modules")

	-- The docmodel-sample.json diff already pins this fixture's full roster, so
	-- these assertions stick to what only the surface pass shows: how each
	-- definition style lands in one member list.
	local SAMPLE = util.joinPath(paths.projectFixtures, "sample-project", "src")
	local function evalFile(name: string)
		return eval(fs.readFileToString(util.joinPath(SAMPLE, name)))
	end

	--- 1-based position of `name`, or -1, so order assertions survive unrelated
	--- members being added to the fixture.
	local function orderOf(names: { string }, name: string): number
		for i, v in names do
			if v == name then
				return i
			end
		end
		return -1
	end

	res = evalFile("init.luau")
	root = res.result :: any
	local names = fieldNames(root)
	t.eq(orderOf(names, "Clean"), 1, "literal field opens the member list")
	t.ok(orderOf(names, "Color") > orderOf(names, "Clean"), "require mount follows the literal fields")
	t.eq(orderOf(names, "new"), #names, "cast assign after the literal table closes it")
	t.eq(surface.classify(root, false), false, "Sample root is a module, not a class")
	t.ok(root.defDoc ~= nil, "Sample module table doc")
	t.eq(field(root, "new").isColonMethod, false, "Sample.new via cast assign")
	t.ok(field(root, "new").declaredType ~= nil, "Sample.new declared type from cast")

	res = evalFile("State.luau")
	root = res.result :: any
	t.eq(surface.classify(root, false), true, "State is a class")
	t.ok(field(root, "deferUpdates") ~= nil, "State.deferUpdates prop present")
	t.eq(field(root, "Connect").isColonMethod, true, "State:Connect method")
	t.eq(field(root, "__call").isColonMethod, false, "metamethod present in raw surface")
	local typeNames = {}
	for _, ty in res.types do
		if ty.exported then
			table.insert(typeNames, ty.name)
		end
	end
	t.eq(typeNames, { "StateData", "State", "Stateful" }, "State exported types")

	res = evalFile("Interpolate.luau")
	t.eq((res.result :: any).kind, "function", "Interpolate returns a function")

	res = evalFile("Type.luau")
	t.eq((res.result :: any).valueKind, "nil", "Type returns nil")

	res = evalFile("Color.luau")
	root = res.result :: any
	t.eq(fieldNames(root), { "Linear", "Polar" }, "Color nested sections")
	t.eq(
		fieldNames(field(root, "Linear").value),
		{ "fromGamma", "toGamma" },
		"nested section members are discovered by name, not just counted"
	)
end

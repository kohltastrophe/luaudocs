local fs = require("@std/fs")
local util = require("../util")
local t = require("./harness")
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

	res = eval(table.concat({
		"local Proto = { shared = 1 }",
		"local MT = {}",
		"MT.__index = Proto",
		"local M = { own = 2 }",
		"setmetatable(M :: any, MT)",
		"table.freeze(M :: any)",
		"return M",
	}, "\n"))
	root = res.result :: any
	t.eq(
		{ fieldNames(root), root.frozen },
		{ { "own", "shared" }, true },
		"cast setmetatable/freeze and MT.__index = Proto"
	)

	t.suite("surface: sample-project modules")

	local SAMPLE = util.joinPath(t.projectFixtures, "sample-project", "src")
	local function evalFile(name: string)
		return eval(fs.readFileToString(util.joinPath(SAMPLE, name)))
	end

	res = evalFile("init.luau")
	root = res.result :: any
	t.check(root.kind == "table", "Sample init.luau returns table")
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

	t.suite("surface: operator folding, origin sync, return docs, and factory scope")

	res = eval(table.concat({
		"local unknown = get()",
		"local M = {",
		"\tadd = 1 + 2,",
		"\tsub = 10 - 3,",
		"\tmul = 4 * 5,",
		"\tdiv = 8 / 2,",
		"\tidiv = 9 // 2,",
		"\tmod = 7 % 3,",
		"\tpow = 2 ^ 8,",
		'\tcatStr = "a" .. "b",',
		'\tcatNum = "v" .. 1,',
		"\torBool = false or true,",
		'\torStr = "a" or "b",',
		"\topaqueAdd = unknown + 1,",
		'\topaqueCat = unknown .. "x",',
		"}",
		"return M",
	}, "\n"))
	root = res.result :: any
	t.eq({
		field(root, "add").value.valueKind,
		field(root, "sub").value.valueKind,
		field(root, "mul").value.valueKind,
		field(root, "div").value.valueKind,
		field(root, "idiv").value.valueKind,
		field(root, "mod").value.valueKind,
		field(root, "pow").value.valueKind,
		field(root, "catStr").value.valueKind,
		field(root, "catNum").value.valueKind,
		field(root, "orBool").value.valueKind,
		field(root, "orStr").value.valueKind,
		field(root, "opaqueAdd").value.kind,
		field(root, "opaqueCat").value.kind,
	}, {
		"number",
		"number",
		"number",
		"number",
		"number",
		"number",
		"number",
		"string",
		"string",
		"boolean",
		"string",
		"opaque",
		"opaque",
	}, "binary arithmetic, concat, and or literal folding")

	res = eval(table.concat({
		"type Shape = { own: number }",
		"local Proto = { shared = 1 }",
		"local MT = { __index = Proto }",
		"local raw = { own = 2 }",
		"local M = raw :: Shape",
		"raw.__index = raw",
		"setmetatable(raw, MT)",
		"table.freeze(raw)",
		"return M",
	}, "\n"))
	root = res.result :: any
	t.eq(
		{ fieldNames(root), root.frozen, root.selfIndexing, root.metatable ~= nil },
		{ { "own", "shared" }, true, true, true },
		"mutations on raw table after type-cast rebind sync to M"
	)

	local fnRet = eval("--- Callable module doc.\nreturn function(x: number): number\n\treturn x\nend").result :: any
	local tblRet = eval("--- Direct table return doc.\nreturn { a = 1 }").result :: any
	t.eq(
		{ fnRet.kind, fnRet.defDoc ~= nil, tblRet.kind, tblRet.defDoc ~= nil },
		{ "function", true, "table", true },
		"doc block on top-level return statement attaches to result.defDoc"
	)

	local factory = eval(table.concat({
		"local function makeProto()",
		"\tlocal leaked = { secret = 1 }",
		"\ttype InnerType = number",
		"\treturn { public = 2 }",
		"end",
		"local M = { own = 1 }",
		"setmetatable(M, { __index = makeProto() })",
		"return M",
	}, "\n"))
	local envCount = 0
	for _ in factory.env do
		envCount += 1
	end
	t.eq(
		{ fieldNames(factory.result), envCount, #factory.types },
		{ { "own", "public" }, 2, 0 },
		"factory body delegation does not leak locals or types into module scope"
	)
end

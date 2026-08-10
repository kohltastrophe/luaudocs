local t = require("./harness")
local infer = require("../infer")
local segs = require("../segs")
local surface = require("../surface")

local eval = t.eval

--- The type inferred for `M.x = <expr>`, as its joined display text. The
--- surface work is real (shadowing, locals, chained indexes all matter here),
--- so every case states the whole module rather than a bare expression.
local function typeOf(lines: { string }): string?
	local res = eval(table.concat(lines, "\n"))
	local field = surface.fieldOf(res.result :: any, "x")
	assert(field ~= nil, "spec module must define M.x")
	local list = infer.fromValue(field.value)
	return if list ~= nil then segs.text(list) else nil
end

--- One `M.x = <expr>` module, for the cases needing no surrounding setup.
local function typeOfExpr(expr: string): string?
	return typeOf({ "local M = {}", "M.x = " .. expr, "return M" })
end

--- `t.eq` for a case that reads the generated dump (method returns, the
--- datatype and enum lists). It is never committed, so a checkout that has not
--- run `bun run generate` has nothing for these to prove; the built-in signals
--- are asserted unconditionally alongside them.
local engineLists = require("../engine").lists
local function eqEngine(actual: any, expected: any, name: string)
	if engineLists ~= nil then
		t.eq(actual, expected, name)
	end
end

return function()
	t.suite("infer: literals and operators")

	t.eq(typeOfExpr("5"), "number", "number literal")
	t.eq(typeOfExpr('"s"'), "string", "string literal")
	t.eq(typeOfExpr("true"), "boolean", "boolean literal")
	-- a placeholder for a value assigned elsewhere: the type is not `nil`
	t.eq(typeOfExpr("nil"), nil, "nil literal infers nothing")
	t.eq(typeOfExpr("a == b"), "boolean", "comparison")
	t.eq(typeOfExpr("not a"), "boolean", "not")
	t.eq(typeOfExpr("#a"), "number", "length")
	-- overloadable, so it could be a Vector3 as readily as a number
	t.eq(typeOfExpr("a + b"), nil, "arithmetic infers nothing")
	t.eq(typeOfExpr("a .. b"), nil, "concatenation infers nothing")
	t.eq(typeOfExpr("a and b"), nil, "and over two unknowns infers nothing")
	t.eq(
		typeOf({ "local M = {}", "local flag = 1 == 2", "M.x = flag", "return M" }),
		"boolean",
		"through a local binding"
	)

	t.suite("infer: tables")

	t.eq(typeOfExpr("{}"), "{}", "empty table literal")
	t.eq(typeOfExpr('{ "a", "b" }'), "{ string }", "homogeneous string list")
	t.eq(typeOfExpr("{ 1, 2 }"), "{ number }", "homogeneous number list")
	-- negating a number is still a number, where every other arithmetic
	-- operator could be anything
	t.eq(typeOfExpr("{ -1, 0, 1 }"), "{ number }", "list holding a negative number")
	t.eq(typeOfExpr("-1"), "number", "negated number literal")
	t.eq(typeOfExpr("-v"), nil, "negated unknown infers nothing")
	t.eq(typeOfExpr('{ 1, "a" }'), nil, "mixed list infers nothing")
	t.eq(typeOfExpr('{ 1, a = "b" }'), nil, "part record infers nothing")
	t.eq(typeOfExpr("{ f() }"), nil, "list of non-literals infers nothing")
	t.eq(typeOfExpr("{ { a = 1 } }"), nil, "list of tables infers nothing")
	-- the literal is empty only where it is spelled: the metatable is what
	-- makes it an instance of something
	t.eq(typeOfExpr("setmetatable({}, Class)"), nil, "a metatable-backed table infers nothing")
	-- the literal was empty, but the value is not: what it holds is documented
	-- as members, and `{}` would contradict them
	t.eq(
		typeOf({ "local M = {}", "M.x = {}", "M.x.y = 1", "return M" }),
		nil,
		"emptied literal assigned into infers nothing"
	)

	t.suite("infer: optional")

	--- finalize hands `optional` a return annotation as written, which is the
	--- only caller reaching a shape pass 1 never builds.
	local function optionalText(list: { any }): string?
		local out = infer.optional(list)
		return if out ~= nil then segs.text(out) else nil
	end

	t.eq(optionalText({ "number" }), "number?", "an atomic type takes the suffix")
	t.eq(optionalText({ "boolean" }), "boolean", "a guarded boolean absorbs the false")
	t.eq(optionalText({ "T", "?" }), "T?", "an already-optional type takes nothing")
	-- `?` is a union suffix over everything left of it: it covers a union as it
	-- stands, and the other two would not parse, or would bind to the wrong half
	t.eq(optionalText({ "A | B" }), "A | B?", "a union needs no parentheses")
	t.eq(optionalText({ "A & B" }), "(A & B)?", "an intersection is parenthesized")
	t.eq(optionalText({ "(s) -> R" }), "((s) -> R)?", "a function type is parenthesized")

	t.suite("infer: conditional mounts")

	-- `A and B` is B where the guard passes and falsy where it does not, so the
	-- type is B's, optional
	t.eq(typeOfExpr("flag and script"), "Instance?", "a guarded instance is optional")
	eqEngine(typeOfExpr("flag and Color3.new(1, 1, 1)"), "Color3?", "a guarded datatype is optional")
	t.eq(typeOfExpr("flag and {}"), "{}?", "a guarded table is optional")
	-- `false | boolean` is just boolean: nothing became absent
	t.eq(typeOfExpr("flag and other"), nil, "a guarded unknown infers nothing")
	t.eq(typeOfExpr("a == b and c ~= d"), "boolean", "a guarded boolean absorbs the false")
	t.eq(
		typeOf({
			"local M = {}",
			'local Server = flag and script:WaitForChild("Server")',
			'M.x = Server and Server:WaitForChild("Tools")',
			"return M",
		}),
		"Instance?",
		"indexing through a guarded value reaches what the guard admits"
	)
	-- as does assigning INTO one, so a guarded table is emptied the same way
	t.eq(
		typeOf({ "local M = {}", "M.x = flag and {}", "M.x.y = 1", "return M" }),
		nil,
		"a guarded literal assigned into infers nothing"
	)

	t.suite("infer: instance paths")

	t.eq(typeOfExpr("script"), "Instance", "script")
	t.eq(typeOfExpr('script:WaitForChild("A")'), "Instance", "WaitForChild")
	t.eq(typeOfExpr('script:WaitForChild("A"):FindFirstChild("B")'), "Instance", "chained child lookups")
	-- `.Value` names a property as readily as a child, and a property is not
	-- an Instance: `script.VERSION.Value` is a string
	t.eq(typeOfExpr("script.A"), nil, "dotted step infers nothing")
	t.eq(typeOfExpr('script.A:WaitForChild("B")'), nil, "a dotted step taints the rest of the path")

	t.suite("infer: engine values")

	local getService = 'local Run = game:GetService("RunService")'
	t.eq(typeOf({ "local M = {}", getService, "M.x = Run", "return M" }), "RunService", "a service is its own class")
	eqEngine(
		typeOf({ "local M = {}", getService, "M.x = Run:IsClient()", "return M" }),
		"boolean",
		"method on a service"
	)
	-- only GetService NAMES a service. `game.X` is stamped with one too, which
	-- is enough for a realm whitelist to filter but not to print: `game.PlaceId`
	-- is a number, and typing it `PlaceId` invents a class
	t.eq(typeOfExpr("game.PlaceId"), nil, "a game property infers nothing")
	t.eq(typeOfExpr('script:GetAttribute("A")'), nil, "an ambiguous return infers nothing")
	eqEngine(typeOfExpr("script:GetChildren()"), "{ Instance }", "an array return")
	-- the receiver is a project value, so the name is not the engine's
	t.eq(
		typeOf({ "local M = {}", "local obj = require(script.Other)", "M.x = obj:IsClient()", "return M" }),
		nil,
		"engine method name on a non-engine receiver infers nothing"
	)

	t.suite("infer: datatypes and enums")

	eqEngine(typeOfExpr("Color3.new(1, 1, 1)"), "Color3", "datatype constructor")
	eqEngine(typeOfExpr("Color3.fromRGB(1, 1, 1)"), "Color3", "from-prefixed constructor")
	eqEngine(typeOfExpr("Vector3.zero"), "Vector3", "datatype constant")
	t.eq(typeOfExpr('Instance.new("Part")'), "Instance", "Instance.new")
	-- an index spells the constructor exactly as the call of it does, and means
	-- the function rather than what it builds
	t.eq(typeOfExpr("Instance.new"), nil, "an uncalled constructor infers nothing")
	t.eq(typeOfExpr("Color3.fromRGB"), nil, "an uncalled from-constructor infers nothing")
	t.eq(typeOfExpr("vector.create(1, 1, 1)"), "vector", "luau library constructor")
	-- plenty of statics return something else entirely
	t.eq(typeOfExpr("Color3.toHSV(c)"), nil, "a non-constructor static infers nothing")
	eqEngine(typeOfExpr("Enum.Material.SmoothPlastic"), "Enum.Material", "enum item")
	t.eq(typeOfExpr("Enum.NotAnEnum.Whatever"), nil, "an unknown enum infers nothing")
	t.eq(
		typeOf({ "local M = {}", "local Color3 = require(script.Color3)", "M.x = Color3.new()", "return M" }),
		nil,
		"a local shadowing a datatype infers nothing"
	)
end

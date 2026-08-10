--- The doc-model JSON encoder: key order, escaping and the pretty-print shape
--- the checked-in captures are diffed in. The diagnostics collector is pinned
--- here too: its list lands verbatim in the emitted JSON.
local t = require("./harness")
local emit = require("../emit")
local util = require("../util")

return function()
	t.suite("emit: determinism")

	-- why this encoder exists instead of @std/json.serialize: the doc-model JSON
	-- is diffed byte-for-byte in CI, so key order must be stable everywhere
	t.eq(
		emit.encode({ zebra = 1, apple = 2, Mango = 3 }),
		'{"Mango":3,"apple":2,"zebra":1}',
		"object keys sort by byte order"
	)
	t.eq(emit.encode({ "b", "a", "c" }), '["b","a","c"]', "arrays keep source order, never sorted")

	t.suite("emit: assembly scratch keys")

	-- `__`-prefixed keys are assembly scratch space; model/init.luau relies on
	-- encode dropping them instead of running a stripping pass
	t.eq(emit.encode({ name = "x", __valueSym = 1 }), '{"name":"x"}', "__-prefixed keys are dropped")
	t.eq(emit.encode({ __only = 1 }), "{}", "a table of nothing but scratch keys encodes as an empty object")

	t.suite("emit: empty tables")

	-- an empty Lua table is indistinguishable from an empty array, so
	-- `externals` is omitted entirely rather than emitted empty
	t.eq(emit.encode({}), "[]", "an empty table encodes as an array, not an object")
	t.eq(emit.encode({ a = {} }), '{"a":[]}', "nested empty table encodes as an array")

	t.suite("emit: mixed-element arrays")

	-- signature segments arrive as arrays mixing bare strings and ref objects;
	-- each element must encode by its own kind, in order
	t.eq(
		emit.encode({ "text", { text = "x", id = "y" } }),
		'["text",{"id":"y","text":"x"}]',
		"a string and an object share one array, object keys still sorted"
	)
	t.eq(
		emit.encode({ { text = "a" }, "mid", { text = "b" }, "end" }),
		'[{"text":"a"},"mid",{"text":"b"},"end"]',
		"objects and strings interleave in source order"
	)
	t.eq(emit.encode({ "a", {} }), '["a",[]]', "an empty table element keeps the empty-table policy")
	t.eq(
		emit.encode({ "a", { name = "T" } }, true),
		'[\n\t"a",\n\t{ "name": "T" }\n]',
		"pretty mixed array: the string gets its line, the leaf object inlines"
	)

	t.suite("emit: string escaping")

	t.eq(emit.encode({ s = 'say "hi"' }), '{"s":"say \\"hi\\""}', "double quotes escaped")
	t.eq(emit.encode({ s = "back\\slash" }), '{"s":"back\\\\slash"}', "backslash escaped")
	t.eq(emit.encode({ s = "tab\there" }), '{"s":"tab\\there"}', "tab uses its short escape")
	t.eq(emit.encode({ s = "a\nb" }), '{"s":"a\\nb"}', "newline uses its short escape")
	-- a doc comment carrying a stray control byte must not produce invalid JSON
	t.eq(emit.encode({ s = "a\0b" }), '{"s":"a\\u0000b"}', "NUL escapes to \\u0000")
	t.eq(emit.encode({ s = "a\1b" }), '{"s":"a\\u0001b"}', "other control bytes escape to \\uXXXX")

	t.suite("emit: numbers and scalars")

	t.eq(emit.encode({ n = 42 }), '{"n":42}', "integers emit without a decimal point")
	t.eq(emit.encode({ n = 1.5 }), '{"n":1.5}', "floats keep their fraction")
	t.eq(emit.encode({ n = 0 / 0 }), '{"n":null}', "NaN is not valid JSON, so it emits null")
	t.eq(emit.encode({ n = math.huge }), '{"n":null}', "infinity emits null")
	t.eq(emit.encode({ true, false }), "[true,false]", "booleans")

	t.suite("emit: pretty printing")

	t.eq(
		emit.encode({ b = 1, a = { 1, 2 } }, true),
		'{\n\t"a": [\n\t\t1,\n\t\t2\n\t],\n\t"b": 1\n}',
		"pretty indents with tabs and still sorts keys"
	)

	-- the captures are mostly two- and three-field records; a line per field
	-- would triple the file and bury real changes in brace noise
	t.eq(
		emit.encode({ file = "a.luau", line = 3 }, true),
		'{ "file": "a.luau", "line": 3 }',
		"pretty keeps an all-scalar object on one line"
	)
	t.eq(
		emit.encode({ refs = { { name = "boolean" } } }, true),
		'{\n\t"refs": [\n\t\t{ "name": "boolean" }\n\t]\n}',
		"a leaf object inside an array inlines; its container still expands"
	)
	t.eq(
		emit.encode({ a = { b = { 1 } } }, true),
		'{\n\t"a": {\n\t\t"b": [\n\t\t\t1\n\t\t]\n\t}\n}',
		"an object holding a non-empty table stays expanded"
	)
	-- `tags = { custom = {} }` is the most repeated shape in the captures
	t.eq(emit.encode({ custom = {} }, true), '{ "custom": [] }', "an empty table needs no line, so it inlines too")
	-- compact is the wire format between the two runtimes; it must not move
	t.eq(
		emit.encode({ file = "a.luau", line = 3 }, false),
		'{"file":"a.luau","line":3}',
		"compact output is unaffected"
	)

	t.suite("emit: diagnostics collection")

	-- what recoverable problems become: Lute has no stderr, so the collector is
	-- the extractor's only channel short of a fatal error, and the TS CLI gates
	-- on the severity spellings pinned here
	local diag = util.diagnostics()
	t.eq(#diag.list, 0, "a fresh collector is empty")
	diag:error("boom", "it broke", "a.luau", 3)
	diag:warn("careful", "watch out", "b.luau")
	diag:info("fyi", "noted")
	t.eq(#diag.list, 3, "each helper appends one diagnostic")
	t.eq(diag.list[1].severity, "error", "error severity")
	t.eq(diag.list[2].severity, "warning", "warn severity is spelled 'warning'")
	t.eq(diag.list[3].severity, "info", "info severity")
	t.eq(diag.list[1].code, "boom", "code recorded")
	t.eq(diag.list[1].file, "a.luau", "file recorded")
	t.eq(diag.list[1].line, 3, "line recorded")
	t.eq(diag.list[2].line, nil, "a diagnostic without a line carries none")
	t.eq(diag.list[3].file, nil, "a project-level diagnostic carries no file")
end

local t = require("./harness")
local segs = require("../core/segs")

local function typeAlias(src: string)
	local parsed, claimIndex, trailingIndex = t.parseWithComments(src)
	for _, stat in parsed.cst.root.statements do
		if stat.tag == "typealias" then
			return parsed, stat, claimIndex, trailingIndex
		end
	end
	error("no typealias in source")
end

local function inline(rhs: string, generics: { [string]: boolean }?): any
	local parsed, stat = typeAlias("type X = " .. rhs)
	return segs.inline(parsed, stat.type, generics)
end

local function fieldsOf(rhs: string)
	local parsed, stat, claim, trailing = typeAlias("type X = " .. rhs)
	return segs.fields(parsed, stat.type, claim, trailing)
end

local ref = segs.ref
local function tagRef(text: string, name: string, prefix: string?): any
	return segs.ref(text, name, prefix, true)
end

return function()
	t.suite("segs: inline")

	local tbl = inline("{ tint: Color3, name: string }")
	t.check(segs.text(tbl) == "{ tint: Color3, name: string }", "inline display text")
	t.eq(tbl, { "{ tint: ", ref("Color3", "Color3"), ", name: ", ref("string", "string"), " }" }, "table type segs")
	t.eq(
		inline("Map<Widget, A.B>"),
		{ ref("Map", "Map"), "<", ref("Widget", "Widget"), ", ", ref("A.B", "B", "A"), ">" },
		"generic head, args, and prefixed ref"
	)
	t.eq(
		inline("Foo . Bar<Baz>"),
		{ ref("Foo.Bar", "Bar", "Foo"), "<", ref("Baz", "Baz"), ">" },
		"spaced qualified ref advances by CST token span"
	)
	t.eq(
		inline("{ a: Foo\n\t.Bar<Baz> }"),
		{ "{ a: ", ref("Foo.Bar", "Bar", "Foo"), "<", ref("Baz", "Baz"), "> }" },
		"multi-line qualified ref collapses without synthetic break"
	)
	t.eq(inline("Foo |\n\t-- legacy\n\tBar"), { ref("Foo", "Foo"), " | ", ref("Bar", "Bar") }, "line comment stripped")
	t.eq(segs.text(inline("{ a: --[[ first\n\tline ]] number }")), "{ a: number }", "block comment stripped")
	t.eq(segs.text(inline('"a--b" | Foo')), '"a--b" | Foo', "-- inside string literal preserved")
	t.eq(
		segs.text(inline("\"a   b\"   |   'c   d'   |   typeof(`e   f`)")),
		"\"a   b\" | 'c   d' | typeof(`e   f`)",
		"internal spaces in string literal singleton types preserved"
	)
	t.eq(inline("(T) -> T", { T = true }), { "(T) -> T" }, "generics in scope demoted to plain text")

	t.suite("segs: block")

	local parsed6, stat6 = typeAlias("type X = {\n\t-- speed in studs\n\tspeed: number,\n\n\ttarget: Widget,\n}")
	local lines, lineOf = segs.block(parsed6, stat6.type)
	t.eq({ t.blockText(lines :: any), lineOf[3], lineOf[5], (lines :: any)[4] }, {
		"{\n\t-- speed in studs\n\tspeed: number,\n\ttarget: Widget,\n}",
		3,
		4,
		{ "\ttarget: ", ref("Widget", "Widget"), "," },
	}, "blanks dropped, comments and indentation kept, line mapping shifted")

	local parsedD, statD = typeAlias("type Y = (\n\t\tWidget\n\t) -> ()")
	local linesD = select(1, segs.block(parsedD, statD.type)) :: any
	t.eq(
		{ t.blockText(linesD), linesD[2] },
		{ "(\n\tWidget\n) -> ()", { "\t", ref("Widget", "Widget") } },
		"continuation lines dedent by shared prefix"
	)

	t.suite("segs: fromTag")

	t.eq(segs.fromTag("{ tint: Color3 }"), { "{ tint: ", tagRef("Color3", "Color3"), " }" }, "parsed tag type")
	t.eq(segs.fromTag("{  tint:Color3 }"), { "{  tint:", tagRef("Color3", "Color3"), " }" }, "verbatim tag spacing")
	t.eq(segs.fromTag("number[]"), { tagRef("number", "number"), "[]" }, "lexical fallback on shorthand")
	t.eq(segs.fromTag("fn: Callback"), { "fn: ", tagRef("Callback", "Callback") }, "lexical skips field key")
	t.eq(
		segs.fromTag("{ fn?: Callback[] }"),
		{ "{ fn?: ", tagRef("Callback", "Callback"), "[] }" },
		"lexical skips optional field key"
	)
	t.eq(
		segs.fromTag('"a" | Foo.Bar[]'),
		{ '"a" | ', tagRef("Foo.Bar", "Bar", "Foo"), "[]" },
		"lexical quotes and dotted refs"
	)
	t.eq(segs.fromTag("Promise<T>", { T = true }), { tagRef("Promise", "Promise"), "<T>" }, "tag generics demoted")

	local first = segs.fromTag("Widget") :: any
	first[1].id = "poisoned"
	t.eq((segs.fromTag("Widget") :: any)[1].id, nil, "memoized tag segments return fresh clones")

	t.suite("segs: fields")

	local fields7 =
		select(1, fieldsOf("{\n\t--- lead doc\n\ta: string,\n\tb: number, -- trail doc\n\tc: boolean,\n}")) :: any
	t.eq(fields7, {
		{ name = "a", type = { ref("string", "string") }, doc = "lead doc", line = 3, docInDisplay = true },
		{ name = "b", type = { ref("number", "number") }, doc = "trail doc", line = 4, docInDisplay = true },
		{ name = "c", type = { ref("boolean", "boolean") }, line = 5 },
	}, "direct table fields claim leading/trailing docs")

	local own8, facts8 = fieldsOf("Base & {\n\tfrozen: boolean, -- capture state\n\tat: number,\n}")
	t.eq(
		{ own8, facts8 },
		{ nil, { frozen = { line = 2, docInDisplay = true }, at = { line = 3, docInDisplay = false } } },
		"intersection operands record line facts without claiming own fields"
	)

	local _, facts9 = fieldsOf("{ x: number } & { x: string, y: boolean, z: buffer }")
	t.eq(facts9, {}, "duplicate field names and shared lines are omitted from lineFacts")

	local ownOpt = select(1, fieldsOf("{\n\t--- lead doc\n\ta: string,\n}?")) :: any
	t.eq(
		ownOpt,
		{ { name = "a", type = { ref("string", "string") }, doc = "lead doc", line = 3, docInDisplay = true } },
		"optional table type unwraps and yields own fields"
	)

	local multiLineTrailing = select(
		1,
		fieldsOf(
			"{\n\tfn: (\n\t\tx: number\n\t) -> (), -- multi-line trailing doc\n\ta: number, b: string, -- shared line\n}"
		)
	) :: any
	t.eq(multiLineTrailing, {
		{
			name = "fn",
			type = { "( x: ", ref("number", "number"), " ) -> ()" },
			doc = "multi-line trailing doc",
			line = 2,
			docInDisplay = true,
		},
		{ name = "a", type = { ref("number", "number") }, line = 5 },
		{ name = "b", type = { ref("string", "string") }, line = 5 },
	}, "multi-line field trailing comment on endLine and no shared-line trailing bleed")

	t.suite("segs: generics and vararg packs")

	local parsed10, stat10 = typeAlias("type G<K, V = K, W = Widget, U... = (number, Widget)> = (W, U...) -> ()")
	t.eq(segs.generics(parsed10, stat10.generics, stat10.genericPacks), {
		{ name = "K", isPack = false },
		{ name = "V", isPack = false, default = { "K" } },
		{ name = "W", isPack = false, default = { ref("Widget", "Widget") } },
		{ name = "U", isPack = true, default = { "(", ref("number", "number"), ", ", ref("Widget", "Widget"), ")" } },
	}, "generics and typepack defaults")

	local parsedFn = t.parse("local function f<T...>(...: T...) end")
	local fnNode = parsedFn.cst.root.statements[1].func
	local fnGenerics, fnNames = segs.generics(parsedFn, fnNode.generics, fnNode.genericPacks)
	local fnParams = segs.paramEntries(parsedFn, fnNode, fnNames)
	t.eq(segs.text(segs.signature(fnGenerics, fnParams, nil)), "<T...>(...: T...)", "vararg pack signature")

	local parsedBlock = t.parse("do\n\texport type T = {\n\t\ta: Foo\n\t\t\t.Bar<Baz>,\n\t}\nend")
	local innerStat = parsedBlock.cst.root.statements[1].body.statements[1]
	local blockLines, blockLineOf = segs.block(parsedBlock, innerStat.type, nil, innerStat.location.beginLine)
	t.eq({
		segs.text((blockLines :: any)[1]),
		segs.text((blockLines :: any)[2]),
		segs.text((blockLines :: any)[3]),
		blockLineOf[3],
		blockLineOf[4],
	}, { "{", "\ta: Foo.Bar<Baz>,", "}", 2, 2 }, "segs.block merges multi-line qualified references before dedentation")
end

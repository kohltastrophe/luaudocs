local t = require("./harness")
local segs = require("../segs")

--- (parsed, first typealias stat, claimIndex, trailingIndex) for `src`.
local function typeAlias(src: string)
	local parsed, claimIndex, trailingIndex = t.parseWithComments(src)
	for _, stat in parsed.cst.root.statements do
		if stat.tag == "typealias" then
			return parsed, stat, claimIndex, trailingIndex
		end
	end
	error("no typealias in source")
end

local function ref(text: string, name: string, prefix: string?): any
	return { text = text, __name = name, __prefix = prefix }
end

local function tagRef(text: string, name: string, prefix: string?): any
	return { text = text, __name = name, __prefix = prefix, __tag = true }
end

return function()
	t.suite("segs: inline")

	local parsed, stat = typeAlias("type X = { tint: Color3, name: string }")
	local inline = segs.inline(parsed, stat.type) :: any
	t.eq(segs.text(inline), "{ tint: Color3, name: string }", "inline display is the source spelling")
	t.eq(inline, {
		"{ tint: ",
		ref("Color3", "Color3"),
		", name: ",
		ref("string", "string"),
		" }",
	}, "field keys are plain, type positions are refs")

	local parsed2, stat2 = typeAlias("type X = Map<Widget, A.B>")
	t.eq(segs.inline(parsed2, stat2.type), {
		ref("Map", "Map"),
		"<",
		ref("Widget", "Widget"),
		", ",
		ref("A.B", "B", "A"),
		">",
	}, "generic head and arguments are separate refs; prefixed refs spell both parts")

	local parsed3, stat3 = typeAlias(table.concat({
		"type X = Foo |",
		"	-- legacy",
		"	Bar",
	}, "\n"))
	t.eq(segs.inline(parsed3, stat3.type), {
		ref("Foo", "Foo"),
		" | ",
		ref("Bar", "Bar"),
	}, "comments strip and the whitespace run across lines collapses to one space")

	local parsed4, stat4 = typeAlias('type X = "a--b" | Foo')
	t.eq(segs.text(segs.inline(parsed4, stat4.type) :: any), '"a--b" | Foo', "a -- inside a string opens no comment")

	local parsed5, stat5 = typeAlias("type X = (T) -> T")
	t.eq(segs.inline(parsed5, stat5.type, { T = true }), {
		"(T) -> T",
	}, "generic names in scope come out plain, merged into one piece")

	t.suite("segs: block")

	local parsed6, stat6 = typeAlias(table.concat({
		"type X = {",
		"	-- speed in studs",
		"	speed: number,",
		"",
		"	target: Widget,",
		"}",
	}, "\n"))
	local lines, lineOf = segs.block(parsed6, stat6.type)
	-- the closing `}` sits at column 1, so the shared dedent prefix is empty
	-- and the body keeps its tabs, exactly as the author spelled it
	t.eq(
		segs.blockText(lines :: any),
		"{\n\t-- speed in studs\n\tspeed: number,\n\ttarget: Widget,\n}",
		"blanks dropped, comments and indentation kept"
	)
	t.eq(lineOf[3], 3, "field line maps through the blank drop")
	t.eq(lineOf[5], 4, "line after the blank shifts up")
	t.eq((lines :: any)[4], { "\ttarget: ", ref("Widget", "Widget"), "," }, "refs survive into block lines")

	-- an alias whose every continuation line is indented (the closer included)
	-- does dedent, and a ref on a dedented line keeps its exact column
	local parsedD, statD = typeAlias(table.concat({
		"type Y = (",
		"		Widget",
		"	) -> ()",
	}, "\n"))
	local linesD = select(1, segs.block(parsedD, statD.type)) :: any
	t.eq(segs.blockText(linesD), "(\n\tWidget\n) -> ()", "continuation lines dedent by the shared prefix")
	t.eq(linesD[2], { "\t", ref("Widget", "Widget") }, "ref column survives the dedent")

	t.suite("segs: fromTag")

	t.eq(segs.fromTag("{ tint: Color3 }"), {
		"{ tint: ",
		tagRef("Color3", "Color3"),
		" }",
	}, "parsed tag type: field keys plain, verbatim spacing, refs marked tag-authored")

	t.eq(segs.fromTag("{  tint:Color3 }"), {
		"{  tint:",
		tagRef("Color3", "Color3"),
		" }",
	}, "tag display is verbatim, never collapsed")

	t.eq(segs.fromTag("number[]"), {
		tagRef("number", "number"),
		"[]",
	}, "invalid Luau falls back to the lexical scan")

	t.eq(segs.fromTag("fn: Callback"), {
		"fn: ",
		tagRef("Callback", "Callback"),
	}, "lexical scan skips an identifier followed by a colon")

	t.eq(segs.fromTag('"a" | Foo.Bar[]'), {
		'"a" | ',
		tagRef("Foo.Bar", "Bar", "Foo"),
		"[]",
	}, "lexical scan: quoted text is plain, dotted pairs join into one prefixed ref")

	t.eq(segs.fromTag("Promise<T>", { T = true }), {
		tagRef("Promise", "Promise"),
		"<T>",
	}, "generic names demote to plain text on the tag path too")

	local first = segs.fromTag("Widget") :: any
	local second = segs.fromTag("Widget") :: any
	first[1].id = "poisoned"
	t.eq(second[1].id, nil, "memoized tag segments come back as fresh clones")

	t.suite("segs: fields")

	local parsed7, stat7, claim7, trailing7 = typeAlias(table.concat({
		"type P = {",
		"	--- lead doc",
		"	a: string,",
		"	b: number, -- trail doc",
		"	c: boolean,",
		"}",
	}, "\n"))
	local fields7 = select(1, segs.fields(parsed7, stat7.type, claim7, trailing7)) :: any
	local function shape(f: any)
		return { name = f.name, desc = f.desc, line = f.line, docInDisplay = f.docInDisplay }
	end
	t.eq(#fields7, 3, "three fields collected")
	t.eq(shape(fields7[1]), { name = "a", desc = "lead doc", line = 3, docInDisplay = true }, "leading doc claims")
	t.eq(
		shape(fields7[2]),
		{ name = "b", desc = "trail doc", line = 4, docInDisplay = true },
		"trailing doc falls back"
	)
	t.eq(shape(fields7[3]), { name = "c", desc = nil, line = 5, docInDisplay = nil }, "undocumented field")
	t.eq(segs.text(fields7[1].type), "string", "field types are inline segments")

	local parsed8, stat8, claim8, trailing8 = typeAlias(table.concat({
		"type S = Base & {",
		"	frozen: boolean, -- capture state",
		"	at: number,",
		"}",
	}, "\n"))
	local own8, facts8 = segs.fields(parsed8, stat8.type, claim8, trailing8)
	t.eq(own8, nil, "an intersection's operand table yields no own fields")
	t.eq(facts8.frozen, { line = 2, docInDisplay = true }, "operand fields still name display lines")
	t.eq(facts8.at, { line = 3, docInDisplay = false }, "operand line facts without docs")

	local parsed9, stat9, claim9, trailing9 = typeAlias("type D = { x: number } & { x: string, y: boolean, z: buffer }")
	local _, facts9 = segs.fields(parsed9, stat9.type, claim9, trailing9)
	t.eq(facts9.x, nil, "a name spelled twice goes line-less")
	t.eq(facts9.y, nil, "a second entry on a used line is skipped")
	t.eq(facts9.z, nil, "a third entry on a used line is skipped too")

	t.suite("segs: generics")

	local parsed10, stat10 = typeAlias("type G<K, V = K, W = Widget> = W")
	local list10 = segs.generics(parsed10, stat10.generics, stat10.genericPacks)
	t.eq(#list10, 3, "three parameters")
	t.eq(list10[1], { name = "K", isPack = false }, "no default")
	t.eq(list10[2], { name = "V", isPack = false, default = { "K" } }, "a default naming an earlier parameter is plain")
	t.eq(
		list10[3],
		{ name = "W", isPack = false, default = { ref("Widget", "Widget") } },
		"a project-type default is a ref"
	)
end

local t = require("./harness")
local tags = require("../tags")

return function()
	t.suite("tags: prose")

	local doc = tags.parse({ "Line one", "", "Line two" })
	t.eq(doc.desc, "Line one\n\nLine two", "prose joined with blank lines")
	t.eq(doc.placing, nil, "no placing")

	doc = tags.parse({ "Credits to @alice and @bob_2x for testing" })
	t.eq(doc.desc, "Credits to @alice and @bob_2x for testing", "unknown @words stay prose")
	t.eq(#doc.diagnostics, 0, "no diagnostics for unknown @words")

	doc = tags.parse({ "Example:", "```lua", "@param not_a_tag", "```" })
	t.eq(#doc.params, 0, "tags inside fences ignored")
	t.eq(doc.desc, "Example:\n```lua\n@param not_a_tag\n```", "fence content preserved")

	doc = tags.parse({ "Example:", "~~~lua", "@param not_a_tag", "~~~" })
	t.eq(#doc.params, 0, "tags inside tilde fences ignored")

	doc = tags.parse({ "Example:", "```lua", "~~~", "@param not_a_tag", "```" })
	t.eq(#doc.params, 0, "a tilde run inside a backtick fence is content, not a closer")

	doc = tags.parse({ "Example:", "", "    @param not_a_tag", "", "prose again" })
	t.eq(#doc.params, 0, "4-space-indented code after a blank line is not a tag")

	doc = tags.parse({ "@interface Options", "    .timeout number -- t" })
	t.eq(
		doc.fields[1],
		{ name = "timeout", type = "number", desc = "t" },
		"an indented dot field directly under @interface still parses (no blank boundary)"
	)

	t.suite("tags: param/return/error")

	doc = tags.parse({
		"Adds numbers",
		"@param x number -- the x value",
		"@param y -- described only",
		"@param z { [string]: number }",
	})
	t.eq(doc.desc, "Adds numbers", "desc before tags")
	t.eq(doc.params[1], { name = "x", type = "number", desc = "the x value" }, "param with type and desc")
	t.eq(doc.params[2], { name = "y", desc = "described only" }, "param desc-only (our extension)")
	t.eq(doc.params[3], { name = "z", type = "{ [string]: number }" }, "param type with spaces, no desc")

	doc = tags.parse({ "@return string -- the name", "@return number" })
	t.eq(doc.returns[1], { type = "string", desc = "the name" }, "return type+desc")
	t.eq(doc.returns[2], { type = "number" }, "return type only")

	doc = tags.parse({ "@error string -- when missing" })
	t.eq(doc.errors[1], { type = "string", desc = "when missing" }, "error tag")

	doc = tags.parse({ "@param ... any -- varargs" })
	t.eq(doc.params[1], { name = "...", type = "any", desc = "varargs" }, "vararg param name")

	doc = tags.parse({
		"@param handler: () -> any | nil -- The function to run",
		"@param ...: any? -- Additional arguments",
	})
	t.eq(
		doc.params[1],
		{ name = "handler", type = "() -> any | nil", desc = "The function to run" },
		"trailing colon on param name tolerated"
	)
	t.eq(
		doc.params[2],
		{ name = "...", type = "any?", desc = "Additional arguments" },
		"trailing colon on vararg tolerated"
	)

	doc = tags.parse({
		"@param obj - A static value, or a one-shot thing.",
		"@param count number - How many.",
		"@return Node - The created node.",
	})
	t.eq(doc.params[1], { name = "obj", desc = "A static value, or a one-shot thing." }, "JSDoc dash: desc only")
	t.eq(doc.params[2], { name = "count", type = "number", desc = "How many." }, "JSDoc dash: type and desc")
	t.eq(doc.returns[1], { type = "Node", desc = "The created node." }, "JSDoc dash on @return")

	t.suite("tags: placing")

	doc = tags.parse({ "@class Ledger", "Tracks entries." })
	t.eq(doc.placing, { kind = "class", name = "Ledger" }, "class placing")
	t.eq(doc.desc, "Tracks entries.", "prose after @class stays the description")

	doc = tags.parse({ "@within Ledger", "@prop entries { [string]: EntryKind }" })
	t.eq(doc.within, "Ledger", "within")
	t.eq(doc.placing, { kind = "prop", name = "entries" }, "prop placing")
	t.eq(doc.placingType, "{ [string]: EntryKind }", "prop type")

	doc = tags.parse({ "@prop Ledger.rows { RowShape } -- held rows" })
	t.eq(doc.within, "Ledger", "qualified prop within")
	t.eq(doc.placing, { kind = "prop", name = "rows" }, "qualified prop name")
	t.eq(doc.placingType, "{ RowShape }", "qualified prop type")
	t.eq(doc.placingDesc, "held rows", "qualified prop desc")

	doc = tags.parse({ "@function Color.Oklab.new" })
	t.eq(doc.within, "Color.Oklab", "nested qualified name splits at the last dot")
	t.eq(doc.placing, { kind = "function", name = "new" }, "nested qualified member name")

	doc = tags.parse({ "@method Color.Oklab:lighten" })
	t.eq(doc.within, "Color.Oklab", "nested colon spelling within")
	t.eq(doc.placing, { kind = "method", name = "lighten" }, "nested colon spelling member name")

	doc = tags.parse({ "@class Color.Oklab" })
	t.eq(doc.placing, { kind = "class", name = "Color.Oklab" }, "classes keep their dotted name")

	doc = tags.parse({ "@function fetch", "@method save" })
	t.eq(doc.placing, { kind = "function", name = "fetch" }, "first placing wins")
	t.eq(doc.diagnostics[1] and doc.diagnostics[1].code, "duplicate-placing-tag", "duplicate placing diagnostic")

	doc = tags.parse({ "@prop first number -- one", "@prop second string -- two" })
	t.eq(doc.placing, { kind = "prop", name = "first" }, "duplicate placing keeps the first")
	t.eq(doc.placingType, "number", "a rejected duplicate's type does not overwrite the kept placing's")
	t.eq(doc.placingDesc, "one", "a rejected duplicate's desc does not overwrite the kept placing's")

	doc = tags.parse({ "@function f", "@function Other.g" })
	t.eq(doc.within, nil, "a rejected duplicate's qualifier does not leak into within")

	t.suite("tags: interface + fields")

	doc = tags.parse({
		"@within Root",
		"@interface _K",
		".Store Store -- storage module",
		".Clock Clock",
		"@field Extras { [string]: any } -- extras",
		"@field Flags: Flags -- feature flags",
	})
	t.eq(doc.placing, { kind = "interface", name = "_K" }, "interface placing")
	t.eq(doc.fields[1], { name = "Store", type = "Store", desc = "storage module" }, "dot field")
	t.eq(doc.fields[2], { name = "Clock", type = "Clock" }, "dot field no desc")
	t.eq(doc.fields[3], { name = "Extras", type = "{ [string]: any }", desc = "extras" }, "@field tag")
	t.eq(
		doc.fields[4],
		{ name = "Flags", type = "Flags", desc = "feature flags" },
		"trailing colon on field name tolerated"
	)

	doc = tags.parse({
		"@interface Options",
		".timeout number",
		"",
		".retries number -- how many",
		"",
		".name string",
	})
	t.eq(#doc.fields, 3, "blank lines between dot-field groups do not end the list")
	t.eq(doc.fields[2], { name = "retries", type = "number", desc = "how many" }, "post-blank dot field parses whole")
	t.eq(doc.desc, "", "grouped dot fields leave no prose behind")

	t.suite("tags: metadata")

	doc = tags.parse({ "@yields", "@private", "@server", "@readonly" })
	t.eq(doc.flags, { yields = true, private = true, server = true, readonly = true }, "flags")

	doc = tags.parse({ "@deprecated v2.0.0 -- use fetchAsync instead" })
	t.eq(doc.deprecated, { version = "v2.0.0", desc = "use fetchAsync instead" }, "deprecated version+desc")

	doc = tags.parse({ "@deprecated -- gone soon" })
	t.eq(doc.deprecated, { desc = "gone soon" }, "deprecated desc only")

	doc = tags.parse({ "@since v0.5.1", "@tag beta", "@tag experimental" })
	t.eq(doc.since, "v0.5.1", "since")
	t.eq(doc.customTags, { "beta", "experimental" }, "custom tags")

	doc = tags.parse({ "@tag experimental -- drop when stable" })
	t.eq(doc.customTags, { "experimental" }, "@tag sheds a trailing comment like every data tag")

	doc = tags.parse({ "Wraps promises.", "@external Promise https://example.com/promise/", "@__index Impl" })
	t.eq(doc.desc, "Wraps promises.", "consumed tags never leak into prose")
	t.eq(
		doc.externals,
		{ { name = "Promise", url = "https://example.com/promise/", lineOffset = 2 } },
		"external parsed into name+url"
	)
	t.eq(#doc.diagnostics, 1, "ignored tags reported")
	t.eq(doc.diagnostics[1].code, "ignored-tag", "ignored tag code")
	t.eq(doc.diagnostics[1].severity, "info", "ignored tag severity")

	doc = tags.parse({ "@external Promise" })
	t.eq(#doc.externals, 0, "external without a url parses nothing")
	t.eq(doc.diagnostics[1] and doc.diagnostics[1].code, "malformed-tag", "external without a url is malformed")

	t.suite("tags: multi-line continuation")

	doc = tags.parse({ "@param options table -- configuration:", "extra line one", "extra line two" })
	t.eq(doc.params[1].desc, "configuration:\nextra line one\nextra line two", "continuation lines append to tag desc")

	doc =
		tags.parse({ "@param defer boolean -- skip the initial run", "", "[Open Documentation](https://example.com/)" })
	t.eq(doc.params[1].desc, "skip the initial run", "a blank line ends the tag desc")
	t.eq(doc.desc, "[Open Documentation](https://example.com/)", "post-blank prose rejoins the block description")

	doc = tags.parse({ "@yields extra junk" })
	t.eq(doc.flags.yields, true, "flag still set with junk arg")
	t.eq(doc.diagnostics[1] and doc.diagnostics[1].code, "unknown-tag-arg", "flag junk arg diagnostic")

	doc = tags.parse({ "@within X", "@function doThing", "Does a thing.", "@yields", "May wait." })
	t.eq(doc.desc, "Does a thing.\nMay wait.", "prose after non-continuable tags rejoins the description")
end

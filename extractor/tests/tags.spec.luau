local t = require("./harness")
local tags = require("../tags")

return function()
	t.suite("tags: prose")

	local doc = tags.parse({ "Line one", "", "Line two" })
	t.eq({ doc.desc, doc.placing }, { "Line one\n\nLine two", nil }, "prose joined with blank lines")

	doc = tags.parse({ "Credits to @alice and @bob_2x for testing" })
	t.eq(
		{ doc.desc, #doc.diagnostics },
		{ "Credits to @alice and @bob_2x for testing", 0 },
		"unknown @words stay prose"
	)

	doc = tags.parse({ "Example:", "```lua", "@param not_a_tag", "```" })
	t.eq({ #doc.params, doc.desc }, { 0, "Example:\n```lua\n@param not_a_tag\n```" }, "backtick fences")
	t.eq(#tags.parse({ "Example:", "~~~lua", "@param not_a_tag", "~~~" }).params, 0, "tilde fences")
	t.eq(#tags.parse({ "Example:", "```lua", "~~~", "@param not_a_tag", "```" }).params, 0, "mismatched fence closer")
	t.eq(#tags.parse({ "Example:", "", "    @param not_a_tag", "", "prose again" }).params, 0, "indented code block")
	t.eq(
		tags.parse({ "@interface Options", "    .timeout number -- t" }).fields,
		{ { name = "timeout", type = "number", desc = "t" } },
		"indented dot field directly under @interface"
	)

	t.suite("tags: param/return/error")

	doc = tags.parse({
		"Adds numbers",
		"@param x number -- the x value",
		"@param y -- described only",
		"@param z { [string]: number }",
		"@param ... any -- varargs",
	})
	t.eq(doc.desc, "Adds numbers", "desc before tags")
	t.eq(doc.params, {
		{ name = "x", type = "number", desc = "the x value" },
		{ name = "y", desc = "described only" },
		{ name = "z", type = "{ [string]: number }" },
		{ name = "...", type = "any", desc = "varargs" },
	}, "param forms")

	t.eq(
		tags.parse({
			"@param handler: () -> any | nil -- The function to run",
			"@param ...: any? -- Additional arguments",
		}).params,
		{
			{ name = "handler", type = "() -> any | nil", desc = "The function to run" },
			{ name = "...", type = "any?", desc = "Additional arguments" },
		},
		"trailing colons on param names"
	)

	doc = tags.parse({
		"@param obj - A static value, or a one-shot thing.",
		"@param count number - How many.",
		"@return string -- the name",
		"@return number",
		"@return Node - The created node.",
		"@error string -- when missing",
	})
	t.eq(doc.params, {
		{ name = "obj", desc = "A static value, or a one-shot thing." },
		{ name = "count", type = "number", desc = "How many." },
	}, "JSDoc dash params")
	t.eq(doc.returns, {
		{ type = "string", desc = "the name" },
		{ type = "number" },
		{ type = "Node", desc = "The created node." },
	}, "returns")
	t.eq(doc.errors, { { type = "string", desc = "when missing" } }, "errors")

	t.suite("tags: placing")

	doc = tags.parse({ "@class Ledger", "Tracks entries." })
	t.eq({ doc.placing, doc.desc }, { { kind = "class", name = "Ledger" }, "Tracks entries." }, "class placing")

	doc = tags.parse({ "@within Ledger", "@prop entries { [string]: EntryKind }" })
	t.eq(
		{ doc.within, doc.placing, doc.placingType },
		{ "Ledger", { kind = "prop", name = "entries" }, "{ [string]: EntryKind }" },
		"explicit within + prop"
	)

	doc = tags.parse({ "@prop Ledger.rows { RowShape } -- held rows" })
	t.eq(
		{ doc.within, doc.placing, doc.placingType, doc.placingDesc },
		{ "Ledger", { kind = "prop", name = "rows" }, "{ RowShape }", "held rows" },
		"qualified prop"
	)

	doc = tags.parse({ "@function Color.Oklab.new" })
	t.eq({ doc.within, doc.placing }, { "Color.Oklab", { kind = "function", name = "new" } }, "nested dot function")

	doc = tags.parse({ "@method Color.Oklab:lighten" })
	t.eq({ doc.within, doc.placing }, { "Color.Oklab", { kind = "method", name = "lighten" } }, "nested colon method")

	t.eq(tags.parse({ "@class Color.Oklab" }).placing, { kind = "class", name = "Color.Oklab" }, "dotted class name")

	doc = tags.parse({ "@function fetch", "@method save" })
	t.eq(
		{ doc.placing, doc.diagnostics[1].code },
		{ { kind = "function", name = "fetch" }, "duplicate-placing-tag" },
		"duplicate placing tag"
	)

	doc = tags.parse({ "@prop first number -- one", "@prop second string -- two" })
	t.eq(
		{ doc.placing, doc.placingType, doc.placingDesc },
		{ { kind = "prop", name = "first" }, "number", "one" },
		"duplicate prop keeps first type and desc"
	)
	t.eq(tags.parse({ "@function f", "@function Other.g" }).within, nil, "rejected duplicate qualifier dropped")

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
	t.eq(doc.fields, {
		{ name = "Store", type = "Store", desc = "storage module" },
		{ name = "Clock", type = "Clock" },
		{ name = "Extras", type = "{ [string]: any }", desc = "extras" },
		{ name = "Flags", type = "Flags", desc = "feature flags" },
	}, "dot fields and @field tags")

	doc = tags.parse({ "@interface Options", ".timeout number", "", ".retries number -- how many", "", ".name string" })
	t.eq(
		{ #doc.fields, doc.fields[2], doc.desc },
		{ 3, { name = "retries", type = "number", desc = "how many" }, "" },
		"blank lines inside dot-field list"
	)

	t.suite("tags: metadata and continuation")

	t.eq(
		tags.parse({ "@yields", "@private", "@server", "@readonly" }).flags,
		{ yields = true, private = true, server = true, readonly = true },
		"flags"
	)
	t.eq(
		tags.parse({ "@deprecated v2.0.0 -- use fetchAsync instead" }).deprecated,
		{ version = "v2.0.0", desc = "use fetchAsync instead" },
		"deprecated version+desc"
	)
	t.eq(tags.parse({ "@deprecated -- gone soon" }).deprecated, { desc = "gone soon" }, "deprecated desc only")

	doc = tags.parse({ "@since v0.5.1", "@tag beta", "@tag experimental -- drop when stable" })
	t.eq({ doc.since, doc.customTags }, { "v0.5.1", { "beta", "experimental" } }, "since + custom tags")

	doc = tags.parse({ "Wraps promises.", "@external Promise https://example.com/promise/", "@__index Impl" })
	t.eq(doc.desc, "Wraps promises.", "consumed tags excluded from prose")
	t.eq(doc.externals, { { name = "Promise", url = "https://example.com/promise/", lineOffset = 2 } }, "externals")
	t.eq(
		{ #doc.diagnostics, doc.diagnostics[1].code, doc.diagnostics[1].severity },
		{ 1, "ignored-tag", "info" },
		"ignored tag"
	)

	doc = tags.parse({ "@external Promise" })
	t.eq({ #doc.externals, doc.diagnostics[1].code }, { 0, "malformed-tag" }, "malformed @external")

	doc = tags.parse({ "@param options table -- configuration:", "extra line one", "extra line two" })
	t.eq(doc.params[1].desc, "configuration:\nextra line one\nextra line two", "continuation lines")

	doc =
		tags.parse({ "@param defer boolean -- skip the initial run", "", "[Open Documentation](https://example.com/)" })
	t.eq(
		{ doc.params[1].desc, doc.desc },
		{ "skip the initial run", "[Open Documentation](https://example.com/)" },
		"blank line ends continuation"
	)

	doc = tags.parse({ "@yields extra junk" })
	t.eq({ doc.flags.yields, doc.diagnostics[1].code }, { true, "unknown-tag-arg" }, "flag junk arg")

	doc = tags.parse({ "@within X", "@function doThing", "Does a thing.", "@yields", "May wait." })
	t.eq(doc.desc, "Does a thing.\nMay wait.", "prose after non-continuable tags")
end

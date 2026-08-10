local t = require("./harness")
local parseMod = require("../parse")
local comments = require("../comments")

return function()
	t.suite("comments: segmentation")

	local parsed = t.parse(table.concat({
		"--!strict",
		"-- plain chatter",
		"",
		"--- Module doc A",
		"--- Module doc B",
		"",
		"--- Attached to M",
		"local M = {}",
		"",
		"return M",
	}, "\n"))
	local blocks = comments.segment(parsed)

	-- doc-ness is the only classification: `--!` and the chatter below it join
	-- into one inert non-doc run, while the `---` lines form their own block
	t.eq(#blocks, 3, "three blocks (non-doc run, doc run, doc)")
	t.eq(blocks[1].doc, false, "hot + chatter run is not doc")
	t.eq(blocks[2].doc, true, "doc run is doc")
	t.eq(blocks[2].content, { "Module doc A", "Module doc B" }, "doc run content, delimiters stripped")
	t.eq(blocks[2].span.endLine + 1, 6, "doc run attach line (blank line below -> floats)")
	t.eq(blocks[3].content, { "Attached to M" }, "attached doc content")
	t.eq(blocks[3].span.endLine + 1, 8, "attached doc attach line")

	t.suite("comments: divider and block comments")

	parsed = t.parse(table.concat({
		"---------------------------------",
		"-- section divider above",
		"--[[",
		"	local commentedOut = true",
		"]]",
		"--[=[",
		"	Real doc block",
		"	@param x number",
		"]=]",
		"local function f(x) end",
		"return f",
	}, "\n"))
	blocks = comments.segment(parsed)

	local docBlocks = {}
	for _, b in blocks do
		if b.doc then
			table.insert(docBlocks, b)
		end
	end
	t.eq(#docBlocks, 2, "both --[[ and --[=[ blocks are doc")
	t.eq(docBlocks[1].content, { "local commentedOut = true" }, "--[[ block content dedented")
	t.eq(docBlocks[2].content, { "Real doc block", "@param x number" }, "block content dedented")
	t.eq(docBlocks[2].span.endLine + 1, 10, "block attach line")

	parsed = t.parse(table.concat({
		"--[[",
		"	Module overview prose.",
		"	More prose.",
		"--]]",
		"local function g() end",
		"return g",
	}, "\n"))
	blocks = comments.segment(parsed)
	t.eq(blocks[1].doc, true, "--[[ block with --]] closer is doc")
	t.eq(blocks[1].content, { "Module overview prose.", "More prose." }, "--]] closer stripped from content")

	t.suite("comments: claims + attributes")

	parsed = t.parse(table.concat({
		"--- doc for f",
		"@native",
		"local function f(x: number): number",
		"	return x",
		"end",
		"return f",
	}, "\n"))
	blocks = comments.segment(parsed)
	local index = comments.claimIndex(blocks)
	local stat = parsed.cst.root.statements[1]
	local startLine = parseMod.effectiveStartLine(stat)
	t.eq(startLine, 2, "effective start includes @native attribute line")
	local claimed = comments.claim(index, startLine)
	t.ok(claimed ~= nil, "doc block claimed through attribute")
	t.eq(claimed and claimed.content, { "doc for f" }, "claimed content")

	t.suite("comments: trailing text")

	parsed = t.parse(table.concat({
		"local M = {",
		"	value = 1, -- the value field",
		"	other = 2,",
		"	block = 3, --[[ block trailer ]]",
		"	blank = 4, --[[   ]]",
		"}",
		"return M",
	}, "\n"))
	local trailing = comments.trailingIndex(parsed)
	t.eq(comments.trailingText(trailing, 2), "the value field", "trailing comment text")
	t.eq(comments.trailingText(trailing, 3), nil, "no trailing comment")
	t.eq(comments.trailingText(trailing, 4), "block trailer", "block-comment trailer text")
	t.eq(comments.trailingText(trailing, 5), nil, "whitespace-only block trailer is no description")

	t.suite("comments: module doc")

	parsed = t.parse(table.concat({
		"--!strict",
		"",
		"--- Standalone module doc",
		"",
		"--- Doc for M",
		"local M = {}",
		"return M",
	}, "\n"))
	blocks = comments.segment(parsed)
	index = comments.claimIndex(blocks)
	comments.claim(index, parseMod.effectiveStartLine(parsed.cst.root.statements[1]))
	local moduleDoc = comments.moduleDoc(blocks, parsed.cst.root.statements[1].location.beginLine)
	t.ok(moduleDoc ~= nil, "module doc found")
	t.eq(moduleDoc and moduleDoc.content, { "Standalone module doc" }, "module doc is the detached block")

	t.suite("comments: eof")

	-- a doc block past the last statement must still segment, and stay unclaimed
	-- so the floating pass can place it
	parsed = t.parse(table.concat({
		"--- doc for f",
		"local function f() end",
		"return f",
		"--- floating doc past the last statement",
	}, "\n"))
	blocks = comments.segment(parsed)
	index = comments.claimIndex(blocks)
	t.eq(#blocks, 2, "eof doc block is segmented")
	t.eq(blocks[2].content, { "floating doc past the last statement" }, "eof block content")
	for _, stat in parsed.cst.root.statements do
		comments.claim(index, parseMod.effectiveStartLine(stat))
	end
	t.ok(blocks[1].claimed, "the pre-statement doc is claimed")
	t.ok(not blocks[2].claimed, "the eof doc stays floating")

	t.suite("comments: token shape parse.luau's walk assumes")

	-- parse.collectComments stops descending at a token, harvesting only the two
	-- trivia lists. That holds exactly while a token's table children are those
	-- two plus `location`, and trivia hold no tokens of their own. A Lute bump
	-- breaking either would silently drop comments reachable only that way (the
	-- member just documents as undocumented), so the assumption is pinned here.
	parsed = t.parse(table.concat({
		"--- doc",
		"--[=[ long ]=]",
		"local function f(a: string): number -- trailer",
		"	return #a",
		"end",
		"return f",
	}, "\n"))

	-- through the real walk, so this pins the shape collectComments sees
	local tokens, offenders, nestedInTrivia = 0, {}, 0
	parseMod.walkNodes(parsed.cst, function(node)
		if node.kind ~= "token" then
			return true
		end
		tokens += 1
		for key, v in node do
			if type(v) == "table" and key ~= "leadingTrivia" and key ~= "trailingTrivia" and key ~= "location" then
				table.insert(offenders, tostring(key))
			end
		end
		for _, list in { node.leadingTrivia, node.trailingTrivia } do
			for _, tr in list or {} do
				for _, v in tr do
					if type(v) == "table" and v.kind == "token" then
						nestedInTrivia += 1
					end
				end
			end
		end
		return false
	end)

	t.ok(tokens > 0, "the walk actually reached tokens")
	t.eq(offenders, {}, "a token's only table children are leadingTrivia, trailingTrivia and location")
	t.eq(nestedInTrivia, 0, "trivia hold no tokens of their own")
	t.eq(#parsed.comments, 3, "and all three comments were collected")
end

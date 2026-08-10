--- Seam over Lute's @std/syntax/parser. Every CST access quirk lives here:
---   * spans are 1-based {beginLine, beginColumn, endLine, endColumn}
---   * comments are trivia on tokens: leadingTrivia of the next token, or
---     trailingTrivia of the last token on the line for same-line comments
---   * trivia text includes delimiters ("--- x", "--[=[ .. ]=]"), no newline
---   * EOF comments hang off cst.eof.leadingTrivia
---   * statement tags are lowercase: local, function, localfunction, assign,
---     typealias, return, expression, ...
---   * function attributes: stat.func.attributes[i] = {kind="attribute", token, location}

local parser = require("@std/syntax/parser")
local util = require("./util")

export type Span = { beginLine: number, beginColumn: number, endLine: number, endColumn: number }

export type Comment = {
	kind: "line" | "block",
	text: string, -- raw, including delimiters
	span: Span,
	trailing: boolean, -- sits after code on its line
}

export type Parsed = {
	cst: any, -- CstParseResult
	lines: { string }, -- 1-based
	comments: { Comment }, -- source order
}

local parse = {}

--- `visit` returns false to stop descending into the node it was handed.
--- Lute's CST shares nodes, so `seen` is what makes the walk terminate;
--- `location` is skipped as a 4-number span no caller wants.
function parse.walkNodes(root: any, visit: (node: any) -> boolean?)
	local seen = {}
	local function walk(node: any)
		if type(node) ~= "table" or seen[node] then
			return
		end
		seen[node] = true
		if visit(node) == false then
			return
		end
		for key, v in node do
			if key ~= "location" and type(v) == "table" then
				walk(v)
			end
		end
	end
	walk(root)
end

--- Lute spells a table-type entry's kind as `tag` on some nodes and `kind` on
--- others. Absorbed here with the rest of the syntax-tree handling, so a shape
--- change lands in one place rather than in every walk that reads entries.
function parse.isTypeProperty(entry: any): boolean
	return (entry.tag or entry.kind) == "property"
end

local function collectComments(cstResult: any): { Comment }
	local out: { Comment } = {}

	local function addTrivia(list: any, trailing: boolean)
		if type(list) ~= "table" then
			return
		end
		for _, tr in list do
			if tr.tag == "comment" or tr.tag == "blockcomment" then
				table.insert(out, {
					kind = if tr.tag == "comment" then "line" else "block",
					text = tr.text,
					span = tr.location,
					trailing = trailing,
				})
			end
		end
	end

	parse.walkNodes(cstResult, function(node)
		if node.kind ~= "token" then
			return true
		end
		addTrivia(node.leadingTrivia, false)
		addTrivia(node.trailingTrivia, true)
		-- a token's only table children are the trivia just harvested
		return false
	end)
	table.sort(out, function(a, b)
		if a.span.beginLine ~= b.span.beginLine then
			return a.span.beginLine < b.span.beginLine
		end
		return a.span.beginColumn < b.span.beginColumn
	end)
	return out
end

--- Returns (Parsed, nil) or (nil, errorMessage); never both.
function parse.parse(source: string): (Parsed?, string?)
	local ok, result = pcall(parser.parse, source)
	if not ok then
		return nil, tostring(result)
	end
	return {
		cst = result,
		lines = util.splitLines(source),
		comments = collectComments(result),
	}, nil
end

local function attributesOf(stat: any): { any }
	if stat == nil then
		return {}
	end
	local fn = stat.func
	if type(fn) == "table" and type(fn.attributes) == "table" then
		return fn.attributes
	end
	return {}
end

--- The line a statement effectively starts on. Leading attributes (`@native`)
--- count as part of it, so doc-comment adjacency is measured against the
--- attribute line, not the `function` line.
function parse.effectiveStartLine(stat: any): number
	local line = stat.location.beginLine
	for _, attr in attributesOf(stat) do
		if attr.location and attr.location.beginLine < line then
			line = attr.location.beginLine
		end
	end
	return line
end

return parse

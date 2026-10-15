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
--- Lute's CST shares nodes, so `seen` keeps the walk from looping;
--- `location` is skipped because it is a 4-number span table no caller needs to visit.
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

--- Lute spells a table-type entry's discriminator as `tag` on some nodes and `kind`
--- on others. Centralizing the check here keeps CST quirks out of individual walkers.
function parse.isTypeProperty(entry: any): boolean
	return (entry.tag or entry.kind) == "property"
end

--- Steps past parentheses and explicit type instantiations (`f<<T>>`) to the
--- wrapped expression; `includeCast` also steps through `:: T` assertions.
function parse.unwrapExpr(node: any, includeCast: boolean?): any
	while node ~= nil do
		if node.tag == "group" then
			node = node.expression
		elseif node.tag == "instantiate" then
			node = node.expr
		elseif includeCast and node.tag == "cast" then
			node = node.operand
		else
			break
		end
	end
	return node
end

--- Steps past parenthesized `(T)` groups and Lute's postfix-`?` union wrapper
--- (`union` of `T` and a trailing `optional` token) to the underlying type.
function parse.unwrapType(node: any): any
	while node ~= nil do
		if node.tag == "group" then
			node = node.type
		elseif
			node.tag == "union"
			and node.types ~= nil
			and #node.types == 2
			and node.types[2].node ~= nil
			and node.types[2].node.tag == "optional"
		then
			node = node.types[1].node
		else
			break
		end
	end
	return node
end

--- Lute sets an explicit typepack default's `.location` to its opening `(`
--- alone; `closeParens` holds the real end of the span.
function parse.typeSpan(typeNode: any): Span?
	if typeNode == nil or typeNode.location == nil then
		return nil
	end
	local span: Span = typeNode.location
	local close = if typeNode.kind == "typepack" and typeNode.closeParens ~= nil
		then typeNode.closeParens.location
		else nil
	if
		close ~= nil
		and (close.endLine > span.endLine or (close.endLine == span.endLine and close.endColumn > span.endColumn))
	then
		return {
			beginLine = span.beginLine,
			beginColumn = span.beginColumn,
			endLine = close.endLine,
			endColumn = close.endColumn,
		}
	end
	return span
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
		-- A token's only table children are the trivia lists harvested above.
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

--- Formats a Lute parser error for user-facing diagnostics. Lute raises errors
--- from inside `@std/syntax` (`@std/syntax/parser.luau:22: parsing failed:`),
--- followed by one `(L, C) - (L, C): message` line per error with 0-based
--- positions. Strip the internal `@std/syntax` prefix, convert positions to
--- 1-based `L:C`, and return the first error's line number for the diagnostic.
local function describeParseError(raw: string): (string, number?)
	local body = raw:match("parsing failed:%s*(.*)$") or raw:gsub("^[^\n]-:%d+: ", "")
	local lines: { string } = {}
	local first: number? = nil
	for _, text in util.splitLines(body) do
		local line, column, message = text:match("^%((%d+), (%d+)%) %- %(%d+, %d+%): (.*)$")
		if line ~= nil then
			local oneBased = tonumber(line) :: number + 1
			first = first or oneBased
			table.insert(lines, string.format("%d:%d: %s", oneBased, tonumber(column) :: number + 1, message))
		elseif util.trim(text) ~= "" then
			table.insert(lines, text)
		end
	end
	return table.concat(lines, "\n"), first
end

--- Returns `(Parsed, nil)` or `(nil, errorMessage, line?)`; never both.
function parse.parse(source: string): (Parsed?, string?, number?)
	local ok, result = pcall(parser.parse, source)
	if not ok then
		return nil, describeParseError(tostring(result))
	end
	return {
		cst = result,
		lines = util.splitLines(source),
		comments = collectComments(result),
	}, nil
end

--- Returns the line a statement effectively starts on. Leading attributes
--- (`@native`, `@[...]`) count as part of the statement, so doc-comment
--- adjacency is measured against the first attribute line rather than the
--- `function` keyword line. Lute stores a bracketed attribute list's opening
--- `@[` in the first attribute token's `leadingTrivia`.
function parse.effectiveStartLine(stat: any): number
	local line = stat.location.beginLine
	local attrs = if stat ~= nil and type(stat.func) == "table" then stat.func.attributes else nil
	local first = if type(attrs) == "table" then attrs[1] else nil
	if first ~= nil then
		if first.location and first.location.beginLine < line then
			line = first.location.beginLine
		end
		for _, tr in (if first.token ~= nil then first.token.leadingTrivia else nil) or {} do
			if tr.text ~= nil and tr.text:sub(1, 2) == "@[" and tr.location.beginLine < line then
				line = tr.location.beginLine
				break
			end
		end
	end
	return line
end

return parse

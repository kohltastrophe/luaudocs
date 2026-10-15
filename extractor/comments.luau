--- Doc-comment model: segments the flat comment index into blocks, decides
--- which blocks are doc-eligible, and answers "which block documents the
--- statement starting at line N" via pure line math.
---
--- Rules (Moonwave-compatible, plus `--[[ ]]`):
---   * `--- text` line runs are doc comments; `----`+ dividers, `--!` hot
---     comments, `--#` directives, and plain `--` comments are not
---   * both `--[=[ ]=]` and `--[[ ]]` blocks count (Moonwave accepts only
---     `--[=[ ]=]`; attachment still requires sitting directly above a statement)
---   * a doc block documents a statement iff it ends on the line directly
---     above the statement's effective start (attributes included)
---   * unclaimed doc blocks "float"; blocks with placing tags create members
---     explicitly in the model stage, and the rest are ignored

local parseMod = require("./parse")
local util = require("./util")

type Span = parseMod.Span
type Parsed = parseMod.Parsed

--- Maps a source line number to the first trailing comment on that line.
export type TrailingIndex = { [number]: parseMod.Comment }

export type DocBlock = {
	doc: boolean,
	content: { string }, -- delimiter-stripped, dedented (doc blocks only)
	span: Span,
	contentLine: number, -- physical source line of content[1]
	claimed: boolean,
}

local comments = {}

--- Matches `--- doc` lines only; `----`+ dividers, `--!` hot comments, `--#`
--- directives, and plain `--` comments are non-doc and merge into inert runs.
local function isDocLine(text: string): boolean
	return text:match("^%-%-%-") ~= nil and text:match("^%-%-%-%-") == nil
end

local function docLineContent(text: string): string
	local stripped = text:gsub("^%-%-%- ?", "")
	return stripped
end

--- Extracts a block comment's lines and returns the count of leading blank
--- lines dropped so callers can map content indices back to source lines.
local function blockContent(text: string): ({ string }, number)
	local eq, rest = text:match("^%-%-%[(=*)%[(.*)$")
	if rest == nil then
		return {}, 0
	end
	local closing = "]" .. eq .. "]"
	if rest:sub(-#closing) == closing then
		rest = rest:sub(1, #rest - #closing)
		-- A `--` abutting the closing bracket belongs to a `--]]`-style closer,
		-- not to the content; content ending in `--` is separated by whitespace.
		if rest:sub(-2) == "--" then
			rest = rest:sub(1, -3)
		end
	end
	local lines = util.splitLines(rest)
	-- Text on the opener line (`--[=[ Summary.`) sits after the opening bracket
	-- rather than at the body's indentation. If included in `dedent`, its zero
	-- leading indent would prevent the body from dedenting (turning an indented
	-- `@param` into an indented code block), so set it aside trimmed first.
	local opener: string? = nil
	if util.trim(lines[1]) ~= "" then
		opener = util.trim(table.remove(lines, 1) :: string)
	end
	-- Drop leading blank lines so `dedent` measures only the body.
	local dropped = 0
	while opener == nil and #lines > 0 and util.trim(lines[1]) == "" do
		table.remove(lines, 1)
		dropped += 1
	end
	local content = util.dedent(lines)
	if opener ~= nil then
		table.insert(content, 1, opener)
	end
	content = util.trimEmptyLines(content)
	-- Trim delimiter padding before a closer on the last line (`x ]]`).
	if #content > 0 then
		content[#content] = (content[#content]:gsub("%s+$", ""))
	end
	return content, dropped
end

--- Segments all non-trailing comments into blocks in source order.
function comments.segment(parsed: Parsed): { DocBlock }
	local blocks: { DocBlock } = {}
	local run: DocBlock? = nil
	local runDoc: boolean? = nil

	local function flush()
		if run ~= nil then
			table.insert(blocks, run)
			run = nil
		end
	end

	for _, c in parsed.comments do
		if c.trailing then
			continue
		end
		if c.kind == "block" then
			flush()
			-- Code after the closer (`--[[ x ]] local a = 1`) makes this an
			-- inline comment; attaching it would wrongly document the statement
			-- on the next line. A trailing comment (`--[[ x ]] -- todo`) is not code.
			local closerLine = parsed.lines[c.span.endLine]
			local after = if closerLine ~= nil then closerLine:sub(c.span.endColumn) else ""
			local codeFollows = after:match("%S") ~= nil and after:match("^%s*%-%-") == nil
			local isDoc = not codeFollows
			local content: { string }, droppedLeading = {}, 0
			if isDoc then
				content, droppedLeading = blockContent(c.text)
			end
			table.insert(blocks, {
				doc = isDoc,
				content = content,
				span = table.clone(c.span),
				contentLine = c.span.beginLine + droppedLeading,
				claimed = false,
			})
		else
			local isDoc = isDocLine(c.text)
			local current = run
			if current ~= nil and runDoc == isDoc and c.span.beginLine == current.span.endLine + 1 then
				current.span.endLine = c.span.endLine
				current.span.endColumn = c.span.endColumn
				if isDoc then
					table.insert(current.content, docLineContent(c.text))
				end
			else
				flush()
				runDoc = isDoc
				run = {
					doc = isDoc,
					content = if isDoc then { docLineContent(c.text) } else {},
					span = table.clone(c.span),
					contentLine = c.span.beginLine,
					claimed = false,
				}
			end
		end
	end
	flush()
	return blocks
end

--- Maps the line directly below each doc block (`endLine + 1`) to the block itself.
function comments.claimIndex(blocks: { DocBlock }): { [number]: DocBlock }
	local index = {}
	for _, block in blocks do
		if block.doc then
			index[block.span.endLine + 1] = block
		end
	end
	return index
end

--- Claims and returns the doc block directly above `startLine`, if any. Each
--- block can be claimed only once so a table field on the same line as its
--- enclosing statement cannot duplicate the statement's doc block.
function comments.claim(index: { [number]: DocBlock }, startLine: number): DocBlock?
	local block = index[startLine]
	if block ~= nil and not block.claimed then
		block.claimed = true
		return block
	end
	return nil
end

--- Maps each source line to its first trailing comment.
function comments.trailingIndex(parsed: Parsed): TrailingIndex
	local index: TrailingIndex = {}
	for _, c in parsed.comments do
		if c.trailing and index[c.span.beginLine] == nil then
			index[c.span.beginLine] = c
		end
	end
	return index
end

--- Returns the trailing comment text on `line` as a fallback description for
--- table fields and table-type fields; trailing comments never document statements.
function comments.trailingText(index: TrailingIndex, line: number): string?
	local c = index[line]
	if c == nil then
		return nil
	end
	if c.kind == "line" then
		local text = c.text:gsub("^%-%-%-? ?", "")
		return util.trim(text)
	end
	local content = blockContent(c.text)
	-- Empty content means a whitespace-only `--[[ ]]` trailer.
	if #content == 0 then
		return nil
	end
	return util.trim(table.concat(content, " "))
end

--- Returns the leading module doc block: the first unclaimed doc block ending
--- before the first statement. (A doc block attached to the statement that
--- defines the returned module table also acts as the module doc; the model
--- stage handles that case.)
function comments.moduleDoc(blocks: { DocBlock }, firstStatLine: number?): DocBlock?
	for _, block in blocks do
		if firstStatLine ~= nil and block.span.beginLine >= firstStatLine then
			break
		end
		if block.doc and not block.claimed then
			return block
		end
	end
	return nil
end

return comments

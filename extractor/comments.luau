--- Doc-comment model: segments the flat comment index into blocks, decides
--- which are doc-eligible, and answers "which block documents the statement
--- starting at line N" via pure line math.
---
--- Rules (moonwave-compatible, plus `--[[ ]]`):
---   * `--- text` line runs are doc comments; `----`+ dividers, `--!` hot
---     comments, `--#` directives and plain `--` chatter are not
---   * both `--[=[ ]=]` and `--[[ ]]` blocks count (moonwave accepts only the
---     former; attachment still requires sitting directly above a statement)
---   * a doc block documents a statement iff it ends on the line directly
---     above the statement's effective start (attributes included)
---   * unclaimed doc blocks "float"; ones with placing tags create members
---     explicitly (model stage), the rest are ignored

local parseMod = require("./parse")
local util = require("./util")

type Span = parseMod.Span
type Parsed = parseMod.Parsed

--- Line -> the trailing comment on it (the first, when a line somehow has two).
export type TrailingIndex = { [number]: parseMod.Comment }

export type DocBlock = {
	doc: boolean,
	content: { string }, -- delimiter-stripped, dedented (doc blocks only)
	span: Span,
	contentLine: number, -- physical source line of content[1]
	claimed: boolean,
}

local comments = {}

--- `--- doc` lines only; a `----`+ divider is the one lookalike. Everything
--- else (`--!` hot comments, `--#` directives, plain `--` chatter) is equally
--- non-doc, so adjacent non-doc lines join into one inert run.
local function isDocLine(text: string): boolean
	return text:match("^%-%-%-") ~= nil and text:match("^%-%-%-%-") == nil
end

local function docLineContent(text: string): string
	local stripped = text:gsub("^%-%-%- ?", "")
	return stripped
end

--- The second return counts leading physical lines dropped, so callers can map
--- content indexes back to source lines.
local function blockContent(text: string): ({ string }, number)
	local eq, rest = text:match("^%-%-%[(=*)%[(.*)$")
	if rest == nil then
		return {}, 0
	end
	local closing = "]" .. eq .. "]"
	if rest:sub(-#closing) == closing then
		rest = rest:sub(1, #rest - #closing)
		-- a `--` abutting the bracket belongs to a `--]]`-style closer, not to
		-- the content; content really ending in `--` is separated by whitespace
		if rest:sub(-2) == "--" then
			rest = rest:sub(1, -3)
		end
	end
	local lines = util.splitLines(rest)
	-- leading blanks are dropped so dedent sees the body
	local dropped = 0
	while #lines > 0 and util.trim(lines[1]) == "" do
		table.remove(lines, 1)
		dropped += 1
	end
	return util.trimEmptyLines(util.dedent(lines)), dropped
end

--- Segments all non-trailing comments into blocks (source order).
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
			local eq = c.text:match("^%-%-%[(=*)%[")
			-- code after the closer (`--[[ x ]] local a = 1`) makes this an
			-- inline comment: attaching it would document the NEXT statement.
			-- A trailing comment (`--[[ x ]] -- todo`) is not code.
			local closerLine = parsed.lines[c.span.endLine]
			local after = if closerLine ~= nil then closerLine:sub(c.span.endColumn) else ""
			local codeFollows = after:match("%S") ~= nil and after:match("^%s*%-%-") == nil
			local isDoc = eq ~= nil and not codeFollows
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

--- The line directly below each doc block -> the block: a statement starting
--- there is what the block documents.
function comments.claimIndex(blocks: { DocBlock }): { [number]: DocBlock }
	local index = {}
	for _, block in blocks do
		if block.doc then
			index[block.span.endLine + 1] = block
		end
	end
	return index
end

--- Claims and returns the doc block directly above `startLine`, if any. A block
--- claims once: a later claimant (a table field sharing the statement's line)
--- gets nil rather than duplicating the prose onto a second owner.
function comments.claim(index: { [number]: DocBlock }, startLine: number): DocBlock?
	local block = index[startLine]
	if block ~= nil and not block.claimed then
		block.claimed = true
		return block
	end
	return nil
end

--- Source line -> trailing comment, the mirror of claimIndex.
function comments.trailingIndex(parsed: Parsed): TrailingIndex
	local index: TrailingIndex = {}
	for _, c in parsed.comments do
		if c.trailing and index[c.span.beginLine] == nil then
			index[c.span.beginLine] = c
		end
	end
	return index
end

--- Only a description fallback for table fields / table-type fields: a trailing
--- comment never documents a statement.
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
	-- empty means a whitespace-only `--[[ ]]` trailer: no description
	if #content == 0 then
		return nil
	end
	return util.trim(table.concat(content, " "))
end

--- The module doc: the first unclaimed doc block ending before the first
--- statement. (A block attached to the statement that *defines the returned
--- module table* also doubles as module doc; the model stage decides that.)
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

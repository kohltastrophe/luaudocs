--- Type displays as segment arrays: plain text interleaved with reference
--- segments, cut from the source slice at the CST's `reference` node positions.
--- The joined segment texts ARE the display, so nothing downstream tracks
--- offsets: inserting a doc-comment line is an array splice.
---
--- Display transforms apply to plain pieces only, which is equivalent to
--- transforming the whole string: a reference segment contains no whitespace
--- and no comment, so no collapsed run and no stripped comment ever crosses a
--- segment boundary.
---
--- Generic parameters in scope are demoted to plain text here, so resolution
--- needs no generics threading.

local parseMod = require("./parse")
local util = require("./util")
local comments = require("./comments")

type Parsed = parseMod.Parsed
type Span = parseMod.Span

--- A plain string, or a reference candidate. `__name`/`__prefix` are the
--- resolution keys (finalize rewrites refs to the wire `{ text, id? }` form);
--- `__tag` marks tag-authored refs, which resolution grants extra fallbacks;
--- `__scope` overrides the module a ref resolves in, for an inferred return
--- type spelled in the callee's file rather than the referencing member's.
export type Seg = string | { text: string, __name: string, __prefix: string?, __tag: boolean?, __scope: string? }

export type Field = {
	name: string,
	type: { Seg }?,
	desc: string?,
	line: number?,
	docInDisplay: boolean?,
}

export type LineFacts = { [string]: { line: number?, docInDisplay: boolean } }

local segs = {}

--- The one reference-segment constructor. `text` is the display spelling (cut
--- verbatim from source wherever there is one), `__name`/`__prefix` the
--- resolution keys, so a segment minted from an inferred type resolves and
--- links exactly like one cut from a real annotation.
function segs.ref(text: string, name: string, prefix: string?, tag: boolean?): Seg
	return { text = text, __name = name, __prefix = prefix, __tag = tag }
end

function segs.text(list: { Seg }): string
	local parts = {}
	for _, seg in list do
		table.insert(parts, if type(seg) == "string" then seg else seg.text)
	end
	return table.concat(parts)
end

--- Spec-facing only: the model ships Seg arrays, and nothing but the specs
--- flattens a whole block back to text.
function segs.blockText(lines: { { Seg } }): string
	local parts = {}
	for _, line in lines do
		table.insert(parts, segs.text(line))
	end
	return table.concat(parts, "\n")
end

--- A reference's location begins at its prefix, and its spelled text is
--- `prefix.name`, not the node span (which covers generic arguments).
local function collectRefs(typeNode: any): { { name: string, prefix: string?, line: number, column: number } }
	local found = {}
	parseMod.walkNodes(typeNode, function(node)
		if node.kind == "token" then
			return false
		end
		if node.tag == "reference" and node.name ~= nil then
			table.insert(found, {
				name = node.name.text,
				prefix = if node.prefix ~= nil then node.prefix.text else nil,
				line = node.location.beginLine,
				column = node.location.beginColumn,
			})
		end
		return true
	end)
	table.sort(found, function(a, b)
		if a.line ~= b.line then
			return a.line < b.line
		end
		return a.column < b.column
	end)
	return found
end

--- No display transform yet; empty plain pieces are dropped as they arise.
local function cutLines(parsed: Parsed, typeNode: any, generics: { [string]: boolean }?): { { Seg } }
	local span: Span = typeNode.location
	local refs = collectRefs(typeNode)
	local refIndex = 1
	local out: { { Seg } } = {}
	for lineNo = span.beginLine, span.endLine do
		local lineText = parsed.lines[lineNo] or ""
		local startCol = if lineNo == span.beginLine then span.beginColumn else 1
		local endCol = if lineNo == span.endLine then span.endColumn - 1 else #lineText
		local trimmed = lineText:sub(startCol, endCol)
		local pieces: { Seg } = {}
		local cursor = 1
		while refIndex <= #refs and refs[refIndex].line == lineNo do
			local ref = refs[refIndex]
			refIndex += 1
			local spelled = if ref.prefix ~= nil then ref.prefix .. "." .. ref.name else ref.name
			local pos = ref.column - startCol + 1
			if pos < cursor or pos + #spelled - 1 > #trimmed then
				continue -- outside the slice (never in practice); keep it as plain text
			end
			if pos > cursor then
				table.insert(pieces, trimmed:sub(cursor, pos - 1))
			end
			if ref.prefix == nil and generics ~= nil and generics[ref.name] then
				table.insert(pieces, spelled)
			else
				table.insert(pieces, segs.ref(spelled, ref.name, ref.prefix))
			end
			cursor = pos + #spelled
		end
		if cursor <= #trimmed then
			table.insert(pieces, trimmed:sub(cursor))
		end
		table.insert(out, pieces)
	end
	return out
end

--- Clamped to the last index when the string never closes.
local function closingQuote(text: string, i: number): number
	local quote = text:sub(i, i)
	local n = #text
	local j = i + 1
	while j <= n do
		local cj = text:sub(j, j)
		if cj == "\\" then
			j += 2
		elseif cj == quote then
			break
		else
			j += 1
		end
	end
	return math.min(j, n)
end

--- Quote-aware: a `--` inside a string opens no comment, and a line comment's
--- terminating newline stays, since the collapse needs it. Long-bracket strings
--- are deliberately not recognized: `{ [string]: T }` opens with the same `[`,
--- and mistaking an indexer for a string would swallow the rest of the display.
local function stripComments(text: string): string
	local kept = {}
	local i = 1
	local n = #text
	while i <= n do
		local c = text:sub(i, i)
		if c == '"' or c == "'" then
			local j = closingQuote(text, i)
			table.insert(kept, text:sub(i, j))
			i = j + 1
		elseif c == "-" and text:sub(i + 1, i + 1) == "-" then
			local eq = text:match("^%[(=*)%[", i + 2)
			if eq ~= nil then
				local closeAt = text:find("]" .. eq .. "]", i + 2, true)
				i = if closeAt ~= nil then closeAt + #eq + 2 else n + 1
			else
				local nl = text:find("\n", i, true)
				i = if nl ~= nil then nl else n + 1
			end
		else
			table.insert(kept, c)
			i += 1
		end
	end
	return table.concat(kept)
end

--- Canonical form: refs separated by exactly zero or one plain piece. Ref
--- objects pass through by IDENTITY, which callers rely on: resolution writes
--- ids into the same tables the params/returns entries render from.
function segs.canonical(list: { Seg }): { Seg }
	local out: { Seg } = {}
	for _, seg in list do
		if type(seg) == "string" then
			if seg == "" then
				continue
			end
			local last = out[#out]
			if type(last) == "string" then
				out[#out] = last .. seg
			else
				table.insert(out, seg)
			end
		else
			table.insert(out, seg)
		end
	end
	return out
end

--- Lines of segments flattened to one list, `"\n"` between them: the one
--- spelling of the line-join glue.
local function joinLines(lines: { { Seg } }): { Seg }
	local flat: { Seg } = {}
	for lineIndex, line in lines do
		if lineIndex > 1 then
			table.insert(flat, "\n")
		end
		for _, piece in line do
			table.insert(flat, piece)
		end
	end
	return flat
end

--- One-line display for signature positions. nil when there is no annotation.
function segs.inline(parsed: Parsed, typeNode: any, generics: { [string]: boolean }?): { Seg }?
	if typeNode == nil or typeNode.location == nil then
		return nil
	end
	local flat = joinLines(cutLines(parsed, typeNode, generics))
	for i, seg in flat do
		if type(seg) == "string" then
			flat[i] = stripComments(seg)
		end
	end
	-- merge BEFORE collapsing: a whitespace run split across the line-join
	-- glue must become one space, not one per piece
	local out: { Seg } = segs.canonical(flat)
	for i, seg in out do
		if type(seg) == "string" then
			out[i] = (seg:gsub("%s+", " "))
		end
	end
	local first = out[1]
	if type(first) == "string" then
		out[1] = first:gsub("^%s+", "")
	end
	local last = out[#out]
	if type(last) == "string" then
		out[#out] = last:gsub("%s+$", "")
	end
	return segs.canonical(out)
end

--- The span cut verbatim, comments kept, blank lines dropped (they terminate
--- markdown-it's html_block downstream, so the renderer would strip them
--- anyway). The second return maps each source line to the display line it
--- landed on, so a field's rendered line is a lookup rather than a search.
function segs.block(
	parsed: Parsed,
	typeNode: any,
	generics: { [string]: boolean }?,
	declLine: number?
): ({ { Seg } }?, { [number]: number })
	if typeNode == nil or typeNode.location == nil then
		return nil, {}
	end
	local lines = cutLines(parsed, typeNode, generics)
	-- the first line starts mid-line (after "= "), so only the rest can
	-- dedent, and never by more than the declaration's own indentation: a
	-- nested decl loses its nesting, while a wrapped union's one-level
	-- continuation indent survives. A ref contains no whitespace, so the
	-- indent sits wholly in the first piece.
	if #lines > 1 then
		local texts = {}
		for i = 2, #lines do
			table.insert(texts, segs.text(lines[i]))
		end
		local prefix = util.commonIndent(texts)
		if declLine ~= nil and prefix ~= nil then
			local declIndent = ((parsed.lines[declLine] or ""):match("^[ \t]*")) :: string
			if prefix:sub(1, #declIndent) == declIndent then
				prefix = declIndent
			end
		end
		if prefix ~= nil and prefix ~= "" then
			for i = 2, #lines do
				local head = lines[i][1]
				if type(head) == "string" then
					lines[i][1] = head:sub(#prefix + 1)
				end
			end
		end
	end
	local head = lines[1] and lines[1][1]
	if type(head) == "string" then
		lines[1][1] = head:gsub("^%s+", "")
	end

	local out: { { Seg } } = {}
	local lineOf: { [number]: number } = {}
	for i, line in lines do
		local text = segs.text(line)
		if util.trim(text) ~= "" then
			table.insert(out, segs.canonical(line))
			lineOf[typeNode.location.beginLine + i - 1] = #out
		end
	end
	return out, lineOf
end

--- Segment list for a type string authored in a doc tag (`@param x Foo.Bar`).
--- No CST node exists for it, so the string is parsed as the right-hand side of
--- a type alias. Tag types are author prose and need not be valid Luau
--- (`number[]`, a bare `...`), so a rejected string falls back to a lexical
--- scan: identifiers become candidate refs, except one followed by `:`, which
--- is what a field key looks like and what a type never does.
---
--- Memoized, since each miss is a full Luau parse. Clones come back because
--- resolution writes ids per module.
local tagCache: { [string]: { Seg } } = {}

local function lexicalSegs(display: string): { Seg }
	local out: { Seg } = {}
	local cursor = 1
	local i = 1
	local n = #display
	while i <= n do
		local c = display:sub(i, i)
		if c == '"' or c == "'" then
			-- a quoted singleton spells text, never a reference
			i = closingQuote(display, i) + 1
		elseif c:match("[%a_]") ~= nil then
			local start, stop = display:find("^[%w_]+", i)
			local prefixText: string? = nil
			local name = display:sub(start :: number, stop :: number)
			-- `A.B` is one reference only if the dot sits between the two
			-- identifiers with nothing else around it
			if display:sub((stop :: number) + 1, (stop :: number) + 1) == "." then
				local s2, e2 = display:find("^[%a_][%w_]*", (stop :: number) + 2)
				if s2 ~= nil then
					prefixText = name
					name = display:sub(s2, e2 :: number)
					stop = e2
				end
			end
			local after = display:match("^%s*:", (stop :: number) + 1)
			if after == nil then
				if start :: number > cursor then
					table.insert(out, display:sub(cursor, (start :: number) - 1))
				end
				local spelled = if prefixText ~= nil then prefixText .. "." .. name else name
				table.insert(out, segs.ref(spelled, name, prefixText))
				cursor = (stop :: number) + 1
			end
			i = (stop :: number) + 1
		elseif c:match("%d") ~= nil then
			local _, stop = display:find("^[%w_%.]+", i)
			i = (stop :: number) + 1
		else
			i += 1
		end
	end
	if cursor <= n then
		table.insert(out, display:sub(cursor))
	end
	return segs.canonical(out)
end

local function cloneForTag(list: { Seg }, generics: { [string]: boolean }?): { Seg }
	local out: { Seg } = {}
	for _, seg in list do
		if type(seg) == "string" then
			table.insert(out, seg)
		elseif seg.__prefix == nil and generics ~= nil and generics[seg.__name] then
			table.insert(out, seg.text)
		else
			table.insert(out, segs.ref(seg.text, seg.__name, seg.__prefix, true))
		end
	end
	return segs.canonical(out)
end

function segs.fromTag(display: string, generics: { [string]: boolean }?): { Seg }
	local cached = tagCache[display]
	if cached == nil then
		local parsed = parseMod.parse("type _ = " .. display)
		if parsed ~= nil then
			local statements = parsed.cst.root.statements
			local stat = if #statements == 1 then statements[1] else nil
			if stat ~= nil and stat.tag == "typealias" and stat.type ~= nil then
				-- cut verbatim, no inline transforms: the display is the
				-- author's own tag text, spacing and all
				cached = segs.canonical(joinLines(cutLines(parsed, stat.type, nil)))
			end
		end
		cached = cached or lexicalSegs(display)
		tagCache[display] = cached :: { Seg }
	end
	return cloneForTag(cached :: { Seg }, generics)
end

--- Per-field docs and line facts for a table-type definition, in two tiers:
---   * the node's own table yields full field entries, CLAIMING each field's
---     leading doc block
---   * intersection/union operands (`Base & { ... }`) are PEEKED only, so a
---     `@field` tag naming such a property can still inject its doc while the
---     block stays free for a placing tag to claim
---
--- A name spelled twice goes line-less, and a second entry on an already-used
--- line is skipped: an injected comment sits above the whole line, so it could
--- only be mis-read as the first entry's doc.
---
--- The display block computed for the line map rides along as the third return.
function segs.fields(
	parsed: Parsed,
	typeNode: any,
	claimIndex: { [number]: comments.DocBlock },
	trailingIndex: comments.TrailingIndex,
	generics: { [string]: boolean }?,
	declLine: number?
): ({ Field }?, LineFacts, { { Seg } }?)
	local facts: LineFacts = {}
	if typeNode == nil or typeNode.location == nil then
		return nil, facts, nil
	end
	local blockLines, lineOf = segs.block(parsed, typeNode, generics, declLine)
	local fields: { Field } = {}
	local ambiguous: { [string]: boolean } = {}
	local usedLines: { [number]: boolean } = {}

	local function fact(name: string, keyLine: number, inDisplay: boolean)
		if ambiguous[name] then
			return
		end
		if facts[name] ~= nil then
			facts[name] = nil
			ambiguous[name] = true
			return
		end
		if usedLines[keyLine] then
			return
		end
		usedLines[keyLine] = true
		facts[name] = { line = lineOf[keyLine], docInDisplay = inDisplay }
	end

	local function gather(node: any, own: boolean)
		if node == nil then
			return
		end
		if node.tag == "table" and node.entries ~= nil then
			for _, entry in node.entries do
				if parseMod.isTypeProperty(entry) and entry.key ~= nil then
					local name = entry.key.text
					local keyLine = entry.key.location.beginLine
					if own then
						local desc: string? = nil
						local block = comments.claim(claimIndex, keyLine)
						if block ~= nil then
							desc = util.joinDesc(block.content)
						else
							desc = comments.trailingText(trailingIndex, keyLine)
						end
						local inDisplay = block ~= nil or trailingIndex[keyLine] ~= nil
						table.insert(fields, {
							name = name,
							type = segs.inline(parsed, entry.value, generics),
							desc = desc,
							line = lineOf[keyLine],
							docInDisplay = if inDisplay then true else nil,
						})
						fact(name, keyLine, inDisplay)
					else
						fact(name, keyLine, claimIndex[keyLine] ~= nil or trailingIndex[keyLine] ~= nil)
					end
				end
			end
		elseif (node.tag == "intersection" or node.tag == "union") and node.types ~= nil then
			for _, pair in node.types do
				gather(pair.node, false)
			end
		end
	end
	gather(typeNode, typeNode.tag == "table")
	return if #fields > 0 then fields else nil, facts, blockLines
end

--- The full name set is collected first, so a default referencing an earlier
--- parameter (`<K, V = K>`) comes out plain.
function segs.generics(
	parsed: Parsed,
	genericsList: any,
	packsList: any
): ({ { name: string, isPack: boolean, default: { Seg }? } }, { [string]: boolean })
	local names: { [string]: boolean } = {}
	local nodes: { { node: any, isPack: boolean } } = {}
	for _, list in { { genericsList, false }, { packsList, true } } do
		for _, pair in (list[1] :: any) or {} do
			local node = pair.node
			if node ~= nil and node.name ~= nil then
				names[node.name.text] = true
				table.insert(nodes, { node = node, isPack = list[2] :: any })
			end
		end
	end
	local out = {}
	for _, entry in nodes do
		table.insert(out, {
			name = entry.node.name.text,
			isPack = entry.isPack,
			default = if entry.node.default ~= nil then segs.inline(parsed, entry.node.default, names) else nil,
		})
	end
	return out, names
end

--- Structured `{name, type}` entries for a function node's parameter list,
--- vararg included, plus each entry's source line (what the trailing-comment
--- doc rule keys on).
function segs.paramEntries(
	parsedFile: any,
	fnNode: any,
	genericNames: { [string]: boolean }?
): ({ any }, { [number]: number })
	local params: { any } = {}
	local paramLines: { [number]: number } = {}
	for _, pair in fnNode.parameters or {} do
		local p = pair.node
		if p ~= nil and p.name ~= nil then
			table.insert(params, {
				name = p.name.text,
				type = segs.inline(parsedFile, p.annotation, genericNames),
			})
			local span = if p.annotation ~= nil then p.annotation.location else p.name.location
			if span ~= nil then
				paramLines[#params] = span.endLine
			end
		end
	end
	if fnNode.vararg ~= nil then
		local annotation = if fnNode.varargAnnotation ~= nil then fnNode.varargAnnotation.type else nil
		table.insert(params, {
			name = "...",
			type = segs.inline(parsedFile, annotation, genericNames),
		})
		local span = if annotation ~= nil then annotation.location else fnNode.vararg.location
		if span ~= nil then
			paramLines[#params] = span.endLine
		end
	end
	return params, paramLines
end

--- Appends the `(name: T, ...)` display of `params` onto `sig`. Segments move
--- in by identity, shared with the entries, so resolution writes the same ref
--- objects both render from.
function segs.pushParamList(sig: { Seg }, params: { any })
	table.insert(sig, "(")
	for i, p in params do
		if i > 1 then
			table.insert(sig, ", ")
		end
		table.insert(sig, p.name)
		if p.type ~= nil then
			table.insert(sig, ": ")
			table.move(p.type, 1, #p.type, #sig + 1, sig)
		end
	end
	table.insert(sig, ")")
end

--- Everything after the callee in a signature display (`<T>(x: T): T`), which
--- is the whole of what the doc model's `segs` field holds. Segments move in by
--- identity, as in pushParamList, so a resolved ref updates every render of it.
function segs.signature(generics: { any }, params: { any }, returnTail: { Seg }?): { Seg }
	local sig: { Seg } = {}
	local function pushType(list: { Seg })
		table.move(list, 1, #list, #sig + 1, sig)
	end
	if #generics > 0 then
		table.insert(sig, "<")
		for i, gp in generics do
			if i > 1 then
				table.insert(sig, ", ")
			end
			table.insert(sig, gp.name .. (if gp.isPack then "..." else ""))
			if gp.default ~= nil then
				table.insert(sig, " = ")
				pushType(gp.default)
			end
		end
		table.insert(sig, ">")
	end
	segs.pushParamList(sig, params)
	if returnTail ~= nil and segs.text(returnTail) ~= "" then
		table.insert(sig, ": ")
		pushType(returnTail)
	end
	return sig
end

return segs

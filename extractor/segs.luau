--- Type displays as segment arrays: plain text interleaved with reference
--- segments cut from the source slice at the CST's `reference` node positions.
--- The joined segment texts form the display directly, so nothing downstream
--- tracks character offsets: inserting a doc-comment line is a plain array splice.
---
--- Display transforms apply only to plain string pieces after `canonical` merges
--- adjacent runs across line breaks. That produces the same result as transforming
--- the joined string because a reference segment never contains whitespace or comments.
---
--- Generic parameters in scope are demoted to plain text here so type resolution
--- does not need to thread generic scopes.

local parseMod = require("./parse")
local util = require("./util")
local comments = require("./comments")

type Parsed = parseMod.Parsed
type Span = parseMod.Span

--- Either a plain string or a reference candidate. `__name` and `__prefix` are
--- the resolution keys (`finalize` rewrites reference segments to `{ text, id? }`);
--- `__tag` marks tag-authored references, which receive extra resolution fallbacks;
--- `__scope` overrides the module a reference resolves in for inferred return
--- types written in the callee's file rather than the referencing member's file.
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

--- Constructs a reference segment. `text` is the display spelling (sliced
--- verbatim from source when available), and `__name`/`__prefix` are the
--- resolution keys, so a segment synthesized from an inferred type resolves and
--- links identically to one sliced from a source annotation.
function segs.ref(text: string, name: string, prefix: string?, tag: boolean?): Seg
	return { text = text, __name = name, __prefix = prefix, __tag = tag }
end

function segs.text(list: { Seg }, from: number?): string
	local parts = {}
	for i = from or 1, #list do
		local seg = list[i]
		table.insert(parts, if type(seg) == "string" then seg else seg.text)
	end
	return table.concat(parts)
end

--- Flattens a multi-line segment block to a newline-joined string (used by test specs).
function segs.blockText(lines: { { Seg } }): string
	local parts = {}
	for _, line in lines do
		table.insert(parts, segs.text(line))
	end
	return table.concat(parts, "\n")
end

--- A reference's location starts at its prefix, and its spelled text is
--- `prefix.name` rather than the full node span (which includes generic type arguments).
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

--- Slices `typeNode` into per-line segment lists before any display transforms.
local function cutLines(parsed: Parsed, typeNode: any, generics: { [string]: boolean }?): { { Seg } }
	local span = parseMod.typeSpan(typeNode) :: Span
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
				continue -- Outside the slice; leave as plain text.
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

--- Strips Luau comments while respecting quoted string literals and keeping a
--- line comment's trailing newline so whitespace collapsing can merge across it.
--- Long-bracket strings are intentionally not recognized here because table
--- indexers (`{ [string]: T }`) also start with `[` and must not be mistaken for strings.
local function stripComments(text: string): string
	local kept = {}
	local i = 1
	local n = #text
	while i <= n do
		local c = text:sub(i, i)
		if c == '"' or c == "'" then
			local j = util.closingQuote(text, i)
			table.insert(kept, text:sub(i, j))
			i = j + 1
		elseif c == "-" and text:sub(i + 1, i + 1) == "-" then
			i = util.commentEnd(text, i)
		else
			table.insert(kept, c)
			i += 1
		end
	end
	return table.concat(kept)
end

--- Merges adjacent non-empty string segments so reference segments are separated
--- by at most one string segment. Reference tables are preserved by identity so
--- resolution updates the same table instances shared between signatures and parameter/return entries.
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

--- Flattens per-line segment lists into a single list with `"\n"` between lines.
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

--- Produces a single-line segment display for inline signature positions, or `nil` when `typeNode` is absent.
function segs.inline(parsed: Parsed, typeNode: any, generics: { [string]: boolean }?): { Seg }?
	if typeNode == nil or typeNode.location == nil then
		return nil
	end
	-- Merge adjacent string pieces across line breaks before stripping comments
	-- and collapsing whitespace so multi-line block comments and whitespace runs
	-- are processed as contiguous strings.
	local out: { Seg } = segs.canonical(joinLines(cutLines(parsed, typeNode, generics)))
	for i, seg in out do
		if type(seg) == "string" then
			out[i] = (stripComments(seg):gsub("%s+", " "))
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

--- Slices `typeNode` as a multi-line block preserving comments and dropping
--- blank lines (which would terminate `markdown-it`'s `html_block` downstream).
--- The second return maps each source line number to its 1-based display line index.
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
	-- Line 1 starts mid-line (after `= `), so only lines 2..N are dedented, and
	-- never by more than the declaration line's own indentation. That strips
	-- outer block indentation while preserving the one-level continuation indent
	-- of a multi-line union or table type.
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

--- Builds a segment list for a type string written in a doc tag (`@param x Foo.Bar`).
--- Since no source CST node exists for tag types, the string is parsed as the
--- right-hand side of `type _ = <display>`. Tag types are prose and may use
--- non-Luau shorthands (`number[]`, bare `...`), so parse failures fall back to
--- a lexical scan that turns identifiers (except `key:` field names) into
--- candidate references.
---
--- Results are memoized because each cache miss runs the Luau parser; `fromTag`
--- returns fresh clones so per-module resolution can mutate reference segments safely.
local tagCache: { [string]: { Seg } } = {}

local function lexicalSegs(display: string): { Seg }
	local out: { Seg } = {}
	local cursor = 1
	local i = 1
	local n = #display
	while i <= n do
		local c = display:sub(i, i)
		if c == '"' or c == "'" then
			-- Quoted string literal types are never type references.
			i = util.closingQuote(display, i) + 1
		elseif c:match("[%a_]") ~= nil then
			local start, stop = display:find("^[%w_]+", i)
			local prefixText: string? = nil
			local name = display:sub(start :: number, stop :: number)
			-- Treat `A.B` as a single qualified reference only when `.` directly
			-- connects two identifiers.
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
				-- Slice verbatim without inline whitespace collapsing so the
				-- author's tag formatting is preserved.
				cached = segs.canonical(joinLines(cutLines(parsed, stat.type, nil)))
			end
		end
		cached = cached or lexicalSegs(display)
		tagCache[display] = cached :: { Seg }
	end
	return cloneForTag(cached :: { Seg }, generics)
end

--- Collects per-field docs and display-line facts for a table-type definition in two tiers:
---   * A direct table type (`own == true`) produces full `Field` entries and
---     claims each field's leading doc block.
---   * Intersection and union operands (`Base & { ... }`, `own == false`) record
---     only `LineFacts` without claiming doc blocks, so an explicit `@field` tag
---     can still inject its description while leaving unclaimed blocks free for placing tags.
---
--- Duplicate field names clear their line mapping, and a second field on the
--- same source line is skipped because an injected doc comment above that line
--- would appear to document the first field on the line.
---
--- Also returns the precomputed `blockLines` as the third return value.
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
		node = parseMod.unwrapType(node)
		if node == nil then
			return
		end
		if node.tag == "table" and node.entries ~= nil then
			for _, entry in node.entries do
				if parseMod.isTypeProperty(entry) and entry.key ~= nil then
					local name = entry.key.text
					local keyLine = entry.key.location.beginLine
					if own then
						local block = comments.claim(claimIndex, keyLine)
						local inDisplay = block ~= nil or trailingIndex[keyLine] ~= nil
						table.insert(fields, {
							name = name,
							type = segs.inline(parsed, entry.value, generics),
							desc = if block ~= nil
								then util.joinDesc(block.content)
								else comments.trailingText(trailingIndex, keyLine),
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
	gather(typeNode, true)
	return if #fields > 0 then fields else nil, facts, blockLines
end

--- Collects all generic parameter names first so a default type that references
--- an earlier generic parameter (`<K, V = K>`) is demoted to plain text.
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
			default = segs.inline(parsed, entry.node.default, names),
		})
	end
	return out, names
end

--- Returns structured `{ name, type }` entries for a function node's parameter
--- list (including varargs) alongside each parameter's ending source line for
--- trailing-comment lookup.
function segs.paramEntries(
	parsedFile: any,
	fnNode: any,
	genericNames: { [string]: boolean }?
): ({ any }, { [number]: number })
	local params: { any } = {}
	local paramLines: { [number]: number } = {}
	local function add(name: string, annotation: any, fallback: any)
		table.insert(params, { name = name, type = segs.inline(parsedFile, annotation, genericNames) })
		local span = if annotation ~= nil then annotation.location else fallback.location
		if span ~= nil then
			paramLines[#params] = span.endLine
		end
	end
	for _, pair in fnNode.parameters or {} do
		local p = pair.node
		if p ~= nil and p.name ~= nil then
			add(p.name.text, p.annotation, p.name)
		end
	end
	if fnNode.vararg ~= nil then
		add("...", fnNode.varargAnnotation, fnNode.vararg)
	end
	return params, paramLines
end

--- Appends the `(name: T, ...)` display of `params` onto `sig`. Reference
--- segments are shared by identity with `params` so resolution updates both
--- places at once.
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

--- Builds the post-callee signature display (`<T>(x: T): T`) stored in the doc
--- model's `segs` field. Reference segments are shared by identity with `generics`,
--- `params`, and `returnTail`.
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

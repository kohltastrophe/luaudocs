--!strict

--- Seam over Lute's `@std/syntax/parser`, `.d.luau` declaration normalization,
--- and `@[deprecated]` attribute extraction. Every CST access quirk lives here:
---   * spans are 1-based `{beginLine, beginColumn, endLine, endColumn}` (`endColumn` is exclusive)
---   * comments are trivia on tokens: `leadingTrivia` of the next token, or
---     `trailingTrivia` of the last token on the line for same-line comments
---   * trivia text includes delimiters (`"--- x"`, `"--[=[ .. ]=]"`), no newline
---   * EOF comments hang off `cst.eof.leadingTrivia`
---   * statement tags are lowercase: `local`, `function`, `localfunction`, `assign`,
---     `typealias`, `return`, `expression`, ...
---   * function attributes: `stat.func.attributes[i] = {kind="attribute", token, location}`
---   * `.d.luau` `declare` constructs are normalized into span-preserving standard Luau
---     with original declaration metadata recorded in `Parsed.decls`

local parser = require("@std/syntax/parser")
local util = require("./util")

export type Span = { beginLine: number, beginColumn: number, endLine: number, endColumn: number }

export type Comment = {
	kind: "line" | "block",
	text: string, -- raw, including delimiters
	span: Span,
	trailing: boolean, -- sits after code on its line
}

export type DeclMeta = {
	classes: { [number]: { name: string } },
	functions: { [number]: { name: string } },
	globals: { [number]: { name: string } },
	classMethods: { [number]: { name: string } },
	classProps: { [number]: { name: string, readonly: boolean } },
	classIndexers: { [number]: { readonly: boolean } },
}

export type Parsed = {
	cst: any, -- CstParseResult
	lines: { string }, -- 1-based
	comments: { Comment }, -- source order
	decls: DeclMeta?,
}

export type ParsedModule = Parsed

local parse = {}

--- Walks CST nodes rooted at `root`. `visit` returns `false` to skip descending
--- into a node. `seen` prevents cycles on shared CST nodes, and `location`
--- span tables are skipped.
function parse.walkNodes(root: any, visit: (node: any) -> boolean?)
	local seen: { [any]: boolean } = {}
	local function walkCst(node: any)
		if type(node) ~= "table" or seen[node] then
			return
		end
		seen[node] = true
		if visit(node) == false then
			return
		end
		for key, v in node do
			if key ~= "location" and type(v) == "table" then
				walkCst(v)
			end
		end
	end
	walkCst(root)
end

--- Lute spells a table-type or table-expression entry's discriminator as `tag`
--- on some CST nodes and `kind` on others. Centralizing these checks keeps CST
--- quirks out of individual walkers.
function parse.entryKind(entry: any): string
	return if type(entry) == "table" then (entry.tag or entry.kind or "") else ""
end

function parse.isTypeProperty(entry: any): boolean
	return parse.entryKind(entry) == "property"
end

function parse.isTypeIndexer(entry: any): boolean
	return parse.entryKind(entry) == "indexer"
end

--- Steps past parentheses and explicit type instantiations (`f<<T>>`) to the
--- wrapped expression. When `includeCast` is true, also steps through `:: T` assertions.
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

--- Steps past parenthesized `(T)` groups only, preserving nullable `T?` unions.
function parse.unwrapGroup(typeNode: any): any
	while typeNode ~= nil and typeNode.tag == "group" do
		typeNode = typeNode.type
	end
	return typeNode
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

--- Slices the source text covered by a 1-based CST `span` (`endColumn` is exclusive)
--- from `parsed.lines`, joining multi-line spans with `\n`.
function parse.sliceSpan(parsed: Parsed, span: Span?): string
	if span == nil then
		return ""
	end
	local parts: { string } = {}
	for lineNo = span.beginLine, span.endLine do
		local lineText = parsed.lines[lineNo] or ""
		local startCol = if lineNo == span.beginLine then span.beginColumn else 1
		local endCol = if lineNo == span.endLine then span.endColumn - 1 else #lineText
		table.insert(parts, lineText:sub(startCol, endCol))
	end
	return table.concat(parts, "\n")
end

--- Lute sets an explicit typepack default's `.location` to its opening `(`
--- alone, while `closeParens` holds the real end of the span.
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
				local kind: "line" | "block" = if tr.tag == "comment" then "line" else "block"
				table.insert(out, {
					kind = kind,
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
	table.sort(out, function(a: Comment, b: Comment)
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
		if line ~= nil and column ~= nil and message ~= nil then
			local oneBased = (tonumber(line) :: number) + 1
			first = first or oneBased
			table.insert(lines, string.format("%d:%d: %s", oneBased, (tonumber(column) :: number) + 1, message))
		elseif util.trim(text) ~= "" then
			table.insert(lines, text)
		end
	end
	return table.concat(lines, "\n"), first
end

local LUAU_KEYWORDS: { [string]: boolean } = {
	["and"] = true,
	["break"] = true,
	["do"] = true,
	["else"] = true,
	["elseif"] = true,
	["end"] = true,
	["false"] = true,
	["for"] = true,
	["function"] = true,
	["if"] = true,
	["in"] = true,
	["local"] = true,
	["nil"] = true,
	["not"] = true,
	["or"] = true,
	["repeat"] = true,
	["return"] = true,
	["then"] = true,
	["true"] = true,
	["until"] = true,
	["while"] = true,
}
parse.LUAU_KEYWORDS = LUAU_KEYWORDS

local function safeIdent(name: string): string
	return if LUAU_KEYWORDS[name] then string.rep("_", #name) else name
end

--- Splits `line` into `(codePart, commentPart, nextBlockCommentEq)`, respecting
--- string literals and multi-line `--[=[...]=]` block comments.
local function splitCodeAndComment(line: string, inBlockComment: string?): (string, string, string?)
	local n = #line
	local i = 1
	if inBlockComment ~= nil then
		local closePat = "]" .. inBlockComment .. "]"
		local closeAt = line:find(closePat, 1, true)
		if closeAt == nil then
			return "", line, inBlockComment
		end
		-- Anything before the block comment close cannot be declaration syntax;
		-- replace with spaces so column offsets of any trailing code stay intact.
		local afterClose = closeAt + #closePat
		local restCode, restComment, nextEq = splitCodeAndComment(line:sub(afterClose), nil)
		return string.rep(" ", afterClose - 1) .. restCode, restComment, nextEq
	end
	while i <= n do
		local hit = line:find("[\"'%-]", i)
		if hit == nil then
			break
		end
		i = hit
		local c = line:sub(i, i)
		if c == '"' or c == "'" then
			i = util.closingQuote(line, i) + 1
		elseif line:sub(i + 1, i + 1) == "-" then
			local eq = line:match("^%[(=*)%[", i + 2)
			if eq ~= nil then
				local closePat = "]" .. eq .. "]"
				local closeAt = line:find(closePat, i + 4 + #eq, true)
				if closeAt ~= nil then
					i = closeAt + #closePat
				else
					return line:sub(1, i - 1), line:sub(i), eq
				end
			else
				return line:sub(1, i - 1), line:sub(i), nil
			end
		else
			i += 1
		end
	end
	return line, "", nil
end

--- Scans `code` from `startIdx` to update bracket nesting depth (`()`, `{}`, `[]`,
--- and `<...>` excluding `->`).
local function updateBracketDepth(code: string, startIdx: number, depth: number, includeAngles: boolean): number
	local n = #code
	local i = startIdx
	while i <= n do
		local c = code:sub(i, i)
		if c == '"' or c == "'" then
			i = util.closingQuote(code, i) + 1
		elseif c == "(" or c == "{" or c == "[" or (includeAngles and c == "<") then
			depth += 1
			i += 1
		elseif c == ")" or c == "}" or c == "]" or (includeAngles and c == ">" and code:sub(i - 1, i - 1) ~= "-") then
			depth = math.max(0, depth - 1)
			i += 1
		else
			i += 1
		end
	end
	return depth
end

local function isTypeContinuation(code: string, nextCode: string?): boolean
	if code:match("[,|&:]%s*$") ~= nil or code:match("%->%s*$") ~= nil then
		return true
	end
	if nextCode ~= nil then
		return nextCode:match("^%s*[|&:]") ~= nil or nextCode:match("^%s*%->") ~= nil
	end
	return false
end

--- Scans balanced `openCh`/`closeCh` pairs from `startIdx` until `depth == 0`
--- or end-of-line, skipping string literals and `->` arrows.
local function scanBalanced(
	code: string,
	startIdx: number,
	depth: number,
	openCh: string,
	closeCh: string
): (number, number)
	local n = #code
	local i = startIdx
	while i <= n and depth > 0 do
		local ch = code:sub(i, i)
		if ch == '"' or ch == "'" then
			i = util.closingQuote(code, i) + 1
		elseif ch == openCh then
			depth += 1
			i += 1
		elseif ch == closeCh and (closeCh ~= ">" or code:sub(i - 1, i - 1) ~= "-") then
			depth -= 1
			i += 1
		else
			i += 1
		end
	end
	return i, depth
end

--- Advances a function signature scan from `startIdx` on `code`. Returns
--- `(completed, nextStage, nextDepth, seenReturn)` where `completed` is true
--- when the signature finished on this line and needs `" end"` appended.
local function advanceFnScan(
	code: string,
	startIdx: number,
	stage: string,
	depth: number,
	seenReturn: boolean,
	nextCode: string?
): (boolean, string, number, boolean)
	local n = #code
	local i = startIdx
	while i <= n do
		local c = code:sub(i, i)
		if c == '"' or c == "'" then
			if stage == "return" then
				seenReturn = true
			end
			i = util.closingQuote(code, i) + 1
		elseif stage == "generics" then
			if depth > 0 then
				i, depth = scanBalanced(code, i, depth, "<", ">")
				if depth == 0 then
					stage = "params"
				end
			elseif c:match("%s") then
				i += 1
			elseif c == "<" then
				i, depth = scanBalanced(code, i + 1, 1, "<", ">")
				if depth == 0 then
					stage = "params"
				end
			else
				stage = "params"
			end
		elseif stage == "params" then
			if depth > 0 then
				i, depth = scanBalanced(code, i, depth, "(", ")")
				if depth == 0 then
					stage = "afterParams"
				end
			elseif c == "(" then
				i, depth = scanBalanced(code, i + 1, 1, "(", ")")
				if depth == 0 then
					stage = "afterParams"
				end
			else
				i += 1
			end
		elseif stage == "afterParams" then
			if c:match("%s") then
				i += 1
			elseif c == ":" then
				stage = "return"
				depth = 0
				seenReturn = false
				i += 1
			else
				return true, "done", 0, false
			end
		elseif stage == "return" then
			if code:find("%S", i) ~= nil then
				seenReturn = true
			end
			depth = updateBracketDepth(code, i, depth, true)
			break
		end
	end
	if stage == "afterParams" then
		if nextCode == nil or nextCode:match("^%s*:") == nil then
			return true, "done", 0, false
		end
	elseif stage == "return" and seenReturn and depth == 0 and not isTypeContinuation(code, nextCode) then
		return true, "done", 0, true
	end
	return false, stage, depth, seenReturn
end

type NormState = {
	outLines: { string },
	sliceLines: { string },
	nextCodes: { [number]: string },
	decls: DeclMeta,
	anyDeclared: boolean,
	inClass: boolean,
	typeDepth: number,
	pendingIndexer: boolean,
	pendingType: boolean,
	fnStage: string?,
	fnDepth: number,
	fnSeenReturn: boolean,
}

local function finishFnLine(st: NormState, idx: number, rewrittenCode: string, scanTail: string, comment: string)
	st.sliceLines[idx] = rewrittenCode .. comment
	local done, nextStage, nextDepth, nextSeen = advanceFnScan(scanTail, 1, "generics", 0, false, st.nextCodes[idx])
	if done then
		st.outLines[idx] = rewrittenCode .. " end" .. comment
	else
		st.outLines[idx] = rewrittenCode .. comment
		st.fnStage, st.fnDepth, st.fnSeenReturn = nextStage, nextDepth, nextSeen
	end
end

local function rewriteTopLevelDecl(st: NormState, idx: number, code: string, comment: string): boolean
	local pre, _, name, rest = code:match("^(%s*)declare%s+(class)%s+([A-Za-z_][A-Za-z0-9_]*)(.*)$")
	if pre == nil then
		pre, _, name, rest = code:match("^(%s*)declare%s+(extern%s+type)%s+([A-Za-z_][A-Za-z0-9_]*)(.*)$")
	end
	if pre ~= nil and name ~= nil and rest ~= nil then
		st.anyDeclared = true
		st.decls.classes[idx] = { name = name }
		if rest:match("%send%s*$") or rest:match("^end%s*$") then
			st.outLines[idx] = pre .. "do end" .. comment
		else
			st.inClass = true
			st.outLines[idx] = pre .. "do" .. comment
		end
		return true
	end

	local attrPre, fnName, fnAfter = code:match("^(.-)declare%s+function%s+([A-Za-z_][A-Za-z0-9_]*)(.*)$")
	if attrPre ~= nil and fnName ~= nil and fnAfter ~= nil then
		st.anyDeclared = true
		st.decls.functions[idx] = { name = fnName }
		local rewrittenCode = attrPre .. "local   function " .. safeIdent(fnName) .. fnAfter
		finishFnLine(st, idx, rewrittenCode, fnAfter, comment)
		return true
	end

	local gPre, gName, gRest = code:match("^(%s*)declare%s+([A-Za-z_][A-Za-z0-9_]*)(%s*:.*)$")
	if gPre ~= nil and gName ~= nil and gRest ~= nil then
		st.anyDeclared = true
		st.decls.globals[idx] = { name = gName }
		local rewrittenCode = gPre .. "local   " .. safeIdent(gName) .. gRest
		st.outLines[idx] = rewrittenCode .. comment
		st.sliceLines[idx] = rewrittenCode .. comment
		st.typeDepth = updateBracketDepth(gRest, 1, 0, true)
		st.pendingType = st.typeDepth == 0 and isTypeContinuation(gRest, st.nextCodes[idx])
		return true
	end

	return false
end

local function stripAccessMod(code: string): (boolean, number)
	local _, endRead = code:find("^%s*read%s+")
	if endRead ~= nil then
		return true, endRead + 1
	end
	local _, endWrite = code:find("^%s*write%s+")
	if endWrite ~= nil then
		return false, endWrite + 1
	end
	local _, endWs = code:find("^%s*")
	return false, (endWs or 0) + 1
end

local function rewriteClassMemberDecl(st: NormState, idx: number, code: string, comment: string): boolean
	if code:match("^%s*end%s*$") then
		st.inClass = false
		return true
	end

	local fnPre, fnName, fnAfter = code:match("^(.-function%s+)([A-Za-z_][A-Za-z0-9_]*)(.*)$")
	if fnPre ~= nil and fnName ~= nil and fnAfter ~= nil then
		st.decls.classMethods[idx] = { name = fnName }
		local rewrittenCode = fnPre .. safeIdent(fnName) .. fnAfter
		finishFnLine(st, idx, rewrittenCode, fnAfter, comment)
		return true
	end

	local isRead, restPos = stripAccessMod(code)
	if code:sub(restPos, restPos) == "[" then
		local idxBody = code:sub(restPos)
		st.decls.classIndexers[idx] = { readonly = isRead }
		st.sliceLines[idx] = "type _={" .. idxBody .. comment
		local d = updateBracketDepth(idxBody, 1, 0, true)
		if d == 0 and not isTypeContinuation(idxBody, st.nextCodes[idx]) then
			st.outLines[idx] = "type _={" .. idxBody .. "}" .. comment
		else
			st.outLines[idx] = "type _={" .. idxBody .. comment
			st.typeDepth = d
			st.pendingIndexer = true
		end
		return true
	end

	local propName, colonPos, propRest = code:match("^([A-Za-z_][A-Za-z0-9_]*)%s*:()(.*)$", restPos)
	if propName ~= nil and colonPos ~= nil and propRest ~= nil then
		st.decls.classProps[idx] = { name = propName, readonly = isRead }
		local col = (colonPos :: number) - 1
		local head = if col >= 7 then "type _=" .. string.rep(" ", col - 7) else "type _="
		local rewrittenCode = head .. propRest
		st.outLines[idx] = rewrittenCode .. comment
		st.sliceLines[idx] = rewrittenCode .. comment
		st.typeDepth = updateBracketDepth(propRest, 1, 0, true)
		st.pendingType = st.typeDepth == 0 and isTypeContinuation(propRest, st.nextCodes[idx])
		return true
	end

	return false
end

--- Rewrites Luau `.d.luau` declaration constructs (`declare class`, `declare extern type`,
--- `declare function`, `declare <name>: <Type>`) into span-preserving standard Luau so
--- `@std/syntax/parser` can build a full CST with comments and type spans intact.
local function normalizeDeclarations(lines: { string }): (string, { string }, DeclMeta, boolean)
	local codeLines: { string } = {}
	local commentParts: { string } = {}
	local inBlockComment: string? = nil
	for idx, line in lines do
		local code, comment, nextBlockEq = splitCodeAndComment(line, inBlockComment)
		inBlockComment = nextBlockEq
		codeLines[idx] = code
		commentParts[idx] = comment
	end

	local nextCodes: { [number]: string } = {}
	local upcoming: string? = nil
	for idx = #lines, 1, -1 do
		if upcoming ~= nil then
			nextCodes[idx] = upcoming
		end
		if util.trim(codeLines[idx]) ~= "" then
			upcoming = codeLines[idx]
		end
	end

	local st: NormState = {
		outLines = table.clone(lines),
		sliceLines = table.clone(lines),
		nextCodes = nextCodes,
		decls = {
			classes = {},
			functions = {},
			globals = {},
			classMethods = {},
			classProps = {},
			classIndexers = {},
		},
		anyDeclared = false,
		inClass = false,
		typeDepth = 0,
		pendingIndexer = false,
		pendingType = false,
		fnStage = nil,
		fnDepth = 0,
		fnSeenReturn = false,
	}

	for idx = 1, #lines do
		local code = codeLines[idx]
		local comment = commentParts[idx]
		if util.trim(code) == "" then
			continue
		end

		local nextCode = st.nextCodes[idx]
		if st.fnStage ~= nil then
			local done, nextStage, nextDepth, nextSeen =
				advanceFnScan(code, 1, st.fnStage, st.fnDepth, st.fnSeenReturn, nextCode)
			if done then
				st.outLines[idx] = code .. " end" .. comment
				st.fnStage = nil
			else
				st.fnStage, st.fnDepth, st.fnSeenReturn = nextStage, nextDepth, nextSeen
			end
			continue
		end

		if st.pendingIndexer then
			st.typeDepth = updateBracketDepth(code, 1, st.typeDepth, true)
			if st.typeDepth == 0 and not isTypeContinuation(code, nextCode) then
				st.outLines[idx] = code .. "}" .. comment
				st.pendingIndexer = false
			end
			continue
		end

		if st.typeDepth > 0 or st.pendingType then
			st.typeDepth = updateBracketDepth(code, 1, st.typeDepth, true)
			st.pendingType = st.typeDepth == 0 and isTypeContinuation(code, nextCode)
			continue
		end

		if not st.inClass then
			rewriteTopLevelDecl(st, idx, code, comment)
		else
			if not rewriteClassMemberDecl(st, idx, code, comment) then
				st.typeDepth = updateBracketDepth(code, 1, st.typeDepth, true)
				st.pendingType = st.typeDepth == 0 and isTypeContinuation(code, nextCode)
			end
		end
	end

	return table.concat(st.outLines, "\n"), st.sliceLines, st.decls, st.anyDeclared
end

--- Parses `source` and returns `(Parsed, nil)` or `(nil, errorMessage, line?)`.
function parse.parse(source: string): (Parsed?, string?, number?)
	local ok, result = pcall(parser.parse, source)
	local lines = util.splitLines(source)
	local decls: DeclMeta? = nil
	if not ok and source:find("declare") ~= nil then
		local normalized, sliceLines, meta, anyDeclared = normalizeDeclarations(lines)
		if anyDeclared then
			local okNorm, normResult = pcall(parser.parse, normalized)
			result = normResult
			if okNorm then
				ok = true
				lines = sliceLines
				decls = meta
			end
		end
	end
	if not ok then
		local errMsg, errLine = describeParseError(tostring(result))
		return nil, errMsg, errLine
	end
	return {
		cst = result,
		lines = lines,
		comments = collectComments(result),
		decls = decls,
	}, nil, nil
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
		local trivia: { any } = if first.token ~= nil and type(first.token.leadingTrivia) == "table"
			then first.token.leadingTrivia
			else {}
		for _, tr in trivia do
			if tr.text ~= nil and tr.text:sub(1, 2) == "@[" and tr.location.beginLine < line then
				line = tr.location.beginLine
				break
			end
		end
	end
	return line
end

--- Extracts a Luau deprecation attribute (`@[deprecated { use = "...", reason = "..." }]`)
--- from `fnNode.attributes`, returning `{ note = string? }` when present.
function parse.extractDeprecationAttr(parsed: Parsed?, fnNode: any): { note: string? }?
	local attrs = if fnNode ~= nil then fnNode.attributes else nil
	if type(attrs) ~= "table" then
		return nil
	end
	for _, attr in attrs do
		local tokText = if attr.token ~= nil then attr.token.text else nil
		if tokText ~= "@deprecated" and tokText ~= "deprecated" then
			continue
		end
		local note: string? = nil
		if parsed ~= nil and attr.location ~= nil then
			-- Lute's attribute span (`[beginColumn, endColumn)`) covers the entire
			-- `deprecated { ... }` entry and stops before sibling attributes, the
			-- `function` keyword, parameters, and trailing same-line comments.
			local raw = parse.sliceSpan(parsed, attr.location)
			local reason = raw:match('reason%s*=%s*"([^"]+)"') or raw:match("reason%s*=%s*'([^']+)'")
			local use = raw:match('use%s*=%s*"([^"]+)"') or raw:match("use%s*=%s*'([^']+)'")
			if reason ~= nil and use ~= nil then
				note = string.format("%s (use `%s` instead)", reason, use)
			elseif reason ~= nil then
				note = reason
			elseif use ~= nil then
				note = string.format("Use `%s` instead.", use)
			end
		end
		return { note = note }
	end
	return nil
end

--- Returns the CST local binding for the second argument of `setmetatable(x, Class)`
--- when it is a local variable reference.
local function setmetatableClassLocal(callNode: any): any?
	callNode = parse.unwrapExpr(callNode, true)
	if callNode == nil or callNode.tag ~= "call" then
		return nil
	end
	local func = parse.unwrapExpr(callNode.func, true)
	if func == nil or func.tag ~= "global" or func.name.text ~= "setmetatable" then
		return nil
	end
	local args = callNode.arguments
	local second: any = if args ~= nil and args[2] ~= nil then parse.unwrapExpr(args[2].node, true) else nil
	if second == nil or second.tag ~= "local" then
		return nil
	end
	return second["local"]
end

--- Returns the class local referenced by a metatable type alias in either
--- `typeof(setmetatable(_, Class))` or `setmetatable<_, typeof(Class)>`.
function parse.setmetatableTypeClassLocal(typeNode: any): any?
	typeNode = parse.unwrapType(typeNode)
	if typeNode == nil then
		return nil
	end
	if typeNode.tag == "typeof" then
		return setmetatableClassLocal(typeNode.expression)
	end
	if typeNode.tag ~= "reference" or typeNode.prefix ~= nil or typeNode.name == nil then
		return nil
	end
	if typeNode.name.text ~= "setmetatable" or typeNode.parameters == nil then
		return nil
	end
	local second = typeNode.parameters[2]
	local arg: any = if second ~= nil then parse.unwrapType(second.node) else nil
	local expr: any = if arg ~= nil and arg.tag == "typeof" then parse.unwrapExpr(arg.expression, true) else nil
	if expr == nil or expr.tag ~= "local" then
		return nil
	end
	return expr["local"]
end

--- Returns the CST local binding constructed by a same-module constructor returning
--- `setmetatable(_, Class)` directly or via `local self = setmetatable(_, Class); ...; return self`.
function parse.constructedClassLocal(fnNode: any): any?
	if fnNode == nil or fnNode.body == nil or fnNode.body.statements == nil then
		return nil
	end
	local stats = fnNode.body.statements
	local last = stats[#stats]
	if last == nil or last.tag ~= "return" or last.expressions == nil then
		return nil
	end
	local first = last.expressions[1]
	if first == nil or first.node == nil then
		return nil
	end
	local retExpr = parse.unwrapExpr(first.node, true)
	local classLocal = setmetatableClassLocal(retExpr)
	if classLocal == nil and retExpr ~= nil and retExpr.tag == "local" then
		for _, stat in stats do
			if stat.tag == "local" and stat.values ~= nil then
				for i, varPair in stat.variables do
					if varPair.node == retExpr["local"] and stat.values[i] ~= nil then
						classLocal = setmetatableClassLocal(stat.values[i].node)
						break
					end
				end
			end
		end
	end
	return classLocal
end

return parse

--- Public-surface discovery: symbolically evaluates a module chunk's top-level
--- statements and resolves what the module returns, without executing anything.
--- Also owns OOP-class classification over the surfaced tables (classify,
--- isMetamethod), which only means anything next to SymValue.
---
--- The environment maps CstLocal *identity* -> SymValue; the parser links every
--- local reference to its binding via `expr.local`, so it handles shadowing for
--- us. Only top-level statements are evaluated: early returns inside `if` blocks
--- are ignored, since the chunk return is always the last top-level statement.

local parseMod = require("./parse")
local comments = require("./comments")

type Span = parseMod.Span
type Parsed = parseMod.Parsed
type DocBlock = comments.DocBlock

export type SymValue = {
	kind: "table" | "require" | "import" | "function" | "literal" | "opaque" | "ipath",
	-- table
	fields: { SymField }?,
	fieldIndex: { [string]: number }?,
	metatable: SymValue?,
	frozen: boolean?, -- passed through table.freeze (shallow, like the freeze)
	isEmptyLiteral: boolean?, -- spelled `{}`, whatever was assigned into it later
	arrayItemKind: string?, -- literal kind shared by every item of a pure list
	-- require
	requireInfo: { kind: "string" | "ipath" | "dynamic", text: string?, segs: { string }? }?,
	-- import (member of a required module: `raw = State.raw`)
	base: SymValue?,
	path: { string }?,
	-- function
	fnNode: any?, -- CstExprFunction
	-- literal
	valueKind: string?, -- "number" | "string" | "boolean" | "nil"
	-- ipath (Roblox instance path rooted at `script`)
	segs: { string }?,
	dotted: boolean?, -- a `.X` step, which names a property as readily as a child
	-- opaque
	callee: string?,
	service: string?, -- Roblox service name (`game:GetService("X")`, `game.X`)
	engineMethod: string?, -- method called on a value already known to be an Instance
	calleeValue: SymValue?, -- what a call called, for a return-type lookup
	-- `A and B`: the conditional-mount idiom, kept in halves
	guard: SymValue?, -- A, which a realm test makes realm evidence
	guarded: SymValue?, -- B, what the value is wherever the guard passes
	-- common
	castType: any?, -- CstType from `:: T`
	annotation: any?, -- CstType from an annotated local binding
	defDoc: DocBlock?, -- doc block on the defining statement
	span: Span?,
}

export type SymField = {
	name: string,
	value: SymValue,
	--- defined as `function T:name()`: decides `:` vs `.` in the rendered
	--- callee, and one colon method makes its table a class
	isColonMethod: boolean,
	declaredType: any?, -- CstType from `:: T` on the field value
	fieldDoc: DocBlock?, -- block above the table-literal field
	defDoc: DocBlock?, -- block above a later `function M.f` / `M.f = ...` definition
	trailingDesc: string?,
	keySpan: Span,
	defSpan: Span,
}

export type TypeAliasInfo = {
	name: string,
	exported: boolean,
	kind: "alias" | "typefunction",
	stat: any,
	doc: DocBlock?,
}

export type SurfaceResult = {
	result: SymValue?,
	types: { TypeAliasInfo },
	requireLocals: { [string]: SymValue }, -- local name -> require SymValue (for type prefix resolution)
	firstStatLine: number?,
	env: { [any]: SymValue }, -- CstLocal -> SymValue (classType/constructor detection)
}

local surface = {}

local function newTable(span: Span?): SymValue
	return { kind = "table", fields = {}, fieldIndex = {}, span = span }
end

local function opaque(expr: any?, callee: string?): SymValue
	return { kind = "opaque", callee = callee, span = expr and expr.location }
end

--- Operator text -> the `valueKind` its result always has. Unary and binary
--- share one table: no operator spelled both ways lands in both halves.
local OPERATOR_RESULTS: { [string]: string } = {
	["not"] = "boolean",
	["=="] = "boolean",
	["~="] = "boolean",
	["<"] = "boolean",
	["<="] = "boolean",
	[">"] = "boolean",
	[">="] = "boolean",
	["#"] = "number",
}

--- Past every `A and B` wrapper to the B underneath, plus whether one was
--- there. Indexing or calling through a guarded value reaches what the guard
--- admits (`Server:WaitForChild("Tools")` runs only where Server is the
--- instance), so every consumer of a value works on the unguarded one.
local function unguard(value: SymValue): (SymValue, boolean)
	local guarded = false
	while value.guarded ~= nil do
		value = value.guarded :: SymValue
		guarded = true
	end
	return value, guarded
end

surface.unguard = unguard

--- Past any parentheses to the expression they wrap.
local function ungroup(node: any): any
	while node ~= nil and node.tag == "group" do
		node = node.expression
	end
	return node
end

--- Dotted callee path when statically nameable ("require", "table.freeze").
local function calleePath(expr: any): string?
	if expr == nil then
		return nil
	end
	if expr.tag == "global" then
		return expr.name.text
	end
	if expr.tag == "local" then
		return expr.token.text
	end
	if expr.tag == "indexname" then
		local base = calleePath(expr.expression)
		if base ~= nil then
			return base .. expr.accessor.text .. expr.index.text
		end
	end
	return nil
end

surface.calleePath = calleePath

type Ctx = {
	env: { [any]: SymValue },
	claimIndex: { [number]: DocBlock },
	trailingIndex: comments.TrailingIndex,
	types: { TypeAliasInfo },
	requireLocals: { [string]: SymValue },
}

local evalExpr -- forward

--- What indexing `base` by `indexText` evaluates to. Split out of the index
--- branch because a call reads it too, off the receiver it has already
--- evaluated: re-entering evalExpr for the callee would walk that receiver a
--- second time, doubling the work at every link of a chained call.
local function indexValue(base: SymValue, indexText: string, expr: any): SymValue
	if base.kind == "table" then
		local field = surface.fieldOf(base, indexText)
		if field ~= nil then
			return field.value
		end
		return opaque(expr)
	elseif base.kind == "require" then
		return { kind = "import", base = base, path = { indexText }, span = expr.location }
	elseif base.kind == "import" then
		local path = table.clone(base.path :: { string })
		table.insert(path, indexText)
		return { kind = "import", base = base.base, path = path, span = expr.location }
	elseif base.kind == "ipath" then
		local segs = table.clone(base.segs :: { string })
		table.insert(segs, indexText)
		return { kind = "ipath", segs = segs, dotted = true, span = expr.location }
	elseif base.kind == "opaque" and base.callee == "game" then
		-- `game.Players` names a service the way GetService does
		return { kind = "opaque", callee = "game." .. indexText, service = indexText, span = expr.location }
	elseif base.kind == "opaque" and base.callee ~= nil then
		-- keep a global's dotted path spelled out (`Enum.Material`, `Color3.new`):
		-- resolution cannot follow it, but inference reads the root to recognize
		-- an engine library. A shadowing local never gets here, having evaluated
		-- to its own binding above.
		return { kind = "opaque", callee = base.callee .. "." .. indexText, span = expr.location }
	end
	return opaque(expr)
end

--- The named field of a table SymValue: the one spelling of the
--- fieldIndex-into-fields lookup every consumer needs.
function surface.fieldOf(sym: SymValue, name: string): SymField?
	local idx = (sym.fieldIndex :: { [string]: number })[name]
	return if idx ~= nil then (sym.fields :: { SymField })[idx] else nil
end

local function setField(target: SymValue, name: string, field: SymField)
	local fields = target.fields :: { SymField }
	local index = target.fieldIndex :: { [string]: number }
	local existing = index[name]
	if existing ~= nil then
		-- keep original position; later definition data wins, docs merge
		local prev = fields[existing]
		field.fieldDoc = field.fieldDoc or prev.fieldDoc
		field.defDoc = field.defDoc or prev.defDoc
		field.trailingDesc = field.trailingDesc or prev.trailingDesc
		fields[existing] = field
	else
		table.insert(fields, field)
		index[name] = #fields
	end
end

local function evalTable(ctx: Ctx, expr: any): SymValue
	local value = newTable(expr.location)
	value.isEmptyLiteral = #expr.entries == 0
	-- a pure list of one literal kind is the one unnamed shape whose element
	-- type is readable; anything else in the table gives it up
	local itemKind: string? = nil
	local readable = true
	for _, entry in expr.entries do
		local entryKind = entry.tag or entry.kind
		local name: string? = nil
		local keyToken: any = nil
		if entryKind == "record" then
			name = entry.key.text
			keyToken = entry.key
		elseif entryKind == "general" and entry.key ~= nil and entry.key.tag == "string" then
			-- string tokens carry content only (delimiters are trivia), so
			-- stripping would corrupt keys that merely look quoted
			name = entry.key.token.text
			keyToken = entry.key.token
		end
		if name == nil then
			-- neither is public surface, but a list item still tells the
			-- element type. Once the table has given up, the items go
			-- unevaluated rather than rediscover what the first settled.
			if entryKind ~= "list" then
				readable = false
			elseif readable then
				-- and must not be evaluated: that claims the doc block above
				-- its first field, which belongs to whatever it was written
				-- for and never to a list item
				if ungroup(entry.value).tag == "table" then
					readable = false
					continue
				end
				local item = evalExpr(ctx, entry.value)
				local kind = if item.kind == "literal" and item.valueKind ~= "nil" then item.valueKind else nil
				if kind == nil or (itemKind ~= nil and itemKind ~= kind) then
					readable = false
				end
				itemKind = kind or itemKind
			end
			continue
		end
		-- a record half anywhere leaves no element type to read
		readable = false
		-- claim before evaluating the value: a nested table literal on the same
		-- line would otherwise claim the block depth-first, and the doc belongs
		-- to the outermost field
		local fieldDoc = comments.claim(ctx.claimIndex, keyToken.location.beginLine)
		local fieldValue = evalExpr(ctx, entry.value)
		local declaredType = if entry.value.tag == "cast" then entry.value.annotation else nil
		setField(value, name :: string, {
			name = name :: string,
			value = fieldValue,
			isColonMethod = false,
			declaredType = declaredType,
			fieldDoc = fieldDoc,
			trailingDesc = comments.trailingText(ctx.trailingIndex, keyToken.location.beginLine),
			keySpan = keyToken.location,
			defSpan = entry.value.location or keyToken.location,
		})
	end
	if readable and itemKind ~= nil then
		value.arrayItemKind = itemKind
	end
	return value
end

evalExpr = function(ctx: Ctx, expr: any): SymValue
	if expr == nil then
		return opaque(nil)
	end
	local tag = expr.tag

	if tag == "table" then
		return evalTable(ctx, expr)
	elseif tag == "local" then
		return ctx.env[expr["local"]] or opaque(expr)
	elseif tag == "global" then
		if expr.name.text == "script" then
			return { kind = "ipath", segs = {}, span = expr.location }
		end
		return opaque(expr, expr.name.text)
	elseif tag == "string" or tag == "number" or tag == "boolean" or tag == "nil" then
		return {
			kind = "literal",
			valueKind = tag,
			span = expr.location,
		}
	elseif tag == "unary" or tag == "binary" then
		if expr.operator.text == "and" then
			-- keeping both halves is what lets a realm badge and a type come
			-- off the one expression
			local result = opaque(expr)
			result.guard = evalExpr(ctx, expr.lhsOperand)
			result.guarded = evalExpr(ctx, expr.rhsOperand)
			return result
		end
		-- negation keeps its operand's type, so a numeric one settles it. Unary
		-- only: binary `-` is subtraction, which the table below leaves out.
		if tag == "unary" and expr.operator.text == "-" then
			local operand = evalExpr(ctx, expr.operand)
			if operand.kind == "literal" and operand.valueKind == "number" then
				return { kind = "literal", valueKind = "number", span = expr.location }
			end
			return opaque(expr)
		end
		-- the operators Luau gives one result type regardless of what a
		-- metamethod hands back at runtime. Arithmetic and `..` are left out:
		-- `a + b` is a Vector3 as readily as a number.
		local valueKind = OPERATOR_RESULTS[expr.operator.text]
		if valueKind == nil then
			return opaque(expr)
		end
		return { kind = "literal", valueKind = valueKind, span = expr.location }
	elseif tag == "group" then
		return evalExpr(ctx, expr.expression)
	elseif tag == "cast" then
		-- clone so the cast annotates only this use site: the operand may be a
		-- shared SymValue. Shallow, so members defined through either stay visible.
		local wrapped = table.clone(evalExpr(ctx, expr.operand))
		wrapped.castType = expr.annotation
		return wrapped
	elseif tag == "function" then
		return { kind = "function", fnNode = expr, span = expr.location }
	elseif tag == "indexname" then
		local base = unguard(evalExpr(ctx, expr.expression))
		return indexValue(base, expr.index.text, expr)
	elseif tag == "call" then
		local callee = calleePath(expr.func)
		local args = {}
		for _, pair in expr.arguments do
			table.insert(args, pair.node)
		end
		if callee == "require" then
			-- resolve the argument NOW while the local environment is alive
			local requireInfo: any = { kind = "dynamic" }
			local arg = args[1]
			if arg ~= nil then
				if arg.tag == "string" then
					requireInfo = { kind = "string", text = arg.token.text }
				else
					local argValue = evalExpr(ctx, arg)
					if argValue.kind == "ipath" then
						requireInfo = { kind = "ipath", segs = argValue.segs }
					end
				end
			end
			return { kind = "require", requireInfo = requireInfo, span = expr.location }
		elseif callee == "setmetatable" then
			local target = evalExpr(ctx, args[1])
			if target.kind == "table" then
				target.metatable = evalExpr(ctx, args[2])
			end
			return target
		elseif callee == "table.freeze" then
			local target = evalExpr(ctx, args[1])
			if target.kind == "table" then
				target.frozen = true
			end
			return target
		elseif callee == "game:GetService" then
			-- a named service is realm evidence: detect resolves locals bound
			-- to one, so the name has to survive evaluation
			local arg = args[1]
			if arg ~= nil and arg.tag == "string" then
				return { kind = "opaque", callee = callee, service = arg.token.text, span = expr.location }
			end
		elseif callee == "table.clone" then
			-- a clone is a NEW table: members defined on it later must not
			-- appear on the original, so it gets its own field identity
			local original = evalExpr(ctx, args[1])
			if original.kind == "table" then
				local copy = table.clone(original)
				copy.fields = table.clone(original.fields :: { SymField })
				copy.fieldIndex = table.clone(original.fieldIndex :: { [string]: number })
				copy.span = expr.location
				-- table.clone returns an unfrozen table even from a frozen one
				copy.frozen = nil
				return copy
			end
			return original
		end
		-- methods on an engine receiver: the path ones extend the path
		-- (`script.X:WaitForChild("Name")`), the rest name the engine's own
		local calleeValue: SymValue? = nil
		if expr.func ~= nil and expr.func.tag == "indexname" then
			local method = expr.func.index.text
			local base = unguard(evalExpr(ctx, expr.func.expression))
			if expr.func.accessor.text == ":" then
				if
					(method == "WaitForChild" or method == "FindFirstChild")
					and base.kind == "ipath"
					and args[1] ~= nil
					and args[1].tag == "string"
				then
					local segs = table.clone(base.segs :: { string })
					table.insert(segs, args[1].token.text)
					return { kind = "ipath", segs = segs, dotted = base.dotted, span = expr.location }
				end
				if base.kind == "ipath" or base.service ~= nil or base.callee == "game" then
					-- the receiver is engine-owned, so the method name is the
					-- engine's: its return type is a lookup rather than a guess
					return { kind = "opaque", callee = callee, engineMethod = method, span = expr.location }
				end
			end
			-- the receiver above is the only evaluation of it: what the callee
			-- resolves to is one index off it, never a second walk
			calleeValue = indexValue(base, method, expr.func)
		elseif expr.func ~= nil then
			calleeValue = evalExpr(ctx, expr.func)
		end
		local result = opaque(expr, callee)
		result.calleeValue = calleeValue
		return result
	end
	return opaque(expr)
end

--- True for expressions that re-bind an existing value (`Foo`, `M.sub`) rather
--- than defining one: they evaluate to a SymValue shared with the original.
local function isRebindExpr(node: any): boolean
	node = ungroup(node)
	return node ~= nil and (node.tag == "local" or node.tag == "indexname")
end

--- An index chain as (container table, field name, accessor).
local function resolveIndexChain(ctx: Ctx, expr: any): (SymValue?, string?, string?)
	if expr == nil or expr.tag ~= "indexname" then
		return nil, nil, nil
	end
	-- unguarded like every other value consumer: a field assigned into a
	-- conditionally mounted table (`M.cache = IsServer() and {}`, then
	-- `M.cache.entries = 1`) belongs to the table the guard admits
	local base = unguard(evalExpr(ctx, expr.expression))
	if base.kind == "table" then
		return base, expr.index.text, expr.accessor.text
	end
	return nil, nil, nil
end

--- The bookkeeping every binding statement shares, so `local X = ...` and
--- forward-declare-then-assign (`local T` ... `T = require(x)`, the
--- cyclic-require workaround) cannot drift apart.
local function bindLocal(ctx: Ctx, cstLocal: any, value: SymValue, doc: DocBlock?, isFirst: boolean)
	if isFirst and doc ~= nil and value.defDoc == nil then
		value.defDoc = doc
	end
	ctx.env[cstLocal] = value
	if value.kind == "require" then
		ctx.requireLocals[cstLocal.name.text] = value
	end
end

function surface.evaluate(
	parsed: Parsed,
	claimIndex: { [number]: DocBlock },
	trailingIndex: comments.TrailingIndex
): SurfaceResult
	local ctx: Ctx = {
		env = {},
		claimIndex = claimIndex,
		trailingIndex = trailingIndex,
		types = {},
		requireLocals = {},
	}
	local result: SymValue? = nil
	local firstStatLine: number? = nil
	local processStatements

	local function processStatement(stat: any, topLevel: boolean)
		local tag = stat.tag
		if firstStatLine == nil then
			firstStatLine = parseMod.effectiveStartLine(stat)
		end

		if tag == "local" then
			local doc = comments.claim(claimIndex, parseMod.effectiveStartLine(stat))
			local values = stat.values or {}
			for i, varPair in stat.variables do
				local cstLocal = varPair.node
				local valuePair = values[i]
				local value = if valuePair ~= nil then evalExpr(ctx, valuePair.node) else opaque(nil)
				-- an alias re-bind (`local F = Foo`) returns the original's own
				-- SymValue: never clobber its docs, and never stamp the new
				-- local's annotation onto the shared value
				if
					cstLocal.annotation ~= nil
					and value.annotation == nil
					and not isRebindExpr(if valuePair ~= nil then valuePair.node else nil)
				then
					value.annotation = cstLocal.annotation
				end
				if value.span == nil then
					value.span = stat.location
				end
				bindLocal(ctx, cstLocal, value, doc, i == 1)
			end
		elseif tag == "localfunction" then
			local doc = comments.claim(claimIndex, parseMod.effectiveStartLine(stat))
			local value: SymValue = { kind = "function", fnNode = stat.func, defDoc = doc, span = stat.location }
			ctx.env[stat.name] = value
		elseif tag == "function" then
			local doc = comments.claim(claimIndex, parseMod.effectiveStartLine(stat))
			local nameExpr = stat.name
			if nameExpr ~= nil and nameExpr.tag == "indexname" then
				local target, fieldName, accessor = resolveIndexChain(ctx, nameExpr)
				if target ~= nil then
					setField(target, fieldName :: string, {
						name = fieldName :: string,
						value = { kind = "function", fnNode = stat.func, span = stat.location },
						isColonMethod = accessor == ":",
						defDoc = doc,
						keySpan = nameExpr.index.location or stat.location,
						defSpan = stat.location,
					})
				end
			elseif nameExpr ~= nil and nameExpr.tag == "local" then
				ctx.env[nameExpr["local"]] =
					{ kind = "function", fnNode = stat.func, defDoc = doc, span = stat.location }
			end
		elseif tag == "assign" then
			local doc = comments.claim(claimIndex, parseMod.effectiveStartLine(stat))
			local values = stat.values or {}
			for i, varPair in stat.variables do
				local lhs = varPair.node
				local valuePair = values[i]
				local rhs = if valuePair ~= nil then evalExpr(ctx, valuePair.node) else opaque(nil)
				if lhs.tag == "local" then
					bindLocal(ctx, lhs["local"], rhs, doc, i == 1)
				elseif lhs.tag == "indexname" then
					local target, fieldName = resolveIndexChain(ctx, lhs)
					-- `__index` is machinery, not a member: surfacing it would
					-- make a class built with it list itself as a field
					if target ~= nil and fieldName ~= "__index" then
						local declaredType = if valuePair ~= nil and valuePair.node.tag == "cast"
							then valuePair.node.annotation
							else nil
						setField(target, fieldName :: string, {
							name = fieldName :: string,
							value = rhs,
							isColonMethod = false,
							declaredType = declaredType,
							defDoc = if i == 1 then doc else nil,
							trailingDesc = comments.trailingText(ctx.trailingIndex, lhs.index.location.beginLine),
							keySpan = lhs.index.location,
							defSpan = stat.location,
						})
					end
				end
			end
		elseif tag == "typealias" or tag == "typefunction" then
			local doc = comments.claim(claimIndex, parseMod.effectiveStartLine(stat))
			table.insert(ctx.types, {
				name = stat.name.text,
				exported = stat.export ~= nil,
				kind = if tag == "typealias" then "alias" else "typefunction",
				stat = stat,
				doc = doc,
			})
		elseif tag == "return" then
			-- only the chunk's trailing return defines the module surface
			if topLevel then
				local exprs = stat.expressions or {}
				if exprs[1] ~= nil then
					result = evalExpr(ctx, exprs[1].node)
				else
					result = { kind = "literal", valueKind = "nil", span = stat.location }
				end
			end
		elseif tag == "expression" then
			-- statement-form `setmetatable(M, mt)` / `table.freeze(M)`
			evalExpr(ctx, stat.expression)
		elseif tag == "conditional" then
			-- conditional mounts are still public surface
			-- (`if isClient then M.UI = require(script.UI) end`)
			if stat.thenBlock ~= nil then
				processStatements(stat.thenBlock.statements, false)
			end
			for _, branch in stat.elseifs or {} do
				if branch.thenBlock ~= nil then
					processStatements(branch.thenBlock.statements, false)
				end
			end
			if stat.elseBlock ~= nil then
				processStatements(stat.elseBlock.statements, false)
			end
		elseif tag == "do" then
			if stat.body ~= nil then
				processStatements(stat.body.statements, false)
			end
		end
		-- while/for/repeat and nested function bodies are intentionally not scanned
	end

	processStatements = function(stats: any, topLevel: boolean)
		for _, stat in stats or {} do
			processStatement(stat, topLevel)
		end
	end

	processStatements(parsed.cst.root.statements, true)

	return {
		result = result,
		types = ctx.types,
		requireLocals = ctx.requireLocals,
		firstStatLine = firstStatLine,
		env = ctx.env,
	}
end

function surface.isMetamethod(name: string): boolean
	return name:sub(1, 2) == "__"
end

local function hasColonMethod(sym: SymValue): boolean
	for _, field in sym.fields or {} do
		if field.isColonMethod then
			return true
		end
	end
	return false
end

--- A table is a class if it has an explicit `@class` tag or a colon-defined
--- method. `T.__index = T` is deliberately not a rule: it makes a module
--- self-indexing as often as it builds a class, and a class written that way
--- has colon methods anyway.
function surface.classify(sym: SymValue, hasClassTag: boolean): boolean
	return sym.kind == "table" and (hasClassTag or hasColonMethod(sym))
end

return surface

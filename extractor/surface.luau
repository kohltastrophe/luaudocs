--- Public-surface discovery: symbolically evaluates a module chunk's statements
--- and resolves what the module returns, without executing anything.
--- Also owns OOP-class classification over the surfaced tables (classify,
--- isMetamethod), which only means anything next to SymValue.
---
--- The environment maps CstLocal *identity* -> SymValue; the parser links every
--- local reference to its binding via `expr.local`, so it handles shadowing for
--- us. Top-level statements are evaluated, and so are `if`/`elseif`/`else` and
--- `do` bodies (a conditional mount is still public surface); loops and
--- function bodies are not. Only the chunk's own trailing `return` defines the
--- surface: an early return inside a branch is ignored.

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
	selfIndexing: boolean?, -- `T.__index = T` was assigned (the field itself is not surfaced)
	isEmptyLiteral: boolean?, -- spelled `{}`, whatever was assigned into it later
	arrayItemKind: string?, -- literal kind shared by every item of a pure list
	-- require
	requireInfo: { kind: "string" | "ipath" | "dynamic", text: string?, segs: { string }? }?,
	-- import (member of a required module: `raw = State.raw`)
	base: SymValue?,
	path: { string }?,
	-- function
	fnNode: any?, -- CstExprFunction
	returnedRequire: SymValue?, -- `return require(...)` inside a lazy loader function
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

--- Operator token text mapped to the `valueKind` its result always produces.
--- Unary and binary operators share one table because no operator in this set
--- is valid in both forms.
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

--- Strips `A and B` guard wrappers to reach the guarded value `B`, returning
--- both `B` and whether any guard was stripped. Indexing or calling through a
--- guarded value operates on the underlying value (`Server:WaitForChild("Tools")`
--- runs only where `Server` is the instance).
local function unguard(value: SymValue): (SymValue, boolean)
	local guarded = false
	while value.guarded ~= nil do
		value = value.guarded :: SymValue
		guarded = true
	end
	return value, guarded
end

surface.unguard = unguard

local unwrapExpr = parseMod.unwrapExpr

--- Returns the dotted callee path when statically nameable (`"require"`, `"table.freeze"`).
local function calleePath(expr: any): string?
	expr = unwrapExpr(expr)
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

local function evalRequireCall(ctx: Ctx, arg: any, span: Span?): SymValue
	-- Resolve the argument now while the local environment is still in scope.
	local requireInfo: any = { kind = "dynamic" }
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
	return { kind = "require", requireInfo = requireInfo, span = span }
end

local function evalRequireExpr(ctx: Ctx, expr: any): SymValue?
	expr = unwrapExpr(expr, true)
	if expr ~= nil and expr.tag == "call" and calleePath(expr.func) == "require" then
		local first = expr.arguments and expr.arguments[1]
		return evalRequireCall(ctx, first and first.node, expr.location)
	end
	return nil
end

local function newFunction(ctx: Ctx, fnNode: any, defDoc: DocBlock?, span: Span?): SymValue
	local returnedRequire: SymValue? = nil
	local stats = fnNode and fnNode.body and fnNode.body.statements
	if stats ~= nil and #stats == 1 and stats[1].tag == "return" then
		local exprs = stats[1].expressions
		if exprs ~= nil and exprs[1] ~= nil then
			returnedRequire = evalRequireExpr(ctx, exprs[1].node)
		end
	end
	return { kind = "function", fnNode = fnNode, returnedRequire = returnedRequire, defDoc = defDoc, span = span }
end

--- Evaluates indexing `base` by `indexText`. Factored out of `indexname`
--- evaluation so method and function calls can look up the callee on the
--- already-evaluated receiver without evaluating the receiver expression twice.
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
		-- `game.Players` names a Roblox service just like `game:GetService("Players")`.
		return { kind = "opaque", callee = "game." .. indexText, service = indexText, span = expr.location }
	elseif base.kind == "opaque" and base.callee ~= nil then
		-- Preserve a global's dotted path (`Enum.Material`, `Color3.new`) so type
		-- inference can recognize engine library roots. A shadowed local never
		-- reaches this branch because it evaluates to its own binding above.
		return { kind = "opaque", callee = base.callee .. "." .. indexText, span = expr.location }
	end
	return opaque(expr)
end

--- Looks up a named field on a table `SymValue` via `fieldIndex`.
function surface.fieldOf(sym: SymValue, name: string): SymField?
	local idx = (sym.fieldIndex :: { [string]: number })[name]
	return if idx ~= nil then (sym.fields :: { SymField })[idx] else nil
end

--- Unwraps `typeNode` (following at most one same-module type alias hop in
--- `types`) and returns the underlying table type node, or `nil`.
function surface.unwrapTableType(typeNode: any, types: { TypeAliasInfo }?): any
	typeNode = parseMod.unwrapType(typeNode)
	if
		typeNode ~= nil
		and typeNode.tag == "reference"
		and typeNode.prefix == nil
		and typeNode.name ~= nil
		and types ~= nil
	then
		for _, ty in types do
			if ty.name == typeNode.name.text and ty.stat ~= nil then
				typeNode = parseMod.unwrapType(ty.stat.type)
				break
			end
		end
	end
	return if typeNode ~= nil and typeNode.tag == "table" and typeNode.entries ~= nil then typeNode else nil
end

local function setField(target: SymValue, name: string, field: SymField)
	local fields = target.fields :: { SymField }
	local index = target.fieldIndex :: { [string]: number }
	local existing = index[name]
	if existing ~= nil then
		-- Keep the original field position; later definition data wins and docs merge.
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
	-- A pure list of a single literal kind is the only unnamed table shape whose
	-- element type (`{ string }`, `{ number }`) we can infer; any record or mixed
	-- entry disqualifies it.
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
			-- String tokens carry content only (delimiters are trivia), so
			-- stripping quotes would corrupt keys that contain literal quote characters.
			name = entry.key.token.text
			keyToken = entry.key.token
		end
		if name == nil then
			-- List and computed-key entries are not public surface members, but
			-- homogeneous list entries still determine `arrayItemKind`. Once a
			-- list is disqualified (`readable == false`), skip evaluating the
			-- remaining list items.
			if entryKind ~= "list" then
				readable = false
			elseif readable then
				-- Do not evaluate a nested table literal inside a list: doing so
				-- would claim the doc block above its first field, which never
				-- belongs to an unnamed list item.
				if unwrapExpr(entry.value).tag == "table" then
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
		-- Any named record field means this table is not a pure array literal.
		readable = false
		-- Claim the doc block before evaluating the field value so a nested table
		-- literal on the same line cannot claim the outer field's doc block first.
		local fieldDoc = comments.claim(ctx.claimIndex, keyToken.location.beginLine)
		local fieldValue = evalExpr(ctx, entry.value)
		local rhsNode = unwrapExpr(entry.value)
		local declaredType = if rhsNode ~= nil and rhsNode.tag == "cast" then rhsNode.annotation else nil
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
	elseif tag == "string" or tag == "interpolatedstring" or tag == "number" or tag == "boolean" or tag == "nil" then
		return {
			kind = "literal",
			valueKind = if tag == "interpolatedstring" then "string" else tag,
			span = expr.location,
		}
	elseif tag == "conditional" then
		local thenVal = evalExpr(ctx, expr.thenExpr)
		local elseVal = evalExpr(ctx, expr.elseExpr)
		local elseifs = expr.elseifs or {}
		-- `if cond then X else nil`: the `--!strict` spelling of `cond and X`.
		if
			#elseifs == 0
			and elseVal.kind == "literal"
			and elseVal.valueKind == "nil"
			and not (thenVal.kind == "literal" and thenVal.valueKind == "nil")
		then
			local result = opaque(expr)
			result.guard = evalExpr(ctx, expr.condition)
			result.guarded = thenVal
			return result
		end
		if thenVal.kind == "literal" and thenVal.valueKind ~= "nil" then
			local kind = thenVal.valueKind
			local same = elseVal.kind == "literal" and elseVal.valueKind == kind
			for _, branch in elseifs do
				if not same then
					break
				end
				local bVal = evalExpr(ctx, branch.thenExpr)
				same = bVal.kind == "literal" and bVal.valueKind == kind
			end
			if same then
				return { kind = "literal", valueKind = kind, span = expr.location }
			end
		end
		return opaque(expr)
	elseif tag == "unary" or tag == "binary" then
		if expr.operator.text == "and" then
			-- Preserving both halves lets realm detection read `guard` while
			-- type and surface resolution read `guarded`.
			local result = opaque(expr)
			result.guard = evalExpr(ctx, expr.lhsOperand)
			result.guarded = evalExpr(ctx, expr.rhsOperand)
			return result
		end
		-- Unary negation preserves a numeric literal's type; binary `-` is
		-- subtraction, which `OPERATOR_RESULTS` intentionally omits.
		if tag == "unary" and expr.operator.text == "-" then
			local operand = evalExpr(ctx, expr.operand)
			if operand.kind == "literal" and operand.valueKind == "number" then
				return { kind = "literal", valueKind = "number", span = expr.location }
			end
			return opaque(expr)
		end
		-- Only operators whose result type is fixed by Luau regardless of
		-- metamethods belong in `OPERATOR_RESULTS`. Arithmetic and `..` are
		-- excluded because `a + b` can produce a `Vector3` as readily as a `number`.
		local valueKind = OPERATOR_RESULTS[expr.operator.text]
		if valueKind == nil then
			return opaque(expr)
		end
		return { kind = "literal", valueKind = valueKind, span = expr.location }
	elseif tag == "group" or tag == "instantiate" then
		return evalExpr(ctx, expr.expression or expr.expr)
	elseif tag == "cast" then
		-- Shallow-clone so `castType` annotates only this use site without
		-- mutating a shared `SymValue`, while keeping `fields` shared so later
		-- field assignments on either reference remain visible.
		local wrapped = table.clone(evalExpr(ctx, expr.operand))
		wrapped.castType = expr.annotation
		return wrapped
	elseif tag == "function" then
		return newFunction(ctx, expr, nil, expr.location)
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
			return evalRequireCall(ctx, args[1], expr.location)
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
			-- Record the service name so `detect` can recognize locals bound to
			-- realm-specific services like `RunService` or `ServerStorage`.
			local arg = args[1]
			if arg ~= nil and arg.tag == "string" then
				return { kind = "opaque", callee = callee, service = arg.token.text, span = expr.location }
			end
		elseif callee == "table.clone" then
			-- `table.clone` produces a distinct table with its own `fields` and
			-- `fieldIndex` so members added to the clone do not leak onto the original.
			local original = evalExpr(ctx, args[1])
			if original.kind == "table" then
				local copy = table.clone(original)
				copy.fields = table.clone(original.fields :: { SymField })
				copy.fieldIndex = table.clone(original.fieldIndex :: { [string]: number })
				copy.span = expr.location
				-- `table.clone` returns an unfrozen table even when cloning a frozen one.
				copy.frozen = nil
				return copy
			end
			return original
		end
		-- Methods on an engine receiver either extend an instance path
		-- (`script.X:WaitForChild("Name")`) or call an engine Instance method.
		local calleeValue: SymValue? = nil
		local func = unwrapExpr(expr.func)
		if func ~= nil and func.tag == "indexname" then
			local method = func.index.text
			local base = unguard(evalExpr(ctx, func.expression))
			if func.accessor.text == ":" then
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
					-- The receiver is an engine Instance, so its method return type
					-- can be looked up directly in `engine.luau`.
					return { kind = "opaque", callee = callee, engineMethod = method, span = expr.location }
				end
			end
			-- Index into the already-evaluated `base` rather than walking `func` a second time.
			calleeValue = indexValue(base, method, func)
		elseif func ~= nil then
			calleeValue = evalExpr(ctx, func)
		end
		local result = opaque(expr, callee)
		result.calleeValue = calleeValue
		return result
	end
	return opaque(expr)
end

--- Returns true for expressions that re-bind an existing value (`Foo`, `M.sub`)
--- rather than defining a new one; they evaluate to the original's shared `SymValue`.
local function isRebindExpr(node: any): boolean
	node = unwrapExpr(node)
	return node ~= nil and (node.tag == "local" or node.tag == "indexname")
end

--- Resolves an `indexname` expression to `(containerTable, fieldName, accessor)`.
local function resolveIndexChain(ctx: Ctx, expr: any): (SymValue?, string?, string?)
	if expr == nil or expr.tag ~= "indexname" then
		return nil, nil, nil
	end
	-- Unguard the base so fields assigned onto a conditionally mounted table
	-- (`M.cache = IsServer() and {}`, then `M.cache.entries = 1`) attach to
	-- the underlying table.
	local base = unguard(evalExpr(ctx, expr.expression))
	if base.kind == "table" then
		return base, expr.index.text, expr.accessor.text
	end
	return nil, nil, nil
end

--- Shared local-binding bookkeeping for both `local X = ...` and
--- forward-declare-then-assign (`local T` ... `T = require(x)`).
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
				-- An alias re-bind (`local F = Foo`) returns the original's own
				-- `SymValue`: do not overwrite its docs or stamp the alias local's
				-- type annotation onto the shared value.
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
			ctx.env[stat.name] = newFunction(ctx, stat.func, doc, stat.location)
		elseif tag == "function" then
			local doc = comments.claim(claimIndex, parseMod.effectiveStartLine(stat))
			local nameExpr = stat.name
			if nameExpr ~= nil and nameExpr.tag == "indexname" then
				local target, fieldName, accessor = resolveIndexChain(ctx, nameExpr)
				if target ~= nil then
					setField(target, fieldName :: string, {
						name = fieldName :: string,
						value = newFunction(ctx, stat.func, nil, stat.location),
						isColonMethod = accessor == ":",
						defDoc = doc,
						keySpan = nameExpr.index.location or stat.location,
						defSpan = stat.location,
					})
				end
			elseif nameExpr ~= nil and nameExpr.tag == "local" then
				ctx.env[nameExpr["local"]] = newFunction(ctx, stat.func, doc, stat.location)
			end
		elseif tag == "assign" then
			local doc = comments.claim(claimIndex, parseMod.effectiveStartLine(stat))
			local values = stat.values or {}
			-- Evaluate all right-hand sides before mutating any left-hand bindings
			-- so parallel assignments like `a, b = b, a` read the pre-statement state.
			local rhsValues: { SymValue } = {}
			for i in stat.variables do
				local valuePair = values[i]
				rhsValues[i] = if valuePair ~= nil then evalExpr(ctx, valuePair.node) else opaque(nil)
			end
			for i, varPair in stat.variables do
				local lhs = varPair.node
				local valuePair = values[i]
				local rhs = rhsValues[i]
				if lhs.tag == "local" then
					bindLocal(ctx, lhs["local"], rhs, doc, i == 1)
				elseif lhs.tag == "indexname" then
					local target, fieldName = resolveIndexChain(ctx, lhs)
					-- `__index` is metatable machinery, not a public member: surfacing
					-- it would make `T.__index = T` list the class as a field of itself.
					-- Record `selfIndexing = true` instead (see `isSelfIndexing`).
					if target ~= nil and fieldName == "__index" then
						if rhs.kind == "table" and rhs.fields == target.fields then
							target.selfIndexing = true
						end
					elseif target ~= nil then
						local rhsNode = if valuePair ~= nil then unwrapExpr(valuePair.node) else nil
						local declaredType = if rhsNode ~= nil and rhsNode.tag == "cast"
							then rhsNode.annotation
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
			-- Only the chunk's top-level return defines the module surface.
			if topLevel then
				local exprs = stat.expressions or {}
				if exprs[1] ~= nil then
					result = evalExpr(ctx, exprs[1].node)
				else
					result = { kind = "literal", valueKind = "nil", span = stat.location }
				end
			end
		elseif tag == "expression" then
			-- Statement-form `setmetatable(M, mt)` or `table.freeze(M)`.
			evalExpr(ctx, stat.expression)
		elseif tag == "conditional" then
			-- Conditional mounts are part of the public surface
			-- (`if isClient then M.UI = require(script.UI) end`).
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
		-- Loops (`while`/`for`/`repeat`) and nested function bodies are intentionally not scanned.
	end

	processStatements = function(stats: any, topLevel: boolean)
		for _, stat in stats or {} do
			processStatement(stat, topLevel)
		end
	end

	processStatements(parsed.cst.root.statements, true)

	if result ~= nil and result.kind == "table" then
		-- Delegate fields from `setmetatable(M, { __index = Proto })` when `Proto`
		-- is another table or a local factory call (`local Registry = new()`).
		local mt = result.metatable
		if mt ~= nil and mt.kind == "table" then
			local idxField = surface.fieldOf(mt, "__index")
			local proto = if idxField ~= nil then idxField.value else nil
			if
				proto ~= nil
				and proto.kind == "opaque"
				and proto.calleeValue ~= nil
				and proto.calleeValue.kind == "function"
			then
				local body = proto.calleeValue.fnNode and proto.calleeValue.fnNode.body
				if body ~= nil then
					local saved = result
					result = nil
					processStatements(body.statements, true)
					proto = result or proto
					result = saved
				end
			end
			if proto ~= nil and proto.kind == "table" and proto.fields ~= result.fields then
				for _, f in proto.fields :: { SymField } do
					if surface.fieldOf(result :: SymValue, f.name) == nil then
						setField(result :: SymValue, f.name, f)
					end
				end
			end
		end
		-- Synthesize module mounts declared as `Key: typeof(require(...))` on the
		-- returned table's type annotation (lazy `__index` module tables).
		local ann = surface.unwrapTableType(result.annotation or result.castType, ctx.types)
		if ann ~= nil then
			for _, entry in ann.entries do
				if
					parseMod.isTypeProperty(entry)
					and entry.key ~= nil
					and surface.fieldOf(result, entry.key.text) == nil
				then
					local valType = parseMod.unwrapType(entry.value)
					local reqSym = if valType ~= nil and valType.tag == "typeof"
						then evalRequireExpr(ctx, valType.expression or valType.expr)
						else nil
					if reqSym ~= nil then
						setField(result, entry.key.text, {
							name = entry.key.text,
							value = reqSym,
							isColonMethod = false,
							fieldDoc = comments.claim(claimIndex, entry.key.location.beginLine),
							keySpan = entry.key.location,
							defSpan = entry.location or entry.key.location,
						})
					end
				end
			end
		end
	end

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

--- Checks for `function T.f(self: T, ...)`: the explicitly typed form of a
--- method, which Luau's `:` syntax cannot annotate. Callers still invoke it as
--- `t:f(...)`, so it is documented as a method. Metamethods are excluded by the caller.
function surface.isSelfMethod(fnNode: any): boolean
	local first = fnNode ~= nil and fnNode.parameters ~= nil and fnNode.parameters[1]
	local param = if first then first.node else nil
	return param ~= nil and param.name ~= nil and param.name.text == "self"
end

local function hasMethod(sym: SymValue): boolean
	for _, field in sym.fields or {} do
		if field.isColonMethod then
			return true
		end
		if
			field.value.kind == "function"
			and not surface.isMetamethod(field.name)
			and surface.isSelfMethod(field.value.fnNode)
		then
			return true
		end
	end
	return false
end

--- Returns true if `sym` is a class table: either it has an explicit `@class`
--- tag or it defines at least one method (`:` syntax or a `.` function taking
--- `self` first). `T.__index = T` alone is not enough because modules use
--- self-indexing too, though `T.__index = T` paired with a constructor
--- `setmetatable(..., T)` does promote `T` in `model/build.luau`.
function surface.classify(sym: SymValue, hasClassTag: boolean): boolean
	return sym.kind == "table" and (hasClassTag or hasMethod(sym))
end

--- Returns true when `T.__index = T` was assigned on `sym`.
function surface.isSelfIndexing(sym: SymValue): boolean
	return sym.kind == "table" and sym.selfIndexing == true
end

return surface

--!strict

--- Public-surface discovery. Symbolically evaluates a module chunk's statements
--- and `.d.luau` ambient declarations (`declare class`, `declare extern type`,
--- `declare function`, `declare <name>: <Type>`) to resolve what the module
--- exposes without executing code. Also owns prototype `__index` delegation and
--- OOP-class classification (`classify`, `isMetamethod`) over `SymValue` tables.
---
--- Maps CstLocal *identity* to `SymValue`. The parser links every local reference
--- to its binding via `expr.local`, handling shadowing automatically. Evaluates
--- top-level statements along with `if`/`elseif`/`else` and `do` bodies (a
--- conditional mount is still public surface), while skipping loops and function
--- bodies. Only the chunk's own trailing `return` defines the runtime surface,
--- ignoring early returns inside branches; ambient-only `.d.luau` modules fall
--- back to their synthesized declaration root.

local util = require("./util")
local parseMod = require("./parse")
local comments = require("./comments")
local requiresMod = require("./requires")
local tagsMod = require("./tags")

type Span = parseMod.Span
type Parsed = parseMod.Parsed
type DocBlock = comments.DocBlock

export type SymValue = {
	kind: "table" | "require" | "import" | "function" | "literal" | "opaque" | "ipath",
	-- table
	fields: { SymField }?,
	fieldIndex: { [string]: number }?,
	metatable: SymValue?,
	indexTarget: SymValue?, -- `MT.__index = Proto` when `Proto ~= MT`
	origin: SymValue?, -- underlying `SymValue` before a `::` cast clone
	frozen: boolean?, -- passed through table.freeze (shallow, like the freeze)
	selfIndexing: boolean?, -- `T.__index = T` was assigned (the field itself is not surfaced)
	isEmptyLiteral: boolean?, -- spelled `{}`, whatever was assigned into it later
	arrayItemKind: string?, -- literal kind shared by every item of a pure list
	-- require
	requireInfo: requiresMod.RequireInfo?,
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
	isDeclaredRoot: boolean?,
}

export type SymField = {
	name: string,
	value: SymValue,
	--- Defined as `function T:name()`. Decides `:` vs `.` in the rendered
	--- callee, and one colon method makes its table a class.
	isColonMethod: boolean,
	declaredType: any?, -- CstType from `:: T` on the field value
	readonly: boolean?,
	isDeclared: boolean?,
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

export type DeclaredClassInfo = {
	name: string,
	value: SymValue,
	secondaryDoc: DocBlock?,
}

export type SurfaceResult = {
	result: SymValue?,
	types: { TypeAliasInfo },
	declaredClasses: { DeclaredClassInfo }?,
	requireLocals: { [string]: SymValue }, -- local name -> require SymValue (for type prefix resolution)
	firstStatLine: number?,
	env: { [any]: SymValue }, -- CstLocal -> SymValue (classType/constructor detection)
}

local surface = {}

function surface.isMetamethod(name: string): boolean
	return name:sub(1, 2) == "__"
end

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
	parsed: Parsed,
	env: { [any]: SymValue },
	claimIndex: { [number]: DocBlock },
	trailingIndex: comments.TrailingIndex,
	types: { TypeAliasInfo },
	requireLocals: { [string]: SymValue },
	result: SymValue?,
	firstStatLine: number?,
	declRoot: SymValue?,
	declaredClasses: { DeclaredClassInfo },
	declaredClassByName: { [string]: DeclaredClassInfo },
}

local evalExpr: (ctx: Ctx, expr: any) -> SymValue -- forward

local function evalRequireCall(ctx: Ctx, arg: any, span: Span?): SymValue
	-- Resolve the argument now while the local environment is still in scope.
	local requireInfo: requiresMod.RequireInfo = { kind = "dynamic" }
	if arg ~= nil then
		if arg.tag == "string" then
			requireInfo = { kind = "string", text = arg.token.text }
		else
			local argValue = evalExpr(ctx, arg)
			if argValue.kind == "ipath" and argValue.segs ~= nil then
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
		local req = evalRequireCall(ctx, first and first.node, expr.location)
		if req.requireInfo ~= nil and req.requireInfo.kind ~= "dynamic" then
			return req
		end
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
		local callee = base.callee :: string
		return { kind = "opaque", callee = callee .. "." .. indexText, span = expr.location }
	end
	return opaque(expr)
end

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
		-- Keep the original field position while letting later definition data win and docs merge.
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

--- Adds a declared field to `target`, preserving overloaded function entries
--- rather than overwriting earlier signatures of the same name.
local function addDeclaredField(target: SymValue, name: string, field: SymField)
	local fields = target.fields :: { SymField }
	local index = target.fieldIndex :: { [string]: number }
	local existing = index[name]
	if existing ~= nil and fields[existing].value.kind == "function" and field.value.kind == "function" then
		table.insert(fields, field)
	else
		setField(target, name, field)
	end
end

local function addDeclaredProp(
	target: SymValue,
	name: string,
	declaredType: any?,
	readonly: boolean?,
	fieldDoc: DocBlock?,
	trailingDesc: string?,
	keySpan: Span,
	defSpan: Span
)
	addDeclaredField(target, name, {
		name = name,
		value = opaque(nil),
		isColonMethod = false,
		declaredType = declaredType,
		readonly = readonly,
		fieldDoc = fieldDoc,
		trailingDesc = trailingDesc,
		keySpan = keySpan,
		defSpan = defSpan,
		isDeclared = true,
	})
end

local function fnNodeFromType(fnType: any): any
	local params: { any } = {}
	for i, pair in fnType.parameters or {} do
		local p = pair.node
		if p ~= nil then
			local nameTok = p.name or { text = "arg" .. tostring(i), location = p.type and p.type.location }
			table.insert(params, {
				node = {
					name = nameTok,
					annotation = p.type,
					location = nameTok.location,
				},
			})
		end
	end
	local va = fnType.vararg
	return {
		generics = fnType.generics,
		genericPacks = fnType.genericPacks,
		parameters = params,
		vararg = va,
		varargAnnotation = if va ~= nil and va.tag == "variadic" and va.type ~= nil then va.type else va,
		returnAnnotation = fnType.returnTypes,
		location = fnType.location,
	}
end

local function collectFunctionTypes(typeNode: any): { any }?
	typeNode = parseMod.unwrapGroup(typeNode)
	if typeNode == nil then
		return nil
	end
	if typeNode.tag == "function" then
		return { typeNode }
	end
	if typeNode.tag == "intersection" and typeNode.types ~= nil and #typeNode.types > 0 then
		local out: { any } = {}
		for _, pair in typeNode.types do
			local branch = parseMod.unwrapGroup(pair.node)
			if branch == nil or branch.tag ~= "function" then
				return nil
			end
			table.insert(out, branch)
		end
		return out
	end
	return nil
end

local function sliceIndexerKey(parsed: Parsed, keyNode: any): string
	local span = parseMod.typeSpan(keyNode)
	if span == nil then
		return "[unknown]"
	end
	local raw = util.trim((parseMod.sliceSpan(parsed, span):gsub("%s+", " ")))
	return "[" .. raw .. "]"
end

local function evalTable(ctx: Ctx, expr: any): SymValue
	local value = newTable(expr.location)
	value.isEmptyLiteral = #expr.entries == 0
	-- A pure list of a single literal kind is the only unnamed table shape whose
	-- element type (`{ string }`, `{ number }`) we can infer. Any record or mixed
	-- entry disqualifies it.
	local itemKind: string? = nil
	local readable = true
	for _, entry in expr.entries do
		local entryKind = parseMod.entryKind(entry)
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
				-- Do not evaluate a nested table literal inside a list, as doing so
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

local function evalConditionalExpr(ctx: Ctx, expr: any): SymValue
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
end

local ARITHMETIC_OPS: { [string]: boolean } = {
	["+"] = true,
	["-"] = true,
	["*"] = true,
	["/"] = true,
	["//"] = true,
	["%"] = true,
	["^"] = true,
}

local function evalOperatorExpr(ctx: Ctx, expr: any): SymValue
	local op = expr.operator.text
	if op == "and" then
		-- Preserving both halves lets realm detection read `guard` while
		-- type and surface resolution read `guarded`.
		local result = opaque(expr)
		result.guard = evalExpr(ctx, expr.lhsOperand)
		result.guarded = evalExpr(ctx, expr.rhsOperand)
		return result
	end
	-- Unary negation preserves a numeric literal's type.
	if expr.tag == "unary" and op == "-" then
		local operand = evalExpr(ctx, expr.operand)
		if operand.kind == "literal" and operand.valueKind == "number" then
			return { kind = "literal", valueKind = "number", span = expr.location }
		end
		return opaque(expr)
	end
	if expr.tag == "binary" then
		if ARITHMETIC_OPS[op] then
			local lhs = evalExpr(ctx, expr.lhsOperand)
			local rhs = evalExpr(ctx, expr.rhsOperand)
			if
				lhs.kind == "literal"
				and lhs.valueKind == "number"
				and rhs.kind == "literal"
				and rhs.valueKind == "number"
			then
				return { kind = "literal", valueKind = "number", span = expr.location }
			end
			return opaque(expr)
		elseif op == ".." then
			local lhs = evalExpr(ctx, expr.lhsOperand)
			local rhs = evalExpr(ctx, expr.rhsOperand)
			if
				lhs.kind == "literal"
				and (lhs.valueKind == "string" or lhs.valueKind == "number")
				and rhs.kind == "literal"
				and (rhs.valueKind == "string" or rhs.valueKind == "number")
			then
				return { kind = "literal", valueKind = "string", span = expr.location }
			end
			return opaque(expr)
		elseif op == "or" then
			local lhs = evalExpr(ctx, expr.lhsOperand)
			local rhs = evalExpr(ctx, expr.rhsOperand)
			if
				lhs.kind == "literal"
				and lhs.valueKind ~= "nil"
				and rhs.kind == "literal"
				and rhs.valueKind == lhs.valueKind
			then
				return { kind = "literal", valueKind = lhs.valueKind, span = expr.location }
			end
			return opaque(expr)
		end
	end
	-- Only operators whose result type is fixed by Luau regardless of
	-- metamethods belong in `OPERATOR_RESULTS`. Arithmetic and `..` over
	-- non-literals are excluded because `a + b` can produce a `Vector3` as readily as a `number`.
	local valueKind = OPERATOR_RESULTS[op]
	if valueKind == nil then
		return opaque(expr)
	end
	return { kind = "literal", valueKind = valueKind, span = expr.location }
end

--- Stamps table-level metadata onto `target` and mirrors it to `target.origin`
--- when `target` is a shallow `:: T` cast clone.
local function setTableState(target: SymValue, apply: (t: SymValue) -> ())
	apply(target)
	if target.origin ~= nil then
		apply(target.origin)
	end
end

local function evalCallExpr(ctx: Ctx, expr: any): SymValue
	local callee = calleePath(expr.func)
	local args: { any } = {}
	for _, pair in expr.arguments do
		table.insert(args, pair.node)
	end
	if callee == "require" then
		return evalRequireCall(ctx, args[1], expr.location)
	elseif callee == "setmetatable" then
		local target = evalExpr(ctx, args[1])
		if target.kind == "table" then
			local rawMt = if args[2] ~= nil then evalExpr(ctx, args[2]) else nil
			local mt = if rawMt ~= nil and not (rawMt.kind == "literal" and rawMt.valueKind == "nil")
				then rawMt
				else nil
			setTableState(target, function(t)
				t.metatable = mt
			end)
		end
		return target
	elseif callee == "table.freeze" then
		local target = evalExpr(ctx, args[1])
		if target.kind == "table" then
			setTableState(target, function(t)
				t.frozen = true
			end)
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
		return evalConditionalExpr(ctx, expr)
	elseif tag == "unary" or tag == "binary" then
		return evalOperatorExpr(ctx, expr)
	elseif tag == "group" or tag == "instantiate" then
		return evalExpr(ctx, expr.expression or expr.expr)
	elseif tag == "cast" then
		-- Shallow-clone so `castType` annotates only this use site without
		-- mutating a shared `SymValue`, while keeping `fields` shared so later
		-- field assignments on either reference remain visible.
		local inner = evalExpr(ctx, expr.operand)
		local wrapped = table.clone(inner)
		wrapped.origin = inner.origin or inner
		wrapped.castType = expr.annotation
		return wrapped
	elseif tag == "function" then
		return newFunction(ctx, expr, nil, expr.location)
	elseif tag == "indexname" then
		local base = unguard(evalExpr(ctx, expr.expression))
		return indexValue(base, expr.index.text, expr)
	elseif tag == "call" then
		return evalCallExpr(ctx, expr)
	end
	return opaque(expr)
end

--- Returns true for expressions that re-bind an existing value (`Foo`, `M.sub`)
--- rather than defining a new one. They evaluate to the original's shared `SymValue`.
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

local function processLocalStat(ctx: Ctx, stat: any)
	local doc = comments.claim(ctx.claimIndex, parseMod.effectiveStartLine(stat))
	local values = stat.values or {}
	for i, varPair in stat.variables do
		local cstLocal = varPair.node
		local valuePair = values[i]
		local value = if valuePair ~= nil then evalExpr(ctx, valuePair.node) else opaque(nil)
		-- An alias re-bind (`local F = Foo`) returns the original's own
		-- `SymValue`. Do not overwrite its docs or stamp the alias local's
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
end

local function processFunctionStat(ctx: Ctx, stat: any)
	local doc = comments.claim(ctx.claimIndex, parseMod.effectiveStartLine(stat))
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
end

local function processAssignStat(ctx: Ctx, stat: any)
	local doc = comments.claim(ctx.claimIndex, parseMod.effectiveStartLine(stat))
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
			-- `__index` is metatable machinery, not a public member. Surfacing
			-- it would make `T.__index = T` list the class as a field of itself.
			-- Record `selfIndexing = true` instead (see `isSelfIndexing`).
			if target ~= nil and fieldName == "__index" then
				local indexTarget: SymValue = rhs
				if rhs.kind == "table" and rhs.fields == target.fields then
					setTableState(target, function(t)
						t.selfIndexing = true
					end)
				elseif rhs.kind == "table" or rhs.kind == "opaque" then
					setTableState(target, function(t)
						t.indexTarget = indexTarget
					end)
				end
			elseif target ~= nil then
				local rhsNode: any = if valuePair ~= nil then unwrapExpr(valuePair.node) else nil
				local declaredType: any = if rhsNode ~= nil and rhsNode.tag == "cast" then rhsNode.annotation else nil
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
end

local function isOrphanClassProto(ctx: Ctx, result: SymValue, mt: SymValue): boolean
	if mt.defDoc ~= nil and tagsMod.className(tagsMod.parseBlock(mt.defDoc)) ~= nil then
		return true
	end
	for _, ty in ctx.types do
		local classLocal = if ty.stat ~= nil then parseMod.setmetatableTypeClassLocal(ty.stat.type) else nil
		local sym = if classLocal ~= nil then ctx.env[classLocal] else nil
		if sym ~= nil and sym.fields == mt.fields then
			return true
		end
	end
	local seen: { [SymValue]: boolean } = {}
	local function hasConstructorForMt(sym: SymValue): boolean
		if sym.kind ~= "table" or seen[sym] then
			return false
		end
		seen[sym] = true
		for _, f in (sym.fields or {}) :: { SymField } do
			if f.value.kind == "function" then
				local classLocal = parseMod.constructedClassLocal(f.value.fnNode)
				local constructed = if classLocal ~= nil then ctx.env[classLocal] else nil
				if constructed ~= nil and constructed.fields == mt.fields then
					return true
				end
			elseif f.value.kind == "table" and hasConstructorForMt(f.value) then
				return true
			end
		end
		return false
	end
	return hasConstructorForMt(result)
end

local function delegateMetatableFields(ctx: Ctx, result: SymValue, evalFactoryBody: (statements: any) -> SymValue?)
	-- Delegate non-metamethod fields from `setmetatable(M, { __index = Proto })`
	-- or a non-class `Proto.__index = Proto` prototype table when `Proto` is
	-- another table or a local factory call (`local Registry = new()`).
	local mt = result.metatable
	if mt == nil or mt.kind ~= "table" then
		return
	end
	local idxField = surface.fieldOf(mt, "__index")
	local proto: SymValue? = if idxField ~= nil
		then idxField.value
		elseif mt.indexTarget ~= nil then mt.indexTarget
		elseif mt.selfIndexing and not isOrphanClassProto(ctx, result, mt) then mt
		else nil
	if
		proto ~= nil
		and proto.kind == "opaque"
		and proto.calleeValue ~= nil
		and proto.calleeValue.kind == "function"
	then
		local body = proto.calleeValue.fnNode and proto.calleeValue.fnNode.body
		if body ~= nil then
			proto = evalFactoryBody(body.statements) or proto
		end
	end
	if proto ~= nil and proto.kind == "table" and proto.fields ~= result.fields then
		for _, f in proto.fields :: { SymField } do
			if not surface.isMetamethod(f.name) and surface.fieldOf(result, f.name) == nil then
				setField(result, f.name, table.clone(f))
			end
		end
	end
end

local function synthesizeAnnotatedMounts(ctx: Ctx, result: SymValue)
	-- Synthesize module mounts declared as `Key: typeof(require(...))` on the
	-- returned table's type annotation (lazy `__index` module tables).
	local ann = surface.unwrapTableType(result.annotation or result.castType, ctx.types)
	if ann == nil then
		return
	end
	for _, entry in ann.entries do
		if parseMod.isTypeProperty(entry) and entry.key ~= nil and surface.fieldOf(result, entry.key.text) == nil then
			local valType = parseMod.unwrapType(entry.value)
			local reqSym = if valType ~= nil and valType.tag == "typeof"
				then evalRequireExpr(ctx, valType.expression or valType.expr)
				else nil
			if reqSym ~= nil then
				setField(result, entry.key.text, {
					name = entry.key.text,
					value = reqSym,
					isColonMethod = false,
					fieldDoc = comments.claim(ctx.claimIndex, entry.key.location.beginLine),
					keySpan = entry.key.location,
					defSpan = entry.location or entry.key.location,
				})
			end
		end
	end
end

local function postProcessResult(ctx: Ctx, result: SymValue, evalFactoryBody: (statements: any) -> SymValue?)
	delegateMetatableFields(ctx, result, evalFactoryBody)
	synthesizeAnnotatedMounts(ctx, result)
end

local function processBranchStatements(stat: any, processStatements: (stats: any, topLevel: boolean) -> ())
	if stat.tag == "conditional" then
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
	elseif stat.tag == "do" and stat.body ~= nil then
		processStatements(stat.body.statements, false)
	end
end

local function syncOrigin(sym: SymValue?, seenOpt: { [SymValue]: boolean }?)
	if sym == nil then
		return
	end
	local seen = seenOpt or {}
	if seen[sym] then
		return
	end
	seen[sym] = true
	if sym.guarded ~= nil then
		syncOrigin(sym.guarded, seen)
	end
	if sym.kind ~= "table" then
		return
	end
	if sym.origin ~= nil then
		local orig = sym.origin
		sym.metatable = sym.metatable or orig.metatable
		sym.frozen = sym.frozen or orig.frozen
		sym.selfIndexing = sym.selfIndexing or orig.selfIndexing
		sym.indexTarget = sym.indexTarget or orig.indexTarget
	end
	for _, field in sym.fields or {} do
		syncOrigin(field.value, seen)
	end
	syncOrigin(sym.metatable, seen)
	syncOrigin(sym.indexTarget, seen)
end

local function ensureDeclRoot(ctx: Ctx, span: Span?): SymValue
	if ctx.declRoot == nil then
		local root = newTable(span)
		root.isDeclaredRoot = true
		ctx.declRoot = root
	end
	return ctx.declRoot :: SymValue
end

local function ensureDeclaredClass(ctx: Ctx, name: string, span: Span?, doc: DocBlock?, isClassBlock: boolean): SymValue
	local info = ctx.declaredClassByName[name]
	if info == nil then
		local sym = newTable(span)
		sym.selfIndexing = true
		sym.defDoc = doc
		local created: DeclaredClassInfo = { name = name, value = sym, secondaryDoc = nil }
		ctx.declaredClassByName[name] = created
		table.insert(ctx.declaredClasses, created)
		return sym
	else
		if isClassBlock and span ~= nil then
			info.value.span = span
		end
		if doc ~= nil then
			if info.value.defDoc == nil then
				info.value.defDoc = doc
			elseif isClassBlock then
				info.secondaryDoc = info.value.defDoc
				info.value.defDoc = doc
			else
				info.secondaryDoc = info.secondaryDoc or doc
			end
		end
	end
	return info.value
end

local function declaredEntryMeta(ctx: Ctx, entry: any): (DocBlock?, string?, boolean)
	local headToken = entry.access or entry.key or entry.indexerOpen
	local entryLine = if headToken ~= nil and headToken.location ~= nil then headToken.location.beginLine else nil
	local entryDoc = if entryLine ~= nil then comments.claim(ctx.claimIndex, entryLine) else nil
	local valEndLine = if entry.value ~= nil and entry.value.location ~= nil
		then entry.value.location.endLine
		else entryLine
	local trailingDesc = if valEndLine ~= nil then comments.trailingText(ctx.trailingIndex, valEndLine) else nil
	local isRead = entry.access ~= nil and entry.access.text == "read"
	return entryDoc, trailingDesc, isRead
end

local function recordFnParamNames(fnNode: any, dest: { [string]: boolean })
	for _, pair in (fnNode and fnNode.parameters) or {} do
		local p = pair.node
		if p ~= nil and p.name ~= nil and p.name.text ~= nil then
			dest[p.name.text] = true
		end
	end
end

local function addDeclaredFn(
	ctx: Ctx,
	target: SymValue,
	name: string,
	fnNode: any,
	doc: DocBlock?,
	trailingDesc: string?,
	keySpan: Span,
	defSpan: Span,
	isTableEntry: boolean?
)
	local existingIdx = (target.fieldIndex :: { [string]: number })[name]
	local firstField = if existingIdx ~= nil then (target.fields :: { SymField })[existingIdx] else nil
	if firstField ~= nil and firstField.value.kind == "function" then
		local firstFn = firstField.value.fnNode
		if firstFn ~= nil then
			-- CST function nodes returned by `@std/syntax/parser` are frozen; clone
			-- before attaching overload parameter sets.
			if table.isfrozen(firstFn) then
				firstFn = table.clone(firstFn)
				firstField.value.fnNode = firstFn
			end
			if table.isfrozen(fnNode) then
				fnNode = table.clone(fnNode)
			end
			local shared: { [string]: boolean } = firstFn.overloadParams or {}
			if firstFn.overloadParams == nil then
				recordFnParamNames(firstFn, shared)
				firstFn.overloadParams = shared
			end
			if fnNode.overloadParams ~= nil and fnNode.overloadParams ~= shared then
				for paramName in fnNode.overloadParams do
					shared[paramName] = true
				end
			end
			recordFnParamNames(fnNode, shared)
			fnNode.overloadParams = shared
			if doc == nil then
				fnNode.isSecondaryOverload = true
			end
		end
	end
	local fnVal = newFunction(ctx, fnNode, doc, defSpan)
	addDeclaredField(target, name, {
		name = name,
		value = fnVal,
		isColonMethod = false,
		fieldDoc = if isTableEntry then doc else nil,
		defDoc = if isTableEntry then nil else doc,
		trailingDesc = trailingDesc,
		keySpan = keySpan,
		defSpan = defSpan,
		isDeclared = true,
	})
end

local function addDeclaredFnOverloads(
	ctx: Ctx,
	target: SymValue,
	fieldName: string,
	fnTypes: { any },
	doc: DocBlock?,
	trailingDesc: string?,
	keySpan: Span,
	isTableEntry: boolean?
)
	local fnNodes: { any } = {}
	local overloadParams: { [string]: boolean }? = if #fnTypes > 1 then {} else nil
	for _, ft in fnTypes do
		local fnNode = fnNodeFromType(ft)
		table.insert(fnNodes, fnNode)
		if overloadParams ~= nil then
			recordFnParamNames(fnNode, overloadParams)
		end
	end
	for i, fnNode in fnNodes do
		fnNode.overloadParams = overloadParams
		fnNode.isSecondaryOverload = i > 1
		local defSpan = fnTypes[i].location or keySpan
		addDeclaredFn(
			ctx,
			target,
			fieldName,
			fnNode,
			doc,
			if i == 1 then trailingDesc else nil,
			keySpan,
			defSpan,
			isTableEntry
		)
	end
end

local function populateDeclaredTableType(ctx: Ctx, target: SymValue, tblType: any)
	for _, entry in tblType.entries or {} do
		local entryDoc, trailingDesc, isRead = declaredEntryMeta(ctx, entry)
		if parseMod.isTypeProperty(entry) and entry.key ~= nil then
			local fieldName = entry.key.text
			local keySpan = entry.key.location
			local fnTypes = collectFunctionTypes(entry.value)
			if fnTypes ~= nil then
				addDeclaredFnOverloads(ctx, target, fieldName, fnTypes, entryDoc, trailingDesc, keySpan, true)
			else
				local defSpan = (entry.value and entry.value.location) or keySpan
				addDeclaredProp(target, fieldName, entry.value, isRead, entryDoc, trailingDesc, keySpan, defSpan)
			end
		elseif parseMod.isTypeIndexer(entry) and entry.key ~= nil then
			local idxName = sliceIndexerKey(ctx.parsed, entry.key)
			local span = entry.location or entry.key.location
			local defSpan = (entry.value and entry.value.location) or span
			addDeclaredProp(target, idxName, entry.value, isRead, entryDoc, trailingDesc, span, defSpan)
		end
	end
end

local function processDeclaredClassBlock(ctx: Ctx, stat: any, classMeta: { name: string })
	local decls = ctx.parsed.decls
	local classDoc = comments.claim(ctx.claimIndex, stat.location.beginLine)
	local classSym = ensureDeclaredClass(ctx, classMeta.name, stat.location, classDoc, true)
	for _, inner in (stat.body and stat.body.statements) or {} do
		local innerLine = inner.location.beginLine
		local fnLine = if inner.name ~= nil and inner.name.location ~= nil
			then inner.name.location.beginLine
			else innerLine
		local innerDoc = comments.claim(ctx.claimIndex, parseMod.effectiveStartLine(inner))
		local trailingDesc = comments.trailingText(ctx.trailingIndex, inner.location.endLine)
		local methodMeta = decls and (decls.classMethods[innerLine] or decls.classMethods[fnLine])
		local propMeta = decls and decls.classProps[innerLine]
		local idxMeta = decls and decls.classIndexers[innerLine]
		if inner.tag == "function" and methodMeta ~= nil then
			addDeclaredFn(
				ctx,
				classSym,
				methodMeta.name,
				inner.func,
				innerDoc,
				trailingDesc,
				inner.location,
				inner.location,
				false
			)
		elseif inner.tag == "typealias" and propMeta ~= nil then
			local fnTypes = collectFunctionTypes(inner.type)
			if fnTypes ~= nil then
				addDeclaredFnOverloads(
					ctx,
					classSym,
					propMeta.name,
					fnTypes,
					innerDoc,
					trailingDesc,
					inner.location,
					false
				)
			else
				addDeclaredProp(
					classSym,
					propMeta.name,
					inner.type,
					propMeta.readonly,
					innerDoc,
					trailingDesc,
					inner.location,
					inner.location
				)
			end
		elseif inner.tag == "typealias" and idxMeta ~= nil then
			local entry = inner.type and inner.type.entries and inner.type.entries[1]
			if entry ~= nil and entry.key ~= nil then
				local idxName = sliceIndexerKey(ctx.parsed, entry.key)
				addDeclaredProp(
					classSym,
					idxName,
					entry.value,
					idxMeta.readonly,
					innerDoc,
					trailingDesc,
					inner.location,
					inner.location
				)
			end
		end
	end
end

local function processDeclaredTopLevel(ctx: Ctx, stat: any): boolean
	local decls = ctx.parsed.decls
	if decls == nil then
		return false
	end
	local tag = stat.tag
	local statLine = stat.location.beginLine
	local fnLine = if stat.name ~= nil and stat.name.location ~= nil then stat.name.location.beginLine else statLine
	local fnMeta = decls.functions[statLine] or decls.functions[fnLine]
	if tag == "do" and decls.classes[statLine] ~= nil then
		processDeclaredClassBlock(ctx, stat, decls.classes[statLine])
		return true
	elseif tag == "localfunction" and fnMeta ~= nil then
		local doc = comments.claim(ctx.claimIndex, parseMod.effectiveStartLine(stat))
		addDeclaredFn(
			ctx,
			ensureDeclRoot(ctx, stat.location),
			fnMeta.name,
			stat.func,
			doc,
			comments.trailingText(ctx.trailingIndex, stat.location.endLine),
			stat.location,
			stat.location,
			false
		)
		return true
	elseif tag == "local" and decls.globals[statLine] ~= nil then
		local gMeta = decls.globals[statLine]
		local doc = comments.claim(ctx.claimIndex, parseMod.effectiveStartLine(stat))
		local cstLocal = stat.variables and stat.variables[1] and stat.variables[1].node
		local typeNode = cstLocal and cstLocal.annotation
		local unwrapped = parseMod.unwrapType(typeNode)
		if unwrapped ~= nil and unwrapped.tag == "table" and unwrapped.entries ~= nil and #unwrapped.entries > 0 then
			local classSym = ensureDeclaredClass(ctx, gMeta.name, stat.location, doc, false)
			populateDeclaredTableType(ctx, classSym, unwrapped)
		else
			local fnTypes = collectFunctionTypes(typeNode)
			if fnTypes ~= nil then
				addDeclaredFnOverloads(
					ctx,
					ensureDeclRoot(ctx, stat.location),
					gMeta.name,
					fnTypes,
					doc,
					comments.trailingText(ctx.trailingIndex, stat.location.endLine),
					stat.location,
					false
				)
			else
				addDeclaredProp(
					ensureDeclRoot(ctx, stat.location),
					gMeta.name,
					typeNode,
					nil,
					doc,
					comments.trailingText(ctx.trailingIndex, stat.location.endLine),
					stat.location,
					stat.location
				)
			end
		end
		return true
	end
	return false
end

local processStatements: (ctx: Ctx, stats: any, topLevel: boolean) -> () -- forward

local function processStatement(ctx: Ctx, stat: any, topLevel: boolean)
	local tag = stat.tag
	if ctx.firstStatLine == nil then
		ctx.firstStatLine = parseMod.effectiveStartLine(stat)
	end

	if topLevel and processDeclaredTopLevel(ctx, stat) then
		return
	end

	if tag == "local" then
		processLocalStat(ctx, stat)
	elseif tag == "localfunction" then
		local doc = comments.claim(ctx.claimIndex, parseMod.effectiveStartLine(stat))
		ctx.env[stat.name] = newFunction(ctx, stat.func, doc, stat.location)
	elseif tag == "function" then
		processFunctionStat(ctx, stat)
	elseif tag == "assign" then
		processAssignStat(ctx, stat)
	elseif tag == "typealias" or tag == "typefunction" then
		local doc = comments.claim(ctx.claimIndex, parseMod.effectiveStartLine(stat))
		local kind: "alias" | "typefunction" = if tag == "typealias" then "alias" else "typefunction"
		table.insert(ctx.types, {
			name = stat.name.text,
			exported = stat.export ~= nil,
			kind = kind,
			stat = stat,
			doc = doc,
		})
	elseif tag == "return" and topLevel then
		-- Only the chunk's top-level return defines the module surface.
		local exprs = stat.expressions or {}
		local firstNode = if exprs[1] ~= nil then exprs[1].node else nil
		local doc = if firstNode ~= nil and not isRebindExpr(firstNode)
			then comments.claim(ctx.claimIndex, parseMod.effectiveStartLine(stat))
			else nil
		local res: SymValue = if firstNode ~= nil
			then evalExpr(ctx, firstNode)
			else { kind = "literal", valueKind = "nil", span = stat.location }
		if doc ~= nil and res.defDoc == nil then
			res.defDoc = doc
		end
		ctx.result = res
	elseif tag == "expression" then
		-- Statement-form `setmetatable(M, mt)` or `table.freeze(M)`.
		evalExpr(ctx, stat.expression)
	elseif tag == "conditional" or tag == "do" then
		processBranchStatements(stat, function(stats: any, isTop: boolean)
			processStatements(ctx, stats, isTop)
		end)
	end
	-- Loops (`while`/`for`/`repeat`) and nested function bodies are intentionally not scanned.
end

processStatements = function(ctx: Ctx, stats: any, topLevel: boolean)
	for _, stat in stats or {} do
		processStatement(ctx, stat, topLevel)
	end
end

function surface.evaluate(
	parsed: Parsed,
	claimIndex: { [number]: DocBlock },
	trailingIndex: comments.TrailingIndex
): SurfaceResult
	local ctx: Ctx = {
		parsed = parsed,
		env = {},
		claimIndex = claimIndex,
		trailingIndex = trailingIndex,
		types = {},
		requireLocals = {},
		result = nil,
		firstStatLine = nil,
		declRoot = nil,
		declaredClasses = {},
		declaredClassByName = {},
	}

	processStatements(ctx, parsed.cst.root.statements, true)
	local synced: { [SymValue]: boolean } = {}
	syncOrigin(ctx.result, synced)
	for _, sym in ctx.env do
		syncOrigin(sym, synced)
	end

	if ctx.result ~= nil and ctx.result.kind == "table" then
		postProcessResult(ctx, ctx.result, function(statements: any): SymValue?
			local savedResult, savedEnv, savedReq, savedTypes = ctx.result, ctx.env, ctx.requireLocals, ctx.types
			ctx.result, ctx.env, ctx.requireLocals, ctx.types =
				nil, table.clone(savedEnv), table.clone(savedReq), table.clone(savedTypes)
			processStatements(ctx, statements, true)
			local evaluated = ctx.result
			syncOrigin(evaluated)
			ctx.result, ctx.env, ctx.requireLocals, ctx.types = savedResult, savedEnv, savedReq, savedTypes
			return evaluated
		end)
	end

	if ctx.result == nil and ctx.declRoot ~= nil then
		ctx.result = ctx.declRoot
	end

	return {
		result = ctx.result,
		types = ctx.types,
		declaredClasses = if #ctx.declaredClasses > 0 then ctx.declaredClasses else nil,
		requireLocals = ctx.requireLocals,
		firstStatLine = ctx.firstStatLine,
		env = ctx.env,
	}
end

--- Checks for `function T.f(self: T, ...)`, the explicitly typed form of a
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

--- Returns true if `sym` is a class table, meaning it either has an explicit `@class`
--- tag or defines at least one method (`:` syntax or a `.` function taking
--- `self` first). `T.__index = T` alone is not enough because modules use
--- self-indexing too, though `T.__index = T` paired with a constructor
--- `setmetatable(..., T)` does promote `T` in `model/build.luau`.
function surface.classify(sym: SymValue, hasClassTag: boolean): boolean
	if sym.isDeclaredRoot and not hasClassTag then
		return false
	end
	return sym.kind == "table" and (hasClassTag or hasMethod(sym))
end

function surface.isSelfIndexing(sym: SymValue): boolean
	return sym.kind == "table" and sym.selfIndexing == true
end

return surface

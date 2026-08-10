--- The type a value implies, for a member whose code declares none. A prop
--- assigned `RunService:IsClient()` is a boolean whether or not anyone wrote
--- `: boolean`.
---
--- Only inferences that cannot be wrong belong here. A rendered type is
--- indistinguishable from a declared one, so a plausible guess is worse than
--- the blank it replaces. That bar keeps out arithmetic (`a + b` is a Vector3
--- as readily as a number), limits engine lookups to receivers already
--- established as engine-owned, and stops an instance path at its first `.X`
--- step, which names a property (`script.Name`) as readily as a child.
---
--- Cross-module call returns are inferred in model/finalize instead: they need
--- every module's surface, which pass 1 does not have.

local engineMod = require("./engine")
local segsMod = require("./segs")
local surfaceMod = require("./surface")

type Seg = segsMod.Seg
type SymValue = surfaceMod.SymValue

--- The generated engine tables, absent in a checkout that never installed:
--- inference then knows everything but these.
local ENGINE = engineMod.lists

local infer = {}

--- Luau's own libraries that construct a value named after the library.
local LUAU_LIBS: { [string]: boolean } = { vector = true, buffer = true }

--- Statics that RETURN the type they hang off, so only a call of one is it.
--- Listed rather than assumed: `Color3.toHSV` returns three numbers.
local CONSTRUCTOR_NAMES: { [string]: boolean } = {
	new = true,
	create = true,
	now = true,
	Angles = true,
	lookAt = true,
}

--- Statics that ARE the type they hang off, so an index of one already is it:
--- the split separating `Vector3.zero` from `Vector3.new`.
local CONSTANT_NAMES: { [string]: boolean } = {
	identity = true,
	zero = true,
	one = true,
}

local function namesTheType(name: string, called: boolean): boolean
	if not called then
		return CONSTANT_NAMES[name] == true
	end
	return CONSTRUCTOR_NAMES[name] == true or name:match("^[Ff]rom%u") ~= nil
end

--- A type name as the one reference segment an annotation of it would produce.
--- Through segs' constructor, so "resolves like a declared one" is structural
--- rather than a shape restated here.
local function ref(text: string, prefix: string?): Seg
	return segsMod.ref(if prefix ~= nil then prefix .. "." .. text else text, text, prefix)
end

local PRIMITIVES: { [string]: boolean } = { boolean = true, number = true, string = true }

--- One engine type spelling as segments. `{ Instance }` is the only shape the
--- dump produces around a name, so its brackets are plain text either side.
local function engineSegs(text: string): { Seg }
	if PRIMITIVES[text] then
		return { text }
	end
	local inner = text:match("^{ (.+) }$")
	if inner ~= nil then
		return { "{ ", ref(inner), " }" }
	end
	local enum = text:match("^Enum%.(.+)$")
	if enum ~= nil then
		return { ref(enum, "Enum") }
	end
	return { ref(text) }
end

--- `Enum.Material.SmoothPlastic` -> `Enum.Material`. A member is the enum item
--- itself, so this needs no call.
local function fromEnumPath(callee: string): { Seg }?
	local parts = string.split(callee, ".")
	if parts[1] == "Enum" and #parts == 3 and ENGINE ~= nil and ENGINE.enums[parts[2]] then
		return { ref(parts[2], "Enum") }
	end
	return nil
end

--- `Color3.new()` -> `Color3`, `Vector3.zero` -> `Vector3`: the type a dotted
--- global path names, where `called` says which of the two spellings this is.
local function fromStaticPath(callee: string, called: boolean): { Seg }?
	local parts = string.split(callee, ".")
	local root = parts[1]
	if #parts ~= 2 or not namesTheType(parts[2], called) then
		return nil
	end
	if LUAU_LIBS[root] then
		return { root }
	end
	-- `Instance.new` is the one Class spelled like a datatype constructor
	if root == "Instance" or (ENGINE ~= nil and ENGINE.datatypes[root]) then
		return { ref(root) }
	end
	return nil
end

--- `T` where a guard admits it. Spelled `T?` rather than the `T | false` that
--- `and` literally yields: a reader needs to know the value can be absent, not
--- which falsy value stands in. A guarded boolean absorbs the `false`.
---
--- `?` suffixes everything left of it, so a type it cannot simply follow is
--- parenthesized first: `A & B?` does not parse, and `(s) -> R?` binds to R
--- rather than the function. Only finalize reaches those.
local function needsParens(list: { Seg }): boolean
	for _, seg in list do
		local text = if type(seg) == "string" then seg else seg.text
		if text:find("&", 1, true) ~= nil or text:find("->", 1, true) ~= nil then
			return true
		end
	end
	return false
end

--- `boolean`, however it is spelled: pass 1 emits the bare string, an
--- annotation arrives through finalize as a reference segment. Exported so the
--- realm rule in `detect` asks the same question rather than its own copy.
function infer.isBoolean(list: { Seg }?): boolean
	return list ~= nil and #list == 1 and segsMod.text(list) == "boolean"
end

local function optional(list: { Seg }?): { Seg }?
	if list == nil or infer.isBoolean(list) then
		return list
	end
	local last = list[#list]
	-- already optional: the guard adds no case the type does not carry
	if type(last) == "string" and last:sub(-1) == "?" then
		return list
	end
	local out = table.clone(list)
	if needsParens(out) then
		table.insert(out, 1, "(")
		table.insert(out, ")")
	end
	table.insert(out, "?")
	return segsMod.canonical(out)
end

--- Shared with finalize, which optionalizes a guarded cross-module return the
--- same way (`IsServer and Registry.new()`).
infer.optional = optional

--- The type `value` implies, or nil when nothing about it is certain. Callers
--- reach here only for a member no annotation, cast, or `@prop` tag typed.
function infer.fromValue(value: SymValue): { Seg }?
	local unguarded, guarded = surfaceMod.unguard(value)
	if guarded then
		return optional(infer.fromValue(unguarded))
	end
	if value.kind == "literal" then
		-- `nil` is a placeholder for a value assigned elsewhere, never a type
		-- worth printing
		local valueKind = value.valueKind
		return if valueKind ~= nil and valueKind ~= "nil" then { valueKind } else nil
	end
	if value.kind == "ipath" then
		return if value.dotted then nil else { ref("Instance") }
	end
	if value.kind == "table" then
		if value.arrayItemKind ~= nil then
			return { "{ " .. value.arrayItemKind .. " }" }
		end
		-- a metatable is what makes `setmetatable({}, Class)` an instance of
		-- something rather than the empty table it is spelled as
		if value.metatable ~= nil then
			return nil
		end
		return if value.isEmptyLiteral and #(value.fields :: any) == 0 then { "{}" } else nil
	end
	if value.kind ~= "opaque" then
		return nil
	end
	if value.engineMethod ~= nil then
		local returns = if ENGINE ~= nil then ENGINE.methodReturns[value.engineMethod] else nil
		return if returns ~= nil then engineSegs(returns) else nil
	end
	-- only `game:GetService("X")` NAMES a service. `game.X` is stamped with one
	-- too, enough for a realm whitelist to filter but not to print:
	-- `game.PlaceId` is a number, and typing it `PlaceId` invents a class.
	if value.service ~= nil and value.callee == "game:GetService" then
		return { ref(value.service) }
	end
	if value.callee == nil then
		return nil
	end
	local enum = fromEnumPath(value.callee)
	if enum ~= nil then
		return enum
	end
	-- an index and a call spell `callee` identically and mean different things:
	-- `Instance.new` is the function, `Instance.new()` is what it builds. Only
	-- a call carries a `calleeValue`, which tells them apart -- and what it
	-- EVALUATED to tells a datatype from a required module of the same name.
	local calleeValue = value.calleeValue
	if calleeValue ~= nil and calleeValue.kind ~= "opaque" then
		return nil
	end
	return fromStaticPath(value.callee, calleeValue ~= nil)
end

return infer

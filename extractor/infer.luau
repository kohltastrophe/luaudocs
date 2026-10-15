--- Value-based type inference for members without an explicit type annotation,
--- cast, or `@prop` type. For example, a property assigned `RunService:IsClient()`
--- infers as `boolean` even without `: boolean`.
---
--- Only unambiguous inferences belong here: a rendered inferred type looks
--- identical to a declared type, so a plausible guess is worse than omitting
--- the type. Arithmetic (`a + b` could be `Vector3` or `number`) is excluded,
--- engine method lookups apply only to known engine receivers, and instance
--- paths stop at the first `.X` step (`script.Name` could be a string property
--- or a child Instance).
---
--- Cross-module call return types are inferred in `model/finalize.luau`, where
--- the full module graph's surfaces are available.

local engineMod = require("./engine")
local segsMod = require("./segs")
local surfaceMod = require("./surface")

type Seg = segsMod.Seg
type SymValue = surfaceMod.SymValue

--- Generated Roblox API lookup tables (`nil` when `bun run generate` has not run).
local ENGINE = engineMod.lists

local infer = {}

--- Built-in Luau libraries whose constructors return a value of the same name (`vector`, `buffer`).
local LUAU_LIBS: { [string]: boolean } = { vector = true, buffer = true }

--- Static constructor functions that return an instance of the library they
--- hang off when called (`Vector3.new()`, `CFrame.Angles()`). Listed explicitly
--- because other functions on those libraries (`Color3.toHSV`) return different types.
local CONSTRUCTOR_NAMES: { [string]: boolean } = {
	new = true,
	create = true,
	now = true,
	Angles = true,
	lookAt = true,
}

--- Static constants whose value is already an instance of the library they hang
--- off (`Vector3.zero`, `CFrame.identity`), without being called.
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

--- Builds a single reference segment through `segs.ref` so inferred type names
--- resolve and link identically to annotated type references.
local function ref(text: string, prefix: string?): Seg
	return segsMod.ref(if prefix ~= nil then prefix .. "." .. text else text, text, prefix)
end

local PRIMITIVES: { [string]: boolean } = { boolean = true, number = true, string = true }

--- Converts an engine return-type string from `engine.luau` into segments.
--- `{ Instance }` is the only composite shape emitted by `scripts/generate.ts`.
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

--- Infers `Enum.<Name>` from a 3-part `Enum.Material.SmoothPlastic` path.
local function fromEnumPath(callee: string): { Seg }?
	local parts = string.split(callee, ".")
	if parts[1] == "Enum" and #parts == 3 and ENGINE ~= nil and ENGINE.enums[parts[2]] then
		return { ref(parts[2], "Enum") }
	end
	return nil
end

--- Infers a datatype or Luau library type from `Color3.new()` (`called == true`)
--- or `Vector3.zero` (`called == false`).
local function fromStaticPath(callee: string, called: boolean): { Seg }?
	local parts = string.split(callee, ".")
	local root = parts[1]
	if #parts ~= 2 or not namesTheType(parts[2], called) then
		return nil
	end
	if LUAU_LIBS[root] then
		return { root }
	end
	-- `Instance.new` is the only Roblox class constructor spelled like a datatype constructor.
	if root == "Instance" or (ENGINE ~= nil and ENGINE.datatypes[root]) then
		return { ref(root) }
	end
	return nil
end

--- Returns true when `list` must be wrapped in parentheses before appending `?`
--- (`A & B?` is a syntax error, and `(s) -> R?` would bind `?` to `R` rather
--- than the function type).
local function needsParens(list: { Seg }): boolean
	for _, seg in list do
		local text = if type(seg) == "string" then seg else seg.text
		if text:find("&", 1, true) ~= nil or text:find("->", 1, true) ~= nil then
			return true
		end
	end
	return false
end

--- Returns true when `list` spells `boolean` (whether as a plain string from
--- pass 1 or a reference segment from `finalize`). Shared with `detect.propRealm`.
function infer.isBoolean(list: { Seg }?): boolean
	return list ~= nil and #list == 1 and segsMod.text(list) == "boolean"
end

--- Appends `?` to a guarded type `T` (rendering `T?` rather than `T | false`).
--- Guarded `boolean` values stay `boolean` since `false` is already a boolean.
local function optional(list: { Seg }?): { Seg }?
	if list == nil or infer.isBoolean(list) then
		return list
	end
	local last = list[#list]
	-- Already optional; do not append a second `?`.
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

--- Shared with `finalize`, which optionalizes guarded cross-module call returns
--- (`IsServer and Registry.new()`).
infer.optional = optional

--- Infers the type segments implied by `value`, or `nil` when `value`'s type
--- cannot be determined with certainty.
function infer.fromValue(value: SymValue): { Seg }?
	local unguarded, guarded = surfaceMod.unguard(value)
	if guarded then
		return optional(infer.fromValue(unguarded))
	end
	if value.kind == "literal" then
		-- `nil` is typically a placeholder for a value assigned later, never a useful property type.
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
		-- A table with a metatable (`setmetatable({}, Class)`) is an instance
		-- rather than a plain empty table.
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
	-- Only `game:GetService("X")` is guaranteed to return service `X`. `game.X`
	-- also sets `value.service` for realm whitelist checks, but `game.PlaceId`
	-- is a number property rather than a `PlaceId` class.
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
	-- Distinguish a property access (`Instance.new` -> function) from a call
	-- (`Instance.new()` -> `Instance`): only calls set `calleeValue`, and a
	-- non-opaque `calleeValue` means the root local was a required module rather
	-- than an engine global.
	local calleeValue = value.calleeValue
	if calleeValue ~= nil and calleeValue.kind ~= "opaque" then
		return nil
	end
	return fromStaticPath(value.callee, calleeValue ~= nil)
end

return infer

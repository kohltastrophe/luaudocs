local Color = require(script.Color)
local Interpolate = require(script.Interpolate)
local Query = require(script.Query)
local State = require(script.State)
local Tween = require(script.Tween)
local Type = require(script.Type)

--- A small sample library, written to exercise the renderer: every construct
--- below is one the doc-model diff or a page snapshot pins.
local Sample = {
	--- A symbol marking cleanup entries passed to [Sample.edit]
	Clean = table.freeze({ type = "Symbol" }) :: Type.Symbol,

	Color = Color,
	Interpolate = Interpolate,
	--[[
	<strong>Query</strong>: counts states, and is callable itself.
	]]
	Query = Query,
	State = State,
	Type = Type,

	isState = State.isState,
	raw = State.raw,

	--- The linear-light helpers, lifted out of [Color]
	Linear = Color.Linear,
	--- Reaches a member *through* a nested class: two path segments, which no
	--- lookup by bare name can spell
	fromGamma = Color.Linear.fromGamma,

	--- Sets the deferred-update behaviour, defaults to false
	deferUpdates = function(value: boolean?)
		State.deferUpdates = value
	end,
}
Sample.__index = Sample

type Action = {
	callback: (string) -> (),
}

local Action = table.freeze {}

--- Creates an action that runs logic against a named target
function Sample.action(callback: (string) -> ()): Action
	return table.freeze(setmetatable({ callback = callback }, Action))
end

--- Creates a computed state that tracks its dependencies automatically
function Sample.compute<T>(computation: () -> T): State.State<T>
	local self = Sample.state()
	self._computation = computation
	return self
end

--- Creates a new state holding an initial value
function Sample.state<T>(initialValue: T?): State.State<T>
	local self = setmetatable({
		_connections = {},
		_dependencies = {},
		_dependents = {},
		_value = initialValue,
	}, State)
	Tween._tracked[self] = true
	return self
end

--- Applies a table of properties to an existing target
function Sample.edit<T>(target: T, properties: Type.Dict<any>): T
	for property, value in properties do
		Interpolate(property, value, 1)
	end
	return target
end

--- Creates a target of the given class and applies a table of properties to it
Sample.new = (
	function(className: string): (Type.Dict<any>) -> string
		return function(properties: Type.Dict<any>): string
			return Sample.edit(className, properties)
		end
	end :: any
) :: Type.Constructor

return Sample

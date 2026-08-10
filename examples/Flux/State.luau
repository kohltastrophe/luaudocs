--[[ A single reactive value, and the listeners watching it. ]]
local State = {}
State.__index = State

--[[ A value that notifies listeners whenever it changes. ]]
export type State<T> = typeof(setmetatable(
	{} :: {
		value: T, -- the value the state currently holds
		listeners: { (T) -> () }, -- everything registered through [State:Connect]
	},
	State
))

--[[ Creates a state holding `initial`. ]]
function State.new<T>(initial: T?): State<T>
	return setmetatable({ value = initial, listeners = {} }, State) :: any
end

--[[ Reports whether `value` is a state. ]]
function State.isState(value: any): boolean
	return getmetatable(value) == State
end

--[[
Runs `callback` whenever the value changes.

Returns a function that disconnects the listener again.
]]
function State:Connect(callback: (any) -> ()): () -> ()
	table.insert(self.listeners, callback)
	return function()
		local index = table.find(self.listeners, callback)
		if index then
			table.remove(self.listeners, index)
		end
	end
end

--[[
Drops every listener and releases the state.

@deprecated 2.0 -- states are collected once nothing references them
]]
function State:Destroy()
	table.clear(self.listeners)
end

return State

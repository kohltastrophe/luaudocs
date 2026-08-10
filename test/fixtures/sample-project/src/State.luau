local Type = require(script.Parent.Type)

local State = { deferUpdates = true }
State.__index = State

--- Checks whether an object is a state
function State.isState(object: any): boolean
	return type(object) == "table" and getmetatable(object) == State
end

--- Gets the raw value of a state, or the input itself when it is not a state
function State.raw<T>(object: T): any
	return if State.isState(object) then (object :: any)._value else object
end

export type StateData<T> = {
	--- Hooks registered through [State:Connect]
	_connections: Type.Dict<Type.Function>,
	_computation: Type.Function?,
	_dependencies: Type.Set<State<T>>,
	_dependents: Type.Set<State<T>>,
	_value: T,
}
--- A state is its data plus this metatable: the class type the page is built from.
export type State<T> = typeof(setmetatable({} :: StateData<T>, State))
--- Either a plain value or a state holding one.
export type Stateful<T> = T | State<T>

--- Tracks this state as a dependency of the computation currently running
function State:_updateDependence()
	return self
end

-- undocumented on purpose: the model drops metamethods that carry no doc block
function State.__call(self, value: any?)
	if value == nil then
		return self:_updateDependence()._value
	end
	self._value = value
	return self
end

--- Adds a hook to run whenever the value changes, returning a disconnect function
function State:Connect(callback: Type.Function): Type.Function
	self._connections[callback] = true
	return function()
		self._connections[callback] = nil
	end
end

--- Destroys the state, clearing its dependencies and hooks
function State:Destroy()
	table.clear(self._connections)
	table.clear(self._dependencies)
	table.clear(self._dependents)
end

return State

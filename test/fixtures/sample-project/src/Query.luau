--!strict

--[[
Tiny state-query helpers, documented in the plain block style.
]]

local State = require(script.Parent.State)

--[[
Counts how many of the given values are states.
@param objects - The values to inspect.
@return number - How many of them are states.
]]
local function countStates(objects: { any }): number
	local found = 0
	for _, object in objects do
		if State.isState(object) then
			found += 1
		end
	end
	return found
end

local Query = {
	countStates = countStates,
}

local QueryMT = {}

--[[
Calling the module counts states directly: `Query(objects)`.
@param objects - The values to inspect.
]]
function QueryMT.__call(self: any, objects: { any }): number
	return countStates(objects)
end

return setmetatable(Query, QueryMT)

-- The class keeps the functions it defines: the constructor the module hands
-- out is the class's own, documented once.

--- Emits events.
local Signal = {}
Signal.__index = Signal

--- Makes a signal.
function Signal.new()
	return setmetatable({}, Signal)
end

--- Fires the signal.
function Signal:Fire() end

--- Disconnects every listener.
--- @method DisconnectAll
--- @within Signal

return { new = Signal.new }

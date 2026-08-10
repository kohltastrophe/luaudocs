--- A callable module whose `__call` waits.
local run = setmetatable({}, {
	__call = function()
		task.wait()
	end,
})

return run

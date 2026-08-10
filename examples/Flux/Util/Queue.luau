--[[ A queue that yields on `pop` until something is available. ]]
local Queue = {}
Queue.__index = Queue

--[[ A first-in, first-out queue. ]]
export type Queue<T> = typeof(setmetatable(
	{} :: {
		items: { T }, -- everything still waiting, front first
	},
	Queue
))

--[[ Creates an empty queue. ]]
function Queue.new<T>(): Queue<T>
	return setmetatable({ items = {} }, Queue) :: any
end

--[[
Adds `item` to the back of the queue.

@since 1.1.0
]]
function Queue:push(item: any)
	table.insert(self.items, item)
end

--[[ Removes the front item and returns it, waiting when the queue is empty. ]]
function Queue:pop(): any
	while #self.items == 0 do
		task.wait()
	end
	return table.remove(self.items, 1)
end

return Queue

-- Implicit classes: the methods live on a self-indexing table the module never
-- returns, reached only through what a constructor attaches or a type spells.

type CounterData = { count: number }

--- Counts up.
local counterImpl = {}
counterImpl.__index = counterImpl

--- A counter, spelled with the typed idiom.
export type Counter = setmetatable<CounterData, typeof(counterImpl)>

--- Adds one.
function counterImpl.bump(self: Counter, by: number?): number
	self.count += by or 1
	return self.count
end

--- Reads the count.
function counterImpl:get(): number
	return self.count
end

local timerImpl = {}
timerImpl.__index = timerImpl

export type Timer = typeof(setmetatable({} :: { started: number }, timerImpl))

function timerImpl.elapsed(self: Timer): number
	return os.clock() - self.started
end

-- attached by a constructor only: named after the local
local cursorImpl = {}
cursorImpl.__index = cursorImpl

function cursorImpl.advance(self, n: number)
	self.at += n
end

-- self-indexing but nothing attaches it: a namespace, not a class
local Orphan = {}
Orphan.__index = Orphan

function Orphan.helper()
	return 1
end

-- attached, but not self-indexing: a plain metatable, not a class
local Plain = {}
Plain.__tostring = function()
	return "plain"
end

local lib = {}

-- a module named after the class it builds, re-exposing its constructor
lib.Signal = require("./Signal")

--- Makes a counter.
function lib.counter(): Counter
	return setmetatable({ count = 0 } :: CounterData, counterImpl)
end

--- Makes a timer.
function lib.timer(): Timer
	return setmetatable({ started = os.clock() }, timerImpl)
end

function lib.cursor()
	local self = setmetatable({ at = 0 }, cursorImpl)
	return self
end

function lib.plain()
	return setmetatable({}, Plain)
end

--- Looks a counter up: finding none is not constructing one.
function lib.find(): Counter?
	return nil
end

--- Starting values, documented whole rather than opened up as a section.
--- @readonly
lib.defaults = { step = 1 }

--- @prop limits { max: number }
--- Bounds, typed by the block.
lib.limits = { max = 10 }

--- Clears every counter. The block sits above an alias it does not document.
--- @function reset
type Resettable = { reset: () -> () }

return table.freeze(lib)

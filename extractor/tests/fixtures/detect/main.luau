--- One member per cross-module resolution route: the badges assert that
--- detection follows requires, imports, passthroughs, and __call.

local helpers = require("./helpers")
local run = require("./run")
local via = require("./via")
local settle = helpers.settle

local M = {}

--- The wait lives in helpers.
function M.drain()
	helpers.settle()
end

--- Realm crosses the module boundary too.
function M.sync(remote: any)
	helpers.fanout(remote)
end

--- A callable module: run's __call waits.
function M.exec()
	run()
end

--- A member import, called directly.
function M.quick()
	settle()
end

--- Reaches helpers through a passthrough module.
function M.relay()
	via.settle()
end

--- Protected calls run on this thread.
function M.attempt(): boolean
	return (pcall(settle))
end

return M

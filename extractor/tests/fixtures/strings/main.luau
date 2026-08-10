local a = require("./a")
local b = require("./b")
local thing = require("@pkg/thing")

local M = { a = a, b = b, thing = thing }

-- conditional mount with no require-local: cond.luau can only reach the
-- module graph through the surfaced-require walk
if a.enabled then
	M.cond = require("./cond")
end

return M

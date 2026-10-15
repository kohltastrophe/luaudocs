local a = require("./a")
local b = require("./b")
local thing = require("@pkg/thing")
-- bound to a local and never mounted: tags-only, except that it declares a
-- class, which earns it a page and surfaces what it mounts
local promoted = require("./promoted")

local M = { a = a, b = b, thing = thing }

-- conditional mount with no require-local: cond.luau can only reach the
-- module graph through the surfaced-require walk
if a.enabled then
	M.cond = require("./cond")
end

return M

-- from an init.luau: "./a" is a SIBLING of the b/ directory (strings/a.luau),
-- and "@self/inner" reaches inside b/
local a = require("./a")
local inner = require("@self/inner")

return { a = a, inner = inner }

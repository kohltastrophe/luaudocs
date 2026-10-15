-- from an init.luau: "./a" is a SIBLING of the b/ directory (strings/a.luau),
-- and "@self/inner" reaches inside b/
local RunService = game:GetService("RunService")
local a = require("./a")
local inner = require("@self/inner")

-- mounted behind a realm guard: surfaced like a plain mount all the same
return { a = a, inner = RunService:IsServer() and inner }

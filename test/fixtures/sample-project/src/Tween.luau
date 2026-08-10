--- Reached through require-locals only: nothing re-exports it, so it lands in
--- the doc model but never gets a page. Its members are private, so the module
--- exports nothing either.
local Tween = {}

Tween._tracked = setmetatable({}, { __mode = "k" })

return Tween

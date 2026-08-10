--- @class Diags
local M = {}

local opaque = require("./opaque")
local other = require("./other")
local missing = require("./missing")

M.Opaque = opaque
M.hidden = other.hidden
M.Missing = missing

--- @external Shared https://example.test/shared

--- @external Shared https://example.test/elsewhere

--- @class Twin
local Twin = {}

--- Twin again, in the same module. The bare @param pins that a dropped
--- duplicate still forwards its block's own tag diagnostics.
--- @class Twin
--- @param
local Twin2 = {}

--- @param nope number -- names no parameter
function M.go(x: number)
	return x
end

--- @return string -- the value
--- @return string -- beyond the annotation
function M.one(): string
	return ""
end

--- @param ghost number -- attached to nothing

--- @class Twin

return M

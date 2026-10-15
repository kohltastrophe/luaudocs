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

local types = require("./types")
export type Kept = types.Kept

-- a require-local is enough to join the graph, and to fail parsing there
local broken = require("./broken")
-- the folder holding this file: an instance, but not a module
M.Folder = require(script.Parent)

return M

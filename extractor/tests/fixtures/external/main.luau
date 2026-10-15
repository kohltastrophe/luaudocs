-- Runtime aliases: requires the runtime supplies (`--alias`), which no
-- `.luaurc` resolves. Never a diagnostic; linked when the alias has docs.

local fs = require("@lute/fs")
local client = require("@lute/net/client")
local thing = require("@std/thing")
local plain = require("@pkg/plain")

local M = {}

--- The runtime's file system, mounted whole.
M.fs = fs
M.readFile = fs.readfile
M.thing = thing
M.plain = plain

--- Opens a file.
function M.open(path: string): fs.File
	return fs.open(path)
end

function M.fetch(): client.Response
	return client.get("")
end

function M.raw(): plain.Blob
	return plain.blob()
end

return M

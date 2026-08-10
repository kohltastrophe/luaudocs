--- luaudocs extractor CLI (runs on Lute).
---
--- Usage:
---   lute run extractor/main.luau -- --root <projectDir> --entry <fileOrDir> [--entry ...]
---     [--project-file <p>] [--pretty]
---
--- Emits doc-model JSON to stdout; the schema lives in ./model. Diagnostics are
--- embedded in the JSON, and all error gating lives in the TS CLI
--- (`luaudocs build [--strict]`), which reads them.
--- Exit codes: 0 ok · 2 usage/config error.

local process = require("@std/process")
local fs = require("@std/fs")
local util = require("./util")
local requiresMod = require("./requires")
local graphMod = require("./graph")
local modelMod = require("./model")
local emitMod = require("./emit")

-- Lute 1.0.0 exposes no stderr API, so fatal messages go to stdout and callers
-- key off exit code 2. fail() runs before any JSON is emitted, so error text
-- and the model never share the stream.
local function fail(message: string): never
	print("error: " .. message)
	process.exit(2)
	error("unreachable")
end

local args = util.argsAfterSeparator(process.args)

local root: string? = nil
local entries: { string } = {}
local projectFile: string? = nil
local pretty = false

local i = 1
while i <= #args do
	local arg = args[i]
	local function nextValue(): string
		i += 1
		local v = args[i]
		if v == nil then
			fail(arg .. " requires a value")
		end
		return v :: string
	end
	if arg == "--root" then
		root = nextValue()
	elseif arg == "--entry" then
		table.insert(entries, nextValue())
	elseif arg == "--project-file" then
		projectFile = nextValue()
	elseif arg == "--pretty" then
		pretty = true
	else
		fail("unknown argument: " .. arg)
	end
	i += 1
end

if root == nil then
	fail("--root is required")
end
if #entries == 0 then
	-- the caller always passes these: an empty `[source] entries` means
	-- guide-only, which never spawns the extractor at all
	fail("--entry is required")
end

local rootAbs = util.resolvePath(root :: string)
if not fs.exists(rootAbs) then
	fail("root does not exist: " .. rootAbs)
end

-- lute inherits whatever cwd the caller had, which is not necessarily the user
-- project, so a relative --project-file must resolve against --root
if projectFile ~= nil and not util.isAbsolute(projectFile :: string) then
	projectFile = util.normPath(util.joinPath(rootAbs, projectFile :: string))
end
local proj, projErr = requiresMod.load(rootAbs, { projectFile = projectFile })
if projErr ~= nil then
	fail(projErr)
end
local diag = util.diagnostics()

local entryAbsPaths: { string } = {}
local entryIds: { string } = {}
for _, entry in entries do
	local abs, err = graphMod.expandEntry(rootAbs, entry)
	if abs == nil then
		fail(tostring(err))
	end
	table.insert(entryAbsPaths, abs :: string)
	table.insert(entryIds, util.relPath(rootAbs, abs :: string))
end

local g = graphMod.build(proj, entryAbsPaths, diag)
local docModel = modelMod.assemble(g, diag, { entryPoints = entryIds })

print(emitMod.encode(docModel, pretty))

process.exit(0)

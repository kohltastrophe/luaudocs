--- Module graph: BFS from entry files following surfaced requires (mounts,
--- passthroughs, member imports). Each file is parsed once; cycles are safe
--- because resolution only needs the target's identity, not its surface.

local fs = require("@std/fs")
local util = require("./util")
local parseMod = require("./parse")
local comments = require("./comments")
local surfaceMod = require("./surface")
local requiresMod = require("./requires")

type Project = requiresMod.Project
type Collector = util.Collector

export type ModuleData = {
	id: string, -- project-relative posix path (stable, used in symbol ids)
	absPath: string,
	name: string, -- display name: rojo mount name > init-dir name > file stem
	instancePath: { string }, -- instance path, root-first (rojo tree, else folder layout)
	surfaced: boolean, -- reachable via the public surface (false: tags-only pass)
	parsed: parseMod.Parsed?,
	blocks: { comments.DocBlock }?,
	claimIndex: { [number]: comments.DocBlock }?,
	trailingIndex: comments.TrailingIndex?,
	surface: surfaceMod.SurfaceResult?,
	requireTargets: { [any]: string }, -- require SymValue -> resolved moduleId
	requireFailures: { RequireFailure }, -- surfaced requires that did not resolve, pending a surfaced upgrade
	localModules: { [string]: string }, -- require-local name -> moduleId
	surfacedRequires: { any }?, -- the BFS's collectSurfacedRequires result, reused by the closure
	-- pass; metatables are not walked, so `setmetatable(M, require(X))` contributes no entry
}

export type RequireFailure = {
	reason: string,
	detail: string,
	line: number?,
}

export type Graph = {
	modules: { ModuleData },
	byId: { [string]: ModuleData },
	byAbs: { [string]: ModuleData },
}

local graph = {}

local isInitFile = util.isInitFile

--- Folder-layout position, root-first: where a module sits when rojo does not
--- place it. `dir/init.luau` *is* `dir`, so it contributes no segment.
local function layoutPath(root: string, absPath: string): { string }
	local parts: { string } = {}
	for part in util.relPath(root, absPath):gmatch("[^/]+") do
		if part ~= "." then
			table.insert(parts, part)
		end
	end
	local file = table.remove(parts)
	if file ~= nil and not isInitFile(file) then
		table.insert(parts, util.stem(file))
	end
	return parts
end

--- Where the module lands in the instance tree, root-first. Always answers: the
--- rojo walk lives in `requires`, and this covers what rojo does not place.
local function instancePath(proj: Project, absPath: string): { string }
	if proj.rojoRoot == nil then
		return layoutPath(proj.root, absPath)
	end
	return requiresMod.instancePath(proj, absPath) or layoutPath(proj.root, absPath)
end

--- Such files cannot carry a project-relative id, so entries and requires
--- reject them.
local function isOutsideRoot(root: string, abs: string): boolean
	local rel = util.relPath(root, abs)
	-- a cross-drive path on Windows relativizes to an absolute path rather
	-- than a ../ one, and it is just as outside
	return rel == ".." or rel:sub(1, 3) == "../" or util.isAbsolute(rel)
end

--- Expands an entry (file or directory) to an absolute module file path.
function graph.expandEntry(root: string, entry: string): (string?, string?)
	local abs = if util.isAbsolute(entry) then entry else util.joinPath(root, entry)
	abs = util.normPath(abs)
	if isOutsideRoot(root, abs) then
		return nil, "entry is outside the project root: " .. entry
	end
	if not fs.exists(abs) then
		return nil, "entry does not exist: " .. entry
	end
	if util.isDir(abs) then
		-- not findModuleFile: that probes a sibling `<abs>.luau` first, which is
		-- right for a require but wrong for an entry naming this directory
		local resolved = requiresMod.findInitFile(abs)
		if resolved ~= nil then
			return util.normPath(resolved), nil
		end
		return nil, "entry directory has no init.luau: " .. entry
	end
	return abs, nil
end

local function collectSurfacedRequires(result: surfaceMod.SymValue?): { any }
	local out = {}
	local seen = {}
	local function walk(v: any)
		if v == nil or seen[v] then
			return
		end
		seen[v] = true
		if v.kind == "require" then
			table.insert(out, v)
		elseif v.kind == "import" then
			walk(v.base)
		elseif v.kind == "table" then
			for _, field in v.fields do
				walk(field.value)
			end
		end
	end
	walk(result)
	return out
end

--- A broken require only matters once the module gets a page, so tags-only
--- modules bank their failures until (and if) they surface.
function graph.drainRequireFailures(mod: ModuleData, diag: Collector)
	for _, failure in mod.requireFailures do
		local severity = if failure.reason == "require-nonmodule" then "info" else "warning"
		diag:add(severity :: any, failure.reason, failure.detail, mod.id, failure.line)
	end
	table.clear(mod.requireFailures)
end

function graph.build(proj: Project, entryAbsPaths: { string }, diag: Collector): Graph
	local g: Graph = { modules = {}, byId = {}, byAbs = {} }
	local queue: { string } = {}
	local queued: { [string]: boolean } = {}

	local function enqueue(absPath: string)
		local norm = util.normPath(absPath)
		if not queued[norm] then
			queued[norm] = true
			table.insert(queue, norm)
		end
	end

	--- One resolve rule for surfaced requires and require-locals: a target
	--- outside the project root is a failure, a resolved one is registered
	--- and enqueued. Whether a failure is worth a diagnostic is the caller's.
	local function resolveAndEnqueue(mod: ModuleData, absPath: string, sym: any): (string?, RequireFailure?)
		local resolution = requiresMod.resolve(proj, absPath, sym.requireInfo)
		if resolution.ok and isOutsideRoot(proj.root, resolution.absPath) then
			resolution = {
				ok = false,
				reason = "require-unresolved",
				detail = "module is outside the project root: " .. resolution.absPath,
			}
		end
		if not resolution.ok then
			return nil,
				{
					reason = resolution.reason,
					detail = resolution.detail,
					line = sym.span and sym.span.beginLine,
				}
		end
		local targetId = util.relPath(proj.root, resolution.absPath)
		mod.requireTargets[sym] = targetId
		enqueue(resolution.absPath)
		return targetId, nil
	end

	for _, entry in entryAbsPaths do
		enqueue(entry)
	end

	local cursor = 1
	while cursor <= #queue do
		local absPath = queue[cursor]
		cursor += 1

		local id = util.relPath(proj.root, absPath)
		local mod: ModuleData = {
			id = id,
			absPath = absPath,
			name = requiresMod.instanceName(proj, absPath),
			instancePath = instancePath(proj, absPath),
			-- settled by the closure after the BFS
			surfaced = false,
			parsed = nil,
			blocks = nil,
			claimIndex = nil,
			trailingIndex = nil,
			surface = nil,
			requireTargets = {},
			requireFailures = {},
			localModules = {},
		}
		table.insert(g.modules, mod)
		g.byId[id] = mod
		g.byAbs[absPath] = mod

		local source = util.readFileSafe(absPath)
		if source == nil then
			diag:error("parse-error", "could not read " .. id, id)
			continue
		end

		local parsed, parseErr = parseMod.parse(source)
		if parsed == nil then
			diag:error("parse-error", tostring(parseErr), id)
			continue
		end
		mod.parsed = parsed

		local okEval, evalErr = pcall(function()
			local blocks = comments.segment(parsed)
			local claimIndex = comments.claimIndex(blocks)
			local trailingIndex = comments.trailingIndex(parsed)
			mod.blocks = blocks
			mod.claimIndex = claimIndex
			mod.trailingIndex = trailingIndex
			mod.surface = surfaceMod.evaluate(parsed, claimIndex, trailingIndex)
		end)
		if not okEval then
			diag:error("extract-failed", tostring(evalErr), id)
			continue
		end

		local surface = mod.surface :: surfaceMod.SurfaceResult

		mod.surfacedRequires = collectSurfacedRequires(surface.result)
		for _, sym in mod.surfacedRequires :: { any } do
			local _, failure = resolveAndEnqueue(mod, absPath, sym)
			if failure ~= nil then
				table.insert(mod.requireFailures, failure)
			end
		end

		-- require-locals resolve for type-prefix linking; their modules join the
		-- graph as tags-only, so manual declarations there still materialize
		-- but no pages are auto-created
		local localNames = {}
		for name in surface.requireLocals do
			table.insert(localNames, name)
		end
		table.sort(localNames)
		for _, name in localNames do
			local sym = surface.requireLocals[name]
			local known = mod.requireTargets[sym]
			if known == nil then
				-- non-surfaced unresolved requires are not worth a diagnostic
				known = (resolveAndEnqueue(mod, absPath, sym))
			end
			if known ~= nil then
				mod.localModules[name] = known
			end
		end
	end

	-- surfaced closure: entries, plus everything a surfaced module's surface
	-- requires. One pass, so the BFS never re-promotes a tags-only module.
	local pending: { ModuleData } = {}
	for _, entry in entryAbsPaths do
		local mod = g.byAbs[util.normPath(entry)]
		if mod ~= nil and not mod.surfaced then
			mod.surfaced = true
			table.insert(pending, mod)
		end
	end
	local at = 1
	while at <= #pending do
		local mod = pending[at]
		at += 1
		if mod.surface ~= nil then
			for _, sym in mod.surfacedRequires or {} do
				local targetId = mod.requireTargets[sym]
				local target = if targetId ~= nil then g.byId[targetId] else nil
				if target ~= nil and not target.surfaced then
					target.surfaced = true
					table.insert(pending, target)
				end
			end
		end
	end
	-- drain in BFS order, not closure order, so diagnostic order never depends
	-- on which edge surfaced a module first
	for _, mod in g.modules do
		if mod.surfaced then
			graph.drainRequireFailures(mod, diag)
		end
	end

	return g
end

return graph

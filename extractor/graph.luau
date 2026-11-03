--- Builds the module graph via BFS from entry files, following surfaced requires
--- and local `require` bindings (which join as tags-only modules so manual
--- declarations and type prefixes still resolve). Parses each file once. Cycles
--- are safe because resolution needs only the target's identity, not its
--- evaluated surface.
---
--- Settles which modules get a page (`surfaced`) in a closure pass after the
--- BFS. Surfaced modules include entry modules, modules required by a surfaced
--- module's public surface, and modules that declare a `@class` of their own.
--- Computing the closure here ensures a class-promoted module's own mounts also
--- surface with it.

local fs = require("@std/fs")
local util = require("./util")
local parseMod = require("./parse")
local comments = require("./comments")
local surfaceMod = require("./surface")
local requiresMod = require("./requires")
local tagsMod = require("./tags")

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
	requireFailures: { RequireFailure }, -- surfaced requires that did not resolve, drained once the module surfaces
	localModules: { [string]: string }, -- require-local name -> moduleId
	externalRequires: { [any]: requiresMod.External }, -- require SymValue -> the runtime module it names
	localExternals: { [string]: requiresMod.External }, -- require-local name -> runtime module (type-prefix linking)
	surfacedRequires: { any }?, -- cached `collectSurfacedRequires` result reused by the closure
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

--- Returns the folder-layout position (root-first) when Rojo does not place a
--- module. `dir/init.luau` represents `dir`, so it adds no extra segment.
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

--- Returns where the module lands in the instance tree (root-first), using the
--- Rojo tree when available and falling back to the folder layout otherwise.
local function instancePath(proj: Project, absPath: string): { string }
	if proj.rojoRoot == nil then
		return layoutPath(proj.root, absPath)
	end
	return requiresMod.instancePath(proj, absPath) or layoutPath(proj.root, absPath)
end

--- Files outside `root` cannot carry a project-relative ID, so entries and
--- requires reject them.
local function isOutsideRoot(root: string, abs: string): boolean
	local rel = util.relPath(root, abs)
	-- A cross-drive path on Windows relativizes to an absolute path rather than
	-- a `../` path, and is equally outside `root`.
	return rel == ".." or rel:sub(1, 3) == "../" or util.isAbsolute(rel)
end

--- Expands an entry (file or directory) to an absolute module file path.
function graph.expandEntry(root: string, entry: string): (string?, string?)
	local abs = if util.isAbsolute(entry) then entry else util.joinPath(root, entry)
	abs = util.normPath(abs)
	if isOutsideRoot(root, abs) then
		return nil, "entry is outside the project root: " .. entry
	end
	local kind = util.pathType(abs)
	if kind == nil then
		return nil, "entry does not exist: " .. entry
	end
	if kind == "dir" then
		-- Use `findInitFile` rather than `findModuleFile`: `findModuleFile` probes
		-- a sibling `<abs>.luau` first, which is right for a `require` path but
		-- wrong for an entry pointing at a directory.
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
	local function walkSurface(v: any)
		if v == nil then
			return
		end
		-- A conditional mount (`IsServer() and require(X)`) is still a mount;
		-- the guard decides which realm reaches the module, not whether it is mounted.
		v = surfaceMod.unguard(v)
		if seen[v] then
			return
		end
		seen[v] = true
		if v.kind == "require" then
			table.insert(out, v)
		elseif v.kind == "import" then
			walkSurface(v.base)
		elseif v.kind == "function" then
			walkSurface(v.returnedRequire)
		elseif v.kind == "table" then
			for _, field in v.fields do
				walkSurface(field.value)
			end
		end
	end
	walkSurface(result)
	return out
end
graph.collectSurfacedRequires = collectSurfacedRequires

--- Returns the floating `@class` block that declares a module's container
--- (Moonwave manual mode, where `@class` does not need to sit above the table
--- statement). Matches either an unclaimed doc block or a doc block claimed by
--- a type alias whose placing tag is `@class` (since a type alias cannot be
--- what `@class` documents).
function graph.floatingClassBlock(mod: ModuleData): (comments.DocBlock?, tagsMod.ParsedDoc?)
	local surface = mod.surface
	if surface == nil or mod.blocks == nil then
		return nil, nil
	end
	local typeBlocks: { [any]: boolean } = {}
	for _, ty in surface.types do
		if ty.doc ~= nil then
			typeBlocks[ty.doc] = true
		end
	end
	for _, block in mod.blocks :: { comments.DocBlock } do
		if block.doc and (not block.claimed or typeBlocks[block]) then
			local parsed = tagsMod.parseBlock(block)
			if parsed.placing ~= nil and parsed.placing.kind == "class" then
				return block, parsed
			end
		end
	end
	return nil, nil
end

--- Returns true if `mod` declares a `@class` on its returned table or in a
--- floating doc block, earning it a page even when not mounted from an entry.
local function declaresClass(mod: ModuleData): boolean
	local surface = mod.surface
	if surface == nil then
		return false
	end
	local result = surface.result
	if result ~= nil and result.defDoc ~= nil and tagsMod.className(tagsMod.parseBlock(result.defDoc)) ~= nil then
		return true
	end
	for _, value in surface.env do
		if
			value.kind == "table"
			and value.defDoc ~= nil
			and tagsMod.className(tagsMod.parseBlock(value.defDoc)) ~= nil
		then
			return true
		end
	end
	return graph.floatingClassBlock(mod) ~= nil
end

--- Emits diagnostics for unresolved requires only after promoting a module to
--- `surfaced`, keeping tags-only helper modules quiet.
local function drainRequireFailures(mod: ModuleData, diag: Collector)
	for _, failure in mod.requireFailures do
		if failure.reason == "require-nonmodule" then
			diag:info(failure.reason, failure.detail, mod.id, failure.line)
		else
			diag:warn(failure.reason, failure.detail, mod.id, failure.line)
		end
	end
	table.clear(mod.requireFailures)
end

local function evaluateModule(
	proj: Project,
	absPath: string,
	g: Graph,
	diag: Collector,
	resolveAndEnqueue: (mod: ModuleData, absPath: string, sym: any) -> (string?, RequireFailure?)
)
	local id = util.relPath(proj.root, absPath)
	local mod: ModuleData = {
		id = id,
		absPath = absPath,
		name = requiresMod.instanceName(proj, absPath),
		instancePath = instancePath(proj, absPath),
		-- Settled by the closure pass after the BFS.
		surfaced = false,
		parsed = nil,
		blocks = nil,
		claimIndex = nil,
		trailingIndex = nil,
		surface = nil,
		requireTargets = {},
		requireFailures = {},
		localModules = {},
		externalRequires = {},
		localExternals = {},
	}
	table.insert(g.modules, mod)
	g.byId[id] = mod
	g.byAbs[absPath] = mod

	local source = util.readFileSafe(absPath)
	if source == nil then
		diag:error("parse-error", "could not read " .. id, id)
		return
	end

	local parsed, parseErr, parseLine = parseMod.parse(source)
	if parsed == nil then
		diag:error("parse-error", tostring(parseErr), id, parseLine)
		return
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
		parsed.cst = nil
	end)
	if not okEval then
		diag:error("extract-failed", tostring(evalErr), id)
		return
	end

	local surface = mod.surface :: surfaceMod.SurfaceResult

	local surfacedRequires = collectSurfacedRequires(surface.result)
	mod.surfacedRequires = surfacedRequires
	local resolvedSyms: { [any]: boolean } = {}
	for _, sym in surfacedRequires do
		resolvedSyms[sym] = true
		local _, failure = resolveAndEnqueue(mod, absPath, sym)
		if failure ~= nil then
			table.insert(mod.requireFailures, failure)
		end
	end

	-- Resolve `local X = require(...)` bindings for type-prefix linking;
	-- their target modules join the graph as tags-only unless promoted later.
	local localNames = {}
	for name in surface.requireLocals do
		table.insert(localNames, name)
	end
	table.sort(localNames)
	for _, name in localNames do
		local sym = surface.requireLocals[name]
		local known = mod.requireTargets[sym]
		-- Skip requires already resolved (or recorded as a failure or
		-- external runtime module) during the surfaced-requires pass above.
		if known == nil and not resolvedSyms[sym] then
			-- Unresolved local requires are not part of the public surface, so do not emit diagnostics.
			known = (resolveAndEnqueue(mod, absPath, sym))
		end
		if known ~= nil then
			mod.localModules[name] = known
		elseif mod.externalRequires[sym] ~= nil then
			mod.localExternals[name] = mod.externalRequires[sym]
		end
	end
end

--- Computes the surfaced closure: entry modules, `@class`-declaring modules,
--- and every module reachable through a surfaced module's `surfacedRequires`.
local function promoteSurfacedModules(g: Graph, entryAbsPaths: { string }, diag: Collector)
	local pending: { ModuleData } = {}
	local function seed(mod: ModuleData?)
		if mod ~= nil and not mod.surfaced then
			mod.surfaced = true
			table.insert(pending, mod)
		end
	end
	for _, entry in entryAbsPaths do
		seed(g.byAbs[util.normPath(entry)])
	end
	for _, mod in g.modules do
		if not mod.surfaced and declaresClass(mod) then
			seed(mod)
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
	-- Drain require failures in BFS order rather than closure order so
	-- diagnostic ordering stays deterministic regardless of which edge surfaced a module first.
	for _, mod in g.modules do
		if mod.surfaced then
			drainRequireFailures(mod, diag)
		end
	end
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

	--- Shared resolution helper for surfaced requires and require-locals:
	--- rejects targets outside the project root and registers and enqueues
	--- resolved in-root modules. The caller decides whether to report a failure.
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
			-- Runtime alias targets (`@lute/...`, `@lune/...`) are external
			-- modules rather than graph nodes or resolution failures.
			if resolution.external ~= nil then
				mod.externalRequires[sym] = resolution.external
				return nil, nil
			end
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
		evaluateModule(proj, absPath, g, diag, resolveAndEnqueue)
	end

	promoteSurfacedModules(g, entryAbsPaths, diag)
	return g
end

return graph

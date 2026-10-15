--- Require resolution: string requires (standard Luau semantics) and Roblox
--- instance-style requires (`script.Parent` chains, `WaitForChild`, and
--- `FindFirstChild`) mapped onto the filesystem, together with `.luaurc` alias
--- chains and Rojo `*.project.json` instance trees (including nested project mounts).

local fs = require("@std/fs")
local json = require("@std/json")
local util = require("./util")

export type RojoNode = {
	name: string,
	fsPath: string?, -- absolute
	children: { [string]: RojoNode },
	parent: RojoNode?,
}

export type Project = {
	root: string, -- absolute
	rojoRoot: RojoNode?,
	rojoByPath: { [string]: RojoNode }, -- normalized abs fsPath -> node
	luaurcCache: { [string]: { [string]: string }? },
	luaurcBroken: { [string]: boolean }, -- dirs whose .luaurc failed to parse
	aliases: { [string]: string | boolean }, -- runtime-provided aliases (lowercased) -> docs base URL, or true
}

--- A runtime module referenced through a runtime alias (`@lute/...`, `@lune/...`).
--- `spelling` is the require string as written, `alias` and `path` are its two
--- halves (`lute`, `net/client`), and `url` is its documentation page when the
--- alias has a base URL configured.
export type External = { spelling: string, alias: string, path: string, url: string? }

export type Resolution =
	{ ok: true, absPath: string }
	| { ok: false, reason: string, detail: string, external: External? }

local requires = {}

local isDir, isFile, isInitFile, stem = util.isDir, util.isFile, util.isInitFile, util.stem
local readFileSafe = util.readFileSafe

--- Rewrites `.luaurc` text into strict JSON. Luau parses `.luaurc` with its own
--- lexer (`Config.cpp`), which accepts `--` line and block comments, `//` line
--- comments, and trailing commas before closing brackets. Strip all three outside
--- string literals.
local function luaurcToJson(text: string): string
	local out: { string } = {}
	local i = 1
	local n = #text
	while i <= n do
		local c = text:sub(i, i)
		if c == '"' then
			local j = util.closingQuote(text, i)
			table.insert(out, text:sub(i, j))
			i = j + 1
		elseif c == "-" and text:sub(i + 1, i + 1) == "-" then
			i = util.commentEnd(text, i)
		elseif c == "/" and text:sub(i + 1, i + 1) == "/" then
			i = text:find("\n", i, true) or (n + 1)
		else
			if c == "}" or c == "]" then
				-- Remove a trailing comma from the last non-blank token emitted.
				local k = #out
				while k > 0 and out[k]:match("^%s*$") ~= nil do
					k -= 1
				end
				if k > 0 and out[k] == "," then
					out[k] = ""
				end
			end
			table.insert(out, c)
			i += 1
		end
	end
	return table.concat(out)
end

local function parseJson(text: string): any?
	local ok, value = pcall(json.deserialize, text)
	return if ok then value else nil
end

local MAX_NESTED_PROJECTS = 10

local function buildRojoNode(
	name: string,
	spec: any,
	baseDir: string,
	depth: number,
	byPath: { [string]: RojoNode }
): RojoNode
	local node: RojoNode = {
		name = name,
		fsPath = nil,
		children = {},
		parent = nil,
	}
	local specPath = spec["$path"]
	if type(specPath) == "string" then
		local abs = util.normPath(util.joinPath(baseDir, specPath))
		node.fsPath = abs
		byPath[abs] = node
		-- Nested project mount: a directory containing `default.project.json`,
		-- or a `$path` pointing directly to a `*.project.json` file.
		if depth < MAX_NESTED_PROJECTS and fs.exists(abs) then
			local isDirMount = util.isDir(abs)
			local nestedFile = if isDirMount
				then util.joinPath(abs, "default.project.json")
				elseif abs:match("%.project%.json$") ~= nil then abs
				else nil
			local nestedText = if nestedFile ~= nil then readFileSafe(nestedFile) else nil
			if nestedText ~= nil then
				local nested = parseJson(nestedText)
				if nested ~= nil and type(nested.tree) == "table" then
					local nestedBase = if isDirMount then abs else util.dirname(abs)
					local nestedNode = buildRojoNode(name, nested.tree, nestedBase, depth + 1, byPath)
					node.fsPath = nestedNode.fsPath or node.fsPath
					if node.fsPath ~= nil then
						byPath[node.fsPath :: string] = node
					end
					for childName, child in nestedNode.children do
						node.children[childName] = child
						child.parent = node
					end
				end
			end
		end
	end
	-- Sort child keys rather than iterating in hash order so two children
	-- sharing one `$path` resolve deterministically in `byPath`.
	local childKeys = {}
	for key, value in spec do
		if type(key) == "string" and key:sub(1, 1) ~= "$" and type(value) == "table" then
			table.insert(childKeys, key)
		end
	end
	table.sort(childKeys)
	for _, key in childKeys do
		local child = buildRojoNode(key, spec[key], baseDir, depth, byPath)
		child.parent = node
		node.children[key] = child
	end
	return node
end

--- Loads project configuration. Returns an error string only when an explicitly
--- passed `projectFile` is unreadable or invalid; the implicit
--- `default.project.json` probe is best-effort.
function requires.load(
	root: string,
	opts: { projectFile: string?, aliases: { [string]: string | boolean }? }?
): (Project, string?)
	local options = opts or {}
	local explicit = options.projectFile ~= nil
	local self: Project = {
		root = util.normPath(root),
		rojoRoot = nil,
		rojoByPath = {},
		luaurcCache = {},
		luaurcBroken = {},
		aliases = options.aliases or {},
	}

	local projectFile = options.projectFile
	if projectFile == nil then
		local default = util.joinPath(root, "default.project.json")
		if fs.exists(default) then
			projectFile = default
		end
	end
	if projectFile ~= nil then
		local text = readFileSafe(projectFile)
		if text == nil then
			if explicit then
				return self, "could not read project file: " .. (projectFile :: string)
			end
		else
			local data = parseJson(text)
			if data == nil or type(data.tree) ~= "table" then
				if explicit then
					return self, "not a rojo project file (invalid JSON or no tree): " .. (projectFile :: string)
				end
			else
				self.rojoRoot =
					buildRojoNode(data.name or "root", data.tree, util.dirname(projectFile), 0, self.rojoByPath)
			end
		end
	end

	return self, nil
end

--- Merges `.luaurc` aliases from `project.root` down to `fileAbs`'s directory,
--- with nearer `.luaurc` files overriding outer ones. Alias targets are
--- resolved to absolute paths and keys are lowercased (Luau resolves aliases
--- case-insensitively). The second return lists directories whose `.luaurc`
--- failed to parse so an unresolved alias diagnostic can name the broken file.
local function aliasesFor(self: Project, fileAbs: string): ({ [string]: string }, { string })
	local dir = util.dirname(util.normPath(fileAbs))
	local chain = {}
	local cursor = dir
	while true do
		table.insert(chain, 1, cursor)
		if cursor == self.root or cursor == util.dirname(cursor) then
			break
		end
		local parent = util.dirname(cursor)
		if #parent >= #cursor then
			break
		end
		cursor = parent
	end

	local merged: { [string]: string } = {}
	local broken: { string } = {}
	for _, d in chain do
		local cached = self.luaurcCache[d]
		if cached == nil then
			local text = readFileSafe(util.joinPath(d, ".luaurc"))
			if text ~= nil then
				local data = parseJson(luaurcToJson(text))
				if data == nil then
					self.luaurcBroken[d] = true
				end
				local aliases: { [string]: string } = {}
				if data ~= nil and type(data.aliases) == "table" then
					for name, target in data.aliases do
						if type(name) == "string" and type(target) == "string" then
							aliases[name:lower()] = if util.isAbsolute(target)
								then target
								else util.normPath(util.joinPath(d, target))
						end
					end
				end
				self.luaurcCache[d] = aliases
				cached = aliases
			else
				self.luaurcCache[d] = {}
				cached = {}
			end
		end
		if self.luaurcBroken[d] then
			table.insert(broken, d)
		end
		for name, target in cached :: { [string]: string } do
			merged[name] = target
		end
	end
	return merged, broken
end

function requires.rojoNodeAt(self: Project, absPath: string): RojoNode?
	return self.rojoByPath[util.normPath(absPath)]
end

local function isModuleFile(p: string): boolean
	return p:match("%.luau?$") ~= nil
end

--- Probes `base .. ".luau"` then `base .. ".lua"`, centralizing the `.luau`
--- over `.lua` extension precedence.
local function luauOrLua(base: string): string?
	for _, candidate in { base .. ".luau", base .. ".lua" } do
		if isFile(candidate) then
			return candidate
		end
	end
	return nil
end

local function findInitFile(dir: string): string?
	return luauOrLua(util.joinPath(dir, "init"))
end
requires.findInitFile = findInitFile

--- Resolves `p` to a module file via a single `pathType` check plus extension/init probes.
local function findModuleFile(p: string): string?
	local kind = util.pathType(p)
	if kind == "file" and isModuleFile(p) then
		return p
	end
	local sibling = luauOrLua(p)
	if sibling ~= nil then
		return sibling
	end
	if kind == "dir" then
		return findInitFile(p)
	end
	return nil
end

local resolveInstancePath -- forward

--- Converts a relative require path (`./x`, `../x`, or `@self/x`) into instance-path
--- segments (`"Parent"` and child names) for Rojo `$path` mount fallback.
local function relativeRojoSegs(rel: string, fromSelf: boolean): { string }
	local segs: { string } = if fromSelf then {} else { "Parent" }
	for part in rel:gmatch("[^/]+") do
		if part == ".." then
			table.insert(segs, "Parent")
		elseif part ~= "." then
			table.insert(segs, part)
		end
	end
	return segs
end

--- String require semantics:
---   * plain file `foo.luau`: `./x` is a sibling of `foo.luau`, and `@self/x`
---     reaches into the child directory named after it (`foo/x`)
---   * `init.luau`: the module node IS its directory, so `./x` is a sibling of
---     that directory and `@self/x` reaches inside it
function requires.resolveString(project: Project, fromFileAbs: string, text: string): Resolution
	local fromInit = isInitFile(fromFileAbs)
	local fileDir = util.dirname(fromFileAbs)
	local baseDir = if fromInit then util.dirname(fileDir) else fileDir

	local target: string? = nil
	local rojoSegs: { string }? = nil
	if text:sub(1, 2) == "./" then
		target = util.joinPath(baseDir, text:sub(3))
		rojoSegs = relativeRojoSegs(text:sub(3), false)
	elseif text:sub(1, 3) == "../" then
		target = util.joinPath(baseDir, text)
		rojoSegs = relativeRojoSegs(text, false)
	elseif text:sub(1, 1) == "@" then
		-- Dots are legal in alias names, so the character class must include `.`
		-- or `@my.pkg/mod` would fail to match.
		local alias, rest = text:match("^@([%w_%-%.]+)/?(.*)$")
		if alias == nil then
			return { ok = false, reason = "require-unresolved", detail = "malformed alias " .. text }
		end
		-- Luau alias resolution is case-insensitive, so both `@self` and `.luaurc`
		-- lookups compare lowercased keys.
		if alias:lower() == "self" then
			local selfDir = if fromInit then fileDir else util.joinPath(fileDir, stem(fromFileAbs))
			target = if rest ~= "" then util.joinPath(selfDir, rest) else selfDir
			rojoSegs = relativeRojoSegs(rest, true)
		else
			local aliases, broken = aliasesFor(project, fromFileAbs)
			local aliasTarget = aliases[alias:lower()]
			local isHiddenPkg = aliasTarget ~= nil and util.relPath(project.root, aliasTarget):match("^%.[^/\\]") ~= nil
			-- A `.luaurc` alias into project source overrides runtime aliases so
			-- projects that shadow `@std` locally resolve to their own files;
			-- aliases into dot-directories (`.sert/`, `.pesde/`) are external packages.
			local runtime = if aliasTarget == nil or isHiddenPkg
				then (project.aliases[alias:lower()] or isHiddenPkg)
				else false
			if runtime then
				local url: string? = nil
				if type(runtime) == "string" then
					url = if rest ~= "" then runtime .. "/" .. rest else runtime
				end
				return {
					ok = false,
					reason = "require-external",
					detail = "runtime module " .. text,
					external = { spelling = text, alias = alias:lower(), path = rest, url = url },
				}
			end
			if aliasTarget == nil then
				local detail = "unknown alias @" .. alias
				if #broken > 0 then
					detail ..= " (malformed .luaurc in " .. table.concat(broken, ", ") .. ")"
				end
				return { ok = false, reason = "require-unresolved", detail = detail }
			end
			target = if rest ~= "" then util.joinPath(aliasTarget, rest) else aliasTarget
		end
	else
		return { ok = false, reason = "require-unresolved", detail = "bare require path " .. string.format("%q", text) }
	end

	local resolved = findModuleFile(util.normPath(target :: string))
	if resolved == nil and project.rojoRoot ~= nil and rojoSegs ~= nil then
		local viaRojo = resolveInstancePath(project, fromFileAbs, rojoSegs)
		if viaRojo.ok then
			return viaRojo
		end
	end
	if resolved == nil then
		return { ok = false, reason = "require-unresolved", detail = "no module at " .. tostring(target) }
	end
	return { ok = true, absPath = util.normPath(resolved) }
end

--- Virtual node for instance-path navigation: an fs location plus an optional
--- Rojo tree node (mounts, renamed children, and nested projects).
type VNode = { fsPath: string?, rojo: RojoNode?, isFile: boolean }

--- Returns the Rojo node for `fileAbs`: either a direct mount of the file itself
--- or, for `init.luau`, the node mounted at its parent directory. Direct file
--- mounts take priority over directory mounts.
local function rojoNodeFor(project: Project, fileAbs: string): RojoNode?
	local node = requires.rojoNodeAt(project, fileAbs)
	if node == nil and isInitFile(fileAbs) then
		node = requires.rojoNodeAt(project, util.dirname(fileAbs))
	end
	return node
end

--- Starting `VNode` for `script` in `fileAbs`. An `init.luau` file navigates as
--- its parent directory regardless of whether Rojo mounted the file or the directory.
local function vnodeForFile(project: Project, fileAbs: string): VNode
	local rojo = rojoNodeFor(project, fileAbs)
	if isInitFile(fileAbs) then
		return { fsPath = util.dirname(fileAbs), rojo = rojo, isFile = false }
	end
	return { fsPath = util.normPath(fileAbs), rojo = rojo, isFile = true }
end

local function vnodeFromRojo(node: RojoNode): VNode
	local fsPath = node.fsPath
	return {
		fsPath = fsPath,
		rojo = node,
		isFile = fsPath ~= nil and isFile(fsPath :: string),
	}
end

local function parentOf(project: Project, v: VNode): VNode?
	if v.rojo ~= nil and v.rojo.parent ~= nil then
		return vnodeFromRojo(v.rojo.parent :: RojoNode)
	end
	if v.fsPath == nil then
		return nil
	end
	local parentDir = util.dirname(v.fsPath :: string)
	if #parentDir >= #(v.fsPath :: string) then
		return nil
	end
	return { fsPath = parentDir, rojo = requires.rojoNodeAt(project, parentDir), isFile = false }
end

local function childOf(project: Project, v: VNode, name: string): VNode?
	if v.rojo ~= nil then
		local child = v.rojo.children[name]
		if child ~= nil then
			return vnodeFromRojo(child)
		end
	end
	local base = v.fsPath
	if base == nil then
		return nil
	end
	if v.isFile then
		-- Children of a file module live in a sibling directory with the same stem.
		base = util.joinPath(util.dirname(base :: string), stem(base :: string))
	end
	local candidate = luauOrLua(util.joinPath(base :: string, name))
	if candidate ~= nil then
		return { fsPath = util.normPath(candidate), rojo = requires.rojoNodeAt(project, candidate), isFile = true }
	end
	local subdir = util.joinPath(base :: string, name)
	if isDir(subdir) then
		return { fsPath = util.normPath(subdir), rojo = requires.rojoNodeAt(project, subdir), isFile = false }
	end
	return nil
end

local function vnodeModuleFile(v: VNode): string?
	if v.fsPath == nil then
		return nil
	end
	if v.isFile then
		local p = v.fsPath :: string
		return if isModuleFile(p) then p else nil
	end
	return findModuleFile(v.fsPath :: string)
end

--- Display name of a file as an instance.
function requires.instanceName(project: Project, fileAbs: string): string
	local node = rojoNodeFor(project, fileAbs)
	if node ~= nil and node.name ~= nil and node.name ~= "" then
		return node.name
	end
	if isInitFile(fileAbs) then
		return util.basename(util.dirname(fileAbs))
	end
	return stem(fileAbs)
end

--- Computes the Rojo instance path for `fileAbs` by climbing to the nearest
--- mounted Rojo ancestor and appending the folder names crossed on the way down.
--- Returns `nil` when the climb reaches the filesystem root without hitting a
--- Rojo mount, letting the caller fall back to folder layout.
function requires.instancePath(project: Project, fileAbs: string): { string }?
	local node = rojoNodeFor(project, fileAbs)
	local below: { string } = {}
	if node == nil then
		-- `dir/init.luau` represents `dir`, so start climbing from the directory.
		local current = if isInitFile(fileAbs) then util.dirname(fileAbs) else util.normPath(fileAbs)
		while node == nil do
			table.insert(below, 1, stem(current))
			local parent = util.dirname(current)
			if parent == current or parent == "" then
				return nil
			end
			current = parent
			node = requires.rojoNodeAt(project, current)
		end
	end

	local path: { string } = {}
	local ancestor: RojoNode? = node
	while ancestor ~= nil do
		table.insert(path, 1, ancestor.name)
		ancestor = ancestor.parent
	end
	for _, name in below do
		table.insert(path, name)
	end
	return path
end

resolveInstancePath = function(project: Project, fromFileAbs: string, segs: { string }): Resolution
	local v: VNode? = vnodeForFile(project, fromFileAbs)
	for _, seg in segs do
		if v == nil then
			break
		end
		if seg == "Parent" then
			v = parentOf(project, v :: VNode)
		else
			v = childOf(project, v :: VNode, seg)
		end
	end
	if v == nil then
		return { ok = false, reason = "require-unresolved", detail = "instance path script." .. table.concat(segs, ".") }
	end
	local moduleFile = vnodeModuleFile(v :: VNode)
	if moduleFile == nil then
		return {
			ok = false,
			reason = "require-nonmodule",
			detail = "instance path script." .. table.concat(segs, ".") .. " is not a module file",
		}
	end
	return { ok = true, absPath = util.normPath(moduleFile) }
end

function requires.resolve(project: Project, fromFileAbs: string, requireInfo: any): Resolution
	if requireInfo == nil or requireInfo.kind == "dynamic" then
		return { ok = false, reason = "require-unresolved", detail = "dynamic require argument" }
	end
	if requireInfo.kind == "string" then
		return requires.resolveString(project, fromFileAbs, requireInfo.text)
	end
	if requireInfo.kind == "ipath" then
		return resolveInstancePath(project, fromFileAbs, requireInfo.segs)
	end
	return { ok = false, reason = "require-unresolved", detail = "unknown require kind" }
end

return requires

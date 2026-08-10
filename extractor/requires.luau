--- Require resolution: string requires (current Luau semantics) and Roblox
--- instance-style requires (script.Parent chains, WaitForChild/FindFirstChild)
--- mapped onto the filesystem, plus the project context that mapping reads:
--- .luaurc alias chains and rojo *.project.json instance trees (including
--- nested project mounts). One module because turning a require expression
--- into a file is what the alias chains and rojo tree exist to answer.

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
}

export type Resolution = { ok: true, absPath: string } | { ok: false, reason: string, detail: string }

local requires = {}

local isDir, isFile, isInitFile, stem = util.isDir, util.isFile, util.isInitFile, util.stem
local readFileSafe = util.readFileSafe

--- Strips // line comments (string-aware) so .luaurc parses as JSON.
local function stripJsonComments(text: string): string
	local out = {}
	local i = 1
	local inString = false
	local n = #text
	while i <= n do
		local c = text:sub(i, i)
		if inString then
			table.insert(out, c)
			if c == "\\" then
				table.insert(out, text:sub(i + 1, i + 1))
				i += 1
			elseif c == '"' then
				inString = false
			end
		elseif c == '"' then
			inString = true
			table.insert(out, c)
		elseif c == "/" and text:sub(i + 1, i + 1) == "/" then
			while i <= n and text:sub(i, i) ~= "\n" do
				i += 1
			end
			table.insert(out, "\n")
		else
			table.insert(out, c)
		end
		i += 1
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
		-- nested project mount: a directory holding default.project.json, or a
		-- `$path` naming a *.project.json file
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
	-- sorted, not hash order: JSON parsing loses declared order, so two children
	-- sharing one $path would otherwise race for byPath (last wins)
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

--- The second return errors only when an *explicitly* passed project file is
--- unusable; the implicit default.project.json probe stays best-effort.
function requires.load(root: string, opts: { projectFile: string? }?): (Project, string?)
	local options = opts or {}
	local explicit = options.projectFile ~= nil
	local self: Project = {
		root = util.normPath(root),
		rojoRoot = nil,
		rojoByPath = {},
		luaurcCache = {},
		luaurcBroken = {},
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

--- Merged .luaurc aliases for a file: root down to the file's directory, nearer
--- files overriding. Targets are absolute; names are lowercased because Luau
--- resolves them case-insensitively. The second return lists chain directories
--- whose .luaurc failed to parse, so an alias miss can name the broken file.
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
				local data = parseJson(stripJsonComments(text))
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
	return p:match("%.luau$") ~= nil or p:match("%.lua$") ~= nil
end

--- The extension probe, and the one place `.luau` beating `.lua` is spelled:
--- callers hand over the extensionless path.
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

--- One stat answers both the file and directory questions about `p`.
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

--- String require semantics:
---   * plain file foo.luau: `./x` is a sibling of foo.luau, and `@self/x`
---     reaches into the component directory named after it (`foo/x`)
---   * init.luau: the module node IS its directory, so `./x` is a sibling of
---     that directory and `@self/x` reaches inside it
function requires.resolveString(project: Project, fromFileAbs: string, text: string): Resolution
	local fromInit = isInitFile(fromFileAbs)
	local fileDir = util.dirname(fromFileAbs)
	local baseDir = if fromInit then util.dirname(fileDir) else fileDir

	local target: string? = nil
	if text:sub(1, 2) == "./" then
		target = util.joinPath(baseDir, text:sub(3))
	elseif text:sub(1, 3) == "../" then
		target = util.joinPath(baseDir, text)
	elseif text:sub(1, 1) == "@" then
		-- dots are legal in alias names, so the class must accept them or
		-- `@my.pkg/mod` splits at the first dot
		local alias, rest = text:match("^@([%w_%-%.]+)/?(.*)$")
		if alias == nil then
			return { ok = false, reason = "require-unresolved", detail = "malformed alias " .. text }
		end
		-- Luau alias resolution is case-insensitive, so both @self and .luaurc
		-- lookups compare lowercased (aliasesFor stores keys lowered)
		if alias:lower() == "self" then
			local selfDir = if fromInit then fileDir else util.joinPath(fileDir, stem(fromFileAbs))
			target = if rest ~= "" then util.joinPath(selfDir, rest) else selfDir
		else
			local aliases, broken = aliasesFor(project, fromFileAbs)
			local aliasTarget = aliases[alias:lower()]
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
	if resolved == nil then
		return { ok = false, reason = "require-unresolved", detail = "no module at " .. tostring(target) }
	end
	return { ok = true, absPath = util.normPath(resolved) }
end

--- Virtual node for instance-path navigation: an fs location plus an optional
--- rojo tree node (mounts, renamed children, nested projects).
type VNode = { fsPath: string?, rojo: RojoNode?, isFile: boolean }

local function vnodeForFile(project: Project, fileAbs: string): VNode
	if isInitFile(fileAbs) then
		local dir = util.dirname(fileAbs)
		return { fsPath = dir, rojo = requires.rojoNodeAt(project, dir), isFile = false }
	end
	return { fsPath = util.normPath(fileAbs), rojo = requires.rojoNodeAt(project, fileAbs), isFile = true }
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
		-- children of a file node live in a sibling directory named after it
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

--- The rojo node a file becomes: its own, or (for `init.luau`) the one mounted
--- at its directory. In that order: a `$path` naming the init file itself is a
--- direct mount and outranks the directory it happens to sit in.
local function rojoNodeFor(project: Project, fileAbs: string): RojoNode?
	local node = requires.rojoNodeAt(project, fileAbs)
	if node == nil and isInitFile(fileAbs) then
		node = requires.rojoNodeAt(project, util.dirname(fileAbs))
	end
	return node
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

--- Rojo declares only mount points, so this climbs to the nearest mounted
--- ancestor and appends the folder names crossed on the way down. nil when the
--- climb reaches the filesystem root without meeting rojo; the caller falls
--- back to the folder layout.
function requires.instancePath(project: Project, fileAbs: string): { string }?
	local node = rojoNodeFor(project, fileAbs)
	local below: { string } = {}
	if node == nil then
		-- `dir/init.luau` *is* `dir`, so climb from the directory either way
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

local function resolveInstancePath(project: Project, fromFileAbs: string, segs: { string }): Resolution
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

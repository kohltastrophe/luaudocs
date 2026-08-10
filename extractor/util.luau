--- Small shared helpers for the extractor: the diagnostic collector every
--- stage reports through (Lute has no stderr write API, so problems ride
--- inside the model), path helpers (relPath keeps module ids posix-spelled
--- on every platform, mirroring the renderer's toPosix; the Windows CI leg
--- is why), and the line-trimming the doc-comment passes share.

local fs = require("@std/fs")
local pathlib = require("@std/path")

local util = {}

export type Severity = "error" | "warning" | "info"
export type Diagnostic = {
	severity: Severity,
	code: string,
	message: string,
	file: string?,
	line: number?,
}

export type Collector = {
	list: { Diagnostic },
	add: (self: Collector, severity: Severity, code: string, message: string, file: string?, line: number?) -> (),
	error: (self: Collector, code: string, message: string, file: string?, line: number?) -> (),
	warn: (self: Collector, code: string, message: string, file: string?, line: number?) -> (),
	info: (self: Collector, code: string, message: string, file: string?, line: number?) -> (),
}

--- Diagnostics are emitted into the doc-model JSON; the extractor never crashes
--- on weird-but-parseable code, it degrades and reports.
function util.diagnostics(): Collector
	local collector = { list = {} } :: Collector
	function collector.add(self, severity, code, message, file, line)
		table.insert(self.list, {
			severity = severity,
			code = code,
			message = message,
			file = file,
			line = line,
		})
	end
	function collector.error(self, code, message, file, line)
		self:add("error", code, message, file, line)
	end
	function collector.warn(self, code, message, file, line)
		self:add("warning", code, message, file, line)
	end
	function collector.info(self, code, message, file, line)
		self:add("info", code, message, file, line)
	end
	return collector
end

-- @std/path returns path objects (tables with __tostring); these wrappers hand
-- back plain strings.

function util.joinPath(...: string): string
	return tostring(pathlib.join(...))
end

function util.normPath(p: string): string
	return tostring(pathlib.normalize(p))
end

--- Always `/`-separated: results become module ids, which land in the doc-model
--- JSON and in source-link URLs, never in filesystem calls.
function util.relPath(from: string, to: string): string
	return (tostring(pathlib.relative(from, to)):gsub("\\", "/"))
end

function util.resolvePath(p: string): string
	return tostring(pathlib.resolve(p))
end

function util.dirname(p: string): string
	return tostring(pathlib.dirname(p))
end

function util.basename(p: string): string
	return tostring(pathlib.basename(p))
end

function util.isAbsolute(p: string): boolean
	return pathlib.isAbsolute(p)
end

--- `dir/init.luau` *is* `dir`, an exact match, so `init.client.luau` stays a
--- plain module.
function util.isInitFile(fileAbs: string): boolean
	local base = util.basename(fileAbs)
	return base == "init.luau" or base == "init.lua"
end

--- Strips one extension only: `data.lua.luau` stems to `data.lua`, not `data`.
function util.stem(p: string): string
	local base = util.basename(p)
	local stripped = base:gsub("%.luau$", "")
	if stripped == base then
		stripped = base:gsub("%.lua$", "")
	end
	return stripped
end

--- fs.type throws on paths it cannot stat, so the pcall doubles as the
--- existence check. nil means missing.
function util.pathType(p: string): string?
	local ok, kind = pcall(fs.type, p)
	return if ok then kind else nil
end

function util.isDir(p: string): boolean
	return util.pathType(p) == "dir"
end

function util.isFile(p: string): boolean
	return util.pathType(p) == "file"
end

--- nil collapses missing and unreadable: every caller treats them alike.
function util.readFileSafe(p: string): string?
	if not fs.exists(p) then
		return nil
	end
	local ok, text = pcall(fs.readFileToString, p)
	return if ok then text else nil
end

--- The args after the `--` separator in process.args: the script's own argv
--- (Lute puts the runner's args first).
function util.argsAfterSeparator(processArgs: { string }): { string }
	local out: { string } = {}
	local past = false
	for _, a in processArgs do
		if past then
			table.insert(out, a)
		elseif a == "--" then
			past = true
		end
	end
	return out
end

function util.trim(s: string): string
	local trimmed = s:gsub("^%s+", ""):gsub("%s+$", "")
	return trimmed
end

--- Splits on \n and \r\n. Always yields at least one line.
function util.splitLines(text: string): { string }
	local lines = string.split(text, "\n")
	for index, line in lines do
		lines[index] = (line:gsub("\r$", ""))
	end
	-- split yields a trailing empty line when text already ends with \n
	if #lines > 1 and lines[#lines] == "" and text:sub(-1) == "\n" then
		table.remove(lines)
	end
	return lines
end

function util.trimEmptyLines(lines: { string }): { string }
	local first, last = 1, #lines
	while first <= last and util.trim(lines[first]) == "" do
		first += 1
	end
	while last >= first and util.trim(lines[last]) == "" do
		last -= 1
	end
	local out = {}
	for i = first, last do
		table.insert(out, lines[i])
	end
	return out
end

--- A shared prefix string, not a character count: counting would treat a tab
--- and a space as equal width and mis-strip blocks that mix them.
function util.commonIndent(lines: { string }): string?
	local prefix: string? = nil
	for _, line in lines do
		if util.trim(line) ~= "" then
			local indent = line:match("^[ \t]*") :: string
			if prefix == nil then
				prefix = indent
			else
				local limit = math.min(#prefix, #indent)
				local shared = 0
				while shared < limit and prefix:sub(shared + 1, shared + 1) == indent:sub(shared + 1, shared + 1) do
					shared += 1
				end
				prefix = prefix:sub(1, shared)
			end
			if prefix == "" then
				break
			end
		end
	end
	return prefix
end

function util.dedent(lines: { string }): { string }
	local prefix = util.commonIndent(lines)
	if prefix == nil or prefix == "" then
		return lines
	end
	local out = {}
	for _, line in lines do
		if util.trim(line) == "" then
			table.insert(out, "")
		else
			table.insert(out, line:sub(#prefix + 1))
		end
	end
	return out
end

function util.joinDesc(lines: { string }): string
	return table.concat(util.trimEmptyLines(lines), "\n")
end

return util

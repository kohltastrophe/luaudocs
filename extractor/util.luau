--- Shared helpers for the extractor: the diagnostic collector every stage
--- reports through (Lute has no stderr write API, so diagnostics travel inside
--- the doc-model JSON), path helpers (`relPath` normalizes separators to `/`
--- across platforms to match the renderer's `toPosix`), and string/line utilities.

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

--- Diagnostics are emitted into the doc-model JSON; on unexpected or malformed
--- constructs, the extractor records a diagnostic and degrades gracefully.
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

-- `@std/path` returns path objects (tables with `__tostring`); these wrappers
-- return plain strings.

function util.joinPath(...: string): string
	return tostring(pathlib.join(...))
end

function util.normPath(p: string): string
	return tostring(pathlib.normalize(p))
end

--- Always `/`-separated: results become module IDs in the doc-model JSON and
--- source-link URLs rather than OS filesystem paths.
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

--- Matches `init.luau` and `init.lua` only, so `init.client.luau` remains a plain module.
function util.isInitFile(fileAbs: string): boolean
	return util.basename(fileAbs):match("^init%.luau?$") ~= nil
end

--- Strips a single `.luau`/`.lua` extension (`data.lua.luau` stems to `data.lua`).
function util.stem(p: string): string
	local stripped = util.basename(p):gsub("%.luau?$", "")
	return stripped
end

--- `fs.type` throws when `p` does not exist; wrapping it in `pcall` returns `nil` for missing paths.
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

--- Reads `p` as a string, returning `nil` if the file is missing or unreadable.
function util.readFileSafe(p: string): string?
	local ok, text = pcall(fs.readFileToString, p)
	return if ok then text else nil
end

--- Returns the arguments after `--` in `process.args` (Lute places its own runner arguments before `--`).
function util.argsAfterSeparator(processArgs: { string }): { string }
	local sep = table.find(processArgs, "--")
	return if sep ~= nil then table.move(processArgs, sep + 1, #processArgs, 1, {}) else {}
end

function util.trim(s: string): string
	local trimmed = s:gsub("^%s+", ""):gsub("%s+$", "")
	return trimmed
end

--- Splits on `\n` and `\r\n`, always returning at least one line.
function util.splitLines(text: string): { string }
	local lines = string.split(text, "\n")
	for index, line in lines do
		lines[index] = (line:gsub("\r$", ""))
	end
	-- `string.split` produces a trailing empty element when `text` ends with `\n`.
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
	return if first <= last then table.move(lines, first, last, 1, {}) else {}
end

--- Returns the longest whitespace prefix shared by all non-blank lines. Compares
--- exact characters rather than character counts so mixed tabs and spaces are
--- never stripped past their shared prefix.
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

--- Clamped to the last index when the string literal opening at `i` never closes.
function util.closingQuote(text: string, i: number): number
	local quote = text:sub(i, i)
	local n = #text
	local j = i + 1
	while j <= n do
		local cj = text:sub(j, j)
		if cj == "\\" then
			j += 2
		elseif cj == quote then
			break
		else
			j += 1
		end
	end
	return math.min(j, n)
end

--- Index of the first character after a `--` or `--[=[...]=]` comment opening
--- at `i` (the terminating `\n` of a line comment, or `#text + 1` at EOF).
function util.commentEnd(text: string, i: number): number
	local n = #text
	local eq = text:match("^%[(=*)%[", i + 2)
	if eq ~= nil then
		local closeAt = text:find("]" .. eq .. "]", i + 2, true)
		return if closeAt ~= nil then closeAt + #eq + 2 else n + 1
	end
	return text:find("\n", i, true) or (n + 1)
end

return util

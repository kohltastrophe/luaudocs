--- Moonwave-compatible tag grammar over doc-block content lines.
---
--- A line is a tag line iff it matches `@word ...` AND `word` is one of the 24
--- known Moonwave tags; anything else (`@Kohl`, `@2x`, emails) stays prose, as
--- does anything inside a markdown code fence. Prose before the first tag is
--- the description; lines after a tag continue that tag's description when the
--- tag accepts continuation (`@param`, `@return`, etc.) and rejoin the block
--- description otherwise (supporting Moonwave's `@class X` + prose-below pattern).
---
--- `@__index` is accepted and ignored because implementation tables are detected
--- automatically. `@external Name URL` is a data tag that links external type
--- names to their documentation URLs.
---
--- Type/description splitting follows Moonwave (`@param name Type -- desc`);
--- with no separator, the entire remainder is the type. LuauDocs extensions:
--- the type may be omitted (`@param name -- desc`) because types are read from
--- annotations, a single ` - ` also works as a separator (JSDoc style), and a
--- trailing colon on the parameter or field name is stripped.

local util = require("./util")

export type FieldDoc = { name: string, type: string?, desc: string? }
export type ExternalDoc = { name: string, url: string, lineOffset: number }
export type ParamDoc = { name: string, type: string?, desc: string? }
export type ReturnDoc = { type: string?, desc: string? }
export type ErrorDoc = { type: string, desc: string? }

export type Placing = {
	kind: "class" | "prop" | "type" | "function" | "method" | "interface",
	name: string,
}

export type Diagnostic = {
	code: string,
	message: string,
	lineOffset: number,
	severity: "info"?, -- default warning
}

export type ParsedDoc = {
	desc: string, -- markdown prose not claimed by any tag
	placing: Placing?, -- explicit declaration tag, if any
	placingType: string?, -- explicit type on @prop/@type placing tags
	placingDesc: string?, -- trailing ` -- desc` on @prop/@type placing tags
	within: string?, -- @within Owner, or the Class part of a qualified name
	params: { ParamDoc },
	returns: { ReturnDoc },
	errors: { ErrorDoc },
	fields: { FieldDoc }, -- @field lines and `.name` lines in @interface blocks
	flags: { [string]: boolean }, -- yields/unreleased/server/client/plugin/private/ignore/readonly
	deprecated: { version: string?, desc: string? }?,
	since: string?,
	customTags: { string }, -- @tag values
	externals: { ExternalDoc }, -- @external Name URL declarations
	diagnostics: { Diagnostic },
}

--- Realm flag tags in the order the `realm` badge renders them. `realmList`
--- iterates this array so the realm vocabulary is defined in one place.
local REALM_FLAGS = { "server", "client", "plugin" }

local FLAG_TAGS = {
	yields = true,
	unreleased = true,
	private = true,
	ignore = true,
	readonly = true,
}
for _, realm in REALM_FLAGS do
	FLAG_TAGS[realm] = true
end

--- Tag names that declare a member or container; each key matches its `Placing.kind`.
local PLACING_TAGS = {
	class = true,
	prop = true,
	type = true,
	["function"] = true,
	method = true,
	interface = true,
}

local DATA_TAGS = {
	param = true,
	["return"] = true,
	error = true,
	field = true,
	within = true,
	deprecated = true,
	since = true,
	tag = true,
	external = true,
}

--- Redundant with auto-detection: consumed (never treated as prose), reported as info, and dropped.
local IGNORED_TAGS: { [string]: string } = {
	__index = "@__index is ignored: implementation tables are detected automatically",
}

--- Tags whose subsequent non-blank lines continue the tag's own description;
--- for all other tags, subsequent prose rejoins the block description.
local CONTINUABLE = {
	param = true,
	["return"] = true,
	error = true,
	field = true,
	prop = true,
	type = true,
	deprecated = true,
}

local function isKnown(name: string): boolean
	return FLAG_TAGS[name] == true or PLACING_TAGS[name] == true or DATA_TAGS[name] == true or IGNORED_TAGS[name] ~= nil
end

local tags = {}

--- Returns the active realm flags from `flags` in canonical badge order, or `nil` when none are set.
function tags.realmList(flags: { [string]: boolean }): { string }?
	local realm = {}
	for _, flag in REALM_FLAGS do
		if flags[flag] then
			table.insert(realm, flag)
		end
	end
	return if #realm > 0 then realm else nil
end

--- Splits `Type -- desc` (or JSDoc `Type - desc`); with no separator, the entire string is the type.
local function splitTypeDesc(rest: string): (string?, string?)
	rest = util.trim(rest)
	if rest == "" then
		return nil, nil
	end
	-- Starts directly with the separator (`--` or `- `): description only, no type.
	local desc = rest:match("^%-%-%s*(.*)$") or rest:match("^%-%s+(.*)$")
	if desc ~= nil then
		return nil, if desc ~= "" then desc else nil
	end
	local typePart, descPart = rest:match("^(.-)%s+%-%-%s*(.*)$")
	if typePart == nil then
		typePart, descPart = rest:match("^(.-)%s+%-%s+(.*)$")
	end
	if typePart ~= nil then
		typePart = util.trim(typePart)
		return if typePart ~= "" then typePart else nil, if descPart ~= "" then descPart else nil
	end
	return rest, nil
end

--- Splits `Class.Nested.Name` at the last dot into `(memberName, withinClass?)`,
--- keeping dotted container names intact.
local function splitQualified(name: string): (string, string?)
	local class, member = name:match("^([%w_%.]+)%.([%w_]+)$")
	if class ~= nil then
		return member :: string, class
	end
	return name, nil
end

type Entry = {
	name: string,
	arg: string,
	descLines: { string },
	lineOffset: number,
}

function tags.parse(content: { string }): ParsedDoc
	local doc: ParsedDoc = {
		desc = "",
		placing = nil,
		placingType = nil,
		placingDesc = nil,
		within = nil,
		params = {},
		returns = {},
		errors = {},
		fields = {},
		flags = {},
		deprecated = nil,
		since = nil,
		customTags = {},
		externals = {},
		diagnostics = {},
	}

	local proseLines: { string } = {}
	local entries: { Entry } = {}
	local current: Entry? = nil
	local sawInterface = false
	local inFence = false
	local fenceMarker = ""
	local inIndentedCode = false
	local prevBlank = true -- block start counts as a blank boundary

	local function report(code: string, message: string, lineOffset: number, severity: "info"?)
		table.insert(doc.diagnostics, { code = code, message = message, lineOffset = lineOffset, severity = severity })
	end

	local function sink(line: string)
		if current ~= nil then
			table.insert(current.descLines, line)
		else
			table.insert(proseLines, line)
		end
	end

	for i, line in content do
		local blank = line:match("^%s*$") ~= nil
		local wasBlank = prevBlank
		prevBlank = blank

		-- CommonMark allows at most three spaces of indentation before a code
		-- fence; a 4-space-indented ``` is an indented code line (handled below),
		-- and treating it as a fence opener would swallow subsequent tag lines.
		local indent = line:match("^([ \t]*)") :: string
		local fence: string? = nil
		if #indent <= 3 and indent:find("\t", 1, true) == nil then
			fence = line:match("^%s*(```+)") or line:match("^%s*(~~~+)")
		end
		if inFence then
			sink(line)
			-- A closing fence must match the opening fence's character and be at least as long.
			if fence ~= nil and fence:sub(1, 1) == fenceMarker:sub(1, 1) and #fence >= #fenceMarker then
				inFence = false
			end
			continue
		end
		if fence ~= nil then
			inFence = true
			fenceMarker = fence
			sink(line)
			continue
		end

		-- In CommonMark, an indented code block cannot interrupt a paragraph, so
		-- a 4-space-indented line only opens a code block after a blank line.
		-- That keeps `@words` inside indented code examples from parsing as tags
		-- while still allowing `@interface` followed immediately by indented
		-- `.field` lines.
		local codeIndent = not blank and (#indent >= 4 or indent:find("\t", 1, true) ~= nil)
		if inIndentedCode then
			if blank or codeIndent then
				sink(line)
				continue
			end
			inIndentedCode = false
		elseif codeIndent and wasBlank then
			inIndentedCode = true
			sink(line)
			continue
		end

		-- A blank line ends a continuable tag's description so the following
		-- paragraph rejoins the block description. `@interface` `.field` lines
		-- still match across blank lines because `sawInterface` stays true for
		-- the rest of the block.
		if blank then
			current = nil
		end

		local tagName, rest = line:match("^%s*@([%w_]+)%s*(.*)$")
		if tagName ~= nil and IGNORED_TAGS[tagName] ~= nil then
			report("ignored-tag", IGNORED_TAGS[tagName], i, "info")
			current = nil
			continue
		end
		if tagName ~= nil and isKnown(tagName) then
			local entry: Entry = { name = tagName, arg = rest :: string, descLines = {}, lineOffset = i }
			table.insert(entries, entry)
			current = if CONTINUABLE[tagName] then entry else nil
			if tagName == "interface" then
				sawInterface = true
			end
			continue
		end

		-- `.fieldName Type -- desc` inside an `@interface` block.
		if sawInterface then
			local fieldArg = line:match("^%s*%.([%w_]+.*)$")
			if fieldArg ~= nil then
				current = { name = "field", arg = fieldArg, descLines = {}, lineOffset = i }
				table.insert(entries, current :: Entry)
				continue
			end
		end

		sink(line)
	end

	doc.desc = util.joinDesc(proseLines)

	local function mergeDesc(base: string?, entry: Entry): string?
		local extra = util.joinDesc(entry.descLines)
		if extra == "" then
			return base
		end
		if base == nil then
			return extra
		end
		return base .. "\n" .. extra
	end

	--- Parses the shared `@param`/`@field` shape (`name Type -- desc`), stripping
	--- any trailing colon on `name`. Returns `nil` when `entry` has no name.
	local function parseNamedEntry(entry: Entry): (string?, string?, string?)
		local name, rest = util.trim(entry.arg):match("^(%S+)%s*(.*)$")
		if name == nil then
			return nil, nil, nil
		end
		local typeStr, desc = splitTypeDesc(rest :: string)
		return ((name :: string):gsub(":$", "")), typeStr, mergeDesc(desc, entry)
	end

	--- Sets `doc.placing`, or returns `false` if a placing tag was already seen
	--- so the caller also discards the duplicate tag's type, description, and owner.
	local function setPlacing(entry: Entry, kind: string, name: string): boolean
		if doc.placing ~= nil then
			report(
				"duplicate-placing-tag",
				string.format(
					"@%s conflicts with earlier @%s %s; ignoring",
					entry.name,
					doc.placing.kind,
					doc.placing.name
				),
				entry.lineOffset
			)
			return false
		end
		doc.placing = { kind = kind :: any, name = name }
		return true
	end

	for _, entry in entries do
		local name = entry.name
		local arg = util.trim(entry.arg)

		if FLAG_TAGS[name] then
			doc.flags[name] = true
			if arg ~= "" then
				report("unknown-tag-arg", string.format("@%s takes no arguments (got %q)", name, arg), entry.lineOffset)
			end
		elseif PLACING_TAGS[name] then
			local declName: string? = nil
			local rest: string? = nil
			if name == "method" or name == "function" then
				-- `Class:method` is the colon-accessor spelling of a qualified name.
				local qualifier, colonName, colonRest = arg:match("^([%w_%.]+):([%w_]+)%s*(.*)$")
				if qualifier ~= nil then
					declName = qualifier .. "." .. colonName
					rest = colonRest
				end
			end
			if declName == nil then
				declName, rest = arg:match("^([%w_%.]+):?%s*(.*)$")
			end
			if declName == nil then
				report("malformed-tag", "@" .. name .. " requires a name", entry.lineOffset)
			else
				local memberName = declName
				local qualifiedWithin: string? = nil
				-- `@class` keeps dotted names intact; member placing tags split `Class.name`.
				if name ~= "class" then
					local short, within = splitQualified(declName)
					memberName = short
					qualifiedWithin = within
				end
				if setPlacing(entry, name, memberName) then
					if qualifiedWithin ~= nil then
						doc.within = doc.within or qualifiedWithin
					end
					if name == "prop" or name == "type" then
						local typeStr, desc = splitTypeDesc(rest :: string)
						doc.placingType = typeStr
						doc.placingDesc = mergeDesc(desc, entry)
					end
				end
			end
		elseif name == "within" then
			local owner = arg:match("^([%w_%.]+)")
			if owner == nil then
				report("malformed-tag", "@within requires a class name", entry.lineOffset)
			else
				doc.within = owner
			end
		elseif name == "field" or name == "param" then
			local entryName, typeStr, desc = parseNamedEntry(entry)
			if entryName == nil then
				report("malformed-tag", "@" .. name .. " requires a name", entry.lineOffset)
			else
				local list = if name == "field" then doc.fields else doc.params
				table.insert(list, { name = entryName, type = typeStr, desc = desc })
			end
		elseif name == "return" then
			local typeStr, desc = splitTypeDesc(arg)
			table.insert(doc.returns, { type = typeStr, desc = mergeDesc(desc, entry) })
		elseif name == "error" then
			local typeStr, desc = splitTypeDesc(arg)
			table.insert(doc.errors, { type = typeStr or "unknown", desc = mergeDesc(desc, entry) })
		elseif name == "deprecated" then
			local version = arg:match("^([^%s]+)")
			-- `@deprecated -- note` starts with the separator: no version string.
			if version ~= nil and version:sub(1, 1) == "-" then
				version = nil
			end
			local _, desc = splitTypeDesc(arg)
			doc.deprecated = { version = version, desc = mergeDesc(desc, entry) }
		elseif name == "since" then
			doc.since = if arg ~= "" then arg else nil
		elseif name == "external" then
			local extName, url = arg:match("^(%S+)%s+(%S+)")
			if extName == nil or url == nil then
				report("malformed-tag", "@external requires a name and a URL", entry.lineOffset)
			else
				table.insert(doc.externals, { name = extName, url = url, lineOffset = entry.lineOffset })
			end
		elseif name == "tag" then
			-- `@tag name -- comment` strips the trailing comment like other data
			-- tags; with no separator, the entire argument is the tag value.
			local value = splitTypeDesc(arg)
			if value ~= nil and value ~= "" then
				table.insert(doc.customTags, value)
			end
		end
	end

	return doc
end

--- Returns the class name declared by `@class`, if any.
function tags.className(doc: ParsedDoc): string?
	local placing = doc.placing
	return if placing ~= nil and placing.kind == "class" then placing.name else nil
end

return tags

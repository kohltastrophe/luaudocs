--- Deterministic JSON serializer: object keys sorted alphabetically, arrays in
--- order, proper string escaping. (@std/json.serialize has unstable key order,
--- which would break snapshot tests.)

local emit = {}

local ESCAPES = {
	['"'] = '\\"',
	["\\"] = "\\\\",
	["\b"] = "\\b",
	["\f"] = "\\f",
	["\n"] = "\\n",
	["\r"] = "\\r",
	["\t"] = "\\t",
}

local function escapeString(s: string): string
	local out = s:gsub('[%z\1-\31\\"]', function(c)
		return ESCAPES[c] or string.format("\\u%04x", string.byte(c))
	end)
	return out
end

--- An object key, quoted and escaped. Memoized: keys come from the schema's
--- small vocabulary, so each distinct key escapes once, not once per record.
local quotedKeys: { [string]: string } = {}
local function quotedKey(k: any): string
	local s = tostring(k)
	local cached = quotedKeys[s]
	if cached == nil then
		cached = '"' .. escapeString(s) .. '"'
		quotedKeys[s] = cached
	end
	return cached
end

--- True when nothing under `keys` needs a line of its own (scalars, and empty
--- tables, which encode as `[]` either way). Pretty mode prints such objects on
--- one line: the model is mostly two- and three-field records, and a line per
--- field would bury a capture diff under brace noise.
local function isLeafObject(t: { [any]: any }, keys: { any }): boolean
	for _, k in keys do
		local v = t[k]
		if type(v) == "table" and next(v) ~= nil then
			return false
		end
	end
	return true
end

local function isArray(t: { [any]: any }): boolean
	local count = 0
	for k in t do
		if type(k) ~= "number" then
			return false
		end
		count += 1
	end
	return count == #t
end

--- Marks a table as a record for the wire: an empty table would otherwise
--- satisfy isArray and encode as `[]`. The scratch key defeats isArray, then
--- the `__`-prefix strip in encodeValue drops it, leaving `{}`.
function emit.record(t: { [any]: any }): { [any]: any }
	t.__record = true
	return t
end

local function encodeValue(value: any, pretty: boolean, indent: string, out: { string })
	local kind = type(value)
	if kind == "nil" then
		table.insert(out, "null")
	elseif kind == "boolean" then
		table.insert(out, tostring(value))
	elseif kind == "number" then
		if value ~= value or value == math.huge or value == -math.huge then
			table.insert(out, "null")
		elseif value % 1 == 0 and math.abs(value) < 2 ^ 53 then
			table.insert(out, string.format("%d", value))
		else
			table.insert(out, string.format("%.17g", value))
		end
	elseif kind == "string" then
		table.insert(out, '"' .. escapeString(value) .. '"')
	elseif kind == "table" then
		local nextIndent = indent .. "\t"
		if isArray(value) then
			if #value == 0 then
				table.insert(out, "[]")
				return
			end
			table.insert(out, if pretty then "[\n" else "[")
			for i, item in ipairs(value) do
				if pretty then
					table.insert(out, nextIndent)
				end
				encodeValue(item, pretty, nextIndent, out)
				if i < #value then
					table.insert(out, if pretty then ",\n" else ",")
				end
			end
			table.insert(out, if pretty then "\n" .. indent .. "]" else "]")
		else
			local keys = {}
			for k in value do
				-- `__`-prefixed keys are the assembler's scratch space
				-- (model/init.luau); they never belong in the doc model
				if type(k) ~= "string" or k:sub(1, 2) ~= "__" then
					table.insert(keys, k)
				end
			end
			if #keys == 0 then
				table.insert(out, "{}")
				return
			end
			table.sort(keys, function(a, b)
				return tostring(a) < tostring(b)
			end)
			if pretty and isLeafObject(value, keys) then
				local parts = {}
				for _, k in keys do
					local piece = {}
					encodeValue(value[k], pretty, nextIndent, piece)
					table.insert(parts, quotedKey(k) .. ": " .. table.concat(piece))
				end
				table.insert(out, "{ " .. table.concat(parts, ", ") .. " }")
				return
			end
			table.insert(out, if pretty then "{\n" else "{")
			for i, k in keys do
				if pretty then
					table.insert(out, nextIndent)
				end
				table.insert(out, quotedKey(k) .. ":" .. (if pretty then " " else ""))
				encodeValue(value[k], pretty, nextIndent, out)
				if i < #keys then
					table.insert(out, if pretty then ",\n" else ",")
				end
			end
			table.insert(out, if pretty then "\n" .. indent .. "}" else "}")
		end
	else
		table.insert(out, "null")
	end
end

function emit.encode(value: any, pretty: boolean?): string
	local out = {}
	encodeValue(value, pretty == true, "", out)
	return table.concat(out)
end

return emit

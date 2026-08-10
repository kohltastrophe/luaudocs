--- Minimal deterministic test harness (assert-style, no framework deps).

local parseMod = require("../parse")
local commentsMod = require("../comments")
local surfaceMod = require("../surface")
local utilMod = require("../util")
local requiresMod = require("../requires")
local graphMod = require("../graph")

--- Deep structural equality (arrays + maps), for `eq` alone. `seen` pairs each
--- table with the one it is compared against, so cyclic values (a surfaced
--- table reachable from its own fields) terminate rather than overflow.
local function deepEqual(a: any, b: any, seen: { [any]: any }?): boolean
	if a == b then
		return true
	end
	if type(a) ~= "table" or type(b) ~= "table" then
		return false
	end
	local visited = seen or {}
	if visited[a] ~= nil then
		return visited[a] == b
	end
	visited[a] = b
	for k, v in a do
		if not deepEqual(v, b[k], visited) then
			return false
		end
	end
	for k in b do
		if a[k] == nil then
			return false
		end
	end
	return true
end

local harness = {
	passed = 0,
	failed = 0,
	failures = {} :: { string },
	currentSuite = "?",
}

local function repr(v: any, depth: number?): string
	local d = depth or 0
	if type(v) == "string" then
		return string.format("%q", v)
	end
	if type(v) ~= "table" then
		return tostring(v)
	end
	if d > 4 then
		return "{...}"
	end
	-- array part in index order first, then the remaining keys sorted, so a
	-- failure message never reorders a list or drops a non-contiguous key
	local parts = {}
	local arrayLen = #v
	for i = 1, arrayLen do
		table.insert(parts, repr(v[i], d + 1))
	end
	local keys = {}
	for k in v do
		if type(k) ~= "number" or k % 1 ~= 0 or k < 1 or k > arrayLen then
			table.insert(keys, k)
		end
	end
	table.sort(keys, function(a, b)
		return tostring(a) < tostring(b)
	end)
	for _, k in keys do
		table.insert(parts, tostring(k) .. " = " .. repr(v[k], d + 1))
	end
	if #parts == 0 then
		return "{}"
	end
	return "{ " .. table.concat(parts, ", ") .. " }"
end

function harness.suite(name: string)
	harness.currentSuite = name
end

function harness.eq(actual: any, expected: any, label: string?)
	if deepEqual(actual, expected) then
		harness.passed += 1
	else
		harness.failed += 1
		table.insert(
			harness.failures,
			string.format(
				"[%s] %s\n    expected: %s\n    actual:   %s",
				harness.currentSuite,
				label or "eq",
				repr(expected),
				repr(actual)
			)
		)
	end
end

function harness.ok(cond: any, label: string?)
	if cond then
		harness.passed += 1
	else
		harness.failed += 1
		table.insert(harness.failures, string.format("[%s] %s: expected truthy", harness.currentSuite, label or "ok"))
	end
end

--- Records a spec that threw before finishing. The runner keeps going, so one
--- bad spec does not discard every other result.
function harness.crash(name: string, err: any)
	harness.failed += 1
	table.insert(harness.failures, string.format("[%s] spec threw before finishing: %s", name, tostring(err)))
end

--- Parses `src`, failing loudly rather than returning nil: a parse regression
--- should name itself here, not surface as a nil index downstream.
function harness.parse(src: string): any
	local parsed, err = parseMod.parse(src)
	assert(parsed ~= nil, "parse failed: " .. tostring(err))
	return parsed
end

--- `harness.parse` plus the two comment indexes every doc-comment entry point
--- needs, so a spec spells only the selector it cares about.
function harness.parseWithComments(src: string): (any, any, any)
	local parsed = harness.parse(src)
	local claimIndex = commentsMod.claimIndex(commentsMod.segment(parsed))
	return parsed, claimIndex, commentsMod.trailingIndex(parsed)
end

--- `surface.evaluate` over `parseWithComments`: the one-module evaluation the
--- surface and detect specs both build their cases on.
function harness.eval(src: string): any
	return surfaceMod.evaluate(harness.parseWithComments(src))
end

--- Load + expandEntry + graph.build over a fixture root: the graph every
--- whole-fixture spec starts from, with the entry asserted valid.
function harness.buildGraph(root: string, entry: string): (any, any)
	local proj = requiresMod.load(root)
	local diag = utilMod.diagnostics()
	local entryAbs, err = graphMod.expandEntry(root, entry)
	assert(entryAbs ~= nil, tostring(err))
	local g = graphMod.build(proj, { entryAbs :: string }, diag)
	return g, diag
end

--- Picking one entry out of a doc-model list (modules, classes, members,
--- types, fields). Every whole-fixture spec reads its assertions this way.
function harness.byName(list: { any }, name: string): any
	for _, entry in list do
		if entry.name == name then
			return entry
		end
	end
	return nil
end

function harness.byId(list: { any }, id: string): any
	for _, entry in list do
		if entry.id == id then
			return entry
		end
	end
	return nil
end

function harness.report(): boolean
	print(string.format("\n%d passed, %d failed", harness.passed, harness.failed))
	for _, failure in harness.failures do
		print("FAIL " .. failure)
	end
	return harness.failed == 0
end

return harness

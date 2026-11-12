--- Minimal deterministic test harness (assert-style, no framework deps).

local parseMod = require("../core/parse")
local commentsMod = require("../core/comments")
local surfaceMod = require("../core/surface")
local utilMod = require("../core/util")
local requiresMod = require("../core/requires")
local graphMod = require("../core/graph")
local segsMod = require("../core/segs")
local membersMod = require("../model/members")

--- Deep structural equality (arrays + maps), for `eq` alone. Tracks active
--- ancestor pairs on both sides so cyclic values terminate while shared DAG
--- subtrees compare structurally on every visit.
local function deepEqual(a: any, b: any, activeAOpt: { [any]: any }?, activeBOpt: { [any]: any }?): boolean
	if a == b then
		return true
	end
	if type(a) ~= "table" or type(b) ~= "table" then
		return false
	end
	local activeA = activeAOpt or {}
	local activeB = activeBOpt or {}
	if activeA[a] ~= nil or activeB[b] ~= nil then
		return activeA[a] == b and activeB[b] == a
	end
	activeA[a] = b
	activeB[b] = a
	local equal = true
	for k, v in a do
		if not deepEqual(v, b[k], activeA, activeB) then
			equal = false
			break
		end
	end
	if equal then
		for k in b do
			if a[k] == nil then
				equal = false
				break
			end
		end
	end
	activeA[a] = nil
	activeB[b] = nil
	return equal
end

local here = utilMod.dirname(utilMod.resolvePath(debug.info(1, "s")))
local repoRoot = utilMod.dirname(utilMod.dirname(here))

local harness = {
	passed = 0,
	failed = 0,
	failures = {} :: { string },
	currentSuite = "?",
	--- the small, purpose-built extractor fixtures.
	fixtures = utilMod.joinPath(here, "fixtures"),
	--- the shared project fixtures the TypeScript side also uses.
	projectFixtures = utilMod.joinPath(repoRoot, "test", "fixtures"),
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

harness.check = harness.ok

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
function harness.parseWithComments(src: string): (any, any, any, any)
	local parsed = harness.parse(src)
	local blocks = commentsMod.segment(parsed)
	return parsed, commentsMod.claimIndex(blocks), commentsMod.trailingIndex(parsed), blocks
end

--- `surface.evaluate` over `parseWithComments`: the one-module evaluation the
--- surface and detect specs both build their cases on.
function harness.eval(src: string): any
	local parsed, claimIndex, trailingIndex = harness.parseWithComments(src)
	return surfaceMod.evaluate(parsed, claimIndex, trailingIndex)
end

--- Load + expandEntries + graph.build over a fixture root: the graph every
--- whole-fixture spec starts from, with the entry asserted valid.
function harness.buildGraph(root: string, entry: string, opts: any?): (any, any)
	local proj, projErr = requiresMod.load(root, opts)
	assert(projErr == nil, tostring(projErr))
	local diag = utilMod.diagnostics()
	local entries, err = graphMod.expandEntries(root, entry)
	assert(entries ~= nil, tostring(err))
	return graphMod.build(proj, entries :: { string }, diag), diag
end

--- Picking one entry out of a doc-model list (modules, classes, members,
--- types, fields). Every whole-fixture spec reads its assertions this way.
harness.byName = membersMod.byName

--- Flattens a multi-line segment block to a newline-joined string.
function harness.blockText(lines: { { segsMod.Seg } }): string
	local parts = {}
	for _, line in lines do
		table.insert(parts, segsMod.text(line))
	end
	return table.concat(parts, "\n")
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

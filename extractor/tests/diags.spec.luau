--- The diagnostic codes no other spec reaches, produced once each by the
--- diags fixture and pinned as one exact (code, severity, file, line) list:
--- a lost, re-severitied, or double-reported diagnostic fails by name. The
--- codes the policy and tag specs already cover (duplicate-within,
--- orphaned-within, duplicate-type, the tag-grammar family) stay there.
local t = require("./harness")
local paths = require("./paths")
local util = require("../util")
local model = require("../model")

return function()
	t.suite("diagnostics: the assembled diags fixture")

	local root = util.joinPath(paths.fixtures, "diags")
	local g, diag = t.buildGraph(root, "main.luau")
	model.assemble(g, diag, { entryPoints = { "main.luau" } })

	-- messages are not pinned (one carries an absolute path); the identity of
	-- a diagnostic is its code, severity, and location
	local seen = {}
	for _, d in diag.list do
		table.insert(seen, { code = d.code, severity = d.severity, file = d.file, line = d.line })
	end
	-- file and line are optional on the wire (a could-not-read error carries
	-- no line), so an unexpected diagnostic must fail the list, not the sort
	table.sort(seen, function(a, b)
		if a.file ~= b.file then
			return (a.file or "") < (b.file or "")
		end
		if a.line ~= b.line then
			return (a.line or 0) < (b.line or 0)
		end
		return a.code < b.code
	end)

	t.eq(seen, {
		-- at the first error's own line (1-based), not the file's first
		{ code = "parse-error", severity = "error", file = "broken.luau", line = 4 },
		{ code = "require-unresolved", severity = "warning", file = "main.luau", line = 6 },
		{ code = "unresolved-reexport", severity = "info", file = "main.luau", line = 9 },
		{ code = "duplicate-external", severity = "warning", file = "main.luau", line = 14 },
		-- the warning is the same-module duplicate (its own declaration is
		-- dropped); the info at line 36 is a floating @class naming a class
		-- that already exists. One report each: the dropped duplicate must
		-- not surface again through the floating pass.
		-- malformed-tag itself belongs to the tag specs; this row pins the
		-- forwarding: a block whose @class was dropped as a duplicate still
		-- reports its own tag diagnostics
		{ code = "malformed-tag", severity = "warning", file = "main.luau", line = 22 },
		{ code = "duplicate-class", severity = "warning", file = "main.luau", line = 23 },
		{ code = "param-mismatch", severity = "warning", file = "main.luau", line = 26 },
		{ code = "return-count-mismatch", severity = "warning", file = "main.luau", line = 32 },
		{ code = "orphaned-doc-block", severity = "info", file = "main.luau", line = 36 },
		{ code = "duplicate-class", severity = "info", file = "main.luau", line = 38 },
		-- the one require failure reported as info, not a warning
		{ code = "require-nonmodule", severity = "info", file = "main.luau", line = 46 },
		{ code = "surface-opaque", severity = "info", file = "opaque.luau", line = 5 },
		-- Kept is re-spelled by main.luau and Moved is documented on the Diags
		-- page, so only Lost counts, at its own line
		{ code = "unreached-types", severity = "info", file = "types.luau", line = 9 },
	}, "every otherwise-unreached code, once, at its own line")

	-- the parse error speaks of the user's file: no Lute-internal chunk name,
	-- and 1-based positions. The parser's own wording is Lute's, so only the
	-- shape around it is pinned.
	local message = ""
	for _, d in diag.list do
		if d.code == "parse-error" then
			message = d.message
		end
	end
	t.eq(message:sub(1, 5), "4:1: ", "parse-error message opens with the user's line and column")
	t.eq(message:find("parser.luau", 1, true), nil, "and names no Lute-internal file")
end

--- Runs all extractor unit specs: lute run extractor/tests/run.luau
--- Specs return a function (lute modules cannot yield at require time, and
--- fs-touching specs need to run outside module initialization).
local process = require("@std/process")
local harness = require("./harness")

local specs: { { name: string, run: () -> () } } = {
	{ name = "tags", run = require("./tags.spec") },
	{ name = "comments", run = require("./comments.spec") },
	{ name = "surface", run = require("./surface.spec") },
	{ name = "infer", run = require("./infer.spec") },
	{ name = "detect", run = require("./detect.spec") },
	{ name = "requires", run = require("./requires.spec") },
	{ name = "segs", run = require("./segs.spec") },
	{ name = "model", run = require("./model.spec") },
	{ name = "diags", run = require("./diags.spec") },
	{ name = "emit", run = require("./emit.spec") },
}

-- pcall so one throwing spec still leaves the other results, the report and the
-- exit code intact
for _, spec in specs do
	local ok, err = pcall(spec.run)
	if not ok then
		harness.crash(spec.name, err)
	end
end

local ok = harness.report()
process.exit(if ok then 0 else 1)

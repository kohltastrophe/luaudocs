--- Fixture roots derived from this file's own location rather than the process
--- working directory, so `lute run` works from anywhere; a wrong cwd would
--- otherwise turn every fs-touching spec into a raw filesystem error.
local util = require("../util")

local here = util.dirname(util.resolvePath(debug.info(1, "s")))
local repoRoot = util.dirname(util.dirname(here))

return {
	--- the small, purpose-built extractor fixtures.
	fixtures = util.joinPath(here, "fixtures"),
	--- the shared project fixtures the TypeScript side also uses.
	projectFixtures = util.joinPath(repoRoot, "test", "fixtures"),
}

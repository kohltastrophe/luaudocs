import { defineConfig } from "tsup";

export default defineConfig({
	entry: { cli: "src/cli.ts" },
	format: ["esm"],
	// the `engines` floor: lowering it there without lowering it here ships
	// syntax the declared-supported node cannot parse
	target: "node22.12",
	clean: true,
});

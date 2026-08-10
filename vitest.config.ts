import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// the unit suite only; the e2e suite (needs dist/ and lute) runs from
		// vitest.e2e.config.ts as CI's own later step
		include: ["test/**/*.test.ts"],
		exclude: ["**/node_modules/**", "test/e2e/**"],
		testTimeout: 120_000,
		coverage: {
			provider: "v8",
			reporter: ["text", "lcovonly"],
			include: ["src/**", "templates/runtime/**"],
			// what a unit run cannot execute, excluded so the number means
			// something: these run in other processes, and other layers hold
			// them (CONTRIBUTING's four-layer table). cli/extract/lute are
			// driven through dist/cli.js by the e2e suite and the capture
			// gate; dev is the watch loop around the runBuild that build
			// shares; the three runtime shims run inside the generated
			// VitePress build, whose HTML the e2e suite asserts on.
			exclude: [
				"src/cli.ts",
				"src/dev.ts",
				"src/extract.ts",
				"src/lute.ts",
				"templates/runtime/icons.ts",
				"templates/runtime/inline-highlight.ts",
				"templates/runtime/search-cache.ts",
			],
		},
	},
});

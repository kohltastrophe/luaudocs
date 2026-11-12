import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// the unit suite only; the e2e suite (needs dist/ and lute) runs from
		// vitest.e2e.config.ts as CI's own later step
		include: ["test/**/*.test.ts"],
		exclude: ["**/node_modules/**", "test/e2e/**"],
		testTimeout: 15_000,
		coverage: {
			provider: "v8",
			reporter: ["text", "lcovonly"],
			include: ["src/**", "templates/runtime/**"],
			// `src/lute.ts`'s live GitHub release download runs in the e2e suite
			// rather than unit tests; `cli.ts`, `dev.ts`, `extract.ts`, and
			// `inline-highlight.ts` are covered directly by unit suites.
			exclude: ["src/lute.ts"],
		},
	},
});

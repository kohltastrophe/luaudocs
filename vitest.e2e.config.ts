import { defineConfig } from "vitest/config";

// The e2e suite as its own config rather than an env-var switch: `test:e2e`
// stays one portable command line (a VAR=1 prefix only parses in POSIX shells,
// so it worked on the Windows CI leg only because every step forces bash).
export default defineConfig({
	test: {
		include: ["test/e2e/**/*.test.ts"],
		// it drives dist/cli.js through real installs and a VitePress build
		testTimeout: 300_000,
	},
});

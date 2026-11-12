/**
 * This repository's own site (`.luaudocs/`) against the files it quotes.
 *
 * A guide that prints a file the tool writes is holding a copy, and a copy
 * drifts silently: nothing else compares the two, and the page reads fine
 * either way. Everything here re-derives the original and asserts the page
 * still shows it, so a template edit fails until the guide follows.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createMarkdownRenderer } from "vitepress";
import { describe, expect, it } from "vitest";
import pkg from "../package.json";
import { packageRoot } from "../src/extract";
import { LOCAL_LLMS_FILE } from "../src/llms";
import { outsideFences, stripFrontmatter } from "../src/markdown";
import { isGeneratedFile } from "../src/pages";
import { installMarkupRule } from "../templates/runtime/markup";
import { filesUnder, makeTempDirFactory } from "./helpers";

const tempDir = makeTempDirFactory("luaudocs-docs-site-");

const root = packageRoot();
const deployingPage = join(root, ".luaudocs", "guide", "deploying.md");
const agentsPage = join(root, ".luaudocs", "guide", "coding-agents.md");
const rootLlms = join(root, LOCAL_LLMS_FILE);

/** What `init` substitutes into `templates/project/**` for a project shaped
 * like this one: this repository's docs dir, branch, and Node major version
 * (see the Pages-workflow tests in `scaffold.test.ts`). */
const SUBSTITUTIONS: Record<string, string> = {
	"@DOCS_DIR@": ".luaudocs",
	"@BRANCH@": "main",
	"@NODE_MAJOR@": /\d+/.exec(pkg.engines.node)![0],
};

/**
 * A YAML block reduced to what the two copies must agree on. Comment-only
 * lines go, because the page trims the template's header rather than reprint
 * advice its own prose gives, and so do VitePress's `[!code]` markers, which
 * are page decoration rather than YAML.
 */
function comparable(yaml: string): string {
	return yaml
		.split("\n")
		.map((line) => line.replace(/\s*#\s*\[!code[^\]]*\]\s*$/, ""))
		.filter((line) => !/^\s*#/.test(line))
		.join("\n")
		.trim();
}

describe("the site quotes its sources verbatim", () => {
	// the failure this exists for: an action bumped or a step added in the
	// template alone
	it("shows the Pages workflow `init` actually writes", () => {
		let template = readFileSync(
			join(root, "templates", "project", ".github", "workflows", "docs.yml"),
			"utf8",
		);
		for (const [token, value] of Object.entries(SUBSTITUTIONS)) {
			template = template.replaceAll(token, value);
		}

		const page = readFileSync(deployingPage, "utf8");
		const fence = /```yaml \[\.github\/workflows\/docs\.yml\]\n([\s\S]*?)```/.exec(page);
		expect(fence, "deploying.md no longer carries a docs.yml fence to check").not.toBeNull();

		expect(comparable(fence![1]!)).toBe(comparable(template));
	});

	// every `npx luaudocs` command across the guides and the root llms.txt must
	// pass `@latest` (or `${LUAUDOCS_VERSION:-latest}` in the workflow) so npx
	// does not run a cached older release
	it.each([
		[
			"deploying.md, in the workflow and on Cloudflare",
			deployingPage,
			["${LUAUDOCS_VERSION:-latest}", "latest"],
		],
		[
			"coding-agents.md, in the agent notes and the CI step",
			agentsPage,
			["latest", "latest", "latest", "latest"],
		],
		["the root llms.txt, in its regeneration command", rootLlms, ["latest"]],
	])("uses @latest in %s", (_where, file, expectedTags) => {
		const text = readFileSync(file, "utf8");
		if (file === deployingPage) {
			expect(text).toContain('"luaudocs@${LUAUDOCS_VERSION:-latest}"');
			expect(text).toContain("npx luaudocs@latest");
		}
		const tags = [
			...text.matchAll(/npx(?:\s+--yes)?\s+"?luaudocs(?:@([^\s"`]+))?"?(?=[\s`])/g),
		].map((match) => match[1]);
		expect(tags).toEqual(expectedTags);
	});

	// the guide shows the file the command wrote for this repository; a pasted
	// copy would be exactly the drift this suite exists to catch
	it("shows the llms.txt `luaudocs llms` actually writes", () => {
		const page = readFileSync(agentsPage, "utf8");
		expect(page).toMatch(/^<<< \.\.\/\.\.\/llms\.txt\{md\}$/m);
		const llms = readFileSync(rootLlms, "utf8");
		expect(isGeneratedFile(llms), "the root llms.txt lost its generated marker").toBe(true);
		expect(llms).toContain("\n## Flux.Util.Queue\n");
	});

	it("keeps package.json and CHANGELOG.md in valid semver release order", () => {
		const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
		const headings = [...changelog.matchAll(/^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})$/gm)].map(
			(m) => m[1]!,
		);
		expect(headings[0]).toBe(pkg.version);
		expect(changelog).toContain(
			`[${pkg.version}]: https://github.com/kohltastrophe/luaudocs/releases/tag/v${pkg.version}`,
		);
	});

	it("resolves every intra-doc and cross-guide #fragment link across README, CONTRIBUTING, and .luaudocs", async () => {
		const md = await createMarkdownRenderer(tempDir(), {}, "/");
		installMarkupRule(md, {});

		const guideDir = join(root, ".luaudocs", "guide");
		const docFiles = [
			join(root, "README.md"),
			join(root, "CONTRIBUTING.md"),
			join(root, ".luaudocs", "index.md"),
			...filesUnder(guideDir).filter((file) => file.endsWith(".md")),
		];

		const slugsCache = new Map<string, Set<string>>();
		const slugsFor = (absFile: string): Set<string> => {
			let cached = slugsCache.get(absFile);
			if (!cached) {
				const raw = readFileSync(absFile, "utf8");
				const html = md.render(stripFrontmatter(raw), {
					path: absFile,
					relativePath: absFile,
					cleanUrls: true,
				});
				cached = new Set(
					[...html.matchAll(/<h[1-6][^>]*\sid="([^"]+)"/g)].map((m) => m[1]!),
				);
				slugsCache.set(absFile, cached);
			}
			return cached;
		};

		const resolveDocPath = (fromFile: string, rawPath: string): string | undefined => {
			if (rawPath === "") {
				return fromFile;
			}
			if (rawPath.startsWith("/api/")) {
				return undefined;
			}
			const candidates = rawPath.startsWith("/")
				? [
						join(root, ".luaudocs", `${rawPath.slice(1)}.md`),
						join(root, ".luaudocs", rawPath.slice(1), "index.md"),
						join(root, ".luaudocs", rawPath.slice(1)),
					]
				: [
						resolve(dirname(fromFile), rawPath),
						resolve(dirname(fromFile), `${rawPath}.md`),
						resolve(dirname(fromFile), rawPath, "index.md"),
					];
			return candidates.find((candidate) => existsSync(candidate));
		};

		let checked = 0;
		for (const file of docFiles) {
			const prose = outsideFences(stripFrontmatter(readFileSync(file, "utf8"))).join("\n");
			const withoutInlineCode = prose.replace(/(`+)[\s\S]*?\1/g, "");
			for (const [, rawTarget = "", fragment = ""] of withoutInlineCode.matchAll(
				/\[[^\]]+\]\(([^)#\s]*)#([^)\s]+)\)/g,
			)) {
				if (/^[a-z][a-z0-9+.-]*:/i.test(rawTarget) || rawTarget.startsWith("//")) {
					continue;
				}
				const targetFile = resolveDocPath(file, rawTarget);
				if (rawTarget.startsWith("/api/")) {
					continue;
				}
				expect(
					targetFile,
					`${file}: unresolved target file for (${rawTarget}#${fragment})`,
				).toBeDefined();
				expect(
					slugsFor(targetFile!),
					`${file} -> ${rawTarget}#${fragment} missing on ${targetFile}`,
				).toContain(fragment);
				checked += 1;
			}
		}
		expect(checked).toBeGreaterThan(5);
	});
});

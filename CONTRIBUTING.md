# Contributing to LuauDocs

LuauDocs has two stages connected by a JSON contract: a Luau extractor running on [Lute](https://github.com/luau-lang/lute) emits a doc model, and a TypeScript renderer turns that model into a VitePress site.

Bug reports and pull requests are welcome. Open an issue first for anything larger than a bug fix. For smaller changes, open a PR with the checks below passing. Any change that touches the extractor or a fixture must include regenerated captures (`bun run regen:docmodels`) in the same commit.

## Setup

Install [Bun](https://bun.sh) and install dependencies:

```bash
bun install
```

`prepare` (`npm run generate && tsup`) populates `src/generated/` and `extractor/generated/` and builds `dist/`. The [Lute](https://github.com/luau-lang/lute) binary pinned in `src/lute.ts` downloads into a per-user cache on first spawn (set `LUAUDOCS_LUTE` to override it with a local build).

## The ladder

CI runs these checks in fastest-first order on Linux and Windows:

```bash
bunx tsc --noEmit                                  # typecheck src, tests, templates
bun run format:check && bun run format:luau:check  # prettier + stylua (markdown excluded)
bun run test:lute                                  # extractor specs
bun run regen:docmodels --check                    # doc-model drift
bun run test                                       # renderer unit tests (vitest)
bun run build && bun run test:e2e                  # e2e against dist/cli.js
node dist/cli.js llms --check                      # root llms.txt drift
```

In CI, the unit-test step runs `bun run test:coverage` (see `vitest.config.ts` for coverage scope), followed on Linux by a smoke test that runs `init` and `build` from an `npm pack` tarball with production dependencies only.

For local iteration and formatting:

```bash
bunx vitest run test/emit.test.ts             # one file
bunx vitest run -t "matches the Sample page"  # one test
bunx vitest run -u                            # update snapshots
bun run src/cli.ts <command>                  # run CLI from source
bun run format && bun run format:luau         # format TS (Prettier) and Luau (StyLua)
```

## Inspecting extractor output

`luaudocs build --model <file>` writes the rendered doc model to disk. To inspect raw extractor output on any project without a docs directory or config, run the extractor directly on the pinned Lute binary (JSON goes to `stdout`):

```bash
bun run lute -- run extractor/main.luau -- --root <dir> --entry src --pretty
```

## The site

`.luaudocs/` is this repo's own site, published by Cloudflare Pages at [luaudocs.kohl.gg](https://luaudocs.kohl.gg) on every push (`main` to production, branch pushes to preview URLs). Keep the Cloudflare Pages dashboard settings in sync with `ci.yml` and `release.yml`:

- **Build command**: `bun install --frozen-lockfile && node dist/cli.js build`
- **Build output directory**: `.luaudocs/.vitepress/dist`
- **Environment variables**: `BUN_VERSION=1.3.14`, `NODE_VERSION=22`, and `SKIP_DEPENDENCY_INSTALL=1`

Response headers live in `.luaudocs/public/_headers`. The root `llms.txt` is embedded into the Coding Agents guide via a VitePress `<<<` snippet import. Regenerate it with `bun run dev llms` after editing `examples/Flux` or `.luaudocs/guide/`.

## Releasing

Keep commits atomic per user-visible change using [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) (`feat`, `fix`, `perf`, `security`, `revert`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`). On every push to `main`, [`kohltastrophe/release`](https://github.com/kohltastrophe/release) in `.github/workflows/release.yml` validates commit headers since `v<version>`, infers the next semver step (`patch`, `minor`, or `major`), and opens or updates a standing `chore: release <version>` PR that updates `package.json` and stamps `CHANGELOG.md`.

When the `chore: release <version>` PR is merged to `main`, `.github/workflows/release.yml` runs the full CI ladder and tarball smoke test, publishes to npm with provenance, and creates the `v<version>` tag and GitHub Release.

## Architecture

```
.luau sources
   │  extractor/ (Luau on Lute): parse via @std/syntax, symbolically evaluate
   ▼
doc-model JSON  ← the only interface between the halves (schemaVersion 1)
   │  src/ (TypeScript on Node): render pages, bake the site, drive VitePress
   ▼
<docs>/api/*.md + <docs>/.vitepress/**  →  vitepress dev/build
```

- **Extractor** (`extractor/`, entry `main.luau`, spawned by `src/extract.ts`):
  1. `parse` (the only module touching Lute's CST) and `comments`.
  2. `surface`: symbolic evaluation to the module's return value, including `setmetatable(M, { __index = Proto })` delegation, `Key: typeof(require(...))` table-type mounts, and `returnedRequire` tracking for `return require(...)` loaders.
  3. `requires` (string requires with Rojo `$path` fallback, `.luaurc` and runtime aliases, and Roblox instance paths) and `graph`.
  4. `tags`, `segs` (signature display segments), `detect` (yield/realm badges, guard-derived property realms, and owning-table type lookup), and `infer` (value-based inference for unannotated members).
  5. `model/` in two passes: `build` assembles each module in isolation (with container type fallback for unannotated or `:: any` properties), and `finalize` runs whole-graph resolution, `expandRespelledTypes` for re-exported type aliases, `returnedRequire` return-type inference, and cross-linking.
  6. `emit`: deterministic JSON with sorted keys.
- **Renderer** (`src/`): `runBuild` (`src/build.ts`) is the shared extract-render-write pipeline for `build` and `dev`, while `llms` runs only the extract-and-render half (`renderProject` in `src/render.ts`). `nav.ts` builds the API sidebar from the **public access path** (falling back to the Rojo/folder hierarchy only for unmounted modules, with no manual ordering overrides). Setting `[source] entries = []` in `luaudocs.toml` skips the extractor for guide-only sites. Every module opens with a header comment explaining what it owns.

## Invariants

- **Schema version.** `extractor/model/init.luau` and `src/docmodel.ts` define the doc model at `schemaVersion = 1`, evolving in place while the major version is `0`. Lute specs and `regen:docmodels --check` verify extractor output, so `parseDocModel` validates only user-triggerable failures (malformed JSON, mismatched `schemaVersion`, or a non-doc-model file in `[source.aliases]`).
- **Checked-in doc-models.** `test/fixtures/docmodel-{sample,tags}.json` are both the extractor's expected output and the renderer unit tests' input, letting `bun run test` run without spawning Lute. Regenerate them with `bun run regen:docmodels`.
- **Ownership is by directory.** `syncDir` (`src/pages.ts`) owns `<docs>/api/` and `<docs>/.vitepress/`, deleting stale files inside them (except VitePress's `dist/`, `cache/`, and temporary config bundles) and never deleting user files elsewhere. At the docs root, builds overwrite `changelog.md`, `public/llms*.txt`, `public/docmodel.json`, `package.json`, and `index.md` (only while `index.md` starts with `# Generated by luaudocs`). Turning off `[docs] model` deletes `public/docmodel.json`, whereas `[docs] llms = false` leaves `public/llms*.txt` untouched. At the project root, only `luaudocs llms` writes `llms.txt` (guarded by `<!-- Generated by luaudocs` on line 1, where removing the marker claims the file via `isGeneratedFile` in `src/pages.ts`), and `.gitignore` is created only when missing.
- **Extraction errors never delete pages.** When the doc model has any `error` diagnostic, the build updates pages that succeeded and skips directory sweeps and rewrites of `.vitepress/generated/api-nav.ts`, `trails.ts`, `llms*.txt`, and `changelog.md`. Keeping the API sidebar in `.vitepress/generated/api-nav.ts` preserves the last good API nav while still updating guide navigation in `sidebar.ts`.
- **Scaffold-once vs. runtime templates.** `templates/site/**` and `templates/project/**` use `@TOKEN@` placeholders and are written once by `luaudocs init`. `templates/runtime/**` is copied into `<docs>/.vitepress/generated/` on every `build` and `init` as raw `Buffer` bytes so binary assets like `FiraCode-VF.woff2` are not corrupted by UTF-8 decoding. Runtime modules cannot import from `src/`, so `src/markdown.ts` re-exports shared helpers from `templates/runtime/` instead.
- **Generated Roblox data is not committed.** `scripts/generate.ts` fetches a pinned `Roblox-Client-Tracker` dump and writes `src/generated/roblox-names.json` (Roblox type links) and `extractor/generated/engine.luau` (yield/plugin badges and return-type/datatype/enum inference, with built-in fallbacks when absent). Fixtures (`sample-project`, `tags-project`) must not use dump-only names so dump updates never alter `docmodel-*.json`. Dump-backed inference is tested in `extractor/tests/infer.spec.luau`.
- **Lute has no stderr write API.** Fatal extractor usage errors print to `stdout` and exit `2`. Recoverable issues emit as doc-model diagnostics, and error gating (`--strict` and skipping VitePress) lives in the TypeScript CLI.
- **Paths are normalized on both sides.** `toPosix` (`src/config.ts`) and `relPath` (`extractor/util.luau`) convert `\` to `/` so module IDs and relative paths match on Linux and Windows.
- **Links are never speculative.** VitePress dead-link checking stays enabled, so `src/render.ts` only emits links that resolve to a project symbol, an `@external` declaration, a runtime alias URL, or a known Roblox type.
- **Anchors are predicted, never written.** `mintAnchors` (`src/render.ts`) predicts VitePress heading IDs by walking `pageSteps` and applying `headingSlug` (`src/markdown.ts`, vendored from `@mdit-vue/shared`), verified against VitePress in `test/anchors.test.ts`. Headings must not contain HTML that adds slug text: member names use backtick code spans, badges and source links are self-closing components, and re-export badge links use `class="ignore-header"`.
- **Pinned VitePress, site dependencies, and Lute.** `src/site.ts` copies the exact `devDependencies.vitepress` version into `<docs>/package.json`, and `SITE_DEPENDENCIES` (`src/pages.ts`) is the single dependency list shared with `ensureVitepress` (`src/build.ts`). `src/lute.ts` holds the pinned Lute version, asset names, and four platform SHA-256 digests (falling back to `PATH` only on platforms without prebuilt binaries). Bumping Lute requires updating all four digests and running `bun run regen:docmodels`.

## Tests

Place new coverage in the narrowest layer that fits:

1. **Lute specs** (`extractor/tests/`, registered in `extractor/tests/run.luau` and exporting `run(T)` with no filesystem work at `require` time): per-module unit specs, `model.spec.luau` (full pipeline over `tags-project` covering all 24 Moonwave tags), and `diags.spec.luau` (every diagnostic code not hit elsewhere, except `extract-failed`).
2. **Capture gate** (`bun run regen:docmodels --check`): verifies that extractor JSON output over `sample-project` and `tags-project` matches `test/fixtures/docmodel-{sample,tags}.json`.
3. **Vitest** (`test/`): unit tests using inline minimal doc-model literals (preferred over expanding fixtures), whole-page snapshots paired with `it.each` required/forbidden substring tables in `test/emit.test.ts`, `test/anchors.test.ts`, and `test/docs-site.test.ts` (keeps `.luaudocs/` guides in sync with templates and `npx` commands).
4. **End-to-end** (`test/e2e/sample.e2e.test.ts`): runs `init`, `build`, and `llms` on temporary copies of `sample-project` via `dist/cli.js`.

Keep fixtures domain-agnostic and free of redundancy: prefer tightening an existing fixture over adding a new one.

## Conventions

- Tabs for indentation in `src/` and `extractor/`, enforced by Prettier and StyLua.
- Every module opens with a block comment stating what it owns and why non-obvious design decisions were made. Inline comments explain rationale, never what the code already says.
- No em dashes in prose, and use serial (Oxford) commas in lists of three or more items.

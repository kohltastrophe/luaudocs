# Contributing to LuauDocs

LuauDocs is built in two stages connected by a JSON contract: a Luau extractor (on [Lute](https://github.com/luau-lang/lute)) that reads a library and emits a doc model, and a TypeScript renderer that turns the model into a VitePress site. "The ladder" is the validation sequence below, ordered from fastest to slowest.

Bug reports and pull requests are welcome. Open an issue first for anything larger than a bug fix. Otherwise: branch, make the ladder green, and describe what changed and why. Any pull request touching the extractor or a fixture must include regenerated captures (`test/fixtures/docmodel-*.json`, via `bun run regen:docmodels`) in the same commit.

## Setup

Install [Bun](https://bun.sh) first; every script runs through it.

```bash
bun install
```

That runs the `prepare` hook (`npm run generate && tsup`), populating `src/generated/` and `extractor/generated/`, and building `dist/`. No toolchain setup is needed: the [Lute](https://github.com/luau-lang/lute) binary is pinned in `src/lute.ts` and downloaded into a per-user cache on first spawn, so `test:lute`, `test:e2e`, and `regen:docmodels` all use the same binary automatically. Set `LUAUDOCS_LUTE` to override the pinned binary with a custom build.

## The ladder

CI runs these in order on Linux and Windows. Run them in this order locally to catch failures early:

```bash
bunx tsc --noEmit                                  # one typecheck: src, tests, templates
bun run format:check && bun run format:luau:check  # prettier + stylua
bun run test:lute                                  # extractor specs
bun run regen:docmodels --check                    # doc-model drift
bun run test                                       # renderer tests (vitest)
bun run build && bun run test:e2e                  # e2e drives dist/cli.js
node dist/cli.js llms --check                      # this repo's own llms.txt
```

CI adds a Linux-only smoke test after the ladder that runs `init` and `build` from an extracted `npm pack` tarball with production dependencies only, catching packaging issues masked by a local checkout.

CI's unit-test step runs `bun run test:coverage` (the same suite plus a V8 coverage report uploaded to Codecov). `vitest.config.ts` documents which files count toward coverage and why process-boundary files are excluded.

Targeted commands for local iteration:

```bash
bunx vitest run test/emit.test.ts             # one file
bunx vitest run -t "matches the Sample page"  # one test
bunx vitest run -u                            # update file snapshots
bun run src/cli.ts <command>                  # the CLI from source, no build
```

Formatting is enforced via `bun run format` (Prettier for TypeScript) and `bun run format:luau` (StyLua for `extractor/` and `examples/`). Markdown is excluded from both.

## Inspecting extractor output

`luaudocs build --model <file>` exports the rendered doc model and answers most questions about what the extractor observed. To inspect extractor output for a project without a docs directory or configuration, run it directly on Lute (JSON is emitted to `stdout` for `jq`):

```bash
bun run lute -- run extractor/main.luau -- --root <dir> --entry src --pretty
```

`bun run lute` passes through to the pinned binary (`scripts/lute.ts`), so ad-hoc runs and test suites always share the same Lute binary.

## The site

`.luaudocs/` is this repo's own site, published by Cloudflare Pages at [luaudocs.pages.dev](https://luaudocs.pages.dev), the canonical domain for all documentation links (`luaudocs.kohl.gg` redirects there). No GitHub Actions workflow deploys it: Cloudflare's Git integration builds every push, publishing `main` to production and branches to preview URLs (fork PRs do not get previews). Because Cloudflare Pages build settings live in the dashboard rather than the repo, keep these settings in sync with the dashboard:

- **Build command**: `bun install --frozen-lockfile && node dist/cli.js build`. (`bun install` runs `prepare` to build `dist/cli.js`, which then builds `.luaudocs/`.)
- **Build output directory**: `.luaudocs/.vitepress/dist`.
- **Environment variables**: `BUN_VERSION=1.3.14` and `NODE_VERSION=22` (matching the GitHub Actions workflows), plus `SKIP_DEPENDENCY_INSTALL=1` so only the `bun install --frozen-lockfile` step runs.

When bumping the Bun version in `ci.yml` and `release.yml`, update `BUN_VERSION` in the Cloudflare dashboard to match. Response headers live in `.luaudocs/public/_headers`, which VitePress copies into the build output for Cloudflare Pages.

The root `llms.txt` dogfoods `luaudocs llms`: the Coding Agents guide embeds it via a VitePress `<<<` snippet import, and CI's `llms --check` step verifies that `llms.txt` matches `examples/Flux` and `.luaudocs/guide/`. After editing `examples/Flux`, any guide, or the version in `package.json`, regenerate `llms.txt` with `bun run dev llms` (`test/docs-site.test.ts` enforces the version pin).

## Architecture: two runtimes, one JSON contract

```
.luau sources
   │  extractor/ (Luau on Lute): parse via @std/syntax, symbolically evaluate
   ▼
doc-model JSON  ← the only interface between the halves (schemaVersion 1)
   │  src/ (TypeScript on Node): render pages, bake the site, drive VitePress
   ▼
<docs>/api/*.md + <docs>/.vitepress/**  →  vitepress dev/build
```

**Extractor** (`extractor/`, 17 files, entry `main.luau`, spawned as a subprocess by `src/extract.ts`). The stages, in order: `parse` (the single module touching Lute's CST) → `comments` → `surface` (symbolic evaluation down to the module's return value, including `setmetatable(M, { __index = Proto })` table delegation, `Key: typeof(require(...))` table-type module mounts, and `returnedRequire` tracking for `return require(...)` lazy module loaders) → `requires` (string requires with Rojo `$path` fallback on relative paths, `.luaurc` and runtime aliases, and Roblox instance paths) + `graph` → `tags` + `segs` (signature display segments) + `detect` (behavioral badges: yields and realm inferred from function bodies, property realms from guard expressions, and owning-table type entry lookup) + `infer` (value-based type inference for unannotated members) → `model/` (two passes: `build` assembles each module in isolation with container type annotation fallback for unannotated or `:: any` properties, and `finalize` runs whole-graph resolution, `expandRespelledTypes` for re-exported type aliases, `returnedRequire` return-type inference, and linking) → `emit` (deterministic JSON with sorted keys).

**Renderer** (`src/`, 16 flat files): `cli`, `config`, `extract` + `docmodel` + `lute`, `dependencies` (loads external sites' published doc models for cross-site linking), `build`, `pages` + `nav`, `render`, `site`, `llms`, `init` + `moonwave`, `dev`, and `markdown`. `runBuild` (`src/build.ts`) is the single extract → render → write pipeline shared by `build` and `dev`, enforcing the file-ownership rules below. `llms` shares only the extract-and-render half (`renderProject`) and writes only `llms.txt`.

Every module opens with a header comment explaining what it owns; read those headers for file-level details.

In `luaudocs.toml`, `[source] entries = []` declares a guide-only project with no Luau modules: the extractor is skipped and all commands run the normal site pipeline.

`nav.ts` builds the API sidebar from the **public access path** (the expression a caller writes to reach a module), falling back to the instance hierarchy (Rojo tree or folder layout) only for unmounted modules. It accepts no manual ordering or grouping overrides.

## Invariants

These design invariants protect against subtle breakage from otherwise reasonable-looking changes.

- **Schema version.** The doc-model shape is documented in `extractor/model/init.luau` and declared in `src/docmodel.ts`, fixed at `schemaVersion = 1` and evolving in place on both sides while the major version is `0`. There is intentionally no deep runtime schema validator: Lute specs and `regen:docmodels --check` verify what the extractor emits, so `parseDocModel` checks only user-triggerable failure modes (malformed JSON, a mismatched `schemaVersion`, or a non-doc-model file passed to `[source.aliases]`).
- **Checked-in doc-models.** `test/fixtures/docmodel-{sample,tags}.json` serve as both the extractor's expected output and the renderer unit tests' input, letting `bun run test` run without spawning Lute. Any intentional extractor or fixture change requires running `bun run regen:docmodels` and reviewing the diff, which stays readable because keys are sorted alphabetically and formatted with `--pretty`.
- **Ownership is by directory.** Never write a generated file to a new location without deciding whether it is tool-owned or user-owned. `syncDir` (`src/build.ts`) enforces the boundary: `<docs>/api/` and `<docs>/.vitepress/` are synchronized to contain only the current build's emitted files, deleting stale files inside them (except VitePress's `dist/`, `cache/`, and temporary config bundles). Outside those two directories, LuauDocs never deletes user files. At the docs root, builds overwrite `changelog.md`, `public/llms*.txt`, `public/docmodel.json`, `package.json`, and `index.md` (only while `index.md` carries the `# Generated by luaudocs` marker). When `[docs] model` is turned off, `public/docmodel.json` is deleted so dependent sites do not read stale data; when `[docs] llms = false`, `public/llms*.txt` are left untouched in case the author maintains them by hand. At the project root, only `luaudocs llms` writes `llms.txt` (or its `--out` target), guarded by the `<!-- Generated by luaudocs` marker on line 1. Deleting the marker line claims the file for manual editing (`isGeneratedFile` in `src/pages.ts`), preventing `build` and `init` from overwriting it. `.gitignore` is created only when missing.
- **Extraction errors never delete pages.** When the doc model contains any `error` diagnostic, the build updates the pages that succeeded and skips all destructive steps: directory cleanup sweeps and rewrites of `.vitepress/generated/api-nav.ts`, `trails.ts`, `llms*.txt`, and `changelog.md` that would delist existing pages on disk. Keeping the API sidebar in `.vitepress/generated/api-nav.ts` lets error builds preserve the last good API navigation byte for byte while still updating guide navigation in `sidebar.ts`. A temporary syntax error during `dev` must never wipe out the site.
- **Scaffold-once templates.** `templates/site/**` (copied into the docs directory) and `templates/project/**` (copied into the project root, currently `.github/workflows/docs.yml`) are scaffolded once by `luaudocs init` and then belong to the user, so edits to those templates only affect newly initialized projects. Any file `init` writes verbatim belongs in `templates/` with `@TOKEN@` placeholders rather than inline in `src/init.ts`.
- **Runtime templates sync on every build.** `templates/runtime/**` is copied into `<docs>/.vitepress/generated/` on every build and `init`, so updates reach existing projects automatically on upgrade. Runtime modules cannot import from `src/`; instead, `src/markdown.ts` re-exports shared helpers from `templates/runtime/` so the renderer and browser runtime cannot drift. `syncDir` copies runtime files as raw bytes (`Buffer`) rather than UTF-8 strings because `templates/runtime/` includes `FiraCode-VF.woff2`: decoding a binary font as UTF-8 corrupts it and causes browsers to silently fall back to system monospace fonts.
- **`src/generated/` and `extractor/generated/` are not committed.** `scripts/generate.ts` (run by `prepare` and CI) fetches the Roblox API dump from a pinned `Roblox-Client-Tracker` commit and writes `src/generated/roblox-names.json` (used by the renderer to link Roblox types) and `extractor/generated/engine.luau` (yielding and plugin-only member names for badge detection, plus method return types, datatype names, and enum names for type inference). When `engine.luau` is absent, the extractor falls back to built-in naming conventions so a bare checkout still runs. Test fixtures (`sample-project`, `tags-project`) must not depend on dump-only names so refreshing the API dump commit never alters the checked-in `docmodel-*.json` captures; dump-backed inference is tested directly in `extractor/tests/infer.spec.luau`.
- **Lute has no stderr write API.** The extractor prints fatal usage errors to `stdout` and exits with code `2`; all recoverable issues are emitted as diagnostics inside the doc-model JSON. Error gating (`--strict` and skipping VitePress on extraction errors) lives entirely in the TypeScript CLI.
- **Paths are normalized on both sides.** `toPosix` (`src/pages.ts`) mirrors `relPath` (`extractor/util.luau`), converting `\` to `/` so module IDs and relative paths match across Linux and Windows CI runners.
- **Links are never speculative.** VitePress dead-link checking remains enabled, so `src/render.ts` only emits links that resolve to a known project symbol, an `@external` declaration, a configured runtime alias URL, or a known Roblox type.
- **Anchors are predicted, never written.** VitePress generates heading `id` attributes at build time, and `mintAnchors` (`src/render.ts`) predicts them by walking `pageSteps` (the single source of truth for page heading order) and applying `headingSlug` (`src/markdown.ts`, vendored from `@mdit-vue/shared`). No HTML element inside a rendered heading may contribute extra text to VitePress's slugifier: member names sit in backtick code spans, badges and source links are self-closing components, and re-export badge links carry `class="ignore-header"`. `test/anchors.test.ts` renders every fixture page through VitePress and verifies that predicted symbol anchors and rendered heading IDs match in both directions.
- **VitePress is pinned to an exact version.** `src/site.ts` copies `devDependencies.vitepress` from LuauDocs's own `package.json` into every generated site's `package.json`. Upgrading VitePress is an explicit release decision, never a floating range.
- **A generated site's dependencies come from a single list.** `SITE_DEPENDENCIES` (`src/build.ts`) defines the packages written into `<docs>/package.json` (using version ranges from LuauDocs's `devDependencies`) and checked by `ensureVitepress`. Adding a runtime dependency anywhere else would let `ensureVitepress` skip installation when `vitepress` is already present, breaking VitePress config loading on the missing package.
- **Lute is pinned in `src/lute.ts` alone.** `src/lute.ts` holds the pinned Lute version, per-platform release asset names, and SHA-256 digests used by every Lute invocation. Bumping Lute requires updating all four platform digests and running `bun run regen:docmodels` to refresh the test captures. LuauDocs never looks up `lute` on `PATH` except as a last resort on platforms without prebuilt Lute binaries (Intel macOS, musl Linux, BSD).

## Tests

Place new coverage in the narrowest of the four test layers that fits the change:

1. **Lute specs** (`extractor/tests/`, custom test runner): unit specs per extractor module, `model.spec.luau` (full extractor pipeline over `test/fixtures/tags-project`, exercising all 24 Moonwave tags), and `diags.spec.luau` (asserts coverage for every diagnostic code not triggered by other specs, except `extract-failed`, which guards internal extractor crashes).
2. **The capture gate**: `bun run regen:docmodels --check` verifies that the extractor's exact JSON output over `sample-project` and `tags-project` matches `test/fixtures/docmodel-{sample,tags}.json`.
3. **Vitest** (`test/`): unit tests using inline minimal doc-model literals for specific rendering rules (preferred over adding fixture code), whole-page snapshots under `test/__snapshots__/`, `test/anchors.test.ts`, and `test/docs-site.test.ts` (verifying that `.luaudocs/` guides stay in sync with the templates and version pins they quote).
4. **End-to-end test** (`test/e2e/sample.e2e.test.ts`): runs `init`, `build`, and `llms` on temporary copies of `test/fixtures/sample-project` through the built `dist/cli.js` binary.

Fixtures must remain **domain-agnostic** and **free of redundancy**: every construct in a fixture exists because a test assertion, capture, or snapshot checks it. Prefer tightening an existing fixture over adding a new one.

Update snapshots with `bunx vitest run -u`. `test/emit.test.ts` pairs whole-page snapshots with `it.each` marker tables (asserting required and forbidden substrings) so a blind snapshot update cannot silently drop a rendered feature. Relational assertions (such as ordering or exact counts) live in dedicated `it(...)` blocks.

Extractor specs export a `run(T)` function (Lute modules must not perform filesystem work at `require` time) and are registered in `extractor/tests/run.luau`.

## Conventions

- Tabs for indentation in both `src/` and `extractor/`. Prettier and StyLua enforce formatting.
- Every module opens with a block comment stating what it owns and _why_ non-obvious design decisions were made. Inline comments explain rationale rather than restating the code.
- No em dashes in prose, and use serial (Oxford) commas in lists of three or more items. Markdown files are excluded from Prettier and reviewed directly.

# Contributing to LuauDocs

LuauDocs is two halves joined by one JSON contract: a Luau extractor (run on [Lute](https://github.com/luau-lang/lute)) that reads a library and emits a doc model, and a TypeScript renderer that turns the model into a VitePress site. "The ladder" is the check sequence below, run cheapest first.

Bug reports and pull requests are both welcome. Open an issue first for anything larger than a bug fix. Otherwise: branch, make the ladder green, and describe what changed and why. A change touching the extractor or a fixture includes the regenerated captures (`test/fixtures/docmodel-*.json`, via `bun run regen:docmodels`) in the same commit.

## Setup

Install [Bun](https://bun.sh) first; every script here runs through it.

```bash
bun install
```

That runs the `prepare` hook (`npm run generate && tsup`), filling `src/generated/` and `extractor/generated/` and building `dist/`. There is no toolchain step: the [Lute](https://github.com/luau-lang/lute) the extractor runs on is pinned in `src/lute.ts` and downloaded into a per-user cache the first time anything spawns it, so `test:lute`, `test:e2e`, and `regen:docmodels` all reach the same binary with no setup. `LUAUDOCS_LUTE` overrides it with a build of your own, which is how you try an unreleased Lute without editing the pin.

## The ladder

CI runs these in order, on Linux and Windows. Locally, the same order finds the same failure, cheapest first:

```bash
bunx tsc --noEmit                                  # one typecheck: src, tests, templates
bun run format:check && bun run format:luau:check  # prettier + stylua
bun run test:lute                                  # extractor specs
bun run regen:docmodels --check                    # doc-model drift
bun run test                                       # renderer tests (vitest)
bun run build && bun run test:e2e                  # e2e drives dist/cli.js
```

CI adds one Linux-only step after the ladder: a packed-tarball smoke test that
runs `init` and `build` from an extracted `npm pack` tarball with production
dependencies only, so a packaging gap the repo checkout masks still fails CI.

CI's unit-test step runs `bun run test:coverage` (the same suite, plus a V8
coverage report uploaded to Codecov for the README badge). Which files count
toward that number, and why the process-boundary ones sit out, is documented
where it is configured, in `vitest.config.ts`.

Narrower runs while you iterate:

```bash
bunx vitest run test/emit.test.ts             # one file
bunx vitest run -t "matches the Sample page"  # one test
bunx vitest run -u                            # update file snapshots
bun run src/cli.ts <command>                  # the CLI from source, no build
```

Formatting is enforced: `bun run format` (prettier over the TypeScript half) and `bun run format:luau` (StyLua over `extractor/` and `examples/`). Markdown is excluded from both.

## Inspecting extractor output

`luaudocs build --model <file>` writes the doc model that build rendered: the supported route, and enough for most questions about what the extractor saw. To see what it makes of a project with no docs dir and no config, run it directly on Lute; the JSON lands on stdout, pipeable into `jq`:

```bash
bun run lute -- run extractor/main.luau -- --root <dir> --entry src --pretty
```

`bun run lute` is a passthrough to the pinned binary (`scripts/lute.ts`), so an ad-hoc run and the specs cannot end up on different Lutes.

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

**Extractor** (`extractor/`, 17 files, entry `main.luau`, spawned as a subprocess by `src/extract.ts`). The stages, in order: `parse` (the one module that touches Lute's syntax tree) → `comments` → `surface` (symbolic evaluation down to the module's return value) → `requires` + `graph` → `tags` + `segs` (signature display segments) + `detect` (code-signal badges: yields and realm read from function bodies, and a property's realm read from the guard it is mounted behind) + `infer` (the type a value implies, for members declaring none) → `model/` (two passes: `build` assembles each module in isolation, `finalize` runs the whole-model steps) → `emit` (deterministic JSON, keys sorted).

**Renderer** (`src/`, 15 flat files): `cli`, `config`, `extract` + `docmodel` + `lute`, `build`, `pages` + `nav`, `render`, `site`, `llms`, `init` + `moonwave`, `dev`, `markdown`. `runBuild` (`src/build.ts`) is the one extract → render → write sequence `build` and `dev` share, so they cannot drift, and it owns the write contract below.

Every module opens with a block comment stating what it owns; read those rather than a list here.

In `luaudocs.toml`, `[source] entries = []` is a project with no modules, not a mode of its own: the extractor never runs, and every command still takes its one ordinary path.

`nav.ts` mirrors the **public access path** (the expression a caller writes to reach a module), and only modules that nothing exposes fall back to the instance hierarchy (the Rojo tree, or the folder layout). No configuration key touches it, so its one shape has to stay right.

## Invariants

These are the things a reasonable-looking change can break silently.

- **Schema version.** The doc-model shape is documented in the header of `extractor/model/init.luau` and declared in `src/docmodel.ts`, sitting at 1 and changing in place on both sides pre-1.0. There is deliberately no runtime field validator: the specs and `regen:docmodels --check` cover what the extractor emits, so `parseDocModel` checks only what a _user_ can hit (bad JSON, a stale model, the wrong file).
- **Checked-in doc-models.** `test/fixtures/docmodel-{sample,tags}.json` are the extractor's expected output _and_ the renderer tests' input, which is what lets `bun run test` run without Lute. Any intentional extractor or fixture change means running `bun run regen:docmodels` and reading the diff, which stays reviewable because keys are sorted and the captures are written `--pretty`.
- **Ownership is by directory.** Do not write a generated file anywhere new without deciding which side of this line it lives on. The write contract lives in `syncDir` (`src/build.ts`): `<docs>/api/` and `<docs>/.vitepress/` are made to contain exactly the emitted set, everything else under them deleted (VitePress's own `dist/`, `cache/`, and config timestamps are exempt), and outside those two trees the tool deletes nothing. At the docs root it overwrites exactly `changelog.md`, `public/llms*.txt`, `package.json`, and (only while it carries the `# Generated by luaudocs` marker) `index.md`. The marker is the ownership handshake (`isGeneratedFile` in `src/pages.ts`): deleting the line is how a user claims a file, and `init` on its side overwrites a still-marked file but never a claimed one. `.gitignore` is created only when missing.
- **Extraction errors never delete pages.** When the model carries any `error` diagnostic, the build refreshes the pages that did emit and withholds every destructive step: the deletion sweeps, and the sidebar/trails/llms/changelog rewrites that would delist pages kept on disk. A transient typo must never look like intentional removal.
- **Scaffold-once templates.** `templates/site/**` (into the docs dir) and `templates/project/**` (into the project root, currently the Pages workflow) are scaffolded once by `init` and become user-owned, so changes there only reach _new_ projects. Anything `init` writes verbatim belongs in one of those two rather than in a string literal in `src/init.ts`; `@TOKEN@` placeholders are how a value reaches it.
- **Runtime templates sync on every build.** `templates/runtime/**` is synced verbatim into every generated site, so changes there land on upgrade, and anything with behavior of its own belongs there rather than in a `src/site.ts` string literal. Runtime modules cannot import from `src/`; the emitter imports shared helpers _from_ them (`src/markdown.ts` re-exports) so the two cannot drift. The sync is byte-exact rather than text, because the directory also carries the packaged Fira Code woff2 that `luaudocs.css` `@font-face`s: decoding that as utf8 anywhere along the way ships a corrupt font that fails only in the browser, silently, as a fallback to the next family.
- **`src/generated/` and `extractor/generated/` are not committed.** The same `scripts/generate.ts` run (via the `prepare` hook and CI) fetches the Roblox API dump, pinned there to a Roblox-Client-Tracker commit so CI's fresh regenerations and a months-old local tree read the same dump, and writes both: `roblox-names.json` (the renderer's link lists) and `engine.luau` (yielding and plugin-only member names for badge detection, plus method return types and the datatype and enum name lists for type inference). The extractor falls back to its built-in convention signals when `engine.luau` is absent, so a bare checkout still runs; fixtures must not depend on dump-only names, or a dump refresh would shift the pinned captures. So everything `infer` reads OUT of the dump (method returns, the datatype and enum lists) is pinned by `extractor/tests/infer.spec.luau` instead, which asserts on the inference alone and reaches no capture. What a fixture may spell is what the extractor knows without it: `tags-project` mounts a prop behind `RunService:IsServer()`, and the realm badge and the inferred `Instance` are both built-in signals. Only that name's Roblox link is a dump lookup (`roblox-names.json`), and `Instance` is not a name a refresh takes away.
- **Lute has no stderr write API.** The extractor prints fatal messages to stdout and exits 2; everything recoverable becomes a diagnostic in the JSON. All error gating (`--strict`, skipping the VitePress build) lives in the TypeScript CLI.
- **Paths are normalized on both sides.** `toPosix` (`src/pages.ts`) mirrors `relPath` (`extractor/util.luau`), the one that spells module ids, and its `\`-to-`/` rewrite is the half that has to match. CI runs the matrix on Windows, where an unnormalized path matches no glob.
- **Links are never speculative.** VitePress dead-link checking stays on, so `src/render.ts` only emits a link it can resolve (project symbol, `@external` declaration, or Roblox name).
- **Anchors are predicted, never written.** VitePress mints every heading id and `mintAnchors` predicts it: it walks `pageSteps`, the single description of a page's order shared with the page renderer, and applies markdown-it-anchor's rule via `headingSlug` in `src/markdown.ts` (ten lines vendored from `@mdit-vue/shared`). Nothing a heading contains may add text to the minted slug: a member's name is a code span, whose content is the name `mintAnchors` slugifies, badges and source links are self-closing, and the re-export badge's link carries `class="ignore-header"`. Getting this wrong is **silent**, so `test/anchors.test.ts` renders every page through the real VitePress and asserts both directions.
- **VitePress is pinned exactly.** `src/site.ts` copies this package's `devDependencies.vitepress` verbatim into every generated site. Bumping the alpha is a deliberate release, not a caret range.
- **A generated site's dependencies are one list.** `SITE_DEPENDENCIES` (`src/build.ts`) names them; `docsPackageJson` bakes their ranges from this package's own `devDependencies`, and `ensureVitepress` installs when any of them fails to resolve. Adding one anywhere else means a site that resolves VitePress, skips the install, and then dies on a missing import at config load.
- **Lute is pinned exactly too, and `src/lute.ts` is the only place that says so.** It holds the version, the per-platform asset names, and their sha256 digests, and it is what every spawn resolves through. Bumping it means replacing all four digests (the release assets carry their own `digest` field) and rerunning `regen:docmodels`, since the captures are whatever that Lute parses. Nothing else may reach for a `lute` on the PATH: that would be an unpinned second version, exactly the drift the pin exists to prevent.

## Tests

Coverage sits at four layers. Put new coverage in the narrowest one that can hold it:

1. **Lute specs** (`extractor/tests/`, hand-rolled harness): unit specs per extractor module, the whole-model spec that runs the real pipeline over `test/fixtures/tags-project` (the fixture enumerating all 24 Moonwave tags), and the diags spec, which pins, as one exact list, every diagnostic code the other specs do not reach.
2. **The capture gate**: `regen:docmodels --check` pins the extractor's byte-for-byte output over both fixture projects, so either half changing the wire contract fails CI until the captures are regenerated on purpose.
3. **Vitest** (`test/`): inline literal doc-models for one narrow rendering rule each (prefer this: no fixture files, no snapshot churn), file snapshots under `test/__snapshots__/` for whole pages, `test/anchors.test.ts`, and `test/docs-site.test.ts`, which holds this repo's own site to the files it quotes (a guide printing a scaffolded file is a copy, and a copy drifts).
4. **One e2e** (`test/e2e/sample.e2e.test.ts`): `init` + `build` on a copy of the sample project (`test/fixtures/sample-project`), through the built `dist/cli.js`.

Fixtures must be **agnostic** (not modeled on a real library) and carry **no redundancy**: every construct is present because some assertion, capture, or snapshot observes it. Prefer shrinking a fixture over adding a parallel one.

Snapshots refresh with `bunx vitest run -u`, guarded by marker tables so a blind `-u` cannot silently drop a feature: `test/emit.test.ts` runs an `it.each` over `(feature, haystack, marker)` rows (the page text to search, and the substring that must survive in it) plus a forbidden-marker table. The snapshot owns the output, the row only names what must survive. Assertions about a _relationship_ (ordering, counts) stay as their own named `it`.

Extractor specs export a function (Lute modules cannot do filesystem work at require time) and are registered in `run.luau`.

## Conventions

- Tabs for indentation in both `src/` and `extractor/`. Prettier and StyLua enforce the rest.
- Every module opens with a block comment stating what it owns and _why_ the non-obvious decisions are what they are. Inline comments explain rationale, not mechanics.
- No em dashes in prose, and serial (Oxford) commas in lists of three or more. All markdown is excluded from prettier and reviewed by reading it.

# Changelog

Notable changes to LuauDocs, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html): while the major
version is 0, a minor bump may carry breaking changes.

## [0.3.0] - 2026-10-14

### Added

- **Classes defined separately from their constructor table are documented.**
  Typed Luau libraries often keep methods on a local self-indexing table that
  the module never returns (`local Deque = {}`, `Deque.__index = Deque`,
  `function Deque.pushback(self: Deque<T>, value: T)`) and return a table
  containing only `new`, which attaches `Deque` via `setmetatable(_, Deque)`.
  The extractor now follows that attachment (or a type that declares it via
  `typeof(setmetatable(_, Deque))` or `setmetatable<_, typeof(Deque)>`; bare
  `setmetatable<D, M>` is not recognized as a class type) and documents the
  table as a class named after the type (or the local variable when no type
  names it), with the constructor grouped under the class.
  Self-indexing (`T.__index = T`) alone still does not make a table a class:
  the `setmetatable` attachment is what distinguishes a class from a
  self-indexing module namespace.
- **Requires of runtime modules are treated as external rather than unresolved.**
  Requiring a module through a runtime-supplied alias (`@lute/fs`, `@std/path`,
  `@lune/net`) rather than `.luaurc` no longer emits `require-unresolved` on
  every build. Lute and Lune aliases are built in, and `[source.aliases]` lets
  you register custom runtime aliases or override built-in ones with a
  documentation base URL. Mounting a runtime module renders as a property
  showing the `require(...)` call and linking to its documentation URL, and
  types referenced through a runtime alias (`fs.File`) link to that module's
  page just like Roblox types link to Creator Documentation. A `.luaurc` alias
  of the same name still takes precedence. In the doc model, `Reexport` gained
  an optional `url` field for runtime mounts, and `externals` values are now
  either the URL string declared by `@external` or an object
  `{ url?, alias, path, name? }` for types reached through a runtime alias.
- **Sites can cross-link to each other's symbols.** Setting `[docs] model = true`
  publishes the doc model at `public/docmodel.json`, and configuring a
  `[source.aliases]` entry as `{ url, model }` loads that external doc model so
  types reached through the alias link directly to their exact `#anchor` on the
  external site rather than only to the module page. `model` accepts either an
  `http(s)://` URL (fetched and cached per user, with the cache used as a
  fallback when offline) or a project-relative file path; an unreadable model
  emits a warning and falls back to module-level links. Existing sites should
  add `/public/docmodel.json` to their docs directory's `.gitignore` (newly
  scaffolded sites include it automatically).
- **`[api] reportUndocumented` gates documentation coverage.** When enabled, it
  emits an `undocumented` warning for every public member, class, and exported
  type without a doc comment, formatted as callers write it (`Widget:refresh`),
  so `luaudocs build --strict` fails until the public surface is fully
  documented. Disabled by default.
- **Exported types in tags-only modules are reported instead of silently dropped.**
  When a module is required only for its types (for example, `local types = require("./types")`)
  and never mounted on the public surface, its unreached exported types now emit
  an `unreached-types` info diagnostic naming the types and the two ways to
  surface them (`export type Name = ...` in a public module or `@within` on the
  declaration). Types already re-exported by a surfaced module
  (`export type Hook = types.Hook`) are excluded.
- **`function T.f(self: T, ...)` documents as a method.** Explicitly typing
  `self` as the first parameter of a dot-defined function (which Luau's `:`
  syntax cannot annotate) now renders with `:` syntax (`T:f(...)`) and omits
  `self` from the parameter list, and a single such method is enough to classify
  `T` as a class. Adding `@function` still forces it to render as a dot
  function with `self` kept in the signature.
- **Lazy module loaders, `typeof(require(...))` mounts, and `__index` delegation.**
  Functions whose body is `return require(X)` follow `X` in the module graph and
  infer `X` as their linked return type when unannotated or annotated
  `typeof(require(X))`. Table fields declared as `Key: typeof(require(...))` on
  a returned table's type annotation synthesize module mounts, and
  `setmetatable(M, { __index = Proto })` delegates fields from `Proto` (including
  when `Proto` comes from a local factory call).
- **Container type annotation fallback and expanded re-exported types.**
  Unannotated properties (or properties cast to `:: any`) fall back to the field's
  type and doc comment on the owning table's type annotation, and re-exported
  type aliases (`export type T = Other.T` or `export type T<U> = Other.T<U>`)
  expand the origin type's underlying definition, generics, fields, and fallback
  doc comment.
- **`luaudocs llms` generates a project-root `llms.txt` for coding agents.**
  While the site's `/llms.txt` serves AI tools browsing your deployed docs,
  `luaudocs llms` writes a compact `llms.txt` at the repository root for coding
  agents working in a local checkout (referenced from `AGENTS.md` or
  `CLAUDE.md`). It indexes your guide files followed by one section per module,
  headed by the `require(...)` expression that reaches the module and listing
  its types and members as Luau signatures linked to their `file:line`
  declarations. It requires no `luaudocs init` or VitePress build and reads only
  committed repository files; its header instructs agents to rerun
  `npx luaudocs@<version> llms` after changing the public API, doc comments, or
  guides. Pass `--check` in CI to fail on a missing or stale `llms.txt`, or
  `--out <file>` to write to another path. LuauDocs refuses to overwrite an
  `llms.txt` that does not carry its generated marker, and aborts without
  writing when extraction produces an error. See
  [Coding Agents](https://luaudocs.pages.dev/guide/coding-agents).
- **Cloudflare Pages deployment guide.**
  [Deploying](https://luaudocs.pages.dev/guide/deploying#cloudflare-pages) now
  documents building and hosting directly on Cloudflare Pages without a GitHub
  Actions workflow file.

### Changed

- **Documentation site moved to
  [luaudocs.pages.dev](https://luaudocs.pages.dev).** `luaudocs.kohl.gg`
  redirects to the new domain, and package metadata plus newly scaffolded
  starter guides now link to `luaudocs.pages.dev`.
- **Stricter configuration validation for paths and URLs.** Setting `[docs] dir`
  at or outside the project root (`"."`, `".."`, `"../site"`, or `/abs/path`)
  is now rejected so a build can never overwrite the project's own
  `package.json` or `CHANGELOG.md`. URL fields and `--url` must use `http://`
  or `https://`, preventing host-only strings (`docs.example.com:8080`) from
  being parsed as URL schemes and preventing `ssh://` repo URLs from generating
  unclickable source links. `[docs] dir` is also normalized to clean POSIX
  form so `./docs/` no longer leaks leading `./` or trailing slashes into edit
  links and the GitHub Pages workflow.
- **`init` validates existing `luaudocs.toml` files and probes conventional source roots.**
  `luaudocs init` now fails fast on an invalid `luaudocs.toml` instead of
  falling back to default settings, and scaffolds `[source] entries` from the
  existing conventional directories (`src/`, `lib/`) so projects using `lib/`
  build out of the box.
- **The scaffolded GitHub Pages workflow caches `~/.cache/luaudocs`** alongside
  npm and `node_modules` so CI runs reuse the downloaded Lute binary.
- **VitePress build failures exit with code `1`** (build failure) rather than
  `2` (usage/config error).
- **Constructor detection requires a bare class return type** (with optional
  generic arguments): functions returning `Widget?`, `{ Widget }`, or
  `Promise<Widget>` are no longer classified as constructors of `Widget`.
- **Root functions that re-expose an implicit class's constructor or method**
  (`return { new = Signal.new }`) are documented once on the class rather than
  duplicated on the module root.
- **Internal contracts updated in place:** `Reexport` in the doc model gained
  optional `realm` and `within` fields; the generated API sidebar navigation
  moved to `.vitepress/generated/api-nav.ts`; and generated `changelog.md`
  files now include the `# Generated by luaudocs` ownership marker.

### Fixed

- Conditional module mounts written `M.Server = RunService:IsServer() and require(...)`
  now document the mounted module and attach its realm badge instead of
  rendering as an untyped property.
- Re-exports inside nested containers now render on the nested class section
  rather than the module root, and member imports targeting an undocumented
  symbol fall back to rendering as a property alongside the
  `unresolved-reexport` diagnostic.
- Modules promoted to a page solely by a `@class` tag now also surface the
  submodules they mount.
- Block doc comments with text on the opening delimiter line (`--[=[ Summary.`)
  now dedent their body lines properly instead of treating indented `@param`
  tags as indented code blocks.
- `@return` type overrides now update the rendered function signature just like
  `@param` types, and merging a standalone `@function` tag stub into a source
  function preserves the stub's `@return` entries and warns on unmatched
  `@param` or `@return` tags.
- `@prop` and `@readonly` tags on a table-valued field keep it documented as a
  property rather than promoting it to a nested class, and `@class`,
  `@function`, `@prop`, or `@method` blocks placed directly above a `type`
  declaration are no longer consumed as the type alias's doc comment.
- `unreached-types` no longer reports types that were moved to a surfaced class
  via `@within`, and unexported local type aliases are omitted when an
  `@within`-relocated exported type already owns that name on the page.
- Duplicate member declarations that resolve to the same symbol ID now emit a
  `duplicate-member` warning instead of silently overwriting the earlier entry.
- `.luaurc` files containing `--` comments, `//` comments, or trailing commas
  now parse cleanly, matching Luau's own `Config.cpp` reader.
- `require(script.Parent.X)` now resolves from an `init.luau` file whose Rojo
  `$path` mounts the file directly rather than its directory, relative string
  requires (`require("./Sub")`, `require("@self/Sub")`) fall back to the Rojo
  project tree when no sibling file matches on disk, and surfaced requires that
  resolve to a Folder or non-module instance path (`script.Parent.Assets`) emit
  `require-nonmodule`.
- `parse-error` diagnostics now report 1-based line and column numbers and
  strip Lute's internal `@std/syntax/parser.luau` prefix.
- Parallel assignments (`a, b = b, a`) now evaluate all right-hand expressions
  before updating any left-hand bindings.
- Multi-line block comments inside inline type annotations are now stripped
  completely instead of leaving their closing lines in the signature.
- Inline code spans containing `{{` are escaped so Vue does not evaluate them
  as template interpolations.
- Re-export badge links and linked `<Frame>` captions now prefix internal paths
  with VitePress's `withBase` so sites deployed under a subpath (`[docs] url`
  with a path prefix) do not 404.
- Methods re-exported as plain fields (`connect = Signal.Connect`) now include
  the explicit `self` parameter required by dot-call syntax.
- Member anchor predictions stay aligned with VitePress when a guide or doc
  comment contains headings with inline HTML, `:emoji:` shortcodes, reference
  links, custom `{#id}` suffixes, or list prefixes.
- `[Outer.Inner]` doc-comment references now resolve to nested classes, nested
  classes no longer shadow a top-level module page of the same short name in
  `[Reference]` links, and `[Ref]` links inside `@error` descriptions are now
  resolved.
- Nested classes with no public members or description no longer render an
  empty heading, and class names wrapped in underscores (`_Inner_`) are escaped
  so Markdown does not italicize them.
- Linked union types preserve spaces around `|`, and source links or external
  type URLs containing spaces or parentheses are percent-encoded.
- Roblox `Enum.X` types now link to Creator Documentation.
- Guide pages added while an extraction error is active still appear in the
  sidebar; only the API navigation is frozen until the error is fixed.
- Generated `changelog.md` files checked out with CRLF line endings are still
  recognized as tool-generated and cleaned up when `[docs] changelog = false`.
- Concurrent first-time Lute downloads stage into process-specific temporary
  files and write installation notices to `stderr`, keeping `stdout` clean when
  piping extractor JSON.
- Stopping `luaudocs dev` during initial VitePress dependency installation no
  longer spawns the dev server afterward.

## [0.2.0] - 2026-09-01

### Added

- **`_category_` sidebar sidecars for guide folders.** Placing a
  `_category_.json` (or `_category_.yml`) inside a guide folder configures its
  sidebar group's `label`, `position`, `collapsed`, and `collapsible` settings,
  matching Docusaurus and Moonwave conventions. Setting `collapsible: false`
  renders a static group header without a collapse toggle. A folder with an
  `index.md` can also set `sidebar_position`, `collapsed`, and `collapsible` in
  frontmatter, with `_category_` taking precedence per key. Fractional
  positions (`2.5`) sort between integers (`2` and `3`). Invalid sidecar files
  fail the build with the file path in the error message.
  `luaudocs init --from-moonwave` now copies `_category_` files into `guide/`
  and reports only unsupported keys (`link`, `className`).
- **Underscore-prefixed guide folders and files are ignored**, matching
  Docusaurus: `_drafts/` directories and `_partial.md` files for
  `<!--@include: -->` are excluded from the sidebar, search index, and
  `llms.txt`.

### Changed

- **`luaudocs dev` reloads `luaudocs.toml` in place** without requiring a
  manual restart. Editing `luaudocs.toml` re-reads the configuration, updates
  source file watchers for `[source] entries`, and regenerates the VitePress
  config on the fly. Syntax or validation errors in `luaudocs.toml` log an
  error and keep the dev server running on the last valid configuration; only
  changing `[docs] dir` stops the session.
- **`sidebar_position` orders pages relative to their siblings in the same folder.**
  Previously, a folder group inherited the lowest `sidebar_position` of its
  child pages, requiring global numbering across folders. Folder groups are now
  positioned by their own `_category_` file or `index.md` frontmatter (sorting
  after positioned siblings when unspecified). **Sites that relied on child
  positions to order folders should add a `_category_.json` with `position` to
  each folder.**
- **Folder `index.md` files always lead their folder**, sorting ahead of
  numbered sibling pages, including `guide/index.md` at the top of the Guide
  sidebar. An `index.md`'s `sidebar_position` positions the folder itself among
  its parent's children.
- **Top-level guide folders become top-level sidebar sections when `guide/` has no loose pages.**
  When every entry directly under `guide/` is a subdirectory, the outer "Guide"
  wrapper heading is omitted and each subdirectory becomes its own top-level
  sidebar section. Top-level sections render without a collapse toggle unless
  their `_category_` file or `index.md` sets `collapsed` or `collapsible`.
- **Active ancestor groups in the sidebar highlight in the brand color**,
  matching the active page link itself. Top-level section headers stay neutral
  unless they link directly to the current page.

### Fixed

- Empty YAML frontmatter keys (`title:` with no value on the same line) no
  longer consume the next line as their value.

## [0.1.0] - 2026-08-28

First public release.

### Added

- **Surface discovery without tags.** The extractor symbolically evaluates each
  module's top-level statements down to its `return` value, discovering
  functions, methods, properties, nested classes, re-exports, and `export type`
  declarations directly from source code. Table literals, `__index` class
  idioms, `setmetatable` and `table.freeze` calls, type casts, member imports,
  and conditional mounts are all supported. Underscore-prefixed members are
  treated as private by default, with `@private`, `@ignore`, and
  `[api] includePrivate` available as overrides.
- **Behavioral badges inferred from code.** Functions that yield (`task.wait`,
  `signal:Wait()`, `-Async` engine methods, `pcall` wrapping a yielding
  function, or calls to yielding helpers across modules, imports, passthroughs,
  and `__call` metatables) automatically receive a Yields badge. Remote event
  calls, realm-specific services, Studio plugin APIs, and the `plugin` global
  infer Server, Client, or Plugin badges, and properties on `table.freeze`d
  tables or marked `read` in a table type receive a Read Only badge. Explicit
  doc tags (`@yields`, `@server`, `@client`, `@plugin`, and `@readonly`) remain
  available as overrides.
- **Parameter descriptions from trailing comments.** In multi-line function
  signatures, a trailing `-- comment` on a parameter's line documents that
  parameter unless overridden by `@param`.
- **Signatures from real Luau type annotations**, preserved as written in
  source, with every referenced type linked to its declaration or to Roblox
  Creator Documentation.
- **Property types inferred from values.** Unannotated properties infer their
  type when the assigned value is unambiguous: literals, boolean comparisons,
  datatype constructors (`Color3.new(...)`), `Enum.X.Y` items, `script`
  instance paths, engine service methods, homogeneous literal lists, and calls
  to functions with annotated return types across your project. Ambiguous
  expressions (`a + b`, `script.Name`) remain untyped rather than guessing, and
  explicit annotations, casts, or `@prop` tags always take precedence.
- **Same-module table aliases link to their primary entry.** When one table is
  exposed under two names in the same module, the first becomes the documented
  container and the second renders as a property typed as a link to it.
- **Conditional mounts infer realm badges and optional types.** A property
  written `RunService:IsServer() and script:WaitForChild("Storage")` receives a
  Server badge and an inferred type of `Instance?`. Guards over boolean
  predicates (`IsServer() and IsStudio()`) keep their `boolean` type without a
  realm badge.
- **Automatic `[Reference]` linking in doc comments.** Bracketed references
  like `[State:Connect]` resolve against your project's symbols, `@external`
  declarations, and Roblox engine types, leaving unresolved brackets as plain
  text. When a name matches both a module and a type, the module wins; genuine
  ties are left unlinked and reported with `ambiguous-ref`.
- **Zero-setup Lute runtime.** Node.js is the only prerequisite: the extractor
  runs on a pinned Lute binary that LuauDocs downloads, verifies against a
  SHA-256 checksum, and caches per user on first run. Set `LUAUDOCS_LUTE` to
  use a custom Lute binary for offline environments or unsupported platforms.
- **Moonwave compatibility.** All 24 Moonwave tags work as overrides, and
  `luaudocs init --from-moonwave` converts `moonwave.toml` / `moonwave.json`,
  copies `.moonwave/static/` into `public/`, migrates `docs/` and `pages/`
  Markdown/MDX files, rewrites Infima CSS variables in `custom.css`, and
  reports any unmapped settings. Docusaurus `:::note` / `:::caution`
  admonitions and `<Tabs>` / `<TabItem>` blocks render natively in both guide
  pages and doc comments.
- **VitePress 2 site generation**, configured from `luaudocs.toml`: local
  full-text search, dark mode, Luau syntax highlighting in fenced blocks and
  inline `` `code`{luau} `` spans, file-type icons on code groups and titled
  fences, custom `[[site.head]]` tags, `sitemap.xml` generation from
  `[docs] url`, and `/llms.txt` plus `/llms-full.txt`. `<docs>/api/` and
  `<docs>/.vitepress/` are fully managed by LuauDocs, while your hand-written
  guides live alongside them.
- **Bundled [Fira Code](https://github.com/tonsky/FiraCode) variable font** for
  code blocks and inline code spans, with programming ligatures enabled out of
  the box and served locally with zero external CDN requests. Override
  `--vp-font-family-mono` in `custom.css` to customize the monospace font.
- **Automatic `README.md` and `CHANGELOG.md` pages.** When the docs directory
  has no custom `index.md`, builds generate the landing page from your root
  `README.md`, and `CHANGELOG.md` is rendered at `/changelog`.
- **Source and edit links from `[repo] url`**, auto-detected from your git
  remote by `luaudocs init`.
- **Access-path navigation and breadcrumbs.** The API sidebar mirrors how
  callers access your modules in code, falling back to the Rojo tree or folder
  layout for unmounted modules. Disambiguated URLs and titles (`Defaults (Flux)`)
  keep same-named modules distinct, and every page renders a breadcrumb trail
  above its title (excluded from VitePress search indexing).
- **Dedicated type entries.** Exported types and local types referenced by
  documented signatures get their own entries with per-field descriptions from
  doc comments or trailing comments. `type function` declarations render their
  callable signature and link to source.
- **Require resolution** for string requires, `.luaurc` aliases, Roblox
  `script` instance paths, Rojo `*.project.json` trees, and nested Rojo
  projects.
- **CLI commands**: `init`, `dev` (live file watching and HMR), and `build`
  (`--emit-only`, `--strict`, `--url`, and `--model`), plus automatic GitHub
  Pages workflow scaffolding (`.github/workflows/docs.yml`).
- **Structured diagnostics and non-destructive error builds.** Unresolved
  references, malformed tags, and parse failures emit structured diagnostics
  with file and line locations, promoted to build failures under `--strict`.
  Builds that encounter an extraction error preserve existing generated pages
  and navigation on disk so a temporary syntax error never wipes out your site.
- **`<Frame>` component** for embedding live slices of generated `api/` pages
  inside guides via VitePress `<!--@include: -->` directives. See
  [Reference: Markup](https://luaudocs.pages.dev/guide/reference/markup#frames).
- **JSON doc model output (`luaudocs build --model <file>`)** containing every
  module, member, type, resolved type reference, and diagnostic under
  `schemaVersion: 1`. See the
  [doc model reference](https://luaudocs.pages.dev/guide/reference/doc-model).
- **Guide-only mode** (`[source] entries = []`) for documentation sites with no
  Luau modules, skipping extractor execution and Lute installation entirely.

[0.3.0]: https://github.com/kohltastrophe/luaudocs/releases/tag/v0.3.0
[0.2.0]: https://github.com/kohltastrophe/luaudocs/releases/tag/v0.2.0
[0.1.0]: https://github.com/kohltastrophe/luaudocs/releases/tag/v0.1.0

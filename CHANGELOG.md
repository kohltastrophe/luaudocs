# Changelog

Notable changes to LuauDocs, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html): while the major
version is 0, a minor bump may carry breaking changes.

## [0.1.0] - 2026-08-28

First public release.

### Added

- **Surface discovery without tags.** The extractor symbolically evaluates a
  module's top-level statements down to its return value, so functions,
  methods, properties, nested classes, re-exports, and `export type`s are
  documented from the code itself. Table literals, `__index` class idioms,
  `setmetatable` and `table.freeze` wrappers, cast types, member imports, and
  conditional mounts are all recognized. A leading underscore keeps a member
  out of the site, with `@private`, `@ignore`, and `[api] includePrivate` as
  the overrides.
- **Badges detected from code.** A function that waits (`task.wait`,
  `signal:Wait()`, a yielding engine method, a `pcall` running one, or a call
  to something that does, followed across modules, imports, passthroughs, and
  `__call` metatables) is badged Yields without a tag. Remote calls,
  realm-only services, Studio-only members, and the `plugin` global badge a
  function Server, Client, or Plugin, and a prop renders Read Only when its
  table is `table.freeze`d or its field is marked `read` in the table's type.
  The tags stay as overrides: a realm tag replaces whatever was detected.
- **Parameter docs from trailing comments.** In a multi-line signature, the
  trailing `-- comment` on a parameter's line documents that parameter, the
  way it already documents a property or a type field; `@param` outranks it.
- **Signatures from real type annotations**, spelled the way you wrote them.
  Every type mention links to its definition, and Roblox types link to the
  creator docs.
- **Property types read off the value.** A property nothing annotates still
  documents its type when the value settles it: literals and comparisons,
  `Color3.new(...)` and other datatype constructors, `Enum.X.Y`, an instance
  path, an engine method called on a service, a list of literals, and a call
  into your own code, which takes the callee's annotated return and links to
  it (across modules, so a library of `.new` constructors needs no tags). A
  value that settles nothing (`a + b`, `script.Name`) stays untyped rather
  than guessing, and an annotation, a cast, or a floating `@prop` always wins
  over what was inferred.
- **Aliases link to what they alias.** One table reached by two names in a
  module gets one documented section, and the other name is typed as a link to
  it rather than rendering bare beside it. The cross-module case is still a
  re-export, which names the hop it crossed.
- **Conditional mounts badge their realm.** A property written
  `RunService:IsServer() and script:WaitForChild("Storage")` is badged Server
  and typed `Instance?` from that one expression: the guard says where the
  value exists, the guarded half says what it is. A value guarded by an
  already-guarded one carries the same realm. A guard over a plain boolean is
  a predicate rather than a mount, so it keeps its `boolean` type and no
  badge, since the other realm can read it and find it false.
- **References that link themselves.** A `[State:Connect]` in a doc comment
  becomes a link, resolved against your project, `@external` declarations, and
  Roblox names; one that resolves to nothing stays plain text. When one
  spelling could mean two things, a module outranks a
  same-named type and a re-spelling alias cedes to the declaration it
  re-spells; only a genuine tie is left unlinked, reported with both targets.
- **No toolchain to install.** Node is the only requirement. The extractor runs
  on a pinned Lute that the first extraction downloads, verifies against a
  checksum, and caches per user. `LUAUDOCS_LUTE` points LuauDocs at a Lute
  build of your own, for an offline machine or a platform with no prebuilt
  binary.
- **Moonwave compatibility.** All 24 Moonwave tags keep working as overrides,
  so tagged sources need no edits. `luaudocs init --from-moonwave` converts
  the config (`moonwave.toml` or `moonwave.json`, navbar and footer included),
  copies `.moonwave/static/`, and ports the hand-written pages: `docs/` lands
  under `guide/` and the markdown under `pages/` at the site root, with `.mdx`
  renamed, MDX imports and comments stripped, and links, static-asset paths,
  and fence titles respelled, while draft and unlisted pages stay unpublished.
  The homepage banner and feature cards become an `index.md` in VitePress's
  home layout, and `.moonwave/custom.css` arrives with the known Infima
  variables renamed. Whatever has no equivalent is named in a report rather
  than guessed at. Docusaurus markup converts at render time, in doc comments
  and guide pages alike: `:::note` and `:::caution` become VitePress
  containers (bracket titles unwrapped), and `<Tabs>` / `<TabItem>` groups
  become VitePress's own tab strip.
- **A generated VitePress 2 site**, wired up from `luaudocs.toml`: local
  search, dark mode, Luau highlighting in both fences and inline
  `` `code`{luau} `` spans, tool and file-type icons on code-group tabs and
  fence titles, `[[site.head]]` for analytics and verification tags,
  `sitemap.xml` from `[docs] url`, and `llms.txt` plus `llms-full.txt` at the
  site root. `<docs>/api/` and `<docs>/.vitepress/` are wholly tool-owned and
  rebuilt by every build; your content sits beside them and is scaffolded only
  once.
- **[Fira Code](https://github.com/tonsky/FiraCode) for code**, in fences and
  inline spans both, with its programming ligatures on. The font ships with the
  tool and is served from your own site (no request to a font CDN, and no
  network in `dev`), as one variable file covering every weight. Set
  `--vp-font-family-mono` in `custom.css` to use something else.
- **Your README and CHANGELOG become pages.** While the docs directory has no
  `index.md`, every build makes the landing page from your `README.md`, marked
  as generated until you claim the file, and `CHANGELOG.md` renders at
  `/changelog`.
- **Source links from `[repo] url`**, which `init` fills in from your git
  remote: every entry links to the lines that produced it, and the site gets
  edit links and the header's GitHub icon.
- **Navigation that mirrors usage.** The sidebar is the access-path tree
  derived from the code: pages group by how a caller reaches a module rather
  than by folder layout, falling back to the Rojo instance tree (or the folder
  layout) for modules that nothing exposes. There are no keys to reorder, pin,
  or rename groups. Two modules sharing a name stay distinguishable: the later
  gets a numbered URL and carries its parent in the sidebar, search, and tab
  title (`Defaults (Flux)`). Every page also heads with a trail of links to
  what is above it (`Home › Overview › Flux › Util` on an API page, `Home` and
  the enclosing folders on a guide), so a reader arriving from search or a deep
  link sees where the page sits. It renders above the title, which is where
  VitePress's search indexer stops reading, so navigation never enters the
  index.
- **Type entries.** Every exported type, and any local type a documented
  signature mentions, becomes a documented entry with per-field descriptions,
  taken from doc comments above fields or trailing comments on them. A `type
  function` documents as its callable head with parameters, the body behind
  the source link. A tag-written type name resolves against the modules the
  file actually binds, never an unrelated module's same-named class.
- **Require resolution** across string requires, `.luaurc` aliases, Roblox
  instance paths, Rojo `*.project.json` mounts, and nested projects.
- **CLI**: `init`, `dev` (watch plus HMR), and `build` (`--emit-only`,
  `--strict`, `--url`, `--model`); `luaudocs build --emit-only --strict` is the
  CI validation. `init` also scaffolds the GitHub Pages workflow at
  `.github/workflows/docs.yml` when the file does not exist.
- **Extraction never fails silently.** Anything LuauDocs could not do becomes
  a diagnostic with a location, severity, and code, and `--strict` promotes
  warnings to failures. An error build refreshes the pages that did emit and
  withholds every destructive step, so a transient typo cannot look like an
  intentional removal.
- **`<Frame>`**, a labeled border for quoting generated output in a guide.
  Paired with a VitePress file inclusion, it embeds an entry from your own
  `api/` pages by stable region name, and a name that stops existing fails the
  build instead of quietly emptying the frame. See
  [Reference: Markup](https://luaudocs.kohl.gg/guide/reference/markup#frames).
- **The doc model as an output.** `luaudocs build --model <file>` writes the
  JSON the renderer consumed: every module, member, type, and signature, with
  type references resolved to the ids of the declarations they name, and
  diagnostics alongside. `schemaVersion` is `1`, and the shape changes in place
  while the major version is `0`. See the
  [doc model reference](https://luaudocs.kohl.gg/guide/reference/doc-model).
- **Guide-only mode** (`[source] entries = []`) for projects with no Luau
  surface: the extractor never runs and no Lute is fetched.

[0.1.0]: https://github.com/kohltastrophe/luaudocs/releases/tag/v0.1.0

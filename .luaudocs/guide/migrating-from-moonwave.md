---
title: Migrating from Moonwave
description: Convert a Moonwave project, hand-written pages included, in one command, and port the little it cannot guess.
sidebar_position: 7
---

# Migrating from Moonwave

All 24 Moonwave tags keep working here as [overrides](/guide/overriding-with-tags), so tagged sources migrate as-is. Since your public surface is [discovered rather than declared](/guide/how-it-works), a migrated project usually ends up with more pages than it had.

Many of the tags Moonwave required become redundant once the code is read: `@yields` and the realm tags are [detected from what a body does](/guide/overriding-with-tags#adding-badges), `@readonly` follows from `table.freeze` or a `read` field modifier in the table's own type (a type imported from another module does not carry the signal, so keep the tag there), and a trailing comment in a multi-line signature does what `@param` did. Deleting them is optional; a kept tag simply keeps overriding.

One command does the mechanical work:

```bash
luaudocs init --from-moonwave
```

## What converts automatically

Both `moonwave.toml` and `moonwave.json` are understood (TOML wins when both exist), and the keys map across to [`luaudocs.toml`](/guide/configuration):

| Moonwave                        | LuauDocs               |
| :------------------------------ | :--------------------- |
| `gitRepoUrl`, `gitSourceBranch` | `[repo] url`, `branch` |
| `docusaurus.tagline`            | `description`          |
| `docusaurus.url` + `baseUrl`    | `[docs] url`           |
| `docusaurus.favicon`            | `[site] favicon`       |
| `navbar.title`                  | `[site] siteTitle`     |
| `navbar.logo`                   | `[site] logo`          |
| `navbar.items`                  | `[[site.nav]]`         |
| `footer.copyright`              | `[site] footer`        |
| `changelog = false`             | `[docs] changelog`     |
| `home.includeReadme`            | `[docs] includeReadme` |

When `gitRepoUrl` or `docusaurus.url` is absent, `docusaurus.organizationName` and `projectName` are read the way Moonwave's own deploy reads them: they name the GitHub repository and the `*.github.io` site.

Since Moonwave appends `navbar.items` to a derived row while `[[site.nav]]` replaces it, the converted entries arrive with Guide, API, and Changelog baked in ahead of yours.

The Docusaurus mechanics (`deploymentBranch`, `onBrokenLinks`, `onBrokenMarkdownLinks`, `trailingSlash`) are consumed silently: the scaffolded Pages workflow, the always-on link checking, and clean URLs make them moot.

Module roots become `[source] entries`, since Moonwave takes those on the command line rather than in config: `lib/` and `src/` are each taken when they hold an `init.luau`. `.moonwave/static/*` is copied into the site's `public/`, CNAME included.

Your hand-written pages come too: `docs/` lands under `guide/` and the markdown under `pages/` lands at the site root, each file converted once and yours afterwards.

- `.mdx` files are renamed to `.md`, with `import`/`export` lines removed and `{/* */}` comments rewritten as HTML comments.
- Absolute `/docs/...` links move to `/guide/...` and relative links follow the `.mdx` rename, in raw HTML `href`/`src` attributes as well as markdown links.
- Paths reaching into `.moonwave/static/` become root paths, matching where the static copy lands (`public/`).
- Fence attributes are respelled: `title="init.lua"` becomes `[init.lua]`, and `showLineNumbers` becomes `:line-numbers`.
- `sidebar_label`, `sidebar_position`, and `description` frontmatter already means the same thing here (see [the guides sidebar](/guide/configuration#the-guides-sidebar)) and carries over untouched.
- `_category_.json` (or `.yml` / `.yaml`) files are copied over and continue configuring their folders: `label`, `position`, `collapsed`, and `collapsible` are all supported. Any other key in one (`link`, `className`) is inert and named in the report, and categories that do not specify `collapsed` default to being expanded.
- Images and other files sitting beside the pages copy verbatim.
- Pages marked `draft` or `unlisted` stay unpublished, as Moonwave had them, and are named in the report. A `slug` or `id` override is flagged too: URLs here follow the file path.

The homepage and stylesheet convert automatically. `home.bannerImage` and `home.features` generate a ready-made `index.md` in [VitePress's home layout](https://vitepress.dev/reference/default-theme-home-page), with your README included below if `home.includeReadme` is set. Similarly, `.moonwave/custom.css` is migrated to `custom.css`, automatically renaming standard Infima variables to VitePress theme variables (such as `--ifm-color-primary`, `-dark`, and `-darker` to `--vp-c-brand-1`, `-2`, and `-3`, `--ifm-background-color` to `--vp-c-bg`, and `[data-theme="dark"]` selectors to `.dark`).

Your doc comments need no conversion at all. These carry across unchanged:

- `--[=[ ]=]` doc comments, alongside the `--[[ ]]` and `---` styles.
- `:::note` and `:::caution` admonitions, rewritten to VitePress containers, bracket titles (`:::tip[Title]`) unwrapped.
- `<Tabs>` and `<TabItem>`, converted to VitePress's own tab strip, holding prose as happily as code.
- `@__index`, which auto-detection makes redundant, is accepted and ignored.

See [Reference: Markup](/guide/reference/markup) for how the last two render.

## What you port by hand

Any features that cannot be converted automatically are listed in the migration report rather than guessed. Resolving them typically takes only a line or two:

- **Leftover components.** A theme component the conversion cannot express (`<TOCInline>`, say) is reported per page and left in place; delete it or rewrite it as markdown.
- **Leftover styling.** An `--ifm-*` variable outside the rename table survives in `custom.css` as written and is reported; find its [VitePress counterpart](https://vitepress.dev/guide/extending-default-theme) or drop the rule.
- **The blog and React pages.** `blog/` and the `.js`/`.html` files under `pages/` have no equivalent in the generated site.

## What has no equivalent

`classOrder`, `apiCategories`, and `autoSectionPath` have no direct equivalents in LuauDocs. The sidebar here comes from [access paths](/guide/how-it-works#access-paths-not-folders) rather than a pinned section list: to change it, change what your library exposes. The same goes for a pinned `.moonwave/sidebars.js`: the guide sidebar is derived from the pages, their `sidebar_position`, and the `_category_` files beside them.

---
title: Migrating from Moonwave
description: Convert a Moonwave project, hand-written pages included, in one command.
sidebar_position: 8
---

# Migrating from Moonwave

All 24 Moonwave tags continue working as [overrides](/guide/overriding-with-tags), so existing doc comments migrate without edits. Because LuauDocs [discovers your public surface](/guide/how-it-works) rather than requiring `@class` on every module, migrated projects often gain pages that Moonwave skipped.

Many tags that Moonwave required are now inferred automatically: `@yields` and realm tags are [detected from function bodies](/guide/overriding-with-tags#adding-badges), `@readonly` is inferred from `table.freeze` or `read` table-type fields (keep `@readonly` when `read` is on an imported type), and trailing comments in multi-line signatures replace `@param`. Removing redundant tags is optional.

Run one command to migrate your configuration and pages:

```bash
luaudocs init --from-moonwave
```

## What converts automatically

`moonwave.toml` and `moonwave.json` (TOML takes precedence) map to [`luaudocs.toml`](/guide/configuration):

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

When `gitRepoUrl` or `docusaurus.url` is omitted, `docusaurus.organizationName` and `projectName` populate the GitHub repo and `*.github.io` URL. Because Moonwave appends `navbar.items` to its defaults while `[[site.nav]]` replaces defaults wholesale, the converter prepends explicit Guide, API, and Changelog links ahead of your custom items. Docusaurus-only build keys (`deploymentBranch`, `onBrokenLinks`, `onBrokenMarkdownLinks`, `trailingSlash`) are ignored.

Conventional source directories (`src/`, `lib/`) become `[source] entries`, and `.moonwave/static/*` copies into `public/` (including `CNAME`).

Hand-written pages under `docs/` move to `guide/`, and Markdown files under `pages/` move to the docs root:

- `.mdx` files rename to `.md`, stripping `import`/`export` statements and converting `{/* */}` comments to HTML comments.
- `/docs/...` and `.mdx` links rewrite to `/guide/...` and `.md` across Markdown links and HTML `href`/`src` attributes, and `.moonwave/static/` paths rewrite to root `/` paths.
- Code fence attributes convert from `title="init.lua"` and `showLineNumbers` to `[init.lua]` and `:line-numbers`.
- `sidebar_label`, `sidebar_position`, and `description` frontmatter carry over unchanged, as do `_category_.json` / `.yml` files (`label`, `position`, `collapsed`, `collapsible`; unsupported keys such as `link` or `className` are reported).
- Co-located images and assets copy verbatim.
- `draft` and `unlisted` pages stay unpublished and are listed in the migration report alongside any `slug` or `id` frontmatter overrides.

`home.bannerImage` and `home.features` convert into `index.md` using [VitePress's home layout](https://vitepress.dev/reference/default-theme-home-page) (including your README when `home.includeReadme` is enabled). `.moonwave/custom.css` migrates to `custom.css` with standard Infima variables (`--ifm-color-primary*`, `--ifm-background-color`, `[data-theme="dark"]`) mapped to VitePress variables (`--vp-c-brand-*`, `--vp-c-bg`, `.dark`).

Doc comments require no edits: `--[=[ ]=]` blocks, `:::note` / `:::caution` admonitions (including `:::tip[Title]`), `<Tabs>` / `<TabItem>` blocks, and `@__index` (accepted as a no-op) all work out of the box; see [Reference: Markup](/guide/reference/markup).

## What you port by hand

Unconvertible items are listed in the migration report:

- **Leftover components:** Custom MDX/Docusaurus components (`<TOCInline>`) are reported per page; replace them with Markdown.
- **Leftover styling:** Unmapped `--ifm-*` variables in `custom.css` are reported for replacement with [VitePress theme variables](https://vitepress.dev/guide/extending-default-theme).
- **Blog and React pages:** `blog/` and `.js`/`.html` files under `pages/` have no VitePress equivalent.

## What has no equivalent

`classOrder`, `apiCategories`, and `autoSectionPath` have no equivalents because the API sidebar is derived automatically from [access paths](/guide/how-it-works#access-paths-not-folders). Similarly, `.moonwave/sidebars.js` is replaced by `sidebar_position` frontmatter and `_category_` files.

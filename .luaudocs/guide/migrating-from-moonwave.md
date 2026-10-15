---
title: Migrating from Moonwave
description: Convert a Moonwave project, including hand-written guides and assets, in one command.
sidebar_position: 8
---

# Migrating from Moonwave

All 24 Moonwave tags continue working as [overrides](/guide/overriding-with-tags), so your existing doc comments migrate without edits. Because LuauDocs [discovers your public surface](/guide/how-it-works) instead of requiring `@class` on every module, migrated projects often gain pages that Moonwave skipped.

LuauDocs infers many tags that Moonwave required. Function bodies provide [`@yields` and realm badges](/guide/overriding-with-tags#adding-badges), `table.freeze` and `read` table-type fields provide `@readonly` (keep `@readonly` when `read` lives on an imported type), and trailing comments in multi-line signatures replace `@param`. Removing redundant tags is optional.

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

When `gitRepoUrl` or `docusaurus.url` is omitted, `docusaurus.organizationName` and `projectName` populate the GitHub repo and `*.github.io` URL. Because Moonwave appends `navbar.items` to its defaults while `[[site.nav]]` replaces defaults completely, the converter prepends explicit Guide, API, and Changelog links ahead of your custom items. It also ignores Docusaurus-only build keys (`deploymentBranch`, `onBrokenLinks`, `onBrokenMarkdownLinks`, `trailingSlash`).

Conventional source directories (`src/`, `lib/`) become `[source] entries`, and `.moonwave/static/*` copies into `public/` (including `CNAME`).

Hand-written pages under `docs/` move to `guide/`, and Markdown files under `pages/` move to the docs root:

- `.mdx` files rename to `.md`, stripping `import` and `export` statements and converting `{/* */}` comments to HTML comments.
- `/docs/...` and `.mdx` links rewrite to `/guide/...` and `.md` across Markdown links and HTML `href` and `src` attributes, and `.moonwave/static/` paths rewrite to root `/` paths.
- Code fence attributes convert from `title="init.lua"` and `showLineNumbers` to `[init.lua]` and `:line-numbers`.
- `sidebar_label`, `sidebar_position`, and `description` frontmatter carry over unchanged, as do `_category_.json` and `.yml` files (`label`, `position`, `collapsed`, and `collapsible`). Unsupported keys such as `link` or `className` are reported.
- Co-located images and assets copy verbatim.
- `draft` and `unlisted` pages stay unpublished and are listed in the migration report alongside any `slug` or `id` frontmatter overrides.

`home.bannerImage` and `home.features` convert into `index.md` using [VitePress's home layout](https://vitepress.dev/reference/default-theme-home-page) (including your README when `home.includeReadme` is enabled). `.moonwave/custom.css` migrates to `custom.css` with standard Infima variables (`--ifm-color-primary*`, `--ifm-background-color`, `[data-theme="dark"]`) mapped to VitePress variables (`--vp-c-brand-*`, `--vp-c-bg`, `.dark`).

Doc comments don't need any edits. `--[=[ ]=]` blocks, `:::note` and `:::caution` admonitions (including `:::tip[Title]`), `<Tabs>` and `<TabItem>` blocks, and `@__index` (accepted as a no-op) all work out of the box. See [Reference: Markup](/guide/reference/markup).

## What you port by hand

The migration report lists anything that requires manual updates:

- **Leftover components.** Custom MDX or Docusaurus components (`<TOCInline>`) appear per page in the report. Replace them with Markdown.
- **Leftover styling.** Replace reported `--ifm-*` variables in `custom.css` with [VitePress theme variables](https://vitepress.dev/guide/extending-default-theme).
- **Blog and React pages.** `blog/` and `.js` or `.html` files under `pages/` have no VitePress equivalent.

## What has no equivalent

`classOrder`, `apiCategories`, and `autoSectionPath` have no equivalents because [access paths](/guide/how-it-works#access-paths-not-folders) drive the API sidebar directly. `sidebar_position` frontmatter and `_category_` files replace `.moonwave/sidebars.js`.

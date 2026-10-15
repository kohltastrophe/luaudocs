---
title: Deploying
description: Publish your documentation site to GitHub Pages or Cloudflare Pages with base paths and custom domains.
sidebar_position: 6
---

# Deploying

`luaudocs build` emits a static site at `.luaudocs/.vitepress/dist` that any static host can serve. `init` scaffolds a workflow for [GitHub Pages](#github-pages), while [Cloudflare Pages](#cloudflare-pages) builds directly from your repository.

## GitHub Pages

[`luaudocs init`](/guide/reference/cli) writes `.github/workflows/docs.yml` (unless it already exists) with paths matching your `[docs] dir`:

::: code-group

```yaml [.github/workflows/docs.yml]
name: Docs
on:
  push:
    branches: "main"
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: false
jobs:
  publish:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with: { node-version: "22" }
      - uses: actions/cache@v4
        with:
          path: |
            ~/.npm
            ~/.cache/luaudocs
            .luaudocs/node_modules
          key: ${{ runner.os }}-luaudocs-0.2.0
      - id: pages
        uses: actions/configure-pages@v6
      - run: npx luaudocs@0.2.0 build --url "${{ steps.pages.outputs.base_url }}" # [!code highlight]
      - uses: actions/upload-pages-artifact@v5
        with: { path: ".luaudocs/.vitepress/dist" }
      - id: deployment
        uses: actions/deploy-pages@v5
```

:::

::: warning Required repository setting
Set your repository's **Pages source to GitHub Actions**. The workflow deploys directly without a `gh-pages` branch.
:::

Deploying doesn't require a committed `luaudocs.toml` or `.luaudocs/` folder. The runner applies the same [defaults](/guide/getting-started#your-first-site) used locally, and any committed files take precedence.

Node is the only prerequisite. `build` runs `npm install` inside `.luaudocs/` when the pinned VitePress package isn't installed yet, and `actions/cache` caches npm packages and the Lute binary across runs.

- **`--url`** passes the URL from `configure-pages` (overriding `[docs] url`), so project-pages base paths and custom domains work automatically.
- **`luaudocs@latest`** ensures `npx` always uses the current release instead of a cached older version. Replace `@latest` with `@<version>` if you want to pin a specific release.

## Cloudflare Pages

Cloudflare Pages builds directly from your Git repository without a workflow file. In the Cloudflare dashboard under **Workers & Pages**, connect your repository with these build settings:

| Setting                | Value                       |
| :--------------------- | :-------------------------- |
| Framework preset       | None                        |
| Build command          | `npx luaudocs@0.2.0 build` |
| Build output directory | `.luaudocs/.vitepress/dist` |
| Environment variable   | `NODE_VERSION` = `22`       |

Pushes to the production branch deploy to `<project>.pages.dev`, and other branches get preview URLs.

- **`NODE_VERSION=22`** ensures the build image provides Node 22.12+.
- **Configure the site URL.** Set `[docs] url` ([examples below](#base-path-vs-custom-domain)) or pass `--url https://<project>.pages.dev` in the build command so the build emits `sitemap.xml`.
- **Delete `.github/workflows/docs.yml`** if `init` created it so pushes don't also trigger a GitHub Pages build.

To let browsers cache VitePress's content-hashed `/assets/*` files indefinitely on Cloudflare Pages, add `.luaudocs/public/_headers`:

::: code-group

```txt [.luaudocs/public/_headers]
/assets/*
  Cache-Control: public, max-age=31536000, immutable
```

:::

## Other CI

On any other CI provider, run `luaudocs build` and publish `.luaudocs/.vitepress/dist`:

- **`--strict`** turns warnings into build failures ([see all diagnostic codes](/guide/reference/diagnostics)). `luaudocs build --emit-only --strict` validates extraction and links without running VitePress, which makes a fast PR check.
- **Using another package manager.** Run `luaudocs build --emit-only` first to write `.luaudocs/package.json`, install dependencies in `.luaudocs/` with your package manager, and then run `luaudocs build` (which skips `npm install` once VitePress is present).
- **Caching Lute.** Cache [`~/.cache/luaudocs`](/guide/reference/troubleshooting#could-not-download-lute) to avoid re-downloading Lute on cold runners, or set `LUAUDOCS_LUTE` on offline runners.

## Base path vs. custom domain

The GitHub Pages workflow configures both automatically via `--url`. Elsewhere, set `[docs] url` in `luaudocs.toml`:

::: code-group

```toml [Project pages]
# user.github.io/repo/ becomes the site base so assets and links resolve
[docs]
url = "https://user.github.io/repo/"
```

```toml [Custom domain]
# enter the domain in the repository's Pages settings and point a DNS CNAME at user.github.io
[docs]
url = "https://docs.example.com"
```

```toml [Cloudflare Pages]
# Pages serves from the root of its domain, with no path
[docs]
url = "https://my-project.pages.dev"
```

:::

GitHub Actions Pages deployments don't need a `public/CNAME` file. Configure your custom domain directly in the repository's Pages settings.

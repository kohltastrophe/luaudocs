---
title: Deploying
description: Publish the built site. A GitHub Pages workflow, base paths, and custom domains.
sidebar_position: 6
---

# Deploying

`luaudocs build` emits a static site at `.luaudocs/.vitepress/dist`, so any static host serves it as-is.

## GitHub Pages

Run [`luaudocs init`](/guide/reference/cli) if you have not: it writes this workflow to `.github/workflows/docs.yml` (and skips it when that file already exists), with the docs-directory paths following your `[docs] dir`:

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

::: warning The one setting the workflow cannot do for you
Set the repository's **Pages source to GitHub Actions**. The site deploys from the workflow run, so there is no `gh-pages` branch to serve from.
:::

The project needs no `luaudocs.toml` and no committed `.luaudocs/`: the same [defaults](/guide/getting-started#your-first-site) that gave you a site locally apply on the runner, and the build generates the site there. Anything you do commit wins over those defaults.

Two steps the workflow does not need: a toolchain action (Node is the only setup), and an install step (`build` runs `npm install` in the docs directory whenever the VitePress it pins is not already resolvable there). The `actions/cache` step is what keeps that install off later runs: the generated `package.json` has no lockfile to key on, so the key is the LuauDocs version instead.

Two details worth knowing:

- **`--url`** takes the URL `configure-pages` reports, so project-pages base paths and custom domains resolve straight from the Pages settings. It overrides `[docs] url`.
- **The version is pinned.** `init` writes the version it scaffolded with, in both the cache key and the `npx` call, so a later release cannot change this deploy under you. The file is yours from then on: bump the pin the way you would any other dependency.

## Other CI

Nothing about `build` is Pages-specific: run it, then publish `.luaudocs/.vitepress/dist` however your host wants it. Three things matter in a pipeline:

- **`--strict`** promotes warnings to failures, so a stale `@within` or a mistyped `@param` fails the job instead of shipping ([what each one means](/guide/reference/diagnostics)). `luaudocs build --emit-only --strict` is the same validation without the VitePress render, which makes it a good pull request gate.
- **Pre-install to use another package manager.** The automatic docs-directory install is npm's. For another package manager or your own cache keys, run `luaudocs build --emit-only` first: it writes the generated `package.json` without needing VitePress. Install against that, then run the full `build`, which finds the packages already resolvable and installs nothing.
- **Cache Lute.** Reading Luau sources needs [Lute](https://github.com/luau-lang/lute), which `build` downloads on first use. Caching `~/.cache/luaudocs` (`%LOCALAPPDATA%\luaudocs` on Windows) saves the few seconds it costs a cold runner, and a runner with no egress wants [`LUAUDOCS_LUTE`](/guide/reference/troubleshooting#could-not-download-lute) pointed at a Lute you provide instead.

## Base path vs. custom domain

The workflow above settles both through `--url`. Setting it by hand instead:

::: code-group

```toml [Project pages]
# user.github.io/repo/: the path becomes the
# site base, so assets and links resolve
[docs]
url = "https://user.github.io/repo/"
```

```toml [Custom domain]
# also enter the domain in the repository's Pages
# settings, and point a DNS CNAME at user.github.io
[docs]
url = "https://docs.example.com"
```

:::

::: tip
Deploying from Actions needs no `CNAME` file. The domain lives in the Pages settings and nothing force-pushes a branch over it, so a `public/CNAME` is optional rather than load-bearing: this site keeps one, and a project without one deploys just the same.
:::

## Guide-only sites

A [guide-only site](/guide/configuration#guide-only-sites) is the one shape that needs a `luaudocs.toml`, since `[source] entries = []` is what declares it. Nothing else about the workflow changes: the extractor never runs, so the build goes straight to rendering.

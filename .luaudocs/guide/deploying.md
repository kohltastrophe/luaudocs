---
title: Deploying
description: Publish the built site. GitHub Pages or Cloudflare Pages, base paths, and custom domains.
sidebar_position: 6
---

# Deploying

`luaudocs build` emits a static site at `.luaudocs/.vitepress/dist`, so any static host serves it as-is. `init` sets a project up for [GitHub Pages](#github-pages), and [Cloudflare Pages](#cloudflare-pages) takes a few dashboard settings instead.

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

::: warning Required repository setting
Set the repository's **Pages source to GitHub Actions**. The site deploys from the workflow run, so there is no `gh-pages` branch to serve from.
:::

The project needs no `luaudocs.toml` and no committed `.luaudocs/`: the same [defaults](/guide/getting-started#your-first-site) that gave you a site locally apply on the runner, and the build generates the site there. Anything you do commit wins over those defaults.

Two steps the workflow does not need: a toolchain action (Node is the only setup), and an install step (`build` runs `npm install` in the docs directory whenever the VitePress it pins is not already resolvable there). The `actions/cache` step prevents redundant package installations on subsequent runs.

Two details worth knowing:

- **`--url`** takes the URL `configure-pages` reports, so project-pages base paths and custom domains resolve straight from the Pages settings. It overrides `[docs] url`.
- **The version is pinned.** `init` writes the version it scaffolded with, in both the cache key and the `npx` call, preventing upstream releases from altering your deployment behavior. You own this workflow file: update the pinned version as you would any other CI dependency.

## Cloudflare Pages

Cloudflare Pages can build the site straight from your repository, with no workflow file. In the Cloudflare dashboard, go to **Workers & Pages**, create a Pages project connected to your Git repository, and enter these build settings:

| Setting                | Value                       |
| :--------------------- | :-------------------------- |
| Framework preset       | None                        |
| Build command          | `npx luaudocs@0.2.0 build`  |
| Build output directory | `.luaudocs/.vitepress/dist` |
| Environment variable   | `NODE_VERSION` = `22`       |

From then on, every push to the production branch deploys to `<project>.pages.dev`, and every other branch gets a preview URL of its own. As with the workflow, deploying needs no `luaudocs.toml` and no committed `.luaudocs/`, and the output directory follows your `[docs] dir`.

- **The version is pinned** in the build command, for the same reason the workflow pins it.
- **`NODE_VERSION`** makes the build image install Node 22: LuauDocs needs 22.12 or newer, and older build images default to less.
- **Tell the build its address.** Cloudflare does not hand it over the way `configure-pages` does, so set `[docs] url` ([examples below](#base-path-vs-custom-domain)) or append `--url https://<project>.pages.dev` to the build command. Without one the site still deploys, just with no `sitemap.xml`. To serve it from your own domain, add the domain under the project's **Custom domains** tab and use that address instead.
- **Delete `.github/workflows/docs.yml`** if `init` wrote it. That workflow deploys to GitHub Pages, so left in place it either publishes a second copy or fails on every push.

By default, Pages tells browsers to check every file again on every visit. Everything VitePress writes under `/assets/` has a content hash in its name, so browsers can safely keep those files for good, which a `_headers` file in the docs directory's `public/` sets up:

::: code-group

```txt [.luaudocs/public/_headers]
/assets/*
  Cache-Control: public, max-age=31536000, immutable
```

:::

## Other CI

Nothing about `build` is specific to either host: run it, then publish `.luaudocs/.vitepress/dist` however your host wants it. Three things matter in a pipeline:

- **`--strict`** promotes warnings to failures, so a stale `@within` or a mistyped `@param` fails the job instead of shipping ([what each one means](/guide/reference/diagnostics)). `luaudocs build --emit-only --strict` is the same validation without the VitePress render, which makes it a good pull request gate.
- **Pre-install to use another package manager.** The automatic docs-directory install is npm's. For another package manager or your own cache keys, run `luaudocs build --emit-only` first: it writes the generated `package.json` without needing VitePress. Install against that, then run the full `build`, which finds the packages already resolvable and installs nothing.
- **Cache Lute.** Reading Luau sources needs [Lute](https://github.com/luau-lang/lute), which `build` downloads on first use. Caching [its download directory](/guide/reference/troubleshooting#could-not-download-lute) saves download time on cold CI runners, and runners without internet access can set `LUAUDOCS_LUTE` to point to a pre-installed Lute binary.

## Base path vs. custom domain

The GitHub Pages workflow settles both through `--url`. Anywhere else, set `[docs] url` by hand:

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

```toml [Cloudflare Pages]
# Pages serves a site from the root of its domain,
# so this is the pages.dev address or your own
# domain, with no path
[docs]
url = "https://my-project.pages.dev"
```

:::

::: tip
Deploying to GitHub Pages from Actions needs no `CNAME` file. The domain lives in the repository's Pages settings and nothing force-pushes a branch over it, so a `public/CNAME` is optional rather than load-bearing: a project without one deploys just the same.
:::

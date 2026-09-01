---
title: CLI
description: Every luaudocs command and flag.
sidebar_position: 1
---

# CLI

| Command                                                                        | Purpose                                             |
| :----------------------------------------------------------------------------- | :-------------------------------------------------- |
| `luaudocs init [dir] [--force] [--from-moonwave] [--title <t>] [--description <d>]` | scaffold config + docs site                         |
| `luaudocs build [dir] [--emit-only] [--strict] [--url <url>] [--model <file>]` | full static build; extraction errors skip VitePress |
| `luaudocs dev [dir] [-- <vitepress args>]`                                     | watch + live preview (HMR)                          |

`dir` defaults to `.`; `--help` prints the same list, and `--version` the installed version.

## Flags

- **`--emit-only`** (`build`) writes every file the site is made of (the pages, the `.vitepress/` config, `llms.txt`) and then stops, skipping the dependency install and the VitePress render.
- **`--strict`** (`build`) turns warnings into failures. `luaudocs build --emit-only --strict` is the CI gate; see [Deploying](/guide/deploying#other-ci).
- **`--url`** (`build`) overrides `[docs] url` for one build. The [Pages workflow](/guide/deploying#github-pages) uses it for base paths and custom domains.
- **`--model <file>`** (`build`) also writes the [doc model](/guide/reference/doc-model) as JSON, for tooling of your own. It is an extra output on an ordinary build; add `--emit-only` when you want the model without the site.
- **`--from-moonwave`** (`init`) converts an existing Moonwave setup; see [Migrating from Moonwave](/guide/migrating-from-moonwave).
- **`--force`** (`init`) rewrites the user-owned files `init` normally skips when they already exist, including `luaudocs.toml`. It is what applies a Moonwave conversion to a project that already has a config.
- **`--title`**, **`--description`** (`init`) set those `luaudocs.toml` keys instead of taking the folder name and a placeholder description.
- **`--`** (`dev`) forwards everything after it to `vitepress dev`: `luaudocs dev -- --port 4000 --open`.

## What `dev` watches

`dev` rebuilds on changes to your sources, to the root files it reads (`CHANGELOG.md`, `README.md`, the Rojo project file, `.luaurc`), and to the docs directory.

`luaudocs.toml` too: editing it reloads the config in place, re-reads whatever `[source] entries` now names, and rebuilds. A config that does not parse leaves the session running on the last one that did, so a half-typed edit costs you an error line rather than the server.

Moving `[docs] dir` is the one edit that still ends the session, because the server underneath is bound to the directory it started on.

## Environment

- **`LUAUDOCS_LUTE`** points at a [Lute](https://github.com/luau-lang/lute) binary you provide, instead of the pinned one LuauDocs downloads and caches. See [Troubleshooting](/guide/reference/troubleshooting#could-not-download-lute).

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
| `luaudocs llms [dir] [--out <file>] [--check]`                                 | `llms.txt` for coding agents in a checkout          |

`dir` defaults to `.`. `--help` prints this summary, and `--version` prints the installed version.

## Flags

- **`--emit-only`** (`build`): writes generated site files (`api/`, `.vitepress/`, `public/llms*.txt`, `public/docmodel.json`) and stops before installing dependencies or running VitePress.
- **`--strict`** (`build`): promotes warnings to build failures; combine with `--emit-only` for a fast CI gate ([Deploying](/guide/deploying#other-ci)).
- **`--url`** (`build`): overrides `[docs] url` for one build ([GitHub Pages workflow](/guide/deploying#github-pages)).
- **`--model <file>`** (`build`): writes the [doc model](/guide/reference/doc-model) JSON to `<file>` (combine with `--emit-only` to skip the site build).
- **`--out <file>`** (`llms`): writes the agent index to `<file>` instead of `./llms.txt`, adjusting relative links accordingly ([Coding Agents](/guide/coding-agents#where-it-lives)).
- **`--check`** (`llms`): exits `1` without writing if the committed file is missing, stale, or encounters extraction errors.
- **`--from-moonwave`** (`init`): migrates an existing Moonwave project ([Migrating from Moonwave](/guide/migrating-from-moonwave)).
- **`--force`** (`init`): overwrites existing user-owned files (`luaudocs.toml`, `index.md`, `custom.css`).
- **`--title`**, **`--description`** (`init`): populate those `luaudocs.toml` keys instead of defaults.
- **`--`** (`dev`): forwards remaining arguments to `vitepress dev` (`luaudocs dev -- --port 4000 --open`).

## What `dev` watches

`dev` rebuilds on edits to source files, root project files (`CHANGELOG.md`, `README.md`, the Rojo project file, `.luaurc`), the docs directory, and `luaudocs.toml`. Invalid edits to `luaudocs.toml` log an error and keep the server running on the last valid config; only changing `[docs] dir` stops the session.

## Environment

- **`LUAUDOCS_LUTE`**: path to a custom [Lute](https://github.com/luau-lang/lute) binary, bypassing the pinned download ([Troubleshooting](/guide/reference/troubleshooting#could-not-download-lute)).

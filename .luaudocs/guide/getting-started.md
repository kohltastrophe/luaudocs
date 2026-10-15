---
title: Getting Started
description: Install LuauDocs and build a browsable documentation site for your Luau library.
sidebar_position: 1
---

# Getting Started

LuauDocs builds a [VitePress](https://vitepress.dev) documentation site from your Luau library. It discovers exports from what your modules return and reads signatures from your type annotations. You get full-text search, dark mode, and cross-linked types without adding doc tags or writing upfront config.

## Requirements

You need [Node.js](https://nodejs.org/en/download) 22.12 or newer.

LuauDocs uses [Lute](https://github.com/luau-lang/lute) to parse and evaluate your Luau source files. It downloads and caches a pinned Lute binary automatically on first run. For offline environments, [point `LUAUDOCS_LUTE` at a local binary](/guide/reference/troubleshooting#could-not-download-lute).

## Install

::: code-group

```bash [npm]
npm i -g luaudocs
```

```bash [GitHub]
# tracks the latest commit
npm i -g github:kohltastrophe/luaudocs
```

:::

## Your first site

```bash
cd my-luau-library && luaudocs dev
```

`dev` starts a local server and prints a localhost URL for your API reference.

If you don't have a `luaudocs.toml` file, LuauDocs uses sensible defaults. It takes the site title from your folder name and reads modules from `src/` and `lib/`. You can configure other paths under [`[source] entries`](/guide/configuration). If `.luaudocs/` doesn't exist yet, the build creates it with a `.gitignore` for build artifacts so only [your own files are ready to commit](/guide/configuration#which-files-are-yours).

Leave `dev` running while you edit doc comments to see live updates in place.

## What you get

This site documents [`examples/Flux`](https://github.com/kohltastrophe/luaudocs/tree/main/examples/Flux) using those defaults:

```luau [examples/Flux/init.luau]
local State = require("@self/State")
local Util = require("@self/Util")

--[[ A tiny reactive state library. ]]
local Flux = {}

Flux.State = State
Flux.Util = Util

--[[ Reports whether `value` is a state. ]]
Flux.isState = State.isState

--[[
Creates a state holding `initial`.

Call the state to read it, and see [State:Connect] for reacting to changes.
]]
function Flux.state<T>(initial: T?): State.State<T>
	return State.new(initial)
end

return Flux
```

Here is the generated page for that module, embedded directly from the emitted markdown:

<Frame label="Generated reference" link="/api/Flux">

<!--@include: @/api/Flux.md#properties-->

<!--@include: @/api/Flux.md#functions-->

</Frame>

From `return Flux` alone, LuauDocs infers:

- **Required modules become pages.** They carry a <Badge type="info" text="Module" /> badge and nest under **Flux** in the sidebar to match caller access paths (`Flux.State` and `Flux.Util`).
- **`isState` is documented under its exposed name.** It gets a <Badge type="info" text="from State" /> badge that links to its definition.
- **Signatures come from your annotations.** `State.State` links directly to its type entry.
- **`[State:Connect]` resolves to a link** because a project module declares it.

Browse the full example library under [Example API](/api/), where modules nest by access path (`Flux` → `Util` → [`Queue`](/api/Queue)). See [How It Works](/guide/how-it-works) for the rules behind surface discovery and sidebar layout.

## Commands

Each command takes an optional project directory (defaults to `.`):

- `luaudocs dev`: watches sources and serves a live preview.
- `luaudocs build`: builds the static site for publishing. See [Deploying](/guide/deploying).
- `luaudocs init`: scaffolds `luaudocs.toml` and starter pages. See [Configuration](/guide/configuration).
- `luaudocs llms`: writes a repository-root `llms.txt` for coding agents. See [Coding Agents](/guide/coding-agents).

Pass `--help` or see [Reference: CLI](/guide/reference/cli) for all flags.

## Next steps

- **[How It Works](/guide/how-it-works):** how public surface discovery shapes your site.
- **[Writing Doc Comments](/guide/writing-doc-comments):** prose and automatic cross-references.
- **[Configuration](/guide/configuration):** `luaudocs.toml`, file ownership, and styling.
- **[Deploying](/guide/deploying):** GitHub Pages and Cloudflare Pages setup.
- **[Coding Agents](/guide/coding-agents):** generating `llms.txt` indexes for coding agents.
- **[Migrating from Moonwave](/guide/migrating-from-moonwave):** run `luaudocs init --from-moonwave` to convert your config, guides, and static assets while keeping all 24 Moonwave tags.

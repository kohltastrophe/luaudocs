---
title: Getting Started
description: Install LuauDocs and take a Luau library from zero to a browsable documentation site.
sidebar_position: 1
---

# Getting Started

LuauDocs reads a Luau library and builds a [VitePress](https://vitepress.dev) documentation site from it: exports are discovered automatically, signatures come from your type annotations, and the output includes search, dark mode, and cross-linked types with no required tags or upfront configuration.

## Requirements

[Node.js](https://nodejs.org/en/download) 22.12 or newer.

Extracting Luau sources uses [Lute](https://github.com/luau-lang/lute), which LuauDocs downloads and caches automatically on first run. (For offline environments, [point `LUAUDOCS_LUTE` at a local binary](/guide/reference/troubleshooting#could-not-download-lute).)

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

`dev` prints a localhost URL serving your API reference.

Without `luaudocs.toml`, LuauDocs uses defaults: the site title comes from the folder name, and modules are read from `src/` and `lib/` (configure other paths under [`[source] entries`](/guide/configuration)). If `.luaudocs/` does not exist, the build creates it and writes an auto-generated `.gitignore` for build artifacts, leaving [user-owned files ready to commit](/guide/configuration#which-files-are-yours).

Leave `dev` running while you edit doc comments to see live updates in place.

## What you just got

This site documents [`examples/Flux`](https://github.com/kohltastrophe/luaudocs/tree/main/examples/Flux) with those defaults:

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

From `return Flux` alone, LuauDocs inferred:

- **Required modules become pages**, badged <Badge type="info" text="Module" /> and nested under **Flux** in the sidebar to match caller access paths (`Flux.State` and `Flux.Util`).
- **`isState` is documented under the exposed name**, badged <Badge type="info" text="from State" /> and linked to its definition.
- **Signatures come from your annotations**, with `State.State` linking to its type entry.
- **`[State:Connect]` resolves to a link** because a project module declares it.

See [How It Works](/guide/how-it-works) for the rules behind surface discovery and sidebar layout.

::: tip
Browse the full example library under [Example API](/api/), nested by access path (`Flux` → `Util` → [`Queue`](/api/Queue)). Every framed block in these guides is embedded from those generated pages.
:::

## Commands

Each command takes an optional project directory (default `.`):

- `luaudocs dev`: watches sources and serves a live preview.
- `luaudocs build`: builds the static site for publishing; see [Deploying](/guide/deploying).
- `luaudocs init`: scaffolds `luaudocs.toml` and starter pages; see [Configuration](/guide/configuration).
- `luaudocs llms`: writes a repository-root `llms.txt` for coding agents; see [Coding Agents](/guide/coding-agents).

Pass `--help` or see [Reference: CLI](/guide/reference/cli) for all flags.

## Next steps

- **[How It Works](/guide/how-it-works)**: how public surface discovery shapes your site.
- **[Writing Doc Comments](/guide/writing-doc-comments)**: prose and automatic cross-references.
- **[Configuration](/guide/configuration)**: `luaudocs.toml`, file ownership, and styling.
- **[Deploying](/guide/deploying)**: GitHub Pages and Cloudflare Pages setup.
- **[Coding Agents](/guide/coding-agents)**: a repository index for coding agents.

::: tip Already using Moonwave?
`luaudocs init --from-moonwave` converts your config, migrates hand-written pages, and copies static assets while all 24 Moonwave tags continue working as-is. See [Migrating from Moonwave](/guide/migrating-from-moonwave).
:::

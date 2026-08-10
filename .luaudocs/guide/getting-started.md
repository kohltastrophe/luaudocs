---
title: Getting Started
description: Install LuauDocs and take a Luau library from zero to a browsable documentation site.
sidebar_position: 1
---

# Getting Started

LuauDocs reads a Luau library and builds a documentation site from it: the exports are discovered for you, the signatures come from the annotations already in your code, and the result is a [VitePress](https://vitepress.dev) site with search, dark mode, and cross-linked types. There is nothing to tag and no config to write first.

## Requirements

[Node.js](https://nodejs.org/en/download) 22.12 or newer.

Reading Luau sources also needs [Lute](https://github.com/luau-lang/lute), but you do not have to install it: the first extraction downloads and caches a pinned build for you. (On a machine with no internet access, [point `LUAUDOCS_LUTE` at your own copy](/guide/reference/troubleshooting#could-not-download-lute) instead.)

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

That is the whole setup. `dev` prints a localhost URL, and your API reference is already on it.

You have no `luaudocs.toml`, so LuauDocs uses defaults: the site title comes from the folder name, and it reads your modules from `src/` (or `lib/`, if that is what your project has; sources elsewhere take one [`[source] entries`](/guide/configuration) line). You have no `.luaudocs/` directory either, so the build creates one and generates the entire site inside. It is safe to commit as-is: a `.gitignore` written alongside covers everything tool-generated, and [the rest is yours](/guide/configuration#which-files-are-yours).

Leave `dev` running while you work. Edit a doc comment and the page updates in place.

## What you just got

Here is a real library: this site ships [`examples/Flux`](https://github.com/kohltastrophe/luaudocs/tree/main/examples/Flux) and documents it with the same commands you just ran:

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

That module's page is below, embedded from the markdown LuauDocs emitted for it:

<Frame label="Generated reference" link="/api/Flux">

<!--@include: @/api/Flux.md#properties-->

<!--@include: @/api/Flux.md#functions-->

</Frame>

Read what it did with the file:

- **The two required modules became pages**, badged <Badge type="info" text="Module" /> and linked. They sit beside **Flux** at the top of the sidebar, because `Flux.State` and `Flux.Util` are how a caller reaches them.
- **`isState` is documented under the name callers use**, badged <Badge type="info" text="from State" /> so a reader can find where it actually lives.
- **The signatures are your annotations**, with `State.State` linking to the page documenting that type.
- **`[State:Connect]` resolved itself** into a link, because a module in the project declares it.

You wrote no tags and no config. LuauDocs worked all of it out from what `return Flux` evaluates to, and [How It Works](/guide/how-it-works) explains how; read it once and nothing about your sidebar will look mysterious.

::: tip
The whole example is browsable under [Example API](/api/), nested exactly as it is reached: `Flux` → `Util` → [`Queue`](/api/Queue). Every framed block in these guides is embedded from it, and its label links to the entry it came from.
:::

## Commands

Three commands, and every one of them takes an optional project directory (default `.`):

- `luaudocs dev` watches your sources and serves the live preview you just used.
- `luaudocs build` writes the static site, ready to publish. See [Deploying](/guide/deploying).
- `luaudocs init` scaffolds a `luaudocs.toml` and the pages you own, for when you want to shape the site. See [Configuration](/guide/configuration).

`--help` prints the flags, and [Reference: CLI](/guide/reference/cli) documents all of them.

## Next steps

- **[How It Works](/guide/how-it-works)** - why your site contains what it contains.
- **[Writing Doc Comments](/guide/writing-doc-comments)** - the prose layer on top.
- **[Configuration](/guide/configuration)** - `luaudocs.toml`, the files `init` writes, and styling.
- **[Deploying](/guide/deploying)** - GitHub Pages from one workflow file.

::: tip Already using Moonwave?
`luaudocs init --from-moonwave` converts your config and hand-written pages and copies your assets, and all 24 Moonwave tags keep working as-is. See [Migrating from Moonwave](/guide/migrating-from-moonwave).
:::

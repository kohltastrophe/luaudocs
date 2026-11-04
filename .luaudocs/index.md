---
layout: home

hero:
  name: "LuauDocs"
  text: "No tags. Real types. One command."
  tagline: "Generates VitePress documentation sites from your Luau source code. Evaluates what your modules return, reads your type annotations and doc comments directly, and links every type to its definition."
  image:
    src: /logo.svg
    alt: LuauDocs
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Example API
      link: /api/
    - theme: alt
      text: GitHub
      link: https://github.com/kohltastrophe/luaudocs
---

## No tags <span>just your code</span>

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

LuauDocs parses your module and symbolically evaluates its top-level `return` statement. Everything reachable from that return value becomes your public API reference, while local helpers and `_`-prefixed members stay private automatically.

## Real types <span>linked everywhere</span>

<Frame label="Generated reference" link="/api/Flux">

<!--@include: @/api/Flux.md#state-1-->

<!--@include: @/api/Flux.md#isstate-->

</Frame>

Signatures come straight from your Luau annotations, so you never duplicate parameter or return types in `@param` and `@return` tags. Referenced types link to their declarations, `[State:Connect]` resolves to [its method entry](/api/State#connect), and behavioral badges like `Yields` and `Server` are inferred from your code.

## One command <span>for humans and agents</span>

```markdown [llms.txt]
## Flux

- [Flux](examples/Flux/init.luau): A tiny reactive state library.
- [`Flux.State: State`](examples/Flux/State.luau): [Module]
- [`Flux.state<T>(initial: T?): State.State<T>`](examples/Flux/init.luau#L18-L20): Creates a state holding `initial`.
- [`Flux.isState(value: any): boolean`](examples/Flux/State.luau#L20-L22): [from State] Reports whether `value` is a state.
```

Run `luaudocs dev` to preview a searchable VitePress site with live reload, or `luaudocs llms` to write a compact `llms.txt` index linking every guide and public symbol to its `file:line` declaration. Need custom tooling? Run `luaudocs build --model` to export your full API as JSON.

## Batteries Included

LuauDocs handles the full documentation workflow out of the box:

- **Symbolic Discovery:** Evaluates your module's [`return` value](/guide/how-it-works) to find public functions, classes, properties, and re-exports without doc tags.
- **Automatic Badges:** Infers [`Yields`, `Server`, `Client`, `Plugin`, and `Read Only`](/guide/overriding-with-tags#adding-badges) badges directly from function bodies, `RunService` guards, and `table.freeze`.
- **Linked Signatures:** Reads [types from your annotations](/guide/how-it-works#types-get-their-own-entries) and links project types, [cross-site dependencies](/guide/configuration#source-aliases), and Roblox datatypes.
- **Access-Path Navigation:** Organizes the [API sidebar and breadcrumbs](/guide/how-it-works#access-paths-not-folders) around the expression callers write (`Flux.Util.Queue`) rather than folder paths.
- **Moonwave Compatible:** Supports all [24 Moonwave tags](/guide/reference/tags) as overrides and [migrates your existing config, guides, and static assets](/guide/migrating-from-moonwave) in one command.
- **Coding Agents & JSON Model:** Generates [`llms.txt` indexes](/guide/coding-agents) with `file:line` source links and exports your full API as a [JSON doc model](/guide/reference/doc-model).
- **Rich Guides & Embeds:** Write guides with [tabs, admonitions, inline highlighting, and `<Frame>` embeds](/guide/reference/markup) that pull live entries from your generated API pages.

## Quick Start

Requires [Node.js](https://nodejs.org/en/download) 22.12 or newer. LuauDocs automatically downloads, verifies, and caches a pinned [Lute](https://github.com/luau-lang/lute) binary on first run.

```bash
npm i -g luaudocs
cd my-luau-library
luaudocs dev
```

Already using [Moonwave](https://github.com/evaera/moonwave)? Run `luaudocs init --from-moonwave` before `dev` to convert your project in place.

Read the **[Getting Started](/guide/getting-started)** guide or browse the **[Example API](/api/)** generated from [`examples/Flux`](https://github.com/kohltastrophe/luaudocs/tree/main/examples/Flux).

## Sponsors

LuauDocs is free and MIT-licensed. If LuauDocs is useful to you or your team, you can support its development through [GitHub Sponsors](https://github.com/sponsors/kohltastrophe) or [Ko-fi](https://ko-fi.com/kohltastrophe).

<p class="sponsors">
  <a href="https://github.com/sponsors/kohltastrophe"><img src="https://raw.githubusercontent.com/kohltastrophe/kohltastrophe/badges/sponsor-github.svg" alt="GitHub Sponsors" /></a>&nbsp;&nbsp;<a href="https://ko-fi.com/kohltastrophe"><img src="https://raw.githubusercontent.com/kohltastrophe/kohltastrophe/badges/sponsor-kofi.svg" alt="Ko-fi" /></a>
  <a href="https://github.com/sponsors/kohltastrophe"><img src="https://raw.githubusercontent.com/kohltastrophe/kohltastrophe/badges/sponsors.svg" alt="Sponsors" /></a>
</p>

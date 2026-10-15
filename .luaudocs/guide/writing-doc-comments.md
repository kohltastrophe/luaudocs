---
title: Writing Doc Comments
description: The prose layer on top of your API, and references that link themselves.
sidebar_position: 3
---

# Writing Doc Comments

Because LuauDocs discovers your exports, signatures, and types from source code, doc comments only need to explain what an item is for.

## The three styles

Place a comment block above a definition. All three comment styles are interchangeable:

::: code-group

```luau [Block]
--[[
Creates a state holding `initial`.
See [State:Connect] for reacting to changes.
]]
function Flux.state<T>(initial: T?): State.State<T>
```

```luau [Triple dash]
--- Creates a state holding `initial`.
--- See [State:Connect] for reacting to changes.
function Flux.state<T>(initial: T?): State.State<T>
```

```luau [Long bracket]
--[=[
Creates a state holding `initial`.
Prose here can contain [[ and ]] freely.
]=]
function Flux.state<T>(initial: T?): State.State<T>
```

:::

Descriptions use Markdown (lists, links, fenced code, and emphasis), and [tags](/guide/overriding-with-tags) are optional. Multiple paragraphs render as separate paragraphs:

```luau [examples/Flux/State.luau]
--[[
Runs `callback` whenever the value changes.

Returns a function that disconnects the listener again.
]]
function State:Connect(callback: (any) -> ()): () -> ()
```

<Frame label="Generated reference" link="/api/State#connect">

<!--@include: @/api/State.md#connect-->

</Frame>

## Documenting fields

Document table or type fields with either a preceding doc comment or a trailing comment on the same line:

```luau
export type Options = {
	--[[ How long to wait before giving up. ]]
	timeout: number,
	retries: number, -- how many attempts after the first
}
```

On a table-literal member, field prose renders as full Markdown, including [references](#references-that-link-themselves). On a type declaration, field descriptions render inside the type's Luau code fence as trailing `-- comment` lines with inline formatting stripped, so keep type-field descriptions concise.

## Documenting the module itself

Place a doc comment above the returned table's definition (or at the top of the file before the first statement) to set the module page's opening prose:

```luau
--[[
A tiny reactive state library.
]]
local Flux = {}
```

That comment becomes the introduction on [the Flux page](/api/Flux). A [`@class`](/guide/overriding-with-tags#moving-a-member-somewhere-else) block's description serves the same role for tag-declared classes.

## References that link themselves

Wrap a symbol name in square brackets to link it:

| You write         | It resolves to                          |
| :---------------- | :-------------------------------------- |
| `[Class]`         | that class or module's page             |
| `[Class.member]`  | the member's anchor on that page        |
| `[Class:method]`  | the method's anchor on that page        |
| `[CFrame]`        | the Roblox Creator Documentation        |

Bare names resolve against your project first (with modules outranking same-named types), then [`@external`](/guide/reference/tags#data) declarations, and finally Roblox engine types. Dotted and colon forms resolve only within your project.

Unresolved brackets stay as plain `[OldName]` text rather than emitting broken links. If a reference is ambiguous (such as two modules named `Defaults`), LuauDocs leaves it unlinked and emits an [`ambiguous-ref` warning](/guide/reference/diagnostics#renderer-warnings); qualify the reference (`[Module.State]`) to disambiguate it.

## More than prose

Doc comments support the same rich markup as guide pages, including [admonitions](/guide/reference/markup#admonitions), [tab strips](/guide/reference/markup#tabs), [frames](/guide/reference/markup#frames), [badges](/guide/reference/markup#badges), and [inline `{luau}` highlighting](/guide/reference/markup#code-highlighting). See [Overriding with Tags](/guide/overriding-with-tags) when you need to override inferred signatures or placement.

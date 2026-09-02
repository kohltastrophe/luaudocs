---
title: Writing Doc Comments
description: The prose layer on top of your API, and references that link themselves.
sidebar_position: 3
---

# Writing Doc Comments

LuauDocs has already found your exports, their signatures, and their types. Doc comments add the prose on top: you are not declaring what exists or restating an annotated type; you are explaining what something is for.

## The three styles

Write a comment block above a definition. All three formats are functionally identical and can be mixed freely in the same file:

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

The description is markdown, so lists, links, fenced code, and emphasis all work. Everything beyond that is optional, including [tags](/guide/overriding-with-tags).

Paragraphs survive the trip:

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

Fields take prose the same way, either above the field or trailing it, whichever reads better in the source:

```luau
export type Options = {
	--[[ How long to wait before giving up. ]]
	timeout: number,
	retries: number, -- how many attempts after the first
}
```

On a table-literal member the prose renders as markdown, [references](#references-that-link-themselves) included. A type declaration's fields render inside the type's code fence instead, so their prose becomes a `-- comment` line there: plain text, with links, bold, and code spans stripped. Keep those to a short phrase.

## Documenting the module itself

The module's own page takes a description the same way: a doc comment above the definition of the table you return, or at the very top of the file, before the first statement.

```luau
--[[
A tiny reactive state library.
]]
local Flux = {}
```

That comment opens [the example's Flux page](/api/Flux). A [`@class`](/guide/overriding-with-tags#moving-a-member-somewhere-else) block's prose does the same job for a class assembled by hand.

## References that link themselves

A name in square brackets becomes a link:

| You write         | It resolves to                          |
| :---------------- | :-------------------------------------- |
| `[Class]`         | that class or module's page             |
| `[Class.member]`  | the member's anchor on that page        |
| `[Class:method]`  | the method's anchor on that page        |
| `[CFrame]`        | the Roblox creator docs                 |

A bare name is looked up in your project first, then in any [`@external`](/guide/reference/tags#data) names you declared, then among Roblox names. The dotted and colon forms only ever resolve inside your project.

The example library writes `see [State:Connect] for reacting to changes` in a plain doc comment, and [the generated entry](/api/Flux#state-1) carries the link.

A reference that resolves to nothing is left exactly as you typed it, unlinked, so a stale `[OldName]` shows up as plain text rather than a broken link. A module outranks a type sharing its name, so `[Signal]` means the Signal module even where a `type Signal` also exists. If a reference is ambiguous (such as two modules named `Defaults`), LuauDocs refuses to guess, links neither, and [emits a diagnostic warning](/guide/reference/diagnostics#renderer-warnings). Qualify it (`[Module.State]`) to fix that.

## More than prose

Doc comments render the same markdown as a hand-written guide page, which includes [admonitions](/guide/reference/markup#admonitions), [tab strips](/guide/reference/markup#tabs), [frames](/guide/reference/markup#frames), [badges](/guide/reference/markup#badges), and [inline `{luau}` highlighting](/guide/reference/markup#code-highlighting).

When inference gets something wrong, or if you want a member placed somewhere other than where the code puts it, that is what [tags](/guide/overriding-with-tags) are for.

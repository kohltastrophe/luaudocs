---
title: How It Works
description: How LuauDocs finds your public surface, and why your site is shaped the way it is.
sidebar_position: 2
---

# How It Works

Most documentation generators ask you to declare what is public. LuauDocs works it out instead.

That one difference explains everything about the site you just generated: which pages exist, what they are called, which of them are missing, and why the sidebar is arranged the way it is.

## Your module's return value

LuauDocs never runs your code. It reads it, then evaluates it symbolically: it follows the assignments, requires, casts, and metatables closely enough to know what value your module's `return` statement returns.

Whatever that value can reach is your public surface. That is the whole rule.

```luau
local M = {}

function M.visible() end -- documented: reachable from the returned table
local function helper() end -- not documented: nothing exposes it

return M
```

Two consequences are worth knowing up front:

- **Only the top-level `return` counts.** A `return` inside an `if` block is not considered the module's return value, so it is ignored.
- **The value has to resolve to a table.** When it cannot (such as a call into another module, or a value constructed behind an unresolvable conditional), no members are discovered for that module, and LuauDocs emits the [`surface-opaque`](/guide/reference/diagnostics#info) diagnostic.

## Private members

A leading underscore marks a member as private, and private members are left out of the site. Two kinds of members remain public regardless of name: an `export type` (where `export` explicitly declares intent) and a double-underscore metamethod function (`__name`) carrying a doc comment. Without a doc comment, `__` functions are omitted, unlike other undocumented public members.

You can override the convention per member with [`@private` or `@ignore`](/guide/overriding-with-tags#hiding-things), or render private members site-wide with [`[api] includePrivate`](/guide/configuration).

## What the extractor understands

All of these are discovered correctly without a single tag:

- Table-literal members, including doc comments on individual fields
- `function M.f`, `function M:method`, and `M.x = value` assignments
- `__index` class idioms, plus `setmetatable` and `table.freeze` wrappers
- Cast types (`:: T`)
- Re-exported requires, and member imports (`isState = State.isState`)
- Conditional mounts (`if IsClient then M.UI = require(...) end`)
- String requires (`./x`, `@self/x`, and `@alias/x` via `.luaurc`)
- Roblox instance requires (`script.Parent.X`, `:WaitForChild("X")`), including Rojo `*.project.json` mounts and nested project files
- Badges from behavior: a body that waits, code only one realm can run, a property mounted with `RunService:IsServer() and ...`, and a `table.freeze`d table all receive automatic badges; [Adding badges](/guide/overriding-with-tags#adding-badges) lists every signal
- Property types read off the value where nothing declares one (see [below](#property-types-come-from-the-value))
- Parameter docs from trailing comments in a multi-line signature

If something here does not resolve, LuauDocs emits a diagnostic rather than dropping it silently. See [`require-unresolved`](/guide/reference/diagnostics#warnings).

## Access paths, not folders

Once the surface is known, every module has an **access path**: the expression a consumer writes to reach it.

Your folders play no part in this. If callers write `Flux.Util.Queue`, then Queue's access path is `Flux.Util.Queue`, whether its source file lives at `src/Queue.luau`, `src/util/queue/init.luau`, or inside a vendored submodule. A module reachable by more than one path is filed under its shortest path.

This site's [example library](/api/) is arranged that way on purpose, and the index it generates is the access tree itself:

<Frame label="Generated reference" link="/api/">

<!--@include: @/api/index.md#reference-->

</Frame>

`Queue` is nested under `Util` there because `Flux.Util.Queue` is how you reach it, and for no other reason. On disk it is `examples/Flux/Util/Queue.luau`, but moving that file would not move the page.

## The API sidebar

The sidebar is that access tree, rendered. Its shape is fixed: an **Overview** link to the `/api/` index, then a section per entry module that exposes other modules, headed by the module itself and holding everything under it. A module that exposes other modules becomes a group inside that section, and both the section title and the group heading link to their respective pages. A module that is not explicitly exposed is nested under the module that encloses it (see [below](#re-exports-and-internals)). Any remaining modules (including entry modules that expose no other modules) are grouped under **Reference** at the end. As a result, a single-module library simply displays **Overview** followed by **Reference**.

So the example's `Flux.Util.Queue` puts [`Queue`](/api/Queue) under a **Util** group inside the **Flux** section, and clicking **Util** takes you to the [Util](/api/Util) page.

This same hierarchy forms the breadcrumbs at the top of each page. Above each title, breadcrumbs trace parent modules, so arriving from search or a deep link immediately shows where you are without opening the sidebar. The [Queue](/api/Queue) page displays `Home › Overview › Flux › Util`; a guide page displays `Home` and its parent folders. Only the landing page has nothing above it.

::: info The API sidebar takes no configuration
There are no keys for reordering, pinning, or renaming groups, because the sidebar is a picture of your public API rather than a menu you maintain alongside it. To change the sidebar, change what your code exposes.
:::

## Re-exports and internals

**Re-exports render inline**, on the page that exposes them. A re-exported module becomes a property linking to its page, badged <Badge type="info" text="Module" />. A member import (`isState = State.isState`) becomes a full entry under the name callers actually use, badged <Badge type="info" text="from State" />. Both badges link back to the definition.

In the example library, `Util/init.luau` does nothing but assign `Util.Queue = Queue`. That one line generated this:

<Frame label="Generated reference" link="/api/Util">

<!--@include: @/api/Util.md#properties-->

</Frame>

The member-import case is on the root module: [`Flux.isState`](/api/Flux#isstate) is defined in `State.luau`, and its badge says so.

**Internals fall back to the instance tree.** A module that your public value never exposes, but that still carries doc comments, has no access path to be filed under, so LuauDocs files it by structure instead: the Rojo tree when the project has a `default.project.json` (name a different file with [`[source] projectFile`](/guide/configuration)), and the folder layout otherwise. Mounts, nested project files, and renamed instances are all followed, so a vendored `submodules/Flux/src/Async.luau` mounted at `MyLib.Flux` files under the Flux page. An internal module still gets its page and its sidebar entry; only its location in the sidebar changes.

## Types get their own entries

Every `export type` becomes a documented entry, and a local alias does too once a documented signature mentions it. Per-field descriptions come from doc comments above the fields or trailing `--` comments on them.

```luau [examples/Flux/Util/Queue.luau]
--[[ A first-in, first-out queue. ]]
export type Queue<T> = typeof(setmetatable(
	{} :: {
		items: { T }, -- everything still waiting, front first
	},
	Queue
))
```

That declaration, its doc comment, and the trailing comment on its one field produced this entry:

<Frame label="Generated reference" link="/api/Queue#queue-1">

<!--@include: @/api/Queue.md#types-->

</Frame>

Every mention of a type in a signature links to that entry, so a reader who hits `State.State<T>` in a return position is one click away from its definition. Roblox types (`CFrame`, `Instance`, enums) link to the Roblox Creator Documentation, which you can turn off with [`[api] linkRobloxTypes`](/guide/configuration).

## Property types come from the value

Most properties are never annotated: you write `IsClient = RunService:IsClient()` and the type is obvious from the line. LuauDocs reads it off the value, so the entry carries a type without a `:: boolean` or a `@prop` tag:

```luau
Settings.IsClient = RunService:IsClient() -- boolean
Settings.accent = Color3.fromRGB(0, 122, 204) -- Color3
Settings.sortOrder = Enum.SortOrder.LayoutOrder -- Enum.SortOrder
Settings.container = script:WaitForChild("Container") -- Instance
Settings.changed = Signal.new() -- Signal, from what Signal.new returns
Settings.tags = { "ui", "theme" } -- { string }
```

The last one matters most in practice: a call into your own code takes whatever the callee's return annotation says, across modules, so a library of `.new` constructors documents its properties without a tag anywhere. The type links to the callee's own entry.

**Conditional mounts are recognized automatically.** A guarded property conveys two things at once, and both land on the entry:

```luau
Store.folder = RunService:IsServer() and script:WaitForChild("Storage")
-- the entry reads: folder [Server], Store.folder: Instance?
```

The guard indicates where the value exists, so the property receives a <Badge type="info" text="Server" class="luaudocs-server" /> badge without an `@server` tag; the guarded expression determines the underlying type, marked optional (`Instance?`). A value guarded by an already-guarded one (`Server and Server:WaitForChild("Tools")`) carries the same realm badge.

A guard over a plain boolean is a predicate rather than a mount, so `IS_PRIVATE = RunService:IsServer() and game.PrivateServerId ~= ""` stays a `boolean` and is not badged: a client can read it perfectly well and find it false.

**An alias links to what it aliases.** One table under two names (`Z.boolean = Z.bool`) gets one section, under whichever name came first; the other is typed as a link to it, so a reader who arrives at the alias is one click from the members. Across modules this is a re-export instead, badged <Badge type="info" text="from State" />, because there is a module hop worth naming.

When a value cannot be statically resolved, LuauDocs leaves the entry untyped rather than guessing. `a + b` could be a number or a `Vector3`, and `script.Name` is a string while `script.Container` is an `Instance`, so neither is inferred. Declare the type yourself and it is used as written: an annotation or a `:: cast` always wins, and so does a floating `@prop name Type`, which is how you name the shape of a table that starts out empty.

## Where to go from here

Now that the site contains the right things, [Writing Doc Comments](/guide/writing-doc-comments) covers the prose you add on top, and [Overriding with Tags](/guide/overriding-with-tags) covers the cases where you want something other than what your code says.

---
title: How It Works
description: How LuauDocs finds your public surface, and why your site is shaped the way it is.
sidebar_position: 2
---

# How It Works

Most documentation generators ask you to declare what is public. LuauDocs works it out instead.

That one difference explains everything about the site you just generated: which pages exist, what they are called, which of them are missing, and why the sidebar is arranged the way it is.

## Your module's return value

LuauDocs never runs your code. It reads it, then evaluates it symbolically: it follows the assignments, requires, casts, and metatables closely enough to know what value your module's `return` statement hands back.

Whatever that value can reach is your public surface. That is the whole rule.

```luau
local M = {}

function M.visible() end -- documented: reachable from the returned table
local function helper() end -- not documented: nothing exposes it

return M
```

Two consequences are worth knowing up front:

- **Only the top-level `return` counts.** A `return` inside an `if` is not the module's return value, so it is ignored.
- **The value has to resolve to a table.** When it cannot (a call into another module, or a value assembled behind a condition that cannot be resolved), nothing on that module is discovered, and you get the [`surface-opaque`](/guide/reference/diagnostics#info) diagnostic saying so.

## Private members

A leading underscore marks a member as private, and private members are left out of the site. Two kinds of member stay public whatever their name: an `export type`, because the `export` already declares intent, and a `__`-named function, which reads as a documented metamethod.

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
- Badges from behavior: a body that waits gets <Badge type="warning" text="Yields" /> (helpers it calls included, whichever module they live in), remote calls and realm-only services get <Badge type="info" text="Server" /> or <Badge type="info" text="Client" />, a property mounted behind `RunService:IsServer()` gets the realm it mounts in, and a frozen table's props render <Badge type="info" text="Read Only" />
- Property types read off the value where nothing declares one (see [below](#property-types-come-from-the-value))
- Parameter docs from trailing comments in a multi-line signature

If something here does not resolve, LuauDocs says so rather than dropping it quietly. See [`require-unresolved`](/guide/reference/diagnostics#warnings).

## Access paths, not folders

Once the surface is known, every module has an **access path**: the expression a consumer writes to reach it.

Your folders play no part in this. If callers write `Flux.Util.Queue`, then Queue's access path is `Flux.Util.Queue`, whether its source file lives at `src/Queue.luau`, `src/util/queue/init.luau`, or inside a vendored submodule. A module reachable by more than one path is filed on its shortest one.

This site's [example library](/api/) is arranged that way on purpose, and the index it generates is the access tree itself:

<Frame label="Generated reference" link="/api/">

<!--@include: @/api/index.md#reference-->

</Frame>

`Queue` is nested under `Util` there because `Flux.Util.Queue` is how you reach it, and for no other reason. On disk it is `examples/Flux/Util/Queue.luau`, but moving that file would not move the page.

## The API sidebar

The sidebar is that access tree, rendered. Its shape is fixed: an **Overview** link to the `/api/` index, then a section per entry module, headed by the module itself and holding everything it exposes. A module that exposes other modules becomes a group inside that section, and both the section title and the group heading link to their own page. Anything no entry reaches is listed under **Reference** at the end.

So the example's `Flux.Util.Queue` puts [`Queue`](/api/Queue) under a **Util** group inside the **Flux** section, and clicking **Util** takes you to the [Util](/api/Util) page.

The same tree also heads each page. Above its title, every page carries a line of links to what sits above it, so arriving from search or a deep link tells you where you are without opening the sidebar. The [Queue](/api/Queue) page reads `Home › Overview › Flux › Util`; a guide page reads `Home` and the folders it sits in. Only the landing page has nothing above it.

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

**Internals fall back to the instance tree.** A module that your public value never exposes, but that still carries doc comments, has no access path to be filed under, so LuauDocs files it by structure instead: the Rojo tree when the project has a `default.project.json` (name a different file with [`[source] projectFile`](/guide/configuration)), and the folder layout otherwise. Mounts, nested project files, and renamed instances are all followed, so a vendored `submodules/Flux/src/Async.luau` mounted at `MyLib.Flux` files under the Flux page. An internal module still gets its page and its sidebar entry; only where it files changes.

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

Every mention of a type in a signature links to that entry, so a reader who hits `State.State<T>` in a return position is one click from knowing what it holds. Roblox types (`CFrame`, `Instance`, enums) link to the creator docs, which you can turn off with [`[api] linkRobloxTypes`](/guide/configuration).

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

**A conditional mount is read as one.** A guarded property says two things at once, and both land on the entry:

```luau
Store.folder = RunService:IsServer() and script:WaitForChild("Storage")
-- the entry reads: folder [Server], Store.folder: Instance?
```

The guard says where the value exists, so the property is badged <Badge type="info" text="Server" class="luaudocs-server" /> with no `@server` tag; the guarded half says what it is, so the type is that, optional. A value guarded by an already-guarded one (`Server and Server:WaitForChild("Tools")`) carries the same realm.

A guard over a plain boolean is a predicate rather than a mount, so `IS_PRIVATE = RunService:IsServer() and game.PrivateServerId ~= ""` stays a `boolean` and is not badged: a client can read it perfectly well and find it false.

**An alias links to what it aliases.** One table under two names (`Z.boolean = Z.bool`) gets one section, under whichever name came first; the other is typed as a link to it, so a reader who arrives at the alias is one click from the members. Across modules this is a re-export instead, badged <Badge type="info" text="from State" />, because there is a module hop worth naming.

Where a value settles nothing, the entry stays untyped rather than guessing. `a + b` could be a number or a Vector3, and `script.Name` is a string where `script.Container` is an Instance, so neither infers. Declare the type yourself and it is used as written: an annotation or a `:: cast` always wins, and so does a floating `@prop name Type`, which is how you name the shape of a table that starts out empty.

## Where to go from here

Now that the site contains the right things, [Writing Doc Comments](/guide/writing-doc-comments) covers the prose you add on top, and [Overriding with Tags](/guide/overriding-with-tags) covers the cases where you want something other than what your code says.

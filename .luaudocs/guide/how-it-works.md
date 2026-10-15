---
title: How It Works
description: How LuauDocs finds your public surface, and why your site is shaped the way it is.
sidebar_position: 2
---

# How It Works

Instead of asking you to tag what is public, LuauDocs discovers your public surface from your code. That rule determines which pages exist, how they are named, and how the sidebar is organized.

## Your module's return value

LuauDocs never executes your code. It parses the AST and evaluates top-level statements symbolically, following assignments, requires, type casts, and metatables to determine what your module's `return` statement produces. Whatever that returned value can reach is your public surface:

```luau
local M = {}

function M.visible() end -- documented: reachable from the returned table
local function helper() end -- not documented: nothing exposes it

return M
```

Two rules apply to `return`:

- **Only top-level `return` statements count.** A `return` inside an `if` block is ignored as a module return value.
- **The return value must resolve to a table (or a passthrough `require`).** When it cannot (such as a call into another module or an unresolvable conditional), LuauDocs emits the [`surface-opaque`](/guide/reference/diagnostics#info) diagnostic.

## Private members

A leading underscore marks a member as private and omits it from the site. Two exceptions stay public regardless of name: `export type` declarations and double-underscore metamethod functions (`__name`) that carry a doc comment (undocumented `__` functions are omitted).

Override this per member with [`@private` or `@ignore`](/guide/overriding-with-tags#hiding-things), or include private members site-wide with [`[api] includePrivate`](/guide/configuration).

## What the extractor understands

Without any tags, the extractor discovers:

- Table-literal members, including doc comments on individual fields
- `function M.f`, `function M:method`, `M.x = value`, and explicit-`self` methods `function M.f(self: M, ...)` (rendered as `M:f(...)`)
- `__index` class idioms, `setmetatable(M, { __index = Proto })` delegation, and `table.freeze` wrappers, including classes kept on unreturned local tables when attached by a constructor (`setmetatable(_, Impl)`) or a metatable type (`typeof(setmetatable(_, Impl))` or `setmetatable<_, typeof(Impl)>`; bare `setmetatable<D, M>` is not recognized as a class type)
- Cast types (`:: T`) and container type annotations (unannotated or `:: any` properties inherit their field type and doc comment from the owning table's type annotation, and `Key: typeof(require(...))` fields synthesize module mounts)
- Re-exported requires, lazy loader functions (`function M.sub() return require(...) end`), and member imports (`isState = State.isState`)
- Conditional mounts (`if IsClient then M.UI = require(...) end` and `RunService:IsServer() and require(...)`)
- String requires (`./x` and `@self/x`, falling back to the Rojo tree when no sibling file matches on disk; `@alias/x` via `.luaurc`), and runtime aliases (`@lute/fs`, `@lune/net`) configured under [`[source.aliases]`](/guide/configuration)
- Roblox instance requires (`script.Parent.X`, `:WaitForChild("X")`), including Rojo `*.project.json` mounts and nested project files
- Behavioral badges inferred from code: yielding functions, realm-restricted calls (server, client, or plugin), realm-guarded properties, and `table.freeze`d or `read`-typed properties; see [Adding badges](/guide/overriding-with-tags#adding-badges)
- Property types inferred from assigned values when unannotated (see [below](#property-types-come-from-the-value))
- Parameter descriptions from trailing comments in multi-line signatures

Unresolved requires emit [`require-unresolved`](/guide/reference/diagnostics#warnings) rather than failing silently.

## Access paths, not folders

Every surfaced module gets an **access path**: the expression a caller writes to reach it (`Flux.Util.Queue`), regardless of where the file sits on disk. A module reachable by multiple paths uses the shortest one.

This site's [example library](/api/) renders its access tree directly on the API index:

<Frame label="Generated reference" link="/api/">

<!--@include: @/api/index.md#reference-->

</Frame>

`Queue` sits under `Util` because callers reach it as `Flux.Util.Queue`, not because its file is `examples/Flux/Util/Queue.luau`.

## The API sidebar

The sidebar mirrors the access tree: an **Overview** link to `/api/`, a section per entry module that exposes submodules (with nested groups for submodules that expose further modules, all linking to their pages), and a **Reference** section at the end for standalone modules. A single-module library shows **Overview** followed by **Reference**.

Thus `Flux.Util.Queue` places [`Queue`](/api/Queue) inside the **Util** group under **Flux**, where clicking **Util** opens the [Util](/api/Util) page. Breadcrumbs at the top of each page trace the same hierarchy (`Home › Overview › Flux › Util` on [Queue](/api/Queue)).

::: info The API sidebar takes no configuration
There are no settings to reorder, pin, or rename API sidebar groups. The sidebar reflects what your code exposes.
:::

## Re-exports and internals

**Re-exports render inline** on the exposing page. A mounted module renders as a property linking to its page and badged <Badge type="info" text="Module" />. A member import (`isState = State.isState`) renders a full entry under the exposed name, badged <Badge type="info" text="from State" /> and linked to its definition.

In `Util/init.luau`, `Util.Queue = Queue` produces:

<Frame label="Generated reference" link="/api/Util">

<!--@include: @/api/Util.md#properties-->

</Frame>

And on the root module, [`Flux.isState`](/api/Flux#isstate) carries its <Badge type="info" text="from State" /> badge.

**Internals fall back to the instance tree.** A module with doc comments that is never exposed on the public surface has no access path, so LuauDocs files it by project structure: the Rojo tree when `default.project.json` (or [`[source] projectFile`](/guide/configuration)) is present, or the folder layout otherwise, following mounts and nested project files.

## Types get their own entries

Every `export type` (and any local type referenced by a documented signature) gets a dedicated entry, with field descriptions taken from doc comments or trailing `--` comments. Re-exported type aliases (`export type T = Other.T`) expand the origin type's definition and fields automatically.

```luau [examples/Flux/Util/Queue.luau]
--[[ A first-in, first-out queue. ]]
export type Queue<T> = typeof(setmetatable(
	{} :: {
		items: { T }, -- everything still waiting, front first
	},
	Queue
))
```

<Frame label="Generated reference" link="/api/Queue#queue-1">

<!--@include: @/api/Queue.md#types-->

</Frame>

Type references in signatures link to their declaration, Roblox types (`CFrame`, `Instance`, enums) link to Creator Documentation (controlled by [`[api] linkRobloxTypes`](/guide/configuration)), and types reached through a [runtime alias](/guide/configuration) (`fs.File`) link to the runtime's documentation or remote doc model.

## Property types come from the value

When a property has no explicit annotation, LuauDocs infers its type from unambiguous right-hand expressions:

```luau
Settings.IsClient = RunService:IsClient() -- boolean
Settings.accent = Color3.fromRGB(0, 122, 204) -- Color3
Settings.sortOrder = Enum.SortOrder.LayoutOrder -- Enum.SortOrder
Settings.container = script:WaitForChild("Container") -- Instance
Settings.changed = Signal.new() -- Signal, from what Signal.new returns
Settings.tags = { "ui", "theme" } -- { string }
```

Cross-module calls (`Signal.new()`) inherit the callee's annotated return type and link to its declaration.

**Conditional mounts are recognized automatically.** A realm-guarded non-boolean expression attaches both a realm badge and an optional type:

```luau
Store.folder = RunService:IsServer() and script:WaitForChild("Storage")
-- the entry reads: folder [Server], Store.folder: Instance?
```

The guard adds <Badge type="info" text="Server" class="luaudocs-server" /> (including when guarded through a local variable that is itself realm-guarded) and marks the inferred type optional (`Instance?`). Boolean predicates (`IS_PRIVATE = RunService:IsServer() and game.PrivateServerId ~= ""`) keep their `boolean` type without a realm badge.

**Same-module table aliases link to their target.** Exposing one table under two names in the same module (`Z.boolean = Z.bool`) documents the container under the first name and renders the second as a property linked to the first.

Ambiguous expressions (`a + b`, `script.Name`) remain untyped unless you annotate the variable, add a `:: cast`, annotate the owning table type, or write a `@prop name Type` tag.

## Where to go from here

See [Writing Doc Comments](/guide/writing-doc-comments) for adding prose and cross-references, and [Overriding with Tags](/guide/overriding-with-tags) for overriding inferred behavior.

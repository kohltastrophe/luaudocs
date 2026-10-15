---
title: Overriding with Tags
description: Tags correct what inference got wrong. The handful you will actually reach for.
sidebar_position: 4
---

# Overriding with Tags

Tags in LuauDocs are overrides, never requirements: reach for one only when your code cannot express what you want documented. The common tags are covered below; [Reference: Tags](/guide/reference/tags) lists all 24 Moonwave-compatible tags.

Tags sit inside a doc comment, with prose allowed before or after them.

## Describing parameters and returns

Since function signatures already carry parameter and return types, `@param`, `@return`, and `@error` exist to describe values:

```luau
--[[
Sends a request and waits for the response.

@param url -- where to send it
@param retries -- attempts after the first; defaults to 3
@return -- the decoded body
@error Timeout -- raised when the server does not answer in time
]]
function Http.get(url: string, retries: number?): Body
```

Supplying a type in `@param url string -- ...` or `@return Body -- ...` overrides the annotated type in the rendered signature. `@return` tags match return values in order, and mismatched `@param` names or excess `@return` tags [emit a warning](/guide/reference/diagnostics#warnings).

In multi-line signatures, trailing `--` comments document parameters directly without `@param`:

```luau
function Http.get(
	url: string, -- where to send it
	retries: number? -- attempts after the first; defaults to 3
): Body
```

An `@param` for the same parameter overrides its trailing comment field by field (so a type-only `@param retries number` replaces the type while keeping the trailing description).

## Moving a member somewhere else

Use `@within` to file a member or type under a different class or module:

```luau
--[[
Formats a duration for display.

@within Timer
]]
local function formatDuration(seconds: number): string
```

Use `@class Name` to declare a class that static analysis cannot discover, and `@prop`, `@function`, `@method`, `@type`, or `@interface` to declare individual items; see [Reference: Tags](/guide/reference/tags#placement). A doc block may carry at most one placement tag (duplicates warn and are ignored), while `@within` combines freely with any placement tag.

## Hiding things

```luau
--[[ @ignore ]]
function M.experimentalThing() end
```

- **`@ignore`** omits the item from the docs unconditionally.
- **`@private`** marks the item private (hidden by default, or rendered with a badge when `[api] includePrivate = true`), overriding the [leading-underscore convention](/guide/how-it-works#private-members).

## Adding badges

LuauDocs infers common behavioral badges directly from code:

- <Badge type="warning" text="Yields" /> when a function calls `task.wait`, `signal:Wait()`, a yielding engine method, or another yielding function across modules.
- <Badge type="info" text="Server" class="luaudocs-server" />, <Badge type="info" text="Client" class="luaudocs-client" />, or <Badge type="info" text="Plugin" class="luaudocs-plugin" /> when code uses realm-specific remotes, services, Studio APIs, the `plugin` global, or a realm guard (`RunService:IsServer() and ...`).
- <Badge type="info" text="Read Only" /> when a property's table is passed to `table.freeze` or its field is marked `read` in the table's own type (use `@readonly` when `read` lives on an imported type).

In `examples/Flux/Util/Queue.luau`, `push` uses `@since` while `pop` gets its Yields badge automatically from `task.wait()`:

```luau [examples/Flux/Util/Queue.luau]
--[[
Adds `item` to the back of the queue.

@since 1.1.0
]]
function Queue:push(item: any)
	table.insert(self.items, item)
end

--[[ Removes the front item and returns it, waiting when the queue is empty. ]]
function Queue:pop(): any
	while #self.items == 0 do
		task.wait()
	end
	return table.remove(self.items, 1)
end
```

<Frame label="Generated reference" link="/api/Queue#methods">

<!--@include: @/api/Queue.md#methods-->

</Frame>

Use `@yields`, `@server`, `@client`, or `@plugin` when behavior cannot be detected statically (explicit realm tags replace detected realms). `@unreleased` and `@since` track versions, and `@tag name` adds a custom badge. Badges always render in a fixed order.

`@deprecated` adds both a heading badge and a warning callout, as on `State:Destroy` (`@deprecated 2.0 -- states are collected once nothing references them`):

<Frame label="Generated reference" link="/api/State#destroy">

<!--@include: @/api/State.md#destroy-->

</Frame>

## The rest

See [Reference: Tags](/guide/reference/tags) for the complete tag table (including `@external` and `@field`) and multi-line tag description rules.

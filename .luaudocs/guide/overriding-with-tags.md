---
title: Overriding with Tags
description: Tags correct what inference got wrong. The handful you will actually reach for.
sidebar_position: 4
---

# Overriding with Tags

Every tag in LuauDocs is a correction, never a requirement: you reach for one when the code says something other than what you mean, or when inference genuinely cannot see what you want documented. A library with no tags at all still gets a complete site. The handful below cover nearly every real case; [Reference: Tags](/guide/reference/tags) has the complete vocabulary: 24 tags, exactly Moonwave's set.

Tags go inside a doc comment, and prose can sit before or after them.

## Describing parameters and returns

The signature already carries the types, so these tags exist to describe the values, not to declare them:

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

You can write a type after the name (`@param url string -- ...`), and it replaces the annotation in the rendered signature when you do, but usually the annotation already says it. `@return` tags apply in order. If you misspell a parameter name or write more `@return` tags than the function returns values, LuauDocs [says so](/guide/reference/diagnostics#warnings) rather than rendering a lie.

In a multi-line signature, no tag is needed at all: a trailing comment on a parameter's line documents that parameter, the same way it documents a property or a type field.

```luau
function Http.get(
	url: string, -- where to send it
	retries: number? -- attempts after the first; defaults to 3
): Body
```

An `@param` naming the same parameter outranks its trailing comment.

## Moving a member somewhere else

Sometimes a member is defined in one place and belongs, from a reader's point of view, in another. `@within` files it under a different class wherever it is defined:

```luau
--[[
Formats a duration for display.

@within Timer
]]
local function formatDuration(seconds: number): string
```

`@class Name` documents a block as a class, which you need when the class is assembled in a way inference cannot follow. The other placement tags do the same for a single member or type; [Reference: Tags](/guide/reference/tags#placement) tables them.

Only one of these placement tags belongs in a block. A second one is a conflict: the first wins and the later one is dropped and reported. `@within` is a data tag rather than a placement tag, so it combines freely with any of them.

## Hiding things

```luau
--[[ @ignore ]]
function M.experimentalThing() end
```

- **`@ignore`** drops the item from the docs entirely, always.
- **`@private`** marks it private, which hides it by default but renders it (badged) when you set `[api] includePrivate = true`.

An explicit tag beats the [leading-underscore convention](/guide/how-it-works#private-members), so `@private` hides a member whose name has no underscore, and the convention decides only for members you never tagged.

## Adding badges

Badges annotate a member without changing what it is, and the common ones need no tag, because LuauDocs reads the body. A function that waits (`task.wait`, `signal:Wait()`, a yielding engine method, or a call to something that does, in this module or one it requires) is badged <Badge type="warning" text="Yields" />. Code only one realm can run (firing a remote, a realm-only service, the `plugin` global, a Studio-only member) is badged <Badge type="info" text="Server" class="luaudocs-server" />, <Badge type="info" text="Client" class="luaudocs-client" />, or <Badge type="info" text="Plugin" class="luaudocs-plugin" />. A property renders <Badge type="info" text="Read Only" /> when its table is `table.freeze`d or its field is marked `read` in the table's own type; a `read` field in a type imported from another module is not detected, so `@readonly` still applies there.

The example library's `Queue` shows both halves: `push` is tagged `@since`, while `pop` carries no tag at all, its badge detected from the `task.wait()` in its body:

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

The same names remain as tags for what code cannot show: `@yields` when the waiting hides behind a function passed as a value, and `@server`, `@client`, or `@plugin` when the boundary is a convention rather than a call. A realm tag replaces the detected realm entirely, so the tag wins when they disagree. `@unreleased` and `@since` place a member in time, and `@tag name` badges anything else you want to call out. Badges render in a fixed order no matter which order you wrote them in.

`@deprecated` is the one that does more than badge. Writing `@deprecated 2.0 -- states are collected once nothing references them` on the example's `State:Destroy` badged the heading and added a callout under it:

<Frame label="Generated reference" link="/api/State#destroy">

<!--@include: @/api/State.md#destroy-->

</Frame>

## The rest

The full vocabulary is in [Reference: Tags](/guide/reference/tags), including `@external` for pointing an unresolvable type name at another project's docs, and `@field` for the members of an `@interface`.

Two things are true of every tag: `--` separates its description from its arguments (a single `-` works too), and an unknown `@word` is left in your prose untouched, so credits and email addresses survive.

---
title: Tags
description: The complete tag vocabulary. Every tag is an override; none is required.
sidebar_position: 2
---

# Tags

Every tag corrects or extends what the extractor already inferred, and none of them is ever required. [Overriding with Tags](/guide/overriding-with-tags) covers the ones that come up in practice; the three tables below are the complete vocabulary, grouped by shape: flags take no argument, placement tags declare what a block documents, and data tags carry values and descriptions.

Prose can sit before or after the tags, and a single `-` works in place of `--`. A tag that takes its own `-- desc` (`@param`, `@return`, `@error`, `@field`, `@prop`, `@type`, `@deprecated`) keeps collecting its description from the lines below it; after any other tag, trailing prose rejoins the main description.

## Flags

These take no argument. Most add a badge; two change whether the item is documented at all.

| Tag           | Effect                                                                        |
| :------------ | :------------------------------------------------------------------------------ |
| `@yields`     | <Badge type="warning" text="Yields" /> the function may yield the calling thread. |
| `@unreleased` | <Badge type="warning" text="Unreleased" />                                    |
| `@server`     | <Badge type="info" text="Server" class="luaudocs-server" />                   |
| `@client`     | <Badge type="info" text="Client" class="luaudocs-client" />                   |
| `@plugin`     | <Badge type="info" text="Plugin" class="luaudocs-plugin" />                   |
| `@readonly`   | <Badge type="info" text="Read Only" /> on a property.                         |
| `@private`    | <Badge type="danger" text="Private" /> even without a `_` prefix.             |
| `@ignore`     | Drops the item from the docs entirely.                                        |

`@server`, `@client`, and `@plugin` combine and render in that order. The Yields and realm badges are also [detected from what a body does](/guide/overriding-with-tags#adding-badges), and a prop renders Read Only when its table is `table.freeze`d or its field is marked `read` in the table's own type (not one imported from another module), so these flags are only needed when the signal is not in the code ([live](/api/Queue#pop): a Yields badge with no tag behind it). A realm tag replaces the detected realm, so the tag wins when they disagree.

The last two rows differ: `@private` keeps the member and renders it when `[api] includePrivate = true`, while `@ignore` drops it either way. Without either tag, a leading `_` means private, except on an `export type` or a `__`-named function (a documented metamethod).

## Placement

These declare what a block documents when inference cannot reach it, or when you want a member filed under a different class.

| Tag                       | Effect                                                                     |
| :------------------------ | :------------------------------------------------------------------------- |
| `@class Name`             | Documents the block as a class named `Name`.                               |
| `@prop Name Type -- desc` | Documents a property. `@prop Class.name` also files it under `Class`.      |
| `@type Name Type -- desc` | Documents a type declaration.                                              |
| `@function Name`          | Documents a function. `@function Class.name` files it under `Class`.       |
| `@method Name`            | Documents a method. `@method Class:name` is the colon spelling of the same. |
| `@interface Name`         | Documents a shape, with its members written as `.field Type -- desc` lines, blank lines between groups included. |

::: warning
A second placement tag in one block is a conflict: the first wins, the later one is reported and dropped.
:::

## Data

| Tag                        | Effect                                                                       |
| :------------------------- | :--------------------------------------------------------------------------- |
| `@param name Type -- desc` | Documents one parameter. The type is optional; the signature already has it. |
| `@return Type -- desc`     | Documents one return value, in order.                                        |
| `@error Type -- desc`      | Documents an error the function can raise.                                   |
| `@field name Type -- desc` | Documents one field of an `@interface` or of a type declaration.             |
| `@within Class`            | Files the item under `Class`, wherever it is defined.                        |
| `@deprecated v2 -- use X`  | <Badge type="danger" text="Deprecated since v2" /> plus a warning callout ([live](/api/State#destroy)). Both parts are optional. |
| `@since 1.2.0`             | <Badge type="tip" text="since 1.2.0" /> ([live](/api/Queue#push))            |
| `@tag name`                | <Badge type="info" text="name" /> a badge carrying the tag's name.           |
| `@external Name URL`       | Points an unresolvable type name at its own docs site.                       |

A `-- desc` continues onto the lines directly below it, and a blank line ends it: the next paragraph belongs to the item's own description. A single `-` works in place of `--`.

`@param` is also unnecessary in a [multi-line signature](/guide/overriding-with-tags#describing-parameters-and-returns), where a trailing `-- comment` on a parameter's line documents it; the tag outranks the trailer when both exist.

`@external` is the one tag that affects the whole site rather than the item it sits on: declared once, in any module, that name links wherever it appears in a signature or a `[bracket]` reference.

## Type names written in tags

A type you name in a tag (`@prop x Widget`, `@return Widget`, a `.field Widget` line) links to what it names in the module where you wrote the tag: a type that module declares, or a class or module it requires. Requiring is all it takes, and a require is a require however you wrote it, so a module reached only by a table field links the same as one bound to a local:

```luau
local _K = {
	Flux = require(script.Flux), -- no local binding, and `.Flux Flux` still links
}
```

A name the module never reaches stays unlinked rather than being matched against an unrelated module that happens to spell it the same way. Point one somewhere anyway with `@external`, or qualify it through a require-local (`Util.Logger`).

## Tags that do nothing

`@__index` is accepted and ignored, since implementation tables are [discovered automatically](/guide/how-it-works#what-the-extractor-understands). It exists for Moonwave compatibility.

Unknown `@words` (credits, email addresses) stay in your prose untouched.

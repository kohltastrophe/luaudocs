---
title: Tags
description: The complete tag vocabulary. Every tag is an override; none is required.
sidebar_position: 2
---

# Tags

Every tag overrides or extends what the extractor inferred; none is required. [Overriding with Tags](/guide/overriding-with-tags) covers common use cases, while the tables below catalog all 24 Moonwave tags grouped into flags, placement tags, and data tags.

Prose can sit before or after tags. A tag description after `--` (or `-`) continues across adjacent non-blank lines; after a blank line (or a tag that takes no description), subsequent lines return to the item's main description.

## Flags

Flags take no arguments:

| Tag           | Effect                                                                          |
| :------------ | :------------------------------------------------------------------------------ |
| `@yields`     | <Badge type="warning" text="Yields" /> function may yield the calling thread.   |
| `@unreleased` | <Badge type="warning" text="Unreleased" />                                      |
| `@server`     | <Badge type="info" text="Server" class="luaudocs-server" />                     |
| `@client`     | <Badge type="info" text="Client" class="luaudocs-client" />                     |
| `@plugin`     | <Badge type="info" text="Plugin" class="luaudocs-plugin" />                     |
| `@readonly`   | <Badge type="info" text="Read Only" /> on a property.                           |
| `@private`    | <Badge type="danger" text="Private" /> even without a `_` prefix.               |
| `@ignore`     | Omits the item from the docs unconditionally.                                   |

`@server`, `@client`, and `@plugin` can be combined and render in that order. Because Yields, realm, and Read Only badges are [inferred from code](/guide/overriding-with-tags#adding-badges) (see [`Queue:pop`](/api/Queue#pop)), these flags are only needed when the signal is not visible in source (or when `read` is declared on an imported type). Explicit realm tags replace detected realms.

`@private` hides an item unless `[api] includePrivate = true`, whereas `@ignore` always drops it. Untagging an item falls back to the leading-`_` convention (`export type` and documented `__` metamethods stay public).

## Placement

Placement tags declare what a block documents when static analysis cannot discover it:

| Tag                       | Effect                                                                     |
| :------------------------ | :------------------------------------------------------------------------- |
| `@class Name`             | Documents the block as a class named `Name`.                               |
| `@prop Name Type -- desc` | Documents a property (`@prop Class.name` files it under `Class`).          |
| `@type Name Type -- desc` | Documents a type declaration.                                              |
| `@function Name`          | Documents a function (`@function Class.name` files it under `Class`).      |
| `@method Name`            | Documents a method (`@method Class:name` files it under `Class`).          |
| `@interface Name`         | Documents a table shape whose fields are written as `.field Type -- desc`. |

::: warning
A doc block may contain at most one placement tag; any additional placement tag warns and is ignored.
:::

## Data

| Tag                        | Effect                                                                       |
| :------------------------- | :--------------------------------------------------------------------------- |
| `@param name Type -- desc` | Documents a parameter (`Type` is optional and overrides the annotation).     |
| `@return Type -- desc`     | Documents a return value, matched in order.                                  |
| `@error Type -- desc`      | Documents an error the function can raise.                                   |
| `@field name Type -- desc` | Documents a field of an `@interface` or type declaration.                    |
| `@within Class`            | Files the item under `Class`.                                                |
| `@deprecated v2 -- use X`  | <Badge type="danger" text="Deprecated since v2" /> plus a warning callout ([live](/api/State#destroy)). |
| `@since 1.2.0`             | <Badge type="tip" text="since 1.2.0" /> ([live](/api/Queue#push))            |
| `@tag name`                | <Badge type="info" text="name" /> custom badge.                              |
| `@external Name URL`       | Maps an external type name to its documentation URL site-wide.               |

In [multi-line signatures](/guide/overriding-with-tags#describing-parameters-and-returns), trailing `--` comments document parameters without `@param` (when both exist, `@param` overrides field by field). `@external` applies across the entire site wherever `Name` appears in a signature or `[Name]` reference.

## Type names written in tags

Type names inside tags (`@prop x Widget`, `@return Widget`, `.field Widget`) resolve within the containing module's scope: types declared in that module, or classes and modules it requires (whether bound to a local or assigned to a table field):

```luau
local _K = {
	Flux = require(script.Flux), -- no local binding, and `.Flux Flux` still links
}
```

Names that the module neither declares nor requires stay unlinked unless declared with `@external` or qualified through a required module (`Util.Logger`).

## Tags that do nothing

`@__index` is accepted and ignored for Moonwave compatibility, since implementation tables are [discovered automatically](/guide/how-it-works#what-the-extractor-understands). Unknown `@words` (such as handles or email addresses) remain in prose untouched.

---
title: Markup
description: Admonitions, tabs, badges, and inline highlighting, in doc comments and guide pages alike.
sidebar_position: 3
---

# Markup

Everything on this page works identically in doc comments and hand-written guide pages.

## Admonitions

Use `:::` containers with an optional title after the kind:

```markdown
::: tip Worth knowing
The title is optional; without one the container is labeled with its kind.
:::
```

renders as:

::: tip Worth knowing
The title is optional; without one the container is labeled with its kind.
:::

Supported kinds are `info`, `tip`, `warning`, `danger`, and `details` (a collapsible block). Docusaurus spellings (`:::note`, `:::caution`, and `:::tip[Title]`) are converted automatically.

## Tabs

`<Tabs>` and `<TabItem>` convert into VitePress tab strips. Tab titles come from `label` (or `value`), the first tab is active unless another tab sets `default`, and tabs can hold both prose and code (known filenames or tool names such as `npm` or `wally.toml` show their icon):

````mdx
<Tabs>
<TabItem label="Wally">

Add it to your `wally.toml`:

```toml
widget = "user/widget@1.0.0"
```

</TabItem>
<TabItem label="Manual">

Copy the files into your project.

</TabItem>
</Tabs>
````

renders as:

<Tabs>
<TabItem label="Wally">

Add it to your `wally.toml`:

```toml
widget = "user/widget@1.0.0"
```

</TabItem>
<TabItem label="Manual">

Copy the files into your project.

</TabItem>
</Tabs>

When every tab is a single code block, VitePress's `::: code-group` is more concise; see [Getting Started](/guide/getting-started#install).

## Frames

`<Frame>` draws a labeled border around embedded output (such as a slice of a generated `/api/` page):

```mdx
<Frame label="Generated reference" link="/api/Queue#new">

Anything markdown, including an include pulling in one of your own API pages.

</Frame>
```

renders as:

<Frame label="Generated reference" link="/api/Queue#new">

<!--@include: @/api/Queue.md#new-->

</Frame>

| Attribute | Effect                                                                              |
| :-------- | :---------------------------------------------------------------------------------- |
| `label`   | Caption on the top border (omitted when unset).                                     |
| `link`    | Turns `label` into a link with a trailing arrow (requires `label`).                 |

Place `<Frame>` and `</Frame>` on their own lines; frames do not nest. Headings inside a frame are excluded from the "On this page" outline and do not get permalinks of their own.

### Embedding a generated page

The frame above uses a VitePress [file inclusion](https://vitepress.dev/guide/markdown#markdown-file-inclusion) (`@/api/Queue.md#new`) to embed a single region from a generated API page.

Every generated page defines regions for each member (`#new`), each section (`#properties`, `#types`), and the full module (`#queue`), while `/api/index.md` defines `#reference` for the access tree ([How It Works](/guide/how-it-works#access-paths-not-folders)). Missing region names fail the build so stale includes never render empty frames.

## Badges

`<Badge>` is VitePress's built-in badge component (`type` is `info`, `tip`, `warning`, or `danger`, and `text` sets the label). Pass `class="luaudocs-server"`, `luaudocs-client`, or `luaudocs-plugin` for realm colors:

```markdown
Reads the live registry <Badge type="info" text="Server" class="luaudocs-server" />, and is still <Badge type="warning" text="Unreleased" />.
```

renders as:

Reads the live registry <Badge type="info" text="Server" class="luaudocs-server" />, and is still <Badge type="warning" text="Unreleased" />.

In doc comments, prefer [badge tags](/guide/reference/tags#flags) (`@since`, `@unreleased`, `@tag`) to badge the member heading in a fixed order; use `<Badge>` for inline prose or guide pages. On headings, always use the self-closing form (`### Connect <Badge text="new" />`) so the badge text is excluded from the heading's URL slug.

## Code highlighting

Fenced ` ```luau ` blocks and unlabeled code fences highlight as Luau automatically. For inline code spans, append `{luau}` (or `{lua}`):

```markdown
Call `Flux.state(0)`{luau} to create a signal.
```

Renders as: Call `Flux.state(0)`{luau} to create a signal. Any other `{...}` suffix is passed through to VitePress's standard attribute syntax (`{#id}`, `{.class}`).

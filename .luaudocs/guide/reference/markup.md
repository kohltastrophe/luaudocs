---
title: Markup
description: Admonitions, tabs, badges, and inline highlighting, in doc comments and guide pages alike.
sidebar_position: 10
---

# Markup

Everything on this page renders the same in a doc comment as in a hand-written guide page.

## Admonitions

A `:::` container. Anything after the kind becomes its title:

```markdown
::: tip Worth knowing
The title is optional; without one the container is labeled with its kind.
:::
```

renders as:

::: tip Worth knowing
The title is optional; without one the container is labeled with its kind.
:::

The kinds are `info`, `tip`, `warning`, `danger`, and `details`, which renders as a collapsed block that opens on click. Docusaurus spellings are rewritten: `:::note` becomes an info container, `:::caution` a warning one, and a bracket title (`:::tip[Title]`) becomes a plain one. An unrecognized kind is left exactly as you typed it.

## Tabs

`<Tabs>` and `<TabItem>` groups convert into the tab strip VitePress's own code groups use. Each tab is labeled from its `label` (or its `value`), and the first tab shows first unless one carries Docusaurus's bare `default` attribute. A tab can hold prose, a list, or a link, not just code, and one named for a tool or a file (`npm`, `wally.toml`) gets that icon.

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

When every tab is a single code block, VitePress's own `::: code-group` says the same thing in less markup: one fence per tab, each titled `[like this]`, as on [Getting Started](/guide/getting-started#install).

## Frames

`<Frame>` draws a labeled border around anything. It exists for the case this site uses it for: pulling an entry out of your own `/api/` pages into a guide, where it needs to read as generated output rather than as more prose.

```mdx
<Frame label="Generated reference" link="/api/Queue#new">

Anything markdown, including an include pulling in one of your own API pages.

</Frame>
```

renders as:

<Frame label="Generated reference" link="/api/Queue#new">

<!--@include: @/api/Queue.md#new-->

</Frame>

| Attribute | Effect                                                                                        |
| :-------- | :-------------------------------------------------------------------------------------------- |
| `label`   | The caption on the top border. Without one the frame renders bare, with no caption.           |
| `link`    | Turns the caption into a link with a trailing arrow. It decorates the label, so it does nothing without one. |

The opening and closing tags each need a line of their own, and frames do not nest.

A frame quotes content from somewhere else, so headings inside one are left out of the page's "On this page" outline and get no permalink of their own: the label's link is how a reader reaches the original. A framed heading's inline markdown is not rendered either, apart from code spans (the form a generated member heading is written in), so keep headings plain in a frame you write yourself.

### Embedding a generated page

The frame above holds a VitePress [file inclusion](https://vitepress.dev/guide/markdown#markdown-file-inclusion) aimed at `@/api/Queue.md#new`: the `#anchor` slices out that one section, heading and all, rather than pulling in the whole page.

Every generated page carries a region per block, so the name can be a member (`#new`), a section (`#properties`, `#types`), or the page itself (`#queue`, which embeds the title, the module's description and all of its members at once). The API index has one of its own, `#reference`, holding the whole access tree, as on [How It Works](/guide/how-it-works#access-paths-not-folders). Regions are stable names rather than line numbers, so an entry keeps embedding correctly as the page around it grows, and a name that stops existing fails the build instead of quietly emptying the frame.

Note that includes are expanded before the page is parsed and a fenced code block does not stop one, so a guide cannot show the syntax in an example.

## Badges

`<Badge>` is VitePress's own component, and what the [badge tags](/guide/reference/tags#flags) render to. `type` is `info`, `tip`, `warning`, or `danger`; `text` is the label. The realms have a color past those four, so a badge naming one takes `class="luaudocs-server"`, `luaudocs-client`, or `luaudocs-plugin` to match the generated pages.

```markdown
Reads the live registry <Badge type="info" text="Server" class="luaudocs-server" />, and is still <Badge type="warning" text="Unreleased" />.
```

renders as:

Reads the live registry <Badge type="info" text="Server" class="luaudocs-server" />, and is still <Badge type="warning" text="Unreleased" />.

Inside a doc comment, prefer the tag that covers what you mean (`@since`, `@unreleased`, or `@tag` for anything else; the Yields and realm badges are usually [detected](/guide/overriding-with-tags#adding-badges) with no tag at all): it badges the member's own heading, in a fixed order whatever order you wrote them in. Reach for `<Badge>` when the badge belongs mid-sentence, or on a guide page.

On a heading, keep the self-closing form: `### Connect <Badge text="new" />` still anchors as `#connect`, while the slot form `<Badge>new</Badge>` folds its text in and anchors as `#connect-new`.

## Code highlighting

Fenced ` ```luau ` blocks highlight out of the box, and an unlabeled fence defaults to Luau.

Inline code takes a Pandoc-style annotation, in guides and doc comments alike:

```markdown
Call `Flux.state(0)`{luau} to create a signal.
```

That line renders as: Call `Flux.state(0)`{luau} to create a signal.

::: tip
Only `{luau}` and `{lua}` are recognized. Any other `{...}` suffix falls through to VitePress's usual attribute syntax (`{#id}`, `{.class}`).
:::

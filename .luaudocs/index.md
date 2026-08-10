---
layout: home

hero:
  name: "LuauDocs"
  text: "Stop writing docs.<br/>Start generating them."
  tagline: "Point it at a Luau library and get a cross-linked API reference: no tags, no config, nothing to install but Node."
  image:
    src: /logo.svg
    alt: LuauDocs
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: How It Works
      link: /guide/how-it-works
    - theme: alt
      text: GitHub
      link: https://github.com/kohltastrophe/luaudocs

features:
  - icon: 🪄
    title: No tags required
    details: LuauDocs works out what your module returns; an untagged library gets a full API reference.
    link: /guide/how-it-works
    linkText: How it works
  - icon: 🔗
    title: Signatures from your code
    details: Every signature comes from the Luau annotations in your code, with each type linked to its own entry.
    link: /guide/how-it-works#types-get-their-own-entries
    linkText: Type pages
  - icon: 🌙
    title: Moonwave-compatible
    details: All 24 Moonwave tags keep working as overrides, and one command migrates your site.
    link: /guide/migrating-from-moonwave
    linkText: From Moonwave
  - icon: 🔌
    title: Built to be built on
    details: Export the whole API as JSON for your own tooling, and every build ships llms.txt for your readers' AI.
    link: /guide/reference/doc-model
    linkText: The doc model
---

## No tags. No config.

```luau [examples/Flux/init.luau]
--[[
Creates a state holding `initial`.

Call the state to read it, and see [State:Connect] for reacting to changes.
]]
function Flux.state<T>(initial: T?): State.State<T>
	return State.new(initial)
end
```

<Frame label="Generated reference" link="/api/Flux#state-1">

<!--@include: @/api/Flux.md#state-1-->

</Frame>

Nothing in that frame is hand-written. The signature came from the Luau annotations, `State.State` links to [the type's own page](/api/State#state-1), and the `[State:Connect]` reference resolved itself into [a link](/api/State#connect). It is the real generated markdown, embedded straight into this page from [`examples/Flux`](https://github.com/kohltastrophe/luaudocs/tree/main/examples/Flux).

[Browse the whole example reference →](/api/) · [Get started →](/guide/getting-started)

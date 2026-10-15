---
layout: home

hero:
  name: "LuauDocs"
  text: "Documentation from your Luau code"
  tagline: "Generate a cross-linked API reference, guides, and llms.txt directly from your Luau source code and types."
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
    details: Traces what your modules return to build a full API reference without doc tags.
    link: /guide/how-it-works
    linkText: How it works
  - icon: 🔗
    title: Signatures from your code
    details: Reads signatures directly from your Luau annotations and links every type to its definition.
    link: /guide/how-it-works#types-get-their-own-entries
    linkText: Type pages
  - icon: 🌙
    title: Moonwave compatible
    details: Supports all 24 Moonwave tags as overrides and migrates your existing site with one command.
    link: /guide/migrating-from-moonwave
    linkText: From Moonwave
  - icon: 🔌
    title: JSON model and llms.txt
    details: Exports your full API as JSON for custom tooling and generates llms.txt for coding agents.
    link: /guide/reference/doc-model
    linkText: The doc model
---

## Source to site

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

The frame above embeds the generated markdown from [`examples/Flux`](https://github.com/kohltastrophe/luaudocs/tree/main/examples/Flux). LuauDocs reads the signature from the Luau annotations, links `State.State` to [its type entry](/api/State#state-1), and resolves `[State:Connect]` to [its method entry](/api/State#connect).

[Browse the example reference](/api/) · [Get started](/guide/getting-started)

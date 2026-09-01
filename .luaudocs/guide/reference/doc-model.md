---
title: Doc Model
description: The JSON LuauDocs extracts from your source, and how to consume it from your own tooling.
sidebar_position: 5
---

# Doc Model

LuauDocs is two halves joined by one JSON document. The extractor reads your Luau and produces a **doc model**: every module, member, type, and signature it found, with cross-references already resolved. The renderer turns that model into a site.

The site is one thing you can do with it. `--model` hands you the same document, so you can do something else:

```bash
luaudocs build --model api.json
```

That builds your site as usual and writes the model as well. When the model is all you are after, `--emit-only` skips the VitePress render:

```bash
luaudocs build --emit-only --model api.json
```

## What is in it

```json
{
  "diagnostics": [ ... ],
  "externals": { "Promise": "https://eryn.io/roblox-lua-promise/api/Promise" },
  "modules": [ ... ],
  "project": { "entryPoints": ["examples/Flux/init.luau"] },
  "schemaVersion": 1
}
```

`externals` maps every name an [`@external`](/guide/reference/tags#data) tag declared to the URL it points at. It is the one thing signatures do not resolve for you (see below), and it is absent entirely when no module declares any.

Each module carries its `id`, `name`, `classes`, `members`, `types`, `reexports`, its `instancePath`, the `source` it came from, and its `doc` when the module has one. A passthrough (`return require(X)`) also carries `aliasOf` naming X, and gets no page of its own. Here is one real function entry, from this site's [example library](/api/Flux#state-1):

```json
{
  "doc": "Creates a state holding `initial`.\n\nCall the state to read it, and see [State:Connect] for reacting to changes.",
  "errors": [],
  "id": "examples/Flux/init.luau#fn.Flux.state",
  "kind": "function",
  "name": "state",
  "signature": {
    "callee": "Flux.state",
    "params": [{ "name": "initial", "type": ["T?"] }],
    "returns": [
      { "type": [{ "id": "examples/Flux/State.luau#type.State", "text": "State.State" }, "<T>"] }
    ],
    "segs": [
      "<T>(initial: T?): ",
      { "id": "examples/Flux/State.luau#type.State", "text": "State.State" },
      "<T>"
    ]
  },
  "source": { "endLine": 20, "file": "examples/Flux/init.luau", "line": 18 },
  "tags": { "custom": [] },
  "visibility": "public"
}
```

`params`, `returns`, and `errors` are always present on a function, empty arrays included, so the pieces of a signature are available separately from the rendered form in `segs`.

Two things there are worth pointing out, because they are the work you do not have to redo:

- **Signatures come apart into segments.** `segs` spells the whole signature after the callee, as a list of strings and references. Concatenate the `text` values for a plain signature, or keep the `id`s and render them as links. Every type mention that resolves to a declaration in your project carries the id of that declaration.
- **Ids are stable and model-wide.** `examples/Flux/State.luau#type.State` names exactly one declaration, so a reference is a lookup rather than a search.

The full field list lives in the header comment of [`extractor/model/init.luau`](https://github.com/kohltastrophe/luaudocs/blob/main/extractor/model/init.luau), which is the copy that gets updated when the shape does.

::: info What the model leaves for you
Prose references (`[State:Connect]` in the `doc` above) are stored as written. Resolving them against ids is the renderer's job, and yours if you want them linked. Type references in signatures are resolved as far as your project goes, as shown: a segment with no `id` is a name your project does not declare, and linking it is a lookup in `externals` and then in the Roblox names.
:::

## The version, and what it promises

`schemaVersion` is `1`. While LuauDocs is on `0.x` the shape changes in place, without a compatibility layer: a minor bump may add, rename, or remove fields, and the version goes up when it does.

So the version is a mismatch detector, not a migration path. Check it, and fail loudly when it is not the one you wrote against:

```js
const model = JSON.parse(await readFile("api.json", "utf8"));
if (model.schemaVersion !== 1) throw new Error(`unsupported doc model v${model.schemaVersion}`);
```

Pin the LuauDocs version alongside anything you build on this, the same way you would pin a compiler you parse the output of.

## Details that will bite you otherwise

- **The model is the one your pages were rendered from**, so [`[source] include` and `exclude`](/guide/configuration) have already been applied. Per-member visibility has not: hiding a private member is the renderer's job, so one carries `"visibility": "private"` and stays in the file whatever [`[api] includePrivate`](/guide/configuration) says. Filter on that field unless you want the internals your site leaves out.
- **It is written whenever extraction finishes**, the builds that fail on their own diagnostics included: errors live in `diagnostics` alongside everything that did extract. Check `diagnostics` for `"severity": "error"` before trusting the module list to be complete. Every code is listed under [Diagnostics](/guide/reference/diagnostics). A failure that stops extraction outright (Lute missing, an unreadable entry point) writes no file at all, so treat the file's absence as its own error.
- **Output is deterministic**: object keys are sorted, and the same source produces the same bytes. It diffs cleanly, so committing one and watching it change is a reasonable way to catch API drift in review.
- **The path is yours.** LuauDocs writes exactly the file you name and never sweeps it, unlike everything under `api/` and `.vitepress/`.

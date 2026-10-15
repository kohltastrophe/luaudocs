---
title: Doc Model
description: The JSON LuauDocs extracts from your source, and how to consume it from your own tooling.
sidebar_position: 5
---

# Doc Model

LuauDocs is built in two stages connected by a JSON **doc model**: the extractor reads your Luau source and emits every module, member, type, resolved signature reference, and diagnostic, and the renderer turns that JSON into a site.

Export the doc model for your own tooling with `--model` (and add `--emit-only` to skip the VitePress build):

```bash
luaudocs build --model api.json
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

`externals` maps external type or module names to either a URL string (from [`@external`](/guide/reference/tags#data)) or `{ url?, alias, path, name? }` (for modules and types reached through a [runtime alias](/guide/configuration)), and is omitted when empty. Runtime module re-exports record the require string as `targetModule` (with optional `url`), and re-exports carry optional `realm` and `within` fields.

Each module contains `id`, `name`, `classes`, `members`, `types`, `reexports`, `instancePath`, `source`, optional `doc`, and optional `aliasOf` (for passthrough `return require(X)` modules, which get no page of their own). Here is the function entry for [`Flux.state`](/api/Flux#state-1):

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

Functions always include `params`, `returns`, and `errors` arrays alongside `segs`:

- **Segmented signatures (`segs`):** lists strings and `{ text, id }` reference objects after `callee`. Join the strings and `text` fields for plain text, or turn `id`s into links.
- **Stable model-wide IDs:** `examples/Flux/State.luau#type.State` uniquely identifies one declaration across the entire model.

The complete schema is documented in [`extractor/model/init.luau`](https://github.com/kohltastrophe/luaudocs/blob/main/extractor/model/init.luau) and [`src/docmodel.ts`](https://github.com/kohltastrophe/luaudocs/blob/main/src/docmodel.ts).

::: info What the model leaves for you
Prose references (`[State:Connect]` in `doc`) remain as written; the renderer resolves them against symbol IDs, `externals`, and Roblox types. Signature segments without an `id` are external or Roblox type names.
:::

## The version, and what it promises

`schemaVersion` is `1` and evolves in place while LuauDocs is on `0.x` (schema updates are noted in `CHANGELOG.md`). Pin the LuauDocs version in tools that consume `docmodel.json` and check `schemaVersion`:

```js
const model = JSON.parse(await readFile("api.json", "utf8"));
if (model.schemaVersion !== 1) throw new Error(`unsupported doc model v${model.schemaVersion}`);
```

## Important implementation details

- **Module filtering is applied; member visibility is not.** [`[source] include` and `exclude`](/guide/configuration) filter the module list, whereas private members remain in the JSON with `"visibility": "private"` regardless of [`[api] includePrivate`](/guide/configuration).
- **Written whenever extraction finishes**, even when diagnostics contain errors: check `diagnostics` for `"severity": "error"` before assuming the model is complete ([Diagnostics](/guide/reference/diagnostics)). Fatal startup failures (such as an unreadable entry point) write no file.
- **Deterministic output:** object keys are sorted alphabetically so committed models diff cleanly.
- **User-owned target path:** LuauDocs writes the exact `--model <file>` path you specify and never deletes it during directory cleanup.

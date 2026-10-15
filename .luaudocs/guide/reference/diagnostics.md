---
title: Diagnostics
description: Every diagnostic code LuauDocs can emit, and what each severity does to your build.
sidebar_position: 4
---

# Diagnostics

Extraction never fails silently. Unresolved or malformed constructs emit structured diagnostics:

```
src/Widget.luau:42: warning[orphaned-within]: @within Panel: no class or module with that name
```

`luaudocs build --emit-only` prints all diagnostics without running VitePress, and `--strict` fails the build on any warning.

Extractor diagnostics carry a file location and code. Renderer and site-sync warnings apply to the site as a whole (without a source file or code) and also count toward `--strict`.

## How severity is treated

::: danger error
Fails the build. Valid module pages are still emitted and existing pages and navigation remain on disk, but stale-page cleanup and VitePress are skipped and the CLI exits nonzero.
:::

::: warning warning
Printed to stderr; exits nonzero only under `--strict`.
:::

::: info info
Printed dimmed; never affects the exit code, even under `--strict`.
:::

## Errors

| Code             | What it means                                                                                                                              |
| :--------------- | :----------------------------------------------------------------------------------------------------------------------------------------- |
| `parse-error`    | A file in the module graph could not be read or parsed (syntax error or deleted file).                                                     |
| `extract-failed` | The symbolic evaluator hit an internal error analyzing a module. Please [report it](https://github.com/kohltastrophe/luaudocs/issues).     |

## Warnings

| Code                     | What it means                                                                                                          |
| :----------------------- | :--------------------------------------------------------------------------------------------------------------------- |
| `require-unresolved`     | A require target could not be resolved (missing file, unknown `.luaurc` alias, path outside the project, or dynamic argument). Runtime aliases (`@lute`, `@lune`, or [`[source.aliases]`](/guide/configuration)) are treated as external instead. |
| `orphaned-within`        | `@within Name` names no known class or module.                                                                         |
| `duplicate-within`       | Two members collide under the same name after `@within` relocation; the second is dropped.                             |
| `duplicate-class`        | Two blocks in one module declare `@class` with the same name; the duplicate is dropped (see also [Info](#info)).       |
| `duplicate-external`     | Two `@external` tags map the same name; the first wins.                                                                |
| `duplicate-type`         | A type name is declared more than once in a module; the exported (or first) declaration is kept.                       |
| `param-mismatch`         | `@param name` does not match any parameter in the function signature.                                                  |
| `return-count-mismatch`  | More `@return` tags than return values in the signature.                                                               |
| `duplicate-member`       | Two definitions resolve to the same member ID in one container; the later definition is dropped.                       |
| `malformed-tag`          | A tag requiring a name or URL was written without one (such as a bare `@param`).                                       |
| `unknown-tag-arg`        | A flag tag (such as `@yields`) was given an unexpected argument.                                                       |
| `duplicate-placing-tag`  | Multiple placement tags in one doc block (`@class` and `@prop`); the first wins.                                       |
| `undocumented`           | A public member, class, or exported type has no doc comment (emitted when [`[api] reportUndocumented`](/guide/configuration) is enabled). |

## Info

| Code                     | What it means                                                                                                          |
| :----------------------- | :--------------------------------------------------------------------------------------------------------------------- |
| `surface-opaque`         | A module's return value could not be evaluated statically; see [Nothing was generated](/guide/reference/troubleshooting#nothing-was-generated). |
| `orphaned-doc-block`     | A doc comment with tags (`@param`, `@within`) sits above no statement. Plain prose comments are ignored.               |
| `unresolved-reexport`    | A re-export targets a symbol its source module does not document.                                                      |
| `require-nonmodule`      | Emitted when a surfaced require resolves to a Folder or non-module path (`script.Parent.Assets`), leaving no module script to follow. |
| `duplicate-class`        | A floating `@class` names a class that already exists; members aimed at that name merge into the existing class.       |
| `ignored-tag`            | `@__index`, accepted for Moonwave compatibility and ignored.                                                           |
| `unreached-types`        | An unexposed module (such as an internal `types.luau`) exports types never referenced by a documented signature. Add the module to `[source] entries`, move types with `@within`, or re-export them (`export type Hook = types.Hook`). |

## Renderer warnings

Prefixed with `renderer:`:

| Message                                            | What it means                                                                                             |
| :------------------------------------------------- | :--------------------------------------------------------------------------------------------------------- |
| `page name collision`                              | Two modules share a page slug; the second gets a numbered slug and a parent-qualified title (`Defaults (Flux)`). |
| `ambiguous reference name dropped from link table` | A `[Ref]` name matches two equal-standing targets (modules outrank same-named types without warning). Qualify the reference (`[Module.State]`) or rename. |
| `aliases.<name>: could not load its doc model`     | A [`[source.aliases]`](/guide/configuration) `model` URL or path could not be loaded; links fall back to module pages. Counts toward `--strict`. |

## Site-sync warnings

Emitted during site file synchronization (all count toward `--strict`):

| Message                                                                                          | What it means                                                                                                        |
| :----------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------- |
| `[docs] changelog is enabled but CHANGELOG.md was not found`                                     | `[docs] changelog = true` is set, but `CHANGELOG.md` is missing.                                                     |
| `[docs] includeReadme is enabled but README.md was not found`                                    | `[docs] includeReadme = true` is set, but `README.md` is missing.                                                    |
| `index.md includes .vitepress/generated/readme.md, which only [docs] includeReadme = true keeps` | Custom `index.md` includes `.vitepress/generated/readme.md` while `includeReadme` is disabled.                       |
| `README.md links …, which the generated site does not serve`                                     | A relative link in `README.md` points outside the docs directory and `[repo] url` is unset or cannot reach it.       |

---
title: Diagnostics
description: Every diagnostic code LuauDocs can emit, and what each severity does to your build.
sidebar_position: 4
---

# Diagnostics

Extraction never fails silently. Anything LuauDocs could not do becomes a diagnostic, printed by whichever command produced it:

```
src/Widget.luau:42: warning[orphaned-within]: @within Panel: no class or module with that name
```

Location, severity, code, message. `luaudocs build --emit-only` prints the whole list without running VitePress, and `--strict` makes it a CI gate.

The codes below come from the extractor and describe your _source_, so each carries a file and a code. Two smaller families come from the renderer and the site sync instead: they are about the site as a whole rather than any one file, so they carry neither file nor code. All three count toward `--strict`.

## How severity is treated

::: danger error
Stops the site. Pages are still emitted and previously generated ones kept, but VitePress is skipped and the exit code is nonzero. Stale-page cleanup is skipped too, so a typo cannot be mistaken for a deletion.
:::

::: warning warning
Printed and otherwise ignored, unless `--strict` promotes it to an error.
:::

::: info info
Printed dimmed, and never affects the exit code, `--strict` included.
:::

## Errors

| Code             | What it means                                                                                                                              |
| :--------------- | :----------------------------------------------------------------------------------------------------------------------------------------- |
| `parse-error`    | A file in the module graph could not be read or parsed. Usually a syntax error, or a file removed while the watcher was running.             |
| `extract-failed` | The symbolic evaluator raised while walking a module. Please [report it](https://github.com/kohltastrophe/luaudocs/issues) with the module.  |

## Warnings

| Code                     | What it means                                                                                                          |
| :----------------------- | :--------------------------------------------------------------------------------------------------------------------- |
| `require-unresolved`     | A require target could not be resolved to a module in the project: a missing file, an unknown `.luaurc` alias, a path outside the project, or a dynamic argument. Check the alias, or the Rojo project file `[source] projectFile` points at. |
| `orphaned-within`        | `@within Name` names no class or module. Usually a rename that missed the tag.                                          |
| `duplicate-within`       | Two members would land on the same name after `@within` moves. The second is dropped.                                   |
| `duplicate-class`        | Two blocks in one module declare `@class` with the same name. The duplicate declaration is dropped. An info variant exists; see [Info](#info). |
| `duplicate-external`     | A name is mapped by two `@external` declarations. The first wins.                                                       |
| `duplicate-type`         | A type name is declared more than once. The exported (or first) declaration is documented; the other is diagnosed at its own line. |
| `param-mismatch`         | `@param name` names no parameter of the annotated signature. Almost always a typo or a stale tag.                       |
| `return-count-mismatch`  | More `@return` tags than the signature returns values.                                                                  |
| `malformed-tag`          | A tag that needs a name or URL did not get one, such as a bare `@param`.                                                |
| `unknown-tag-arg`        | A flag tag such as `@yields` was given an argument, which it does not take.                                             |
| `duplicate-placing-tag`  | Two placement tags in one block (`@class` and `@prop`, say). The first wins.                                            |

## Info

| Code                     | What it means                                                                                                          |
| :----------------------- | :--------------------------------------------------------------------------------------------------------------------- |
| `surface-opaque`         | A module's return value could not be evaluated statically, so nothing on it was discovered. See [Nothing was generated](/guide/reference/troubleshooting#nothing-was-generated). |
| `orphaned-doc-block`     | A doc comment carrying `@param` or `@within` sits above no statement, so there is nothing for it to describe. A block of plain prose is left alone, since an unattached comment is usually just a comment. |
| `unresolved-reexport`    | A re-export points at something its target module does not document, so the entry renders bare, with nothing to link.   |
| `require-nonmodule`      | An instance path points at something that is not a module script, so there is nothing to follow.                        |
| `duplicate-class`        | A floating `@class` names a class that already exists, possibly in another module. The declaration is ignored, and members aimed at the name file under the existing class. The warning variant is under [Warnings](#warnings). |
| `ignored-tag`            | `@__index`, which is accepted for Moonwave compatibility and then dropped.                                              |

## Renderer warnings

A `renderer:` prefix means extraction was fine: two things wanted one name, and the renderer says which won.

| Message                                        | What it means                                                                                             |
| :--------------------------------------------- | :--------------------------------------------------------------------------------------------------------- |
| `page name collision`                          | Two modules want one URL. The later gets a numbered slug, and its sidebar, search, and tab title carry the parent (`Defaults (Flux)`); rename one to reclaim the bare spelling. |
| `ambiguous reference name dropped from link table` | One spelling resolves to two equal-standing targets (two modules both named `Defaults`, or `Config.get` on two pages); a module outranks a same-named type, so those pairs resolve instead of warning. Linking either would be a coin flip, so neither is linked; the warning names both targets. Qualify the reference (`[Module.State]`) or rename. |

## Site-sync warnings

Four more come from the site sync rather than the API model. They carry no prefix, because each already names the file or the `[docs]` key it is about. All four count toward `--strict`.

| Message                                                                                          | What it means                                                                                                        |
| :----------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------- |
| `[docs] changelog is enabled but CHANGELOG.md was not found`                                     | The key asks for a `/changelog` page and there is no file to build it from, so no page is generated.                  |
| `[docs] includeReadme is enabled but README.md was not found`                                    | The same, for the README copy your landing page includes.                                                             |
| `index.md includes .vitepress/generated/readme.md, which only [docs] includeReadme = true keeps` | `includeReadme` is off while your own `index.md` still includes the copy it generates. Re-enable the key or drop the include, or VitePress fails on a missing include. |
| `README.md links …, which the generated site does not serve`                                     | A README link points at a repository file that is not a page here, and `[repo]` is either unset or cannot reach it. Set `[repo]`, or point the link at a page. |

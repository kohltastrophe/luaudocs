---
title: Troubleshooting
description: The failures that arrive without a diagnostic code, and what to do about each.
sidebar_position: 13
---

# Troubleshooting

Anything that comes with a file and a code is in [Diagnostics](/guide/reference/diagnostics). This page covers the failures that do not.

## `could not download Lute`

Reading Luau sources needs [Lute](https://github.com/luau-lang/lute), which the first extraction downloads from its GitHub releases and caches in `~/.cache/luaudocs` (`~/Library/Caches/luaudocs` on macOS, `%LOCALAPPDATA%\luaudocs` on Windows).

A proxy, an offline machine, or a runner with no egress fails here. Install Lute yourself, point `LUAUDOCS_LUTE` at the binary, and nothing downloads. `checksum mismatch` takes the same fix.

## `there is no prebuilt binary for <platform>`

The releases cover Linux (x86_64, aarch64), macOS on Apple silicon, and Windows x86_64. Anywhere else (an Intel Mac, musl, BSD), [build Lute from source](https://github.com/luau-lang/lute) and either put it on your PATH or point `LUAUDOCS_LUTE` at it.

Extraction is tied to the Lute version, so a build other than the pinned one can document your library differently. That is fine on your own machine; keep CI on the pinned download.

## Nothing was generated

If `.luaudocs/api/` is empty, look for [`surface-opaque`](/guide/reference/diagnostics#info) first: the module's return value could not be traced to a table, usually a call into another module or a value assembled behind an unresolvable conditional. Return the table you built, or name the pieces with [`@class` and `@within`](/guide/overriding-with-tags#moving-a-member-somewhere-else).

Also check that `[source] entries` points at your module root and is not `[]`, which is [guide-only mode](/guide/configuration#guide-only-sites).

## A file I put in `api/` or `.vitepress/` disappeared

Both directories are [tool-owned](/guide/configuration#which-files-are-yours): every build makes them contain exactly what it generates.

This most often bites a `.vitepress/config.mts` kept from a VitePress site that predates LuauDocs. Move the options into `luaudocs.toml` and the styling into [`custom.css`](/guide/configuration#styling); pages you authored belong at the docs root.

## `vitepress is not installed in .luaudocs`

`build` and `dev` install the docs directory with npm when the VitePress they pin does not resolve, and a failing install stops with npm's own error instead of this one. Reaching this message means the install claimed success but the pinned VitePress still does not resolve from the docs directory (a sandboxed CI step, a read-only mount, a package manager that redirected the install).

The message names the docs directory in full. Run `npm install` in it (`npm install --prefix .luaudocs` from the project root) to see what npm has to say.

## Still stuck

::: tip Look at the markdown itself
`luaudocs build --emit-only` shows everything there is to see: the full diagnostic list, and the emitted markdown under `.luaudocs/api/`. A member missing there means the extractor never discovered it, and the diagnostics usually say why.

That, plus the smallest source file that reproduces it, is everything an [issue](https://github.com/kohltastrophe/luaudocs/issues) needs.
:::

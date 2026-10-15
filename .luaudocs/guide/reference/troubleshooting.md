---
title: Troubleshooting
description: The failures that arrive without a diagnostic code, and what to do about each.
sidebar_position: 6
---

# Troubleshooting

Source-level issues with a file location and code are covered in [Diagnostics](/guide/reference/diagnostics). This page covers environment and build failures.

## `could not download Lute`

On first run, LuauDocs downloads a pinned [Lute](https://github.com/luau-lang/lute) binary from GitHub releases and caches it in `~/.cache/luaudocs` (`$XDG_CACHE_HOME/luaudocs`, `~/Library/Caches/luaudocs` on macOS, or `%LOCALAPPDATA%\luaudocs` on Windows).

If a proxy or offline environment blocks the download (or triggers a `checksum mismatch`), install Lute manually and set `LUAUDOCS_LUTE` to the binary path.

## `there is no prebuilt binary for <platform>`

Prebuilt Lute binaries cover Linux (`x86_64`, `aarch64`), macOS (`aarch64`), and Windows (`x86_64`). On other platforms (Intel macOS, musl Linux, BSD), [build Lute from source](https://github.com/luau-lang/lute) and place it on `PATH` or point `LUAUDOCS_LUTE` at it.

## Nothing was generated

If `.luaudocs/api/` is empty, check for [`surface-opaque`](/guide/reference/diagnostics#info): the module's `return` value could not be traced to a table. Return the table directly, or declare containers with [`@class` and `@within`](/guide/overriding-with-tags#moving-a-member-somewhere-else). Also verify that `[source] entries` points at your module roots and is not `[]` ([guide-only mode](/guide/configuration#guide-only-sites)).

## A file I put in `api/` or `.vitepress/` disappeared

Both directories are [tool-owned](/guide/configuration#which-files-are-yours) and synchronized on every build. Put site options in `luaudocs.toml`, custom styles in [`custom.css`](/guide/configuration#styling), and hand-written pages under `guide/` or the docs root.

## `vitepress is not installed in .luaudocs`

`build` and `dev` run `npm install` in the docs directory automatically when VitePress is missing. This error means `npm install` exited with status `0` but VitePress still cannot be resolved from `.luaudocs/` (for example, due to a read-only mount or custom npm prefix). Run `npm install --prefix .luaudocs` directly to inspect npm's output.

## Still stuck

::: tip Look at the markdown itself
Run `luaudocs build --emit-only` to inspect the full diagnostic list and the generated Markdown in `.luaudocs/api/`. Include that output and a minimal reproducing `.luau` file when opening an [issue](https://github.com/kohltastrophe/luaudocs/issues).
:::

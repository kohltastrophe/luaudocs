<div align="center"><img src=".luaudocs/public/logo.svg" alt="" width="112" height="112"></div>

# LuauDocs

[![CI](https://github.com/kohltastrophe/luaudocs/actions/workflows/ci.yml/badge.svg)](https://github.com/kohltastrophe/luaudocs/actions/workflows/ci.yml)
[![coverage](https://codecov.io/gh/kohltastrophe/luaudocs/graph/badge.svg)](https://app.codecov.io/gh/kohltastrophe/luaudocs)
[![npm](https://img.shields.io/npm/v/luaudocs)](https://www.npmjs.com/package/luaudocs)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE.md)

**Documentation generator for Luau.** Point it at your module root to document what your library exports: LuauDocs reads your doc comments and real type annotations to generate a [VitePress](https://vitepress.dev) site.

- **[No tags required](https://luaudocs.pages.dev/guide/how-it-works).** LuauDocs determines what your module returns, so an untagged library still gets a full API reference, including Yields, Server, and Client badges inferred from function behavior. Tags exist only to override what the code says.
- **[Signatures from your real types](https://luaudocs.pages.dev/guide/how-it-works#types-get-their-own-entries).** Every field, parameter, and return type comes from annotations already in your code, cross-linked to each type's own entry, so rendered signatures never drift from the code they document.
- **[Moonwave-compatible](https://luaudocs.pages.dev/guide/migrating-from-moonwave).** All 24 Moonwave tags keep working as overrides, so tagged sources need no edits, and one command ports the config, the hand-written pages, and the static assets.
- **[Built to be built on](https://luaudocs.pages.dev/guide/reference/doc-model).** `luaudocs build --model api.json` exports your entire API as JSON, with type references resolved directly to their declarations. Every build also generates llms.txt and llms-full.txt, making your documentation as accessible to AI tools as it is to developers.

## Quick Start

Requires [Node.js](https://nodejs.org/en/download) 22.12 or newer, with no other dependencies to install: the extractor runs on a pinned [Lute](https://github.com/luau-lang/lute) build that LuauDocs automatically downloads, verifies, and caches on first run.

```bash
npm i -g luaudocs
cd my-luau-library
luaudocs dev
```

_Already on [Moonwave](https://github.com/evaera/moonwave)?_ Run `luaudocs init --from-moonwave` before `dev` to convert the project in place.

## Documentation

**[Read the docs](https://luaudocs.pages.dev)** · **[Browse a generated reference](https://luaudocs.pages.dev/api/)**

That reference is built from [`examples/Flux`](https://github.com/kohltastrophe/luaudocs/tree/main/examples/Flux) using the commands above, and the guides embed real generated pages rather than static mockups.

## License

LuauDocs is released under the [MIT License](LICENSE.md).

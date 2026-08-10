<div align="center"><img src=".luaudocs/public/logo.svg" alt="" width="112" height="112"></div>

# LuauDocs

[![CI](https://github.com/kohltastrophe/luaudocs/actions/workflows/ci.yml/badge.svg)](https://github.com/kohltastrophe/luaudocs/actions/workflows/ci.yml)
[![coverage](https://codecov.io/gh/kohltastrophe/luaudocs/graph/badge.svg)](https://app.codecov.io/gh/kohltastrophe/luaudocs)
[![npm](https://img.shields.io/npm/v/luaudocs)](https://www.npmjs.com/package/luaudocs)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE.md)

**Documentation generator for Luau.** Point it at your module root and it documents what your library exports, reading your doc comments and real type annotations to render a [VitePress](https://vitepress.dev) site.

- **[No tags required](https://luaudocs.kohl.gg/guide/how-it-works).** LuauDocs works out what your module returns, so an untagged library still gets a full API reference, down to Yields, Server, and Client badges read from what each function actually does; tags exist only to override what the code says.
- **[Signatures from your real types](https://luaudocs.kohl.gg/guide/how-it-works#types-get-their-own-entries).** Every field, parameter, and return comes from the annotations already in your code, cross-linked to each type's own entry, so a rendered signature cannot drift from the thing it documents.
- **[Moonwave-compatible](https://luaudocs.kohl.gg/guide/migrating-from-moonwave).** All 24 Moonwave tags keep working as overrides, so tagged sources need no edits, and one command ports the config, the hand-written pages, and the static assets.
- **[Built to be built on](https://luaudocs.kohl.gg/guide/reference/doc-model).** `luaudocs build --model api.json` writes your whole API as JSON, with type references resolved to the declarations they name, and every site ships llms.txt and llms-full.txt, so tooling and AI assistants read your docs as easily as people do.

## Quick Start

Needs [Node.js](https://nodejs.org/en/download) 22.12 or newer, and nothing else to install: the extractor runs on a pinned [Lute](https://github.com/luau-lang/lute) build that the first run downloads, checksums, and caches for you.

```bash
npm i -g luaudocs
cd my-luau-library
luaudocs dev
```

_Already on [Moonwave](https://github.com/evaera/moonwave)?_ Run `luaudocs init --from-moonwave` before `dev` to convert the project in place.

## Documentation

**[Read the docs →](https://luaudocs.kohl.gg)** · **[Browse a generated reference →](https://luaudocs.kohl.gg/api/)**

That reference is built from [`examples/Flux`](https://github.com/kohltastrophe/luaudocs/tree/main/examples/Flux) by the same commands above, and the guides embed it inline rather than mocking it up.

## License

LuauDocs is released under the [MIT License](LICENSE.md).

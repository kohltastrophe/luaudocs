<div align="center"><img src=".luaudocs/public/logo.svg" alt="" width="112" height="112"></div>

# LuauDocs

[![CI](https://github.com/kohltastrophe/luaudocs/actions/workflows/ci.yml/badge.svg)](https://github.com/kohltastrophe/luaudocs/actions/workflows/ci.yml)
[![coverage](https://codecov.io/gh/kohltastrophe/luaudocs/graph/badge.svg)](https://app.codecov.io/gh/kohltastrophe/luaudocs)
[![npm](https://img.shields.io/npm/v/luaudocs)](https://www.npmjs.com/package/luaudocs)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE.md)

LuauDocs generates [VitePress](https://vitepress.dev) documentation sites from your Luau source code. It reads your exported modules, type annotations, and doc comments directly, so you don't need doc tags unless you want to override something.

- **[No tags required](https://luaudocs.kohl.gg/guide/how-it-works):** Evaluates what your module returns to build an API reference and infer `Yields`, `Server`, and `Client` badges.
- **[Real type signatures](https://luaudocs.kohl.gg/guide/how-it-works#types-get-their-own-entries):** Reads field, parameter, and return types from your Luau annotations and links every type to its definition.
- **[Moonwave compatible](https://luaudocs.kohl.gg/guide/migrating-from-moonwave):** Supports all 24 Moonwave tags as overrides and converts your existing config, guides, and static assets with one command.
- **[JSON model and `llms.txt`](https://luaudocs.kohl.gg/guide/coding-agents):** Exports your API as JSON via [`luaudocs build --model`](https://luaudocs.kohl.gg/guide/reference/doc-model) and generates `llms.txt` indexes for coding agents.

## Quick Start

Requires [Node.js](https://nodejs.org/en/download) 22.12 or newer. You don't need to install anything else. LuauDocs automatically downloads, verifies, and caches a pinned [Lute](https://github.com/luau-lang/lute) binary on first run.

```bash
npm i -g luaudocs
cd my-luau-library
luaudocs dev
```

Already using [Moonwave](https://github.com/evaera/moonwave)? Run `luaudocs init --from-moonwave` before `dev` to convert your project in place.

## Documentation

**[Read the docs](https://luaudocs.kohl.gg)** · **[Browse the example API](https://luaudocs.kohl.gg/api/)**

The live API reference is generated from [`examples/Flux`](https://github.com/kohltastrophe/luaudocs/tree/main/examples/Flux), and the guides embed real entries from that build.

## License

LuauDocs is released under the [MIT License](LICENSE.md).

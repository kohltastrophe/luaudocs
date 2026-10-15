# AGENTS.md

LuauDocs is a documentation generator for Luau: it symbolically evaluates a
module's return value to discover the public surface (no mandatory tags), reads
doc comments and real type annotations, and renders a VitePress site.

## Read CONTRIBUTING.md first

[CONTRIBUTING.md](CONTRIBUTING.md) is the canonical description of
this repo: setup, the CI ladder in cheapest-first order, the two-runtime
architecture, the invariants a reasonable-looking change can break silently,
which of the four test layers new coverage belongs in, and the code
conventions. Read it before touching anything.

`CONTRIBUTING.md` is canonical because it is the reviewed copy. This file used
to carry its own architecture section until the two drifted; **do not restate
CONTRIBUTING.md here.** When a change invalidates something in
`CONTRIBUTING.md`, update `CONTRIBUTING.md` in the same change.

## Working notes

- **Released:** A build is in the wild. Any user-visible change goes under a
  new `CHANGELOG.md` heading (never appended to an already-published version)
  and requires bumping the version in `package.json`, the
  `npx luaudocs@<version>` pins in the Deploying and Coding Agents guides, and
  the root `llms.txt` (`test/docs-site.test.ts` checks all three). Internal
  contracts (including the doc-model shape) still evolve in place while the
  major version is `0`, with no compatibility shims, but document those changes
  in `CHANGELOG.md`.
- This repo's own site lives in `.luaudocs/` (published to
  `luaudocs.pages.dev`, with `luaudocs.kohl.gg` redirecting there). Preview it
  locally with `node dist/cli.js dev` after running `bun run build`.
- The only Luau source this repo documents is `examples/Flux`, a small demo
  library whose generated output is embedded directly into the guides via
  `<!--@include: @/api/Flux.md#anchor-->`. Editing `examples/Flux` changes
  those guide embeds, so rebuild and inspect them; removing a heading that a
  guide includes will fail the build rather than silently rendering an empty
  frame.
- The root `llms.txt` is this repo's own `luaudocs llms` output, indexing the
  guides and the Flux API. Editing a guide or `examples/Flux` can change it, so
  run `bun run dev llms` before finishing and commit the updated `llms.txt`
  with your change; CI's `llms --check` step fails otherwise.
- To inspect what the extractor produces on a real project, run it directly on
  Lute using the command in `CONTRIBUTING.md`.
- No em dashes in docs prose (`README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`,
  `.luaudocs/**`, and this file): use parentheses, colons, or commas, and use
  serial (Oxford) commas in lists of three or more items.
- Commit messages must not include `Co-Authored-By`, agent-session trailers, or
  any other attribution lines: end the commit message with its last paragraph.

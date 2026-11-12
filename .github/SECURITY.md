# Security Policy

## Supported versions

LuauDocs is pre-1.0. Fixes land on the latest published release only, and older versions do not receive maintenance patches.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub Security Advisories: [Report a vulnerability](https://github.com/kohltastrophe/luaudocs/security/advisories/new). Do not open a public issue for a security report.

Include what you did, what happened, and the versions involved (`luaudocs --version`, `lute --version`, Node, and OS). Reports receive an acknowledgment within a week and updates as the fix progresses.

## What is in scope

LuauDocs is a build tool, so its security boundary covers what it executes and what it writes:

- **Subprocesses.** The CLI spawns the pinned `lute` binary (verified by SHA-256, unless overridden with `LUAUDOCS_LUTE`) to run the Luau extractor (`extractor/main.luau`, `extractor/core/*`, and `extractor/model/*`). It also runs `npm install` to populate the generated site's dependencies and spawns the locally resolved `vitepress` binary for `build` and `dev`. Any way to make these subprocesses execute unintended code through configuration, project layout, or doc comments is in scope. Setting `LUAUDOCS_LUTE` in the caller's environment explicitly overrides the pinned Lute binary and sits on the caller's side of the trust boundary.
- **Files it writes.** Ownership is by directory. `<docs>/api/` and `<docs>/.vitepress/` are tool-owned and synchronized to what a build emits (`syncDir` in `src/pages.ts`). Outside those directories, LuauDocs deletes nothing (except `public/docmodel.json` when `[docs] model` is disabled) and overwrites only files covered by the documented contract (`changelog.md`, a marker-carrying `index.md`, `public/llms*.txt`, `public/docmodel.json`, the docs `package.json`, and a marker-carrying root `llms.txt` on `luaudocs llms`). Overwriting or deleting files outside that contract, or escaping the project or docs directory through crafted paths, is in scope.
- **Generated site output.** Doc comments render into HTML and Markdown. A doc comment or configuration value that injects executable scripts or unsafe URL schemes into a built site beyond the Markdown VitePress already permits is in scope.
- **The release pipeline.** Anything that lets a third party publish or alter the `luaudocs` npm package is in scope.

## What is out of scope

- **Upstream dependencies.** Report vulnerabilities in VitePress, Lute, or other dependencies upstream. Open a normal issue here if LuauDocs needs to pin around an upstream advisory.
- **Untrusted repositories.** Extraction (`extractor/core/*` and `extractor/model/*`) parses and symbolically evaluates Luau source without executing project code, and `LUAUDOCS_LUTE` comes only from the caller's process environment rather than project files. However, full builds install and run a VitePress toolchain inside the target project's docs directory, so treat running `luaudocs build` or `luaudocs dev` on an untrusted repository the same way you treat running any Node build tool on untrusted code.

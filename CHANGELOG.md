# Changelog

Notable changes to LuauDocs, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html). While the major version is 0, a minor bump may include breaking changes.

## [0.4.0] - 2026-11-06

### Added

- Support parsing Luau declaration (.d.luau) files. ([1b47ca1](https://github.com/kohltastrophe/luaudocs/commit/1b47ca14c7004636f8bf4b7544b61b5b70311c5a))

## [0.3.2] - 2026-11-04

### Changed

- Release parsed CSTs after extraction. ([07d2889](https://github.com/kohltastrophe/luaudocs/commit/07d288967d34946d132f5cc85e0fb3a5f54eb338))

### Fixed

- Avoid false-positive member realms on project tables. ([976106e](https://github.com/kohltastrophe/luaudocs/commit/976106e4869d7823edec574520c8cafa1d9ef633))
- Fold literal binary expressions during surface evaluation. ([6a67952](https://github.com/kohltastrophe/luaudocs/commit/6a67952d428802d5f37e48936913ae5cb98ca66a))
- Preserve tags on respelled type aliases. ([bcff882](https://github.com/kohltastrophe/luaudocs/commit/bcff882d9ee04a7bdf2845d0d068b105f51fec09))
- Handle nested generic alias references in rendered pages. ([028147b](https://github.com/kohltastrophe/luaudocs/commit/028147badbb5be3b4a4de92e9dfb1e36f47bc70e))
- Unshallow shallow Git clones before VitePress build. ([433fb0b](https://github.com/kohltastrophe/luaudocs/commit/433fb0b72dc734ae3bb4276ee1be2066480e064b))

## [0.3.1] - 2026-10-21

### Changed

- Pin scaffolded workflows and guide commands to luaudocs@latest.

### Fixed

- Bound comment tag scanning and reject duplicate custom tags.
- Harden remote doc model fetching and VitePress link escaping.

## [0.3.0] - 2026-10-14

### Added

- Expand extractor class discovery, runtime aliases, and diagnostics.
- Add luaudocs llms, cross-site doc model linking, and rendering fixes.

### Fixed

- Stage Lute downloads via process-specific temp files.

## [0.2.0] - 2026-09-01

### Added

- Read _category_ sidecars and scope sidebar_position to siblings.
- Reload luaudocs.toml in place during dev.

### Fixed

- Highlight ancestor sidebar groups above the current page.

## [0.1.0] - 2026-08-10

### Added

- Add Luau documentation extractor, static site generator, and CLI.

[0.4.0]: https://github.com/kohltastrophe/luaudocs/releases/tag/v0.4.0
[0.3.2]: https://github.com/kohltastrophe/luaudocs/releases/tag/v0.3.2
[0.3.1]: https://github.com/kohltastrophe/luaudocs/releases/tag/v0.3.1
[0.3.0]: https://github.com/kohltastrophe/luaudocs/releases/tag/v0.3.0
[0.2.0]: https://github.com/kohltastrophe/luaudocs/releases/tag/v0.2.0
[0.1.0]: https://github.com/kohltastrophe/luaudocs/releases/tag/v0.1.0

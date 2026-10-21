# Changelog

Notable changes to LuauDocs, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html). While the major version is 0, a minor bump may include breaking changes.

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

[0.3.1]: https://github.com/kohltastrophe/luaudocs/releases/tag/v0.3.1
[0.3.0]: https://github.com/kohltastrophe/luaudocs/releases/tag/v0.3.0
[0.2.0]: https://github.com/kohltastrophe/luaudocs/releases/tag/v0.2.0
[0.1.0]: https://github.com/kohltastrophe/luaudocs/releases/tag/v0.1.0

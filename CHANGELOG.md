# Changelog

All notable changes to this project will be documented in this file.

The format is based on "Keep a Changelog" and aims to make it easy for
contributors and users to follow meaningful changes over time.

Unreleased
----------

### Added
- TEAM-README.md — short team guidelines for line endings and git config.
- .gitattributes — repository-level EOL normalization rules (LF for source,
  CRLF for PowerShell/batch scripts where appropriate).
 - TTL parsing: support for ETS Application Functions (parsed from TTL into
   `applicationFunctions`) in `src/semantic/ttl-loader.js`.
 - Semantic graph: Functions are now represented as `applicationFunction`
   entities in the graph via `src/semantic/graph-builder.js` (includes
   `buildFunctions()` and function → groupAddress relationships).
 - ResourceStore: convenience methods `getApplicationFunctions()` and
   `getFunctions()` added to `src/semantic/resource-store.js` (backwards
   compatible getter that falls back to legacy `function` type).
 - Test scripts: `scripts/test-ttl.js` and `scripts/test-ttl-summary.js` to
   quickly validate TTL parsing and function→groupAddress relationships.

### Changed
- Updated license identifiers to AGPL-3.0-or-later across all JavaScript and test files
  (commits 0667a48, 264783f, 1434b7c).
- Normalized line endings across the repository to LF for source and
  documentation files. This included multiple commits to ensure CR/CRLF
  characters were removed and files were encoded with LF endings.
 - KNX Function type rename: internal semantic resources for ETS functions
   now use `type: 'applicationFunction'`. A backwards-compatible getter
   (`ResourceStore.getFunctions`) is provided to avoid breaking existing
   callers.
 - `SemanticEngine.getAllFunctions()` now uses the new convenience getter
   to ensure both `applicationFunction` and legacy `function` types are
   supported.

2026-06-14
----------

### Added
- Initial changelog file (this file).

### Details (recent commits)
- a65979c — Normalize remaining CR characters to LF in source files
- d6b4298 — Normalize line endings to LF for source files
- f4a6524 — Add TEAM-README.md to outline repository conventions and commands
- 6ae44a4 — Add .gitattributes to normalize end-of-line handling across platforms
- 3f7d2ea — Add .gitattributes and normalize line endings

Guidelines
----------
- Add a short, plain-language entry for each pull request or notable change.
- Use categories such as Added, Changed, Deprecated, Removed, Fixed, Security.
- Keep entries under Unreleased until you create a release tag, then move them
  under the release date/version.

Example entry
-------------
```markdown
### Fixed
- Prevent crash when X is missing on startup (PR #123)
```

If you want, I can open a pull request with this changelog and the
renormalization commits grouped under the 2026-06-14 entry. Tell me which
branch you prefer to use for the PR (e.g. `development`).\r\n

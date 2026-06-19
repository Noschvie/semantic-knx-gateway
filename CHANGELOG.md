# Changelog

All notable changes to this project will be documented in this file.

The format is based on "Keep a Changelog" and aims to make it easy for
contributors and users to follow meaningful changes over time.

Unreleased
----------

### Added
- `meta.hasCurrentState` flag in datapoint resources to distinguish online
  (runtime state exists) from offline (semantic/TTL-only) datapoints.
- Semantic datapoint mappings are now exposed via `/datapoints` collection endpoint
  even before the first KNX telegram arrives, enabling clients to discover full
  datapoint inventory (including group addresses) without waiting for bus activity.

### Changed
- **`GET /api/v2/datapoints`** – now returns union of semantic (ETS/TTL-defined)
  and runtime datapoints instead of runtime-only. Offline datapoints appear with
  `value: null`, `timestamp: null`, and `hasCurrentState: false`.
- **`GET /api/v2/datapoints/{id}`** – now searches semantic + runtime union,
  so offline/semantic-only datapoints return data instead of 404.
- **`GET /api/v2/datapoints/{id}/timeseries`** – now searches semantic + runtime
  union; offline datapoints return empty history list (not 404). Only datapoints
  with `hasCurrentState: true` generate history entries.
- **Filter behavior** (`filter[ga]`, `filter[datapointId]`, `filter[locationId]`,
  `filter[deviceId]`) now matches semantic datapoints as well, enabling discovery
  of offline sensors by group address or location.
- Datapoints without runtime state display `attributes.value: null`,
  `attributes.timestamp: null` per spec-compliance; spec-enabled clients can
  distinguish via `meta.hasCurrentState: false`.
- Docker runtime image cleaned up: removed `curl`, set `NODE_ENV=production`,
  and moved `USER_ID`/`GROUP_ID` defaults to `docker-compose.yml` to avoid
  duplicated build-time defaults.
- Renamed `POSTGRES_USER` environment variable to `POSTGRES_USERNAME` for naming consistency.

2026-06-16
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
- KNX IoT API: Spec-compliant `relationships.functionDatapoints` link added to
  function resources, pointing to `GET /api/v1/functions/{id}/datapoints`.
- KNX IoT API: `ResourceStore.getApplicationFunctions()` now enriches each
  function with `groupAddressUris` loaded from the `semantic_relationships`
  table (predicate `hasGroupAddress`).
- KNX IoT API: shared filter helper module `src/api/routes/helpers/knx-iot-filters.js`
  with `parseFilters`, `getField`, `matchValue`, `applyFilter`, `applyAllFilters` —
  implements spec-compliant `typeFilter`, `tagFilter` and `attributeFilter`
  query parameters for all collection endpoints.
- KNX IoT API: dedicated route modules extracted from `knx-iot-router.js`:
  - `src/api/routes/functions.js` — `GET /functions`, `GET /functions/:id`,
    `GET /functions/:id/datapoints`, `GET /functions/:id/location`
  - `src/api/routes/installations.js` — `GET /installations`,
    `GET /installations/:installationId`
  - `src/api/routes/node.js` — `GET /node`
  - `src/api/routes/sites.js` — `GET /sites`
- TTL loader: ETS `ApplicationFunction` nodes without any `hasFunctionPoint`
  relation are now skipped (ontology-class definitions, not real user functions).
- Debug scripts: `scripts/debug-ttl-content.js` extended to distinguish
  functions with vs. without FunctionPoints for easier ETS data validation.
- KNX IoT API: `functionLocation` relationship added to function resources in
  `knx-iot-transform.js` as per spec.
- KNX IoT REST API: discovery endpoint added (`/.well-known/knx` or equivalent)
  to `rest-api.js` for KNX IoT conformance.
- ESLint + Prettier: `lint`, `lint:fix`, `format` and related scripts added to
  `package.json`; `eslint.config.js` migrated to flat config format with rules
  for unused variables and private class members (underscore prefix convention).
- `.gitignore`: added `.idea/` entry to exclude IntelliJ/JetBrains IDE files.

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
- `knx-iot-router.js` significantly reduced: `functions`, `installations`,
  `node` and `sites` endpoints extracted into dedicated route files; only
  `/.well-known/knx` handler and shared infrastructure remain.
- `toFunctionResource()` in `knx-iot-transform.js` updated: relationship key
  renamed to `functionDatapoints` (spec-compliant), now links to the
  `/api/v1/functions/{id}/datapoints` sub-endpoint instead of embedding
  resource linkage data.
- Filter helpers (`parseFilters`, `applyAllFilters`) deduplicated across all
  route files by centralising them in `helpers/knx-iot-filters.js`.
- REST API migrated from `/api/v1` to `/api/v2`; all internal references and
  documentation updated accordingly.
- `node` router function renamed to `nodeRouter` for clarity and consistency.
- `dpt-decoder.js` refactored: switch-case indentation standardized; DPT 19
  decoding enhanced with richer output (additional date/time fields).
- `tunnel-manager.js` refactored: `srcAddress` and `dstAddress` now accessed
  via `.get()` method instead of direct property access.
- `rest-api.js`, `knxError` helper and multiple modules reformatted for
  consistency (unified section headers, streamlined logger usage, object
  literal style).

### Details (recent commits)
- 3b7f447 — Refactor `tunnel-manager.js`: use `get()` for srcAddress/dstAddress
- 8124811 — Refactor multiple modules for consistent object formatting
- fb94b54 — ESLint: enforce rules for unused variables and private underscore members
- 9aa24f6 — Refactor `dpt-decoder.js`: improved formatting and enhanced DPT 19 decoding
- f3d065e — Update `.gitignore`: add `.idea/` for JetBrains IDE files
- f7677ba — Add KNX IoT discovery endpoint to REST API
- ebe7fcd — Migrate REST API to `/api/v2`
- 181315 — Migrate ESLint configuration to flat `eslint.config.js`
- 3c6375 — Add `eslint`, `prettier`, and related scripts
- afafbe5 — Enhance KNX IoT function transformation: add `functionLocation` relationship
- e405a2e — Rename `node` to `nodeRouter` for clarity
- 7335382 — Refactor KNX IoT routes into dedicated modules
- 186a5eb — Enrich application functions with linked group address URIs
- ddfce1c — Skip ontology-level class definitions without function points

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

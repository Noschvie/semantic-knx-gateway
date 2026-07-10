# Changelog

All notable changes to this project will be documented in this file.

The format is based on "Keep a Changelog" and aims to make it easy for
contributors and users to follow meaningful changes over time.

Unreleased
----------

2026-07-09
----------

### Added
- **Database Management API (Vendor Extension)** – Comprehensive database maintenance endpoints
  under `/api/v2/database/...` (not in KNX IoT spec, vendor extension):
  
  **Tier 1: Information**
  - `GET /api/v2/database/info` — Real-time database statistics and health metrics:
    - Database size, version, backend capabilities
    - Per-table statistics (rows, sizes, indexes)
    - Event timeline (earliest/latest event, coverage, average events/day)
    - TimescaleDB hypertable compression info (chunk count, compression ratio)
    - Subscription counts (total, active, expired)
    - Backend capability flags (VACUUM support, compression support, dry-run support, presets)
    - **Authentication**: Bearer token with `read` scope
  
  **Tier 2: Maintenance**
  - `POST /api/v2/database/purge` — Delete old events with configurable retention policies:
    - **Presets**: `30_days`, `90_days` (recommended), `365_days`, `custom`, `purge_all`
    - **Workflow**: Call with `dry_run=true` to preview, then `dry_run=false` + `confirm=true` to execute
    - **Response (Dry-Run, 200 OK)**: Detailed preview of rows/size to be deleted
    - **Response (Execution, 202 Accepted)**: Job ID, execution timestamps, actual results
    - **Safety**: Destructive operations require explicit confirmation; `purge_all` irreversible
    - **Authentication**: Bearer token with `delete:database` scope
  
  - `POST /api/v2/database/optimize` — Reclaim disk space from deleted rows (PostgreSQL VACUUM):
    - **VACUUM ANALYZE (default)**: Online operation, API stays responsive, ~80-95% space reclamation
    - **VACUUM FULL (optional)**: Maximum space reclamation (100%), requires **maintenance window** (system goes offline 10-30 minutes)
    - **Parameters**: `full: boolean`, `analyze: boolean` (update query planner stats)
    - **Response (202 Accepted)**: Space freed (bytes/pretty), method used, downtime warning for VACUUM FULL
    - **Critical Warning**: VACUUM FULL causes API downtime; never schedule automatically in production
    - **Authentication**: Bearer token with `delete:database` scope
  
  **Tier 3: Audit**
  - `GET /api/v2/database/cleanup-jobs` — Query audit log of all purge/optimize operations:
    - **Pagination**: `offset`, `limit` (max 100), `total` count
    - **Filtering**: `status` (completed/failed), `days` (last N days, default 30)
    - **Results**: Job ID, operation type, strategy, parameters, execution timestamps, duration, affected tables, statistics
    - **Authentication**: Bearer token with `read` scope
  - `GET /api/v2/database/health` — Simple database connectivity check (no authentication required)

- **Database Maintenance Audit Log** – New persistent table `database_maintenance_log`:
  - Tracks all purge and optimize operations with full audit trail
  - Stores: operation type, preset, parameters, execution timestamps, status, results (JSONB)
  - Indexed on status and created_at for efficient queries
  - User attribution via `executed_by` field

- **DatabaseManager class** (`src/storage/database-manager.js`) — High-level database maintenance logic:
  - `getStatistics()` — Comprehensive database metrics (tables, events, hypertables, subscriptions)
  - `getCapabilities()` — Backend feature support detection
  - `getPurgePreview(preset, olderThan)` — Dry-run preview without deletion
  - `executePurge(preset, olderThan, executedBy)` — Execute deletion with audit logging
  - `optimizeDatabase(options, executedBy)` — VACUUM with downtime warnings
  - Helper: Static `formatBytes()` for human-readable size formatting
  - Helper: `_getTotalRowCount()` for row count queries
  - Static `PURGE_PRESETS` configuration for retention policies

- OAuth2 scope `delete:database` added for maintenance operation authorization

### Security
- Database maintenance endpoints require specific OAuth2 scopes (`read` or `delete:database`)
- Destructive purge operations require explicit `confirm=true` flag (2-step confirmation via dry-run)
- `purge_all` operation is intentionally irreversible; dry-run mandatory before execution
- All maintenance operations logged with user attribution in `database_maintenance_log`
- VACUUM FULL downtime warnings prevent accidental system disruption

### Documentation
- Comprehensive Database Management API guide in `docs/DATABASE_MANAGEMENT.md`:
  - Endpoint specifications with request/response examples
  - VACUUM behavior explained (online vs. maintenance-window operations)
  - Admin runbook for daily/monthly operations
  - Dry-run workflow documentation
  - Preset configuration details
  - Performance considerations for TimescaleDB compression
  - Deployment and scheduling recommendations

2026-07-07
----------

### Added
- **Release Workflow automation** – GitHub Actions workflow (`create-release.yml`) and
  Node.js script (`update-changelog-for-release.js`) to automate release process:
  - Manual workflow trigger with version input (e.g., `v2026.07.07`)
  - Automatic CHANGELOG.md update (Unreleased → dated section)
  - Automatic merge `development` → `main`
  - Annotated Git tag creation
  - Automatic sync `main` → `development` for hotfix preparation
  - GitHub Release creation with a changelog link
- `PRETTY_LOGS` environment variable to enable/disable pretty-formatted console logs
  independently of `NODE_ENV` (defaults to `true` for better readability)
- **New Docker deployment approach for TTL file management:**
  - Entire `./config` directory is now mounted into the container (instead of single-file bind mount)
  - New environment variable `KNX_TTL_FILE` (filename only) replaces `KNX_TTL_PATH` (full path)
  - Multiple TTL files can coexist in the config directory, enabling easier multi-project setups
  - **Migration required for existing deployments** — see below

### Changed
- **TTL file configuration (BREAKING CHANGE):**
  - `KNX_TTL_PATH=/app/config/project.ttl` → `KNX_TTL_FILE=project-prod.ttl`
  - Environment variable now contains only the filename; the full path is constructed internally
  - Docker Compose no longer requires modification when switching between projects
  - Volume configuration simplified: `./config:/app/config:ro` (directory mount instead of file mount)

### Improved
- **Startup validation for TTL files:**
  - Clear error messages if `KNX_TTL_FILE` is not set, missing, or points to a directory
  - Application exits cleanly with descriptive error instead of silent failures
  - Fixes previous issue where missing source files caused Docker to create directories instead of mounting files (leading to `EISDIR` errors)

### Migration Guide for Existing Deployments

**Before (old approach):**

*docker-compose.prod.yml:*
```yaml
volumes:
  - ./config/MyProject.ttl:/app/config/project.ttl:ro
```

*.env:*
```env
KNX_TTL_PATH=/app/config/project.ttl
```

**After (new approach):**

*docker-compose.prod.yml (no volume override needed – use base config):*
```yaml
volumes:
  - ./config:/app/config:ro
```

*.env:*
```env
KNX_TTL_FILE=MyProject.ttl
```

**Steps to migrate:**
1. Update your `.env` file: change `KNX_TTL_PATH=...` to `KNX_TTL_FILE=filename.ttl`
2. Ensure your TTL file is in the `./config` directory
3. Update `docker-compose.prod.yml` to remove the single-file volume mount (inherits from base)
4. Restart the stack: `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`

2026-06-24
----------

### Added
- `meta.hasCurrentState` flag in datapoint resources to distinguish online
  (runtime state exists) from offline (semantic/TTL-only) datapoints.
- Semantic datapoint mappings are now exposed via `/datapoints` collection endpoint
  even before the first KNX telegram arrives, enabling clients to discover full
  datapoint inventory (including group addresses) without waiting for bus activity.
- Add platform notes for Raspberry Pi regarding TimescaleDB auto-tuning
- **`GET /api/v2/openapi.yaml`** — new endpoint serving the raw OpenAPI specification
  (from `knxiot_api_openapi.yaml` at runtime); browser-compatible, no strict Accept header required.
  `knxiot_api_openapi.yaml` added to Docker runtime image via `Dockerfile` `COPY` instruction.
- **`GET /docs`** — Swagger UI integrated via `swagger-ui-express`, loads spec from
  `/api/v2/openapi.yaml`; interactive API exploration available in the browser.
- **`GET /api/v2/node` – currentSubscriptions metric** now aggregates both persistent
  (database) and runtime (WebSocket) subscriptions:
  - `SubscriptionStore.countActive({ includeExpired })` — new method to efficiently count
    non-expired active subscriptions from the database.
  - `MessagingWebSocketServer.getActiveSubscriptionCount()` — new method to report the
    number of currently connected WebSocket clients.
  - `/node` endpoint now sums DB subscriptions (valid/non-expired) and active WS clients
    to report `currentSubscriptions`, providing a complete real-time view of all subscription types.

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
- Accept-header validation now exempts OpenAPI spec endpoints (`/api/v2/openapi.yaml`,
  `/api/v2/openapi.json`, `/api/v2/openapi`) and Swagger UI (`/docs`) from strict
  JSON:API `Accept` enforcement, enabling direct browser access.
- **`PUT /api/v2/datapoints/values`** – `type` field in each `data[]` item is now
  validated; requests with `type !== "datapoint"` are rejected with HTTP 400.
- **`PUT /api/v2/datapoints/by-ga`** – same `type` validation added for consistency.
- **`PUT /api/v2/datapoints/values`** – fixed a latent `ReferenceError` in
  `writeDatapointValue()`: invalid DPT now correctly returns
  `{ error: { status: 400, … } }` instead of calling `res.status()` which is not
  available in that helper context.

### Removed
- **`PUT /api/v2/datapoints`** – vendor-extension single-write endpoint removed;
  use `PUT /api/v2/datapoints/values` (spec-compliant bulk write, responds 204)
  or `PUT /api/v2/datapoints/by-ga` (write by group address) instead.

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

2026-06-14
----------

### Added
- Initial changelog file (this file).

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

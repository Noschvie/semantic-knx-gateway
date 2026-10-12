# Changelog

All notable changes to this project will be documented in this file.

The format is based on "Keep a Changelog" and aims to make it easy for
contributors and users to follow meaningful changes over time.

Unreleased
----------

### Fixed
- **Missing KNX DPT name mappings caused HTTP 400 on write** — Writing to a
  datapoint whose DPT is expressed as a symbolic ETS name (e.g. `value1Ucount`)
  failed with `400 Bad Request – Unknown or unsupported DPT: value1Ucount`
  because the name was not present in `DPT_NAME_MAP`.

  **Resolution** (`src/utils/dpt-map.js`):
  - Added the missing 1-byte counter names: `value1Ucount` → `5.010`,
    `value1Count` → `6.010`, plus `percentV8` → `6.001`.
  - Added the missing 4-byte counter names: `value4Ucount` → `12.001`,
    `value4Count` → `13.001`.
  - Corrected `valueTempF` from the wrong `9.010` (time) to the standard
    `9.027` (`DPT_Value_Temp_F`).

- **32-bit counter-values decoded as float on write** — `decodeValueForKnx()`
  (`src/api/routes/helpers/knx-iot-dpt.js`) now decodes DPT main groups `12`
  and `13` via `parseInt()` (integer), matching the newly added
  `value4Ucount`/`value4Count` mappings, instead of falling through to the
  generic numeric `default` branch.

### Changed
- **Clearer diagnostics for unknown/unsupported DPTs on write**
  (`src/api/routes/datapoints.js`):
  - `normalizeDpt()` now logs an explicit warning when a symbolic DPT name is
    not found in `DPT_NAME_MAP`, including the offending name and a hint to add
    the mapping in `src/utils/dpt-map.js`.
  - `writeDatapointValue()` enriches the `400 Bad Request` response and log
    entry with the group address and datapoint name and distinguishes an
    unmapped symbolic name from a malformed numeric DPT.

- **Datapoint mapping access moved into the storage layer** — The direct
  `SELECT ... FROM datapoint_mappings` access in the datapoints API route was
  moved behind `StateStore.getDatapointMappings()` / `StateEngine.getDatapointMappings()`.
  This keeps the HTTP layer free of raw DB queries and aligns datapoint mapping
  access with the existing `StateStore` / `EventStore` abstraction pattern.

2026-10-11
----------

### Fixed
- **Duplicate Datapoints per Group Address** — `GET /api/v2/datapoints` (and
  `/:id`, `/:id/timeseries`) could return two datapoint resources for a single
  group address: the projected one (e.g. `meta.datapointId = "GA-471"`) plus a
  synthetic, derived one (e.g. `ga-2-4-0`). The derived entry originates from a
  telegram processed before its mapping was loaded, so the state engine persisted
  a fallback state under `ga-<a>-<b>-<c>`.

  **Root cause:** The API union keyed datapoints purely by `datapointId`, so the
  synthetic and canonical ids never collapsed onto a single resource, and the
  command path (`PUT /datapoints/values` via resource UUID) and status path
  (WS-Subscribe/Read via `meta.datapointId`) could resolve to different datapoints.

  **Resolution (API-only, no database changes):**
  - **API canonicalization** (`src/api/routes/datapoints.js`): Extracted the
    duplicated union logic into a shared `buildDatapointUnion()` helper. When a
    projected mapping exists for a GA, runtime states are canonicalized onto the
    mapping's `datapointId` so a GA now yields **exactly one** resource (the last
    known value is preserved under the canonical id).
  - **Conflict resolution:** When multiple states collapse onto the same
    canonical key, the one with the newest `updatedAt` wins (also fixes a latent
    "oldest wins" overwriting in the union map).

  **Impact:**
  - ✅ `filter[ga]=<GA>` now returns a single, canonical datapoint.
  - ✅ Command and status paths resolve to the same datapoint: writes resolve the
    UUID against `datapoint_mappings`, and telegrams are emitted under the
    canonical `datapointId`.
  - ✅ No database migration required. A pre-existing synthetic `current_state`
    row remains as harmless, API-invisible data and is superseded once the
    canonical datapoint has a newer value.

- **Stale duplicate datapoints after GA re-assignment / removal in ETS** — Two
  further duplicate-per-GA classes are now handled:
  - **GA drift:** When a datapoint is moved to a new group address in ETS, the
    persisted `current_state` kept its old `ga`, so the datapoint appeared under
    the old GA in the API (and command/status paths diverged).
    `StateEngine.registerDatapoint()` now updates `current_state.ga` when a
    datapoint's GA changes, and a new startup step
    `StateEngine.reconcileStateGaDrift()` (Phase 3b, in `src/index.js`) aligns any
    already-drifted rows in bulk (value-preserving; only the `ga` column is
    corrected).
  - **Orphaned mappings:** `datapoint_mappings` was never cleaned on import, so a
    datapoint removed from ETS (or moved off a GA) left a stale mapping — a
    second, obsolete datapoint for that GA. `SemanticMapper.pruneOrphanedMappings()`
    now removes mappings (and their `current_state`) whose datapointId was not
    part of the latest TTL import. It is **opt-in** via `IMPORT_PRUNE_ENABLED`
    (default `false`, destructive) and guarded against empty imports.
  - Existing databases can be cleaned by the startup reconciliation on the next
    restart, or manually via `scripts/diagnose-duplicate-datapoints.sql` /
    `scripts/cleanup-duplicate-datapoints.sql` and the
    `scripts/check-ga-datapoints.sh` probe.


### Added
- **Import Warning for Multiply Mapped Group Addresses** — Surfaces ETS
  projection errors where one group address is mapped to more than one datapoint:

  **Why:** A group address is normally projected to a single datapoint. When two
  datapoints (e.g. from different functions) share the same GA, the API returns
  two resources for that GA, and the client/BFF must pick one — command and status
  paths can then diverge. The existing `detectDptConflicts()` only fires on
  *different* DPTs, so same-DPT duplicates (e.g., both `scaling`) went unnoticed.

  **What** (`src/semantic/semantic-mapper.js`): During the TTL import,
  `warnMultiplyMappedGAs()` groups the collected mappings by GA and logs a
  warning for every GA that resolves to more than one datapointId, e.g.:
  ```
  [Projection] ⚠️ GA 2/3/12 is mapped to 2 datapoints: GA-445 ("Treppe Position in %"), GA-531 ("Zimmer") — check ETS projection (a group address should map to a single datapoint)
  ```
  followed by a summary count. This is **logging only** — no hard failure and no
  `UNIQUE(ga)` constraint — so legitimate n:1 projections are not blocked while
  data-quality issues become visible in the startup log.

- **Automatic Fallback-State Reconciliation on Startup** — Self-healing of
  duplicate datapoints without manual SQL:

  **Why:** In practice the timing window cannot be avoided — new GAs are
  commissioned in ETS and start sending telegrams while the running gateway
  still has the old TTL, so synthetic `ga-<a>-<b>-<c>` states are persisted.
  After the TTL/project file is replaced and the container restarted, these
  become duplicates of the projected datapoint.

  **What:** During startup, **after** the TTL import and **before** connecting
  the KNX bus (new "Phase 3b" in `src/index.js`), the gateway now reconciles
  synthetic `current_state` rows onto their canonical `datapointId`
  (value-preserving; on conflict the newest value by `updated_at` wins). Only
  synthetic rows that have a matching mapping are touched — genuine unprojected
  datapoints are left intact.

  **Implementation** (`src/state/state-engine.js`):
  - `reconcileFallbackStates({ windowMinutes })` — finds synthetic-with-mapping
    rows via a targeted join and migrates them.
  - `migrateFallbackState(ga, canonicalId)` — value-preserving per-row migration
    (rename when no canonical row exists; copy the newest value and drop synthetic on
    conflict).

  **Configuration** (`env.example`):
  - `DATAPOINT_RECONCILE_ON_START` (default `true`) — enable/disable the startup
    reconciliation.
  - `DATAPOINT_RECONCILE_WINDOW_MINUTES` (default `60`) — only reconcile rows
    updated within the last N minutes; `0` = no limit (reconcile all).

  **Benefits:**
  - ✅ Duplicates are corrected automatically after a TTL replacement and restart.
  - ✅ Time-bounded by default (last 60 min) to target the latest commissioning.
  - ✅ Same value-preserving logic as the manual cleanup script; no bus impact
    (runs before Phase 4 connection).

2026-09-12
----------

### Changed
- **Dependency Update**: Replaced `adm-zip` with `fflate` for ZIP file handling
  - `fflate` provides better performance and a smaller bundle size
  - Fully compatible with existing ZIP import/export functionality

2026-08-31
----------

2026-07-29
----------

### Changed
- **Environment Variable Naming Convention Standardization (BREAKING CHANGE)** — Unified naming pattern for all boolean feature flags:
  
  **Renamed Variables:**
  - `KNX_SECURE` → `KNX_SECURE_ENABLED` (set to `true` to enable KNX IP Secure tunneling)
  - `KNX_READONLY` → `KNX_READONLY_ENABLED` (set to `true` to enable read-only mode)
  - `PRETTY_LOGS` → `PRETTY_LOGS_ENABLED` (set to `true` to enable pretty console logging)
  
  **Naming Convention Established:**
  - **Feature Flags**: `<MODULE>_<FEATURE>_ENABLED` — boolean variables that activate features when set to `true`
    - `KNX_SECURE_ENABLED`, `PRETTY_LOGS_ENABLED`, `KNX_READONLY_ENABLED`
  - **Disable Flags**: `<MODULE>_DISABLED` — boolean variables that deactivate subsystems when set to `true`
    - `KNX_DISABLED`, `OAUTH_DISABLED` (unchanged, already follow this pattern)
  
  **Migration Required:**
  Users must update their `.env` files and Docker configurations:
  ```bash
  # Before
  KNX_SECURE=false
  KNX_READONLY=false
  PRETTY_LOGS=true
  
  # After
  KNX_SECURE_ENABLED=false
  KNX_READONLY_ENABLED=false
  PRETTY_LOGS_ENABLED=true
  ```
  
  **Updated Documentation:**
  - `env.example` — All environment variable examples updated
  - All error messages and log output are updated to reference new variable names
  - Test suite fully migrated to the new naming convention
  
  **Files Modified:**
  - `env.example` — Configuration template
  - `src/knx/tunnel-options.js` — KNX Secure mode detection
  - `src/knx/tunnel-manager.js` — Read-only mode enforcement
  - `src/utils/logger.js` — Pretty logging configuration
  - `src/index.js` — Startup logging messages
  - `src/api/routes/datapoints.js` — Read-only error responses
  - `test/unit/test-tunnel-options.js` — All unit tests updated
  
  **Benefits:**
  - ✅ Consistent naming across all boolean configuration options
  - ✅ Clearer intent: `_ENABLED` for features, `_DISABLED` for protections
  - ✅ Easier maintenance and documentation
  - ✅ Reduced confusion between enable/disable semantics
  
  **Recommendation:**
  Target this change for the next **Major version release** to clearly signal the breaking change to users.

### Added

- **Bus Protection & Graceful Degradation** — Administrative control over KNX bus connectivity:
  
  **New Environment Variables:**
  - `KNX_DISABLED` (default: `false`) — Completely disable KNX tunnel connection without stopping API/DB/Semantic layers
    - Use case: maintenance windows, dry-run/testing environments, protecting the bus during diagnostics
    - All KNX write operations return HTTP 503 with error code `KNX_DISABLED`
    - Incoming telegrams are not processed; the system operates in pure database/API mode
  - `KNX_READONLY` (default: `false`) — Keep a tunnel connected but block outgoing writes (listen-only mode)
    - Use case: troubleshooting write issues, monitoring-only deployments, temporary read-only access
    - All KNX write operations return HTTP 403 with error code `KNX_READONLY`
    - Incoming telegrams are still processed and stored in the database
  
  **Implementation Details:**
  - `TunnelManager` checks both flags on startup and in `write()` method
  - Write errors throw custom exceptions with specific error codes (`KNX_DISABLED`, `KNX_READONLY`)
  - `DatapointsRouter` catches these errors and returns appropriate HTTP status codes and error payloads
  - Startup logging shows the current mode: 🚫 for disabled, 🔒 for read-only, or normal mode
  - Configuration documented in updated `env.example`
  
  **Benefits:**
  - ✅ Bus protection without full shutdown (API remains available for clients)
  - ✅ Zero-breaking-change feature (defaults to false, backward compatible)
  - ✅ Clear error messages and HTTP status codes for client applications
  - ✅ Useful for multi-tenant environments or controlled rollouts

- **Structured Logging Enhancement** — Improved observability and debugging:
  
  **Migration from Console Logging:**
  - Replaced ad-hoc `console.log()`, `console.error()`, `console.warn()` with structured logger calls
  - Affected modules: `src/api/routes/datapoints.js` (primary implementation)
  - Logger uses a consistent format: `{ msg: '...', key: value, error: err.message }`
  - Allows downstream log aggregation tools to parse and filter structured fields
  
  **New Log Points in DatapointsRouter:**
  - `getDatapointMappings()` — Query failures logged with context
  - `writeDatapointValue()` — Comprehensive instrumentation:
    - Info: datapoint not found (404 case)
    - Warn: datapoint not writable, missing metadata, unknown DPT, value decode failures
    - Warn: KNX write blocked due to `KNX_DISABLED` or `KNX_READONLY`
    - Error: tunnelManager unavailable, KNX write failed
    - Error: state update failure after successful KNX writing (non-fatal, logged but still returns success)
  
  **Emoji Prefixes for Visual Debugging:**
  - 🚫 — KNX bus disabled or write rejected
  - 🔒 — Read-only mode restrictions
  - ❌ — Fatal errors (KNX write failed)
  - Non-fatal warnings for client-side issues (bad input, missing metadata)
  
  **Benefits:**
  - ✅ Better root-cause diagnosis for API failures
  - ✅ Clearer distinction between recoverable and fatal errors
  - ✅ Structured fields enable downstream alerting and metrics extraction
  - ✅ Emoji prefixes make log scanning easier in high-volume environments

### Changed
- **CHANGELOG.md cleanup** — Removed redundant "2026-07-16" section (duplicate date marker)

2026-07-17
----------

### Added
- **KNX IP Secure Tunneling Integration** — Enterprise-grade encrypted KNX communication:
  
  **Architecture & Security:**
  - Full support for KNX IP Secure (encrypted, authenticated tunneling per spec KNX/IP 1.0a §3.9)
  - Delegation of all cryptographic work to KNXUltimate library (KNXClient handles a secure session establishment)
  - Environment variable-based mode selection: `KNX_SECURE=true/false` for zero-code switching
  
  **TunnelOptions Module** (`src/knx/tunnel-options.js`):
  - `createTunnelOptions(logger)` function evaluates `KNX_SECURE`, `KNX_HOST_PROTOCOL`, `KNX_KEYRING_FILE`, `KNX_KEYRING_PASSWORD`
  - **Classic Mode (default)**: No behavioral change, fully backward compatible
  - **Secure Mode**: Requires an ETS keyring file and password; forces TunnelTCP transport
  - Fail-fast validation: errors are thrown immediately if required env vars are missing /invalid (before a connection attempt)
  - Returns fully initialized KNXClient options object ready for a tunnel establishment
  
  **Integration with TunnelManager:**
  - `tunnel-manager.js` calls `createTunnelOptions()` in `connect()` method (line 61)
  - Automatic mode detection logged on connection: "Classic (TunnelUDP)" or "Secure (TunnelTCP)"
  - The success message differs for Secure: "✅ KNX connected — Secure session established" vs. "KNX connected"
  - All reconnection logic (health check, queue processing) works identically in both modes
  
  **Environment Variables:**
  - `KNX_SECURE`: Set to `true` to enable KNX IP Secure (default: `false`)
  - `KNX_HOST_PROTOCOL`: Transport protocol (`TunnelUDP` or `TunnelTCP`, default: `TunnelUDP`)
  - `KNX_KEYRING_FILE`: Path to ETS keyring file (`.knxkeys`) — required if `KNX_SECURE=true`
  - `KNX_KEYRING_PASSWORD`: Password protecting the keyring — required if `KNX_SECURE=true`
  - All documented in updated `env.example`
  
  **Documentation:**
  - Comprehensive integration specification in `docs/specifications/KNX_IP_Secure_Integration_Specification.md`
  - Architecture overview, spec references, implementation details, and security rationale
  - Configuration troubleshooting guide and operational runbook
  
  **Testing:**
  - Unit tests in `test/unit/test-tunnel-options.js` covering mode selection, validation, and error handling
  - Integration tests in `test/integration/knx-secure.test.sh` for end-to-end connectivity
  - Test utilities and scripts in `scripts/run-unit-tests.sh` and `scripts/test-knx-secure-integration.sh`
  
  **Benefits:**
  - ✅ Enterprise-ready security for sensitive KNX deployments
  - ✅ Zero-breaking-change adoption: existing classic deployments unaffected
  - ✅ Seamless mode switching via environment variables (no code changes)
  - ✅ Full reuse of reconnection resilience (auto-reconnect, queue, health check) in both modes
  - ✅ Fail-fast validation prevents runtime connection failures
  
- **TTL Loader Topology Enhancements** — Improved RDF parsing and device organization (since July 9):
  - **Enhanced Floor & Room Handling**: Automatic fallback for non-hierarchical structures (Building → Room without Floor)
  - **Device Collection Improvements**: More robust device URI extraction and context tracking
  - **Topology Logging**: Comprehensive logging for building, floor, room, and device counts for debugging
  - **Label Retrieval Refactoring**: Centralized private `#getLabel()` method using RDF namespaces (DC.title, RDFS.label, KNX.label)
  - **Address Normalization**: Enhanced `#normalizePhysAddress()` supporting hex, dot-notation, and invalid format handling
  - **Improved Debugging**: Debug-level logging for device mapping to rooms/floors/buildings
  
  **Files Modified:**
  - `src/semantic/ttl-loader.js` — Phase 1 (device collection), Phase 2 (topology building), private methods refactoring

- **Enhanced KNX IoT Test Suite** — Improved validation and error handling:
  - `scripts/test-knx-iot.sh` — Enhanced datapoint validation with comprehensive error handling
  - Better state change verification and messaging for test outcomes
  - Improved test result reporting for API integration testing

- **Database Statistics & Health Monitoring** — Encapsulated statistics operations:
  - **New `StatisticsStore` Class** (`src/storage/statistics-store.js`): Encapsulated database statistics operations
  - **Integration**: Integrated into `StatisticsLogger` for unified statistics handling
  - **Data Integrity Checks**: Null value handling, sanitization, and comprehensive validation
  - **Enhanced Database Summary**: Improved null handling in aggregation queries with default values
  - **Health Check Script Enhancements**:
    - Local mode support for direct database queries
    - API integration for health check verification
    - Better error handling and data validation
  - **Scripts Updated:**
    - `scripts/database-summary.sh` — Improved API URL handling, JSON validation
    - `scripts/db-health-check.sh` — Typo fixes, enhanced duplicate GA count retrieval
  
  **Benefits:**
  - ✅ More reliable database monitoring and statistics collection
  - ✅ Better error recovery and null value handling
  - ✅ Improved observability for database state and health

- **Advanced Data Quality Analytics – Phase 1** — Anomaly detection and NULL pattern analysis:
  
  **New StatisticsStore Methods:**
  - `getAnomalies(dpt, delta, since, limit)` — Detects temperature/value jumps using SQL `LAG()` window function
    - Calculates delta (absolute change) and delta_percent (percentage change)
    - Severity classification: `high` (> delta), `medium` (> delta/2), `low` (> delta/2)
    - Time gap analysis between consecutive measurements
    - Returns JSON:API response with `meta`, `data`, and `summary`
  
  - `getNullPatterns(dpts, since)` — Analyzes NULL value patterns temporally and spatially
    - **Temporal analysis**: NULL counts grouped by minute-of-hour (detects synchronized issues)
    - **Spatial analysis**: NULL counts grouped by group address (detects sensor communication errors)
    - Automatic diagnosis: likely causes and confidence scores
    - Actionable recommendations for remediation
  
  - `getDatapointSummary(datapointId, since)` — Comprehensive time-series statistics
    - 24-hour window: count, avg, min, max, stddev, median, quartiles (Q1, Q3)
    - 7-day window: measurements, values, anomaly count
    - Current state: latest value, age in seconds, status flag
    - Trend analysis: direction (rising/falling/stable), percentage change
  
  **REST API Endpoints:**
  - `GET /api/v2/stats/anomalies?dpt=9.001&delta=2.0&hours=24&limit=50` — Anomaly detection
    - Query parameters: `dpt` (sensor type), `delta` (threshold), `hours` (time window), `limit` (max results)
  
  - `GET /api/v2/stats/null-patterns?dpts=9.001,9.007&hours=24` — NULL pattern analysis
    - Query parameters: `dpts` (comma-separated DPT types), `hours` (time window)
  
  - `GET /api/v2/stats/datapoints/:id?hours=24` — Datapoint summary by ID or GA
    - Query parameters: `hours` (lookback period)
    - Path parameter: `:id` (datapoint ID or group address, e.g., '3/6/1')
  
  **Timestamp Conventions (Vendor Extensions):**
  - All responses follow a dual-timestamp format per `API_TIMESTAMP_CONVENTION.md`
  - UTC (ISO 8601): `timestamp` field for machine processing
  - Local time: `timestamp_local` field (Europe/Berlin) for developer readability
  - Example: `"timestamp": "2026-07-15T14:30:00Z", "timestamp_local": "15. Juli 2026 16:30:00"`
  
  **Benefits:**
  - ✅ Proactive detection of sensor malfunctions before critical failures
  - ✅ Root-cause diagnosis: distinguish network issues from sensor faults
  - ✅ Time-series analytics for trend monitoring and forecasting
  - ✅ Improved UX with dual timestamps (UTC for APIs, local for logs/debugging)
  - ✅ No performance impact: uses efficient SQL window functions and aggregations

- **Improved GitHub Workflows** — Enhanced CI/CD pipeline configuration:
  - **Dependency Audit Workflow**: Upgraded to latest action versions (checkout@v7, setup-node@v6), increased security level to `high`, and improved error handling
  - **Dependabot Configuration**: Enhanced with better labels, explicit commit message formatting, automatic rebase strategy, and staggered scheduling (npm on Monday, GitHub Actions on Tuesday)
  - **Create Release Workflow**: Updated to the latest action versions for consistency

- **Database Management API – Test Suite** — Comprehensive test coverage for database maintenance endpoints:
  - Automated test script in `scripts/test-database-management-api.sh`
  - Tests for all Phase 1 & 2 endpoints: health checks, database statistics, cleanup jobs, event purging, and optimization
  - Detailed documentation in `docs/DATABASE_MANAGEMENT_API_TESTS.md`
  - Includes operational impact assessment and performance considerations

- **KNX Connection Resilience & Automatic Reconnection** — Robust handling of network interruptions:

  **Automatic Reconnection Strategy:**
  - Phase 1: Exponential backoff for the first 10 attempts (2s, 4s, 6s, ..., 30s)
  - Phase 2: Persistent retry every 30 seconds indefinitely (never gives up)
  - **Never terminates**: System continues reconnecting forever until connection restored
  - Configuration via constants: `MAX_RECONNECT_ATTEMPTS`, `INITIAL_RECONNECT_DELAY_MS`, `MAX_RECONNECT_DELAY_MS`, `PERSISTENT_RECONNECT_INTERVAL_MS`

  **Outgoing Telegram Queue with FIFO Drop Policy:**
  - New `TelegramQueue` class (`src/knx/telegram-queue.js`) implements FIFO queue for outgoing writes
  - Max queue size: 100 (constant `MAX_QUEUE_SIZE`, configurable)
  - **FIFO Drop policy**: When the queue is full, the oldest telegram is dropped to make room for the newest
  - Write API requests return 200 OK even during disconnect (telegram queued for later delivery)
  - Queue automatically processes on reconnection (sends all queued telegrams in FIFO order)
  - Logging for queue status and dropped telegrams

  **Health Check:**
  - Periodic health check every 30 seconds (constant `HEALTH_CHECK_INTERVAL_MS`)
  - Detects silent connection losses (a connection object still exists but is no longer responsive)
  - Triggers automatic reconnection flow on detection

  **Event Emission:**
  - After 10 failed reconnection attempts, the system switches to persistent 30s retry mode
  - Event `knx:max-reconnect-attempts` emitted for admin alerting (email, SMS, dashboard notification)

  **Implementation Details:**
  - `TunnelManager.connect()` — Attempts connection with 10s timeout
  - `TunnelManager.scheduleReconnect()` — Manages exponential backoff + persistent retry
  - `TunnelManager.write()` — Queues telegrams if disconnected (never throws error)
  - `TunnelManager.processQueuedTelegrams()` — Sends all queued telegrams after reconnection
  - `TunnelManager.startHealthCheck()` / `stopHealthCheck()` — 30s health monitoring
  - All constants defined at top of `src/knx/tunnel-manager.js` for easy tuning

  **Documentation:**
  - Comprehensive guide in `docs/KNX_RECONNECT_RESILIENCE.md`
  - State transition diagram showing phases and flows
  - Usage examples for API requests during disconnect
  - Configuration and troubleshooting guide
  - `TelegramQueue` API reference with all methods

- **Duplicate Datapoints Prevention** — Filters orphaned states from API responses:
  - API no longer returns stale datapoints when switching KNX systems
  - Orphaned states (without corresponding datapoint_mappings) are automatically ignored
  - Affected endpoints: `GET /api/v2/datapoints`, `GET /api/v2/datapoints/:id`, `GET /api/v2/datapoints/:id/timeseries`
  - Documentation in `docs/DUPLICATE_DATAPOINTS_PREVENTION.md`

- **DPT History Database Views** — Performance optimization for DPT lookups:
  - New views: `v_dpt_current` (current DPT for each GA), `v_dpt_history` (complete change timeline)
  - `getDptAtTime()` now uses `v_dpt_history` view for efficient historical lookups
  - `getCurrentDptMap()` NEW method uses `v_dpt_current` for O(1) DPT lookups
  - `detectDptConflicts()` now O(n) instead of O(n²) using `getCurrentDptMap()`

- **TelegramQueue Class** — Separated queue logic from TunnelManager:
  - New file: `src/knx/telegram-queue.js`
  - FIFO queue with automatic drop policy
  - Methods: `push()`, `shift()`, `drain()`, `clear()`, `isEmpty()`, `isFull()`, `getStats()`, `getAll()`, `length`
  - Thread-safe for Node.js single-threaded environment
  - Testable in isolation, reusable in other contexts

- **Connection Constants** — Centralized configuration for KNX reconnection:
  - `HEALTH_CHECK_INTERVAL_MS = 30000` — Health check every 30 seconds
  - `INITIAL_RECONNECT_DELAY_MS = 2000` — Start with 2-second backoff
  - `MAX_RECONNECT_DELAY_MS = 30000` — Cap backoff at 30 seconds
  - `MAX_RECONNECT_ATTEMPTS = 10` — Switch to persistent mode after 10 attempts
  - `PERSISTENT_RECONNECT_INTERVAL_MS = 30000` — Persistent retry every 30 seconds
  - `MAX_QUEUE_SIZE = 100` — Maximum outgoing telegram queue size
  - All are configurable at top of `src/knx/tunnel-manager.js`

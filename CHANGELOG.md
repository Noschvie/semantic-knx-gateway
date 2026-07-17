# Changelog

All notable changes to this project will be documented in this file.

The format is based on "Keep a Changelog" and aims to make it easy for
contributors and users to follow meaningful changes over time.

Unreleased
----------

2026-07-17
----------

2026-07-16
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
 
- **DPT Change History Tracking & Conflict Detection** — New audit trail for datapoint type (DPT) changes:
  
  **Database Schema:**
  - New `dpt_change_log` table tracking all DPT modifications per group address
  - Columns: `id`, `datapoint_id`, `ga`, `old_dpt`, `new_dpt`, `changed_at`, `changed_by`, `reason`, `metadata`
  - Indexed on `(ga, changed_at DESC)` and `(datapoint_id, changed_at DESC)` for efficient lookups
  - Automatically created on startup if missing
  
  **DPT History Manager** (`src/storage/dpt-history.js`):
  - `logDptChange(datapointId, ga, oldDpt, newDpt, changedBy, reason)` — Log a DPT change with audit trail
  - `getDptAtTime(ga, timestamp)` — Retrieve the DPT that was active at a specific point in time (for historical value interpretation)
  - `getDptHistory(ga)` — Fetch complete change history for a group address
  - `detectDptConflicts(newMappings)` — Detect conflicts before applying new mappings:
    - **Type 1**: DPT changes for existing group addresses (warns before applying)
    - **Type 2**: Multiple datapoints with different DPTs for the same GA in import (error condition)
  - `getStatistics()` — Aggregate statistics (total changes, affected GAs, last change timestamp)
  
  **State Engine Integration** (`src/state/state-engine.js`):
  - DptHistoryManager initialized in constructor
  - `registerDatapoint()` detects DPT changes and logs them with reason "DPT changed during mapping update"
  - Supports initial DPT recording for new group addresses
  
  **Semantic Mapper Integration** (`src/semantic/semantic-mapper.js`):
  - Conflict detection performed **before** applying new mappings during TTL import
  - All detected conflicts are logged as warnings; import continues safely
  - Each datapoint registration triggers DPT change logging if DPT differs

  **TTL Loader Integration** (`src/semantic/ttl-loader.js`):
  - Constructor remains clean and simple (no dependencies injected)
  - Works independently as an RDF parsing utility
  - DPT conflict detection is handled by `SemanticMapper` using `DptHistoryManager.detectDptConflicts()`
  - Backward compatible with the existing codebase
  
  **Diagnostic Tools:**
  - `scripts/dpt-history-check.sh` — Check table status, view statistics, verify consistency
  - Supports `--log` (recent changes), `--stats` (detailed overview), `--consistency` (mismatch detection)
  
  **Benefits:**
  - ✅ Full audit trail of who changed what DPT and when
  - ✅ Historical values are always interpreted with the correct DPT context
  - ✅ Conflict detection prevents data corruption during TTL imports
  - ✅ Enables debugging of DPT-related issues (e.g., why a value appears wrong)
  
  **Use Cases Now Supported:**
  - Renaming a group address (no DPT logging triggered)
  - Changing DPT for existing GA (logged with old→new DPT tracking)
  - Importing a new TTL file with DPT changes (conflicts detected, logged, safely applied)
  - Interpreting historical states with correct DPT (via `getDptAtTime()`)

- **API Response Enhancement: Historical DPT Tracking** – KNX vendor-specific extension to datapoint responses:
  
  **Field Addition:**
  - New `knx:dptAtCapture` field in response `meta` object (KNX vendor-specific namespace prefix)
  - Shows the DPT that was active when a historical value was captured
  - Added to all datapoint and timeseries endpoints for accurate historical value interpretation
  
  **Integration Points:**
  - `GET /api/v2/datapoints/` — Lists all datapoints with `knx:dptAtCapture` if DPT differs from current
  - `GET /api/v2/datapoints/{id}` — Single datapoint with historical DPT context
  - `GET /api/v2/datapoints/{id}/timeseries` — Each timeseries entry includes `knx:dptAtCapture` for its timestamp
  - `GET /api/v2/datapoints/values` — Bulk endpoint with `knx:dptAtCapture` per datapoint
  
  **Spec Compliance:**
  - Fully compliant with KNX IoT 3rd Party API v2.1.0
  - Uses KNX vendor-specific namespace prefix (`knx:`) per spec §2.1.0, line 2793
  - Placed in JSON:API `meta` object (not `attributes`) per spec §2.1.0, line 2805
  - Graceful fallback: omitted if DPT hasn't changed since capture
  
  **Example Response:**
  ```json
  {
    "data": {
      "id": "uuid...",
      "type": "datapoint",
      "attributes": {
        "title": "Temperature",
        "value": "21.5",
        "timestamp": "2026-07-10T10:30:00Z",
        "dpt": "9.001"
      },
      "meta": {
        "@type": ["knx:dpa.418.52"],
        "ga": "1/2/3",
        "dpt": "9.001",
        "knx:dptAtCapture": "10.001"
      }
    }
  }
  ```
  
  **Implementation Details:**
  - Helper function: `toDatapointResourceWithHistoricalDpt()` in `src/api/routes/datapoints.js`
  - Updated transform: `toDatapointResource()` accepts optional `dptAtCapture` parameter  
  - Reuses `DptHistoryManager` instance from StateEngine for API endpoints (consistency & efficiency)
  - Conflict detection happens in `SemanticMapper.mapDatapointsToStateEngine()` via `DptHistoryManager.detectDptConflicts()`
  - DPT logging occurs in `StateEngine.registerDatapoint()` when mapping is registered
  - Uses `DptHistoryManager.getDptAtTime()` to look up historical DPT for responses
  - Non-blocking: gracefully handles missing history (optional enhancement)

### Changed
- **Code Refactoring & Quality Improvements** (since July 9):
  - **TTL Loader Private Methods**: Refactored to use private field syntax (`#getLabel()`, `#getDeviceInfo()`, etc.) for better encapsulation
  - **Removed Unused Methods**: Eliminated unused hex-to-physical address conversion method
  - **Consistency Fixes**: Fixed misplaced commas and inconsistent string formatting in:
    - `src/knx/tunnel-manager.js`
    - `src/storage/subscription-store.js`
    - `src/state/state-engine.js`
    - `src/state/state-store.js`
  - **Logic Simplification**: Simplified `hasState` logic in `src/storage/statistics.js` for better readability
  - **Database Query Alias Corrections**: Updated orphaned states query to use the correct table alias for affected GAs count

2026-07-09
----------

### Added
- **Database Management API (Vendor Extension)** – Comprehensive database maintenance endpoints
  under `/api/v2/database/...` (not in KNX IoT spec, vendor extension):
  
  **Tier 1: Information**
  - `GET /api/v2/database/info` — Real-time database statistics and health metrics:
    - Database size, version, backend capabilities
    - Per-table statistics (rows, sizes, indexes)
    - Event timeline (the earliest/latest event, coverage, average events/day)
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
    - **Critical Warning**: VACUUM FULL causes API downtime; never schedules automatically in production
    - **Authentication**: Bearer token with `delete:database` scope
  
  **Tier 3: Audit**
  - `GET /api/v2/database/cleanup-jobs` — Query audit log of all purge/optimize operations:
    - **Pagination**: `offset`, `limit` (max 100), `total` count
    - **Filtering**: `status` (completed/failed), `days` (last N days, default 30)
    - **Results**: Job ID, operation type, strategy, parameters, execution timestamps, duration, affected tables, statistics
    - **Authentication**: Bearer token with `read` scope
  - `GET /api/v2/database/health` — Simple database connectivity check (no authentication required)

- **Database Maintenance Audit Log** – New persistent table `database_maintenance_log`:
  - Tracks all purge and optimize operations with a full audit trail
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
  Node.js script (`update-changelog-for-release.js`) to automate a release process:
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

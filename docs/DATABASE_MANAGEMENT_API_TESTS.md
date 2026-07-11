# Database Management API – Test Suite

## Overview

This script tests all endpoints of the **Database Management API (Phase 1 & 2)**:

- `GET /api/v2/database/health` - Health Check
- `GET /api/v2/database/info` - Database Statistics
- `GET /api/v2/database/cleanup-jobs` - Audit Log
- `POST /api/v2/database/purge` - Event Deletion
- `POST /api/v2/database/optimize` - VACUUM Operations

## Usage

### Prerequisites

- KNX IoT 3rd Party API running on `http://localhost:3000`
- `curl` and `jq` installed
- Bash 4.0+

### Execution

```bash
cd semantic-knx-gateway
chmod +x scripts/test-database-management-api.sh
./scripts/test-database-management-api.sh
```

## Operational Impact

| Operation | Blocks App? | Reason |
|-----------|-----------|--------|
| `GET /health` | ❌ No | Read-only Query |
| `GET /info` | ❌ No | Read-only Query |
| `GET /cleanup-jobs` | ❌ No | Read-only Query |
| `POST /purge (Dry-Run)` | ❌ No | Read-only Preview |
| `POST /purge (Execute)` | ⚠️ Minimal | Row-level Locks, short duration |
| `POST /optimize (full=false)` | ❌ No | VACUUM ANALYZE runs in parallel |
| `POST /optimize (full=true)` | 🔴 **YES!** | **Exclusive Lock - App goes offline** |

## Test Flow

### Step 1: Health Check
```
GET /health
```
- No authentication required
- Tests database connectivity

### Step 2: OAuth Token
```
POST /oauth/access
  - grant_type: client_credentials
  - scope: read,delete:database
```
- Retrieves token with `delete:database` scope
- Required for all protected endpoints

### Step 3: GET /info
```
GET /info
  (Before Operations)
```
- Shows database statistics before operations
- Database size, table sizes, event timeline

### Step 4: GET /cleanup-jobs
```
GET /cleanup-jobs
  (Before Operations)
```
- Shows audit log before operations
- Typically empty on a fresh start

### Step 5: POST /purge (Dry-Run)
```
POST /purge
  - preset: 90_days
  - dry_run: true
```
- Preview mode
- Shows what would be deleted without actually deleting

### Step 6: POST /purge (Error Test)
```
POST /purge
  - preset: 90_days
  - dry_run: false
  - confirm: false
```
- Should fail with 409 Confirmation Required
- Tests safety mechanism

### Step 7: POST /optimize
```
POST /optimize
  - full: false (default)
  - analyze: true
```
- VACUUM ANALYZE in online mode
- **App stays online**
- Reclaims disk space

### Step 7b: POST /optimize (Optional - VACUUM FULL)
```
POST /optimize
  - full: true
  - analyze: true
```
- **WARNING: App goes offline!**
- Only run during the maintenance window
- Script asks for confirmation before proceeding

### Step 8: GET /cleanup-jobs (After Operations)
```
GET /cleanup-jobs
  - status: completed
```
- Shows executed operations in the audit log
- Documents who, what, when

### Step 9: GET /info (After Operations)
```
GET /info
  (After Operations)
```
- Before/after comparison
- Shows impact of operations

## Security Features

### OAuth2 Scopes
```
read            - GET Endpoints
delete:database - POST Endpoints (Purge, Optimize)
```

### Destructive Operations Protection
```
POST /purge
  1. dry_run=true  → Preview only
  2. dry_run=false + confirm=true → Execute
```

### Audit Logging
```
All operations are logged in database_maintenance_log:
  - Operation (purge/optimize)
  - Status (running/completed/failed)
  - Timestamps
  - Results (JSON)
  - executed_by (OAuth ClientId)
```

## Frequently Asked Questions

### Can the app run during tests?
**Yes!** The standard test uses:
- Read-only operations (GET)
- Purge with row-level locks (short duration)
- VACUUM ANALYZE online-mode

Only VACUUM FULL (optional) requires downtime.

### What's the difference between VACUUM and VACUUM FULL?
```
VACUUM ANALYZE (full=false)
  ✅ Online (App runs)
  ✅ Fast
  ✅ Updates query planner stats
  ⚠️ Reclaims less storage

VACUUM FULL (full=true)
  🔴 Offline (App blocked)
  ⏱️ Slow (depends on DB size)
  ✅ Reclaims maximum storage
  ✅ Complete defragmentation
```

### How often should I run these tests?
- **Health Check**: Daily (Monitoring)
- **Info/Cleanup-Jobs**: Weekly (Audit review)
- **Purge**: As needed (Retention policy)
- **Optimize**: Monthly (Maintenance)
- **VACUUM FULL**: Semi-annually (Maintenance window)

## Troubleshooting

### "❌ Failed to obtain a token"
- OAuth service is not running
- Client credentials are incorrect
- Check: `curl http://localhost:3000/oauth/access -X POST ...`

### "401 Unauthorized"
- Token has expired
- Insufficient scopes
- Bearer header is malformed

### "409 Confirmation Required"
- Purge requires `confirm=true`
- Safety mechanism working correctly

### "Timeout on VACUUM FULL"
- Normal behavior – DB is larger than expected
- Only run during the maintenance window

## Related Resources

- Documentation: `docs/DATABASE_MANAGEMENT.md`
- API Specification: `docs/knxiot_api_openapi.yaml`
- Implementation: `src/storage/database-manager.js`
- Routes: `src/api/routes/database.js`

## Test Script Location

```
scripts/test-database-management-api.sh
```

Run with:
```bash
./scripts/test-database-management-api.sh
```

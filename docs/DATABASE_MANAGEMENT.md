# DATABASE MANAGEMENT API

**Feature Documentation & Implementation Guide**

Version: 1.0  
Status: Planning  
Date: 2026-07-05

---

## 📋 Overview

This document describes the planned **Database Management API** for the Semantic KNX Runtime Engine. It provides:

1. **Database Statistics Endpoint** — Real-time metrics on database size, element counts, and time coverage
2. **Cleanup & Maintenance Endpoints** — Safe data retention and archival operations
3. **Monitoring & Reporting** — History of cleanup operations and database health

This is a **vendor extension** not defined in the KNX IoT specification, registered under `/api/v2/database/...`.

---

## 🎯 Motivation

### Problem Statement

As the KNX engine runs continuously, the TimescaleDB hypertables (`knx_events`, `subscription_events`) grow unbounded:

- **Rapid data accumulation**: 100+ telegrams/second × 24h = ~8M events/day  
- **Storage costs**: 1-2 GB per month per average installation  
- **Query performance**: Uncompressed old data slows time-range queries  
- **Operational visibility**: No API to understand what data is stored where  

### Solution Goals

✅ **Transparency** — Admins can query database size, event coverage, and table statistics  
✅ **Retention Policy** — Delete old events based on date or count thresholds  
✅ **Safe Operations** — Dry-run mode to preview changes before committing  
✅ **Audit Trail** — Log of all cleanup operations for compliance  
✅ **Performance** — TimescaleDB compression of archived chunks  
✅ **Zero-downtime Optimization** — VACUUM ANALYZE runs while API is online  
⚠️ **Full Optimization** — VACUUM FULL available for maintenance windows (requires downtime)  

---

## 🔌 API Endpoints

### Overview: Three-Tier API Design

```
Tier 1: Information
├── GET /api/v2/database/info → Database statistics (tiles)

Tier 2: Maintenance
├── POST /api/v2/database/purge → Delete old events (with presets)
└── POST /api/v2/database/optimize → Reclaim disk space (VACUUM)

Tier 3: Audit
└── GET /api/v2/database/cleanup-jobs → Cleanup history
```

---

### 1. GET `/api/v2/database/info` — Database Statistics

**Purpose**: Retrieve comprehensive database health metrics. Designed for dashboard tiles.

**Authentication**: `Bearer {token}` (scope: `read`)

**Request:**
```http
GET /api/v2/database/info
Authorization: Bearer eyJ0eXAi...
Content-Type: application/vnd.api+json
```

**Response (200 OK):**
```json
{
  "data": {
    "id": "database-info",
    "type": "database-info",
    "attributes": {
      "timestamp": "2026-07-06T14:30:45Z",
      "database": {
        "name": "knx",
        "size_bytes": 2876543210,
        "size_pretty": "2.7 GB",
        "version": "PostgreSQL 16.0 + TimescaleDB 2.14.1"
      },
      "tables": {
        "knx_events": {
          "type": "hypertable",
          "row_count": 15234891,
          "size_bytes": 2145678901,
          "size_pretty": "2.0 GB",
          "index_size_bytes": 123456789,
          "index_size_pretty": "118 MB"
        },
        "subscription_events": {
          "type": "hypertable",
          "row_count": 156234,
          "size_bytes": 45678901,
          "size_pretty": "43.5 MB",
          "index_size_bytes": 2345678,
          "index_size_pretty": "2.2 MB"
        },
        "current_state": {
          "type": "regular",
          "row_count": 4321,
          "size_bytes": 567890,
          "size_pretty": "554 KB"
        },
        "semantic_resources": {
          "type": "regular",
          "row_count": 8932,
          "size_bytes": 12345678,
          "size_pretty": "11.8 MB"
        },
        "datapoint_mappings": {
          "type": "regular",
          "row_count": 4321,
          "size_bytes": 654321,
          "size_pretty": "639 KB"
        },
        "subscriptions": {
          "type": "regular",
          "row_count": 42,
          "size_bytes": 45678,
          "size_pretty": "44.6 KB"
        }
      },
      "events_timeline": {
        "total_events": 15234891,
        "earliest_event": "2025-01-01T08:00:00Z",
        "latest_event": "2026-07-06T14:30:45Z",
        "coverage_days": 552,
        "events_per_day_avg": 27630
      },
      "hypertables": {
        "knx_events": {
          "chunk_count": 123,
          "earliest_chunk": "2025-01-01",
          "latest_chunk": "2026-07-06",
          "compressed_chunks": 98,
          "uncompressed_chunks": 25,
          "compression_ratio": "3.2:1"
        },
        "subscription_events": {
          "chunk_count": 45,
          "earliest_chunk": "2025-09-15",
          "latest_chunk": "2026-07-06",
          "compressed_chunks": 40,
          "uncompressed_chunks": 5,
          "compression_ratio": "2.1:1"
        }
      },
      "subscriptions": {
        "total_subscriptions": 42,
        "active": 38,
        "expired": 4
      }
    }
  }
}
```

---

### 2. POST `/api/v2/database/purge` — Purge Old Events

**Purpose**: Delete old events using configurable retention strategies with presets or custom dates.

**Authentication**: `Bearer {admin_token}` (scope: `delete:database`)

**Request (Preset):**
```http
POST /api/v2/database/purge
Authorization: Bearer eyJ0eXAi...
Content-Type: application/vnd.api+json

{
  "data": {
    "type": "purge-request",
    "attributes": {
      "preset": "90_days",
      "dry_run": true,
      "confirm": false
    }
  }
}
```

**Preset options:** `"30_days"`, `"90_days"`, `"365_days"`, `"custom"`, or `"purge_all"`

**Request (Custom Date):**
```http
POST /api/v2/database/purge
Authorization: Bearer eyJ0eXAi...
Content-Type: application/vnd.api+json

{
  "data": {
    "type": "purge-request",
    "attributes": {
      "preset": "custom",
      "older_than": "2025-09-01T00:00:00Z",
      "dry_run": true,
      "confirm": false
    }
  }
}
```

**Use this preset:** When using `"preset": "custom"`, specify `older_than` as ISO 8601 timestamp

**Request (Delete All):**
```http
POST /api/v2/database/purge
Authorization: Bearer eyJ0eXAi...
Content-Type: application/vnd.api+json

{
  "data": {
    "type": "purge-request",
    "attributes": {
      "purge_all": true,
      "dry_run": true,
      "confirm": false
    }
  }
}
```

**⚠️ WARNING:** `purge_all: true` is irreversible. Always use `dry_run: true` first to preview changes before confirming with `confirm: true`

**Preset Options:**

| Preset | Retention | Use Case |
|--------|-----------|----------|
| `30_days` | Keep last 30 days | Short-term testing |
| `90_days` | Keep last 90 days | Standard (recommended) |
| `365_days` | Keep last 365 days | Long-term analysis |
| `custom` | User-specified date | One-off cleanup |
| `purge_all` | Delete everything | Complete reset |

**Response (Dry-Run, 200 OK):**
```json
{
  "data": {
    "id": "purge-preview-xyz",
    "type": "purge-result",
    "attributes": {
      "dry_run": true,
      "preset": "90_days",
      "older_than": "2026-04-08T12:00:00Z",
      "preview": {
        "tables": {
          "knx_events": {
            "rows_to_delete": 2145678,
            "rows_remaining": 13089213,
            "size_to_free_bytes": 156234567,
            "size_to_free_pretty": "149 MB",
            "percentage": 10.2
          },
          "subscription_events": {
            "rows_to_delete": 45678,
            "rows_remaining": 110556,
            "size_to_free_bytes": 12345678,
            "size_to_free_pretty": "11 MB",
            "percentage": 15.8
          }
        },
        "totals": {
          "total_rows_to_delete": 2191356,
          "total_rows_remaining": 13199769,
          "total_size_to_free_bytes": 168580245,
          "total_size_to_free_pretty": "160 MB"
        },
        "warning": "This will permanently delete 2,191,356 telegrams recorded before 2026-04-08T12:00:00Z"
      },
      "next_step": "Call again with confirm=true to execute"
    }
  }
}
```

**Response (Execution, 202 Accepted):**
```json
{
  "data": {
    "id": "purge-job-6f8b3d2a-1234-5678-9abc-def012345678",
    "type": "purge-result",
    "attributes": {
      "status": "completed",
      "dry_run": false,
      "preset": "90_days",
      "execution": {
        "started_at": "2026-07-06T14:31:00Z",
        "completed_at": "2026-07-06T14:35:15Z",
        "duration_seconds": 255
      },
      "results": {
        "knx_events": {
          "rows_deleted": 2145678,
          "rows_remaining": 13089213,
          "size_freed_bytes": 156234567,
          "size_freed_pretty": "149 MB"
        },
        "subscription_events": {
          "rows_deleted": 45678,
          "rows_remaining": 110556,
          "size_freed_bytes": 12345678,
          "size_freed_pretty": "11 MB"
        }
      },
      "totals": {
        "total_rows_deleted": 2191356,
        "total_rows_remaining": 13199769,
        "total_freed_bytes": 168580245,
        "total_freed_pretty": "160 MB"
      }
    }
  }
}
```

**Error Response (Missing Confirmation):**
```json
{
  "errors": [
    {
      "status": "409",
      "title": "Confirmation Required",
      "detail": "This is a destructive operation. Call with dry_run=false and confirm=true after reviewing the preview."
    }
  ]
}
```

---

### 3. POST `/api/v2/database/optimize` — Reclaim Disk Space

**Purpose**: Optimize a database and reclaim space from deleted rows (PostgreSQL VACUUM).

**⚠️ CRITICAL: Read Before Using**

- **Default (`full: false`)**: VACUUM ANALYZE — Runs online, API stays responsive, safe for daily use
- **Full (`full: true`)**: VACUUM FULL — **REQUIRES MAINTENANCE WINDOW, SYSTEM GOES OFFLINE**

**Authentication**: `Bearer {admin_token}` (scope: `delete:database`)

**Request:**
```http
POST /api/v2/database/optimize
Authorization: Bearer eyJ0eXAi...
Content-Type: application/vnd.api+json

{
  "data": {
    "type": "optimize-request",
    "attributes": {
      "full": false,
      "analyze": true
    }
  }
}
```

**Parameter options:**
- `"full": false` — Online VACUUM (recommended for daily operations)
- `"full": true` — VACUUM FULL (⚠️ requires a maintenance window, the system goes offline)
- `"analyze": true` — Update query planner statistics (recommended)

**⚠️ CRITICAL: VACUUM FULL Impact**

When `full: true`, the database:
- **Goes offline** — Exclusive table lock acquired
- **API becomes unavailable** — All requests fail
- **Stops recording KNX telegrams** — Events are lost during operation
- **Duration**: 10–30 minutes for 10GB databases
- **Should ONLY be scheduled during maintenance windows**

**Response (202 Accepted):**
```json
{
  "data": {
    "id": "optimize-job-abc123",
    "type": "optimize-result",
    "attributes": {
      "status": "completed",
      "execution": {
        "started_at": "2026-07-06T15:00:00Z",
        "completed_at": "2026-07-06T15:02:30Z",
        "duration_seconds": 150
      },
      "results": {
        "size_before_bytes": 2876543210,
        "size_before_pretty": "2.7 GB",
        "size_after_bytes": 2681234567,
        "size_after_pretty": "2.5 GB",
        "space_freed_bytes": 195308643,
        "space_freed_pretty": "186 MB",
        "space_freed_percent": 6.8,
        "method": "VACUUM ANALYZE",
        "tables_optimized": ["knx_events", "current_state", "subscription_events"],
        "downtime_warning": null
      }
    }
  }
}
```

**Response Fields:**
- `method` — Either "VACUUM ANALYZE" (online) or "VACUUM FULL" (requires downtime)
- `downtime_warning` — null if online operation, or warning message if VACUUM FULL was used (e.g., "⚠️ VACUUM FULL: System was offline for 150 seconds")

**Response Example (VACUUM FULL – with downtime warning):**
```json
{
  "data": {
    "id": "optimize-job-xyz789",
    "type": "optimize-result",
    "attributes": {
      "status": "completed",
      "execution": {
        "started_at": "2026-07-07T03:00:00Z",
        "completed_at": "2026-07-07T03:25:00Z",
        "duration_seconds": 1500
      },
      "results": {
        "size_before_bytes": 2876543210,
        "size_before_pretty": "2.7 GB",
        "size_after_bytes": 2234567890,
        "size_after_pretty": "2.1 GB",
        "space_freed_bytes": 641975320,
        "space_freed_pretty": "612 MB",
        "space_freed_percent": 22.3,
        "method": "VACUUM FULL",
        "tables_optimized": ["knx_events", "current_state", "subscription_events"],
        "downtime_warning": "⚠️ VACUUM FULL: System was offline for 1500 seconds (25 minutes)"
      }
    }
  }
}
```

---

### 4. GET `/api/v2/database/cleanup-jobs` — Cleanup History

**Purpose**: Query audit log of all performed purge/optimize operations.

**Authentication**: `Bearer {token}` (scope: `read`)

**Query Parameters:**
- `offset`: Pagination offset (default: 0)
- `limit`: Results per page (default: 20, max: 100)
- `status`: Filter by status (`completed`, `failed`, `simulated`)
- `days`: Show jobs from last N days (default: 30)

**Request:**
```http
GET /api/v2/database/cleanup-jobs?offset=0&limit=20&status=completed
Authorization: Bearer eyJ0eXAi...
Content-Type: application/vnd.api+json
```

**Response (200 OK):**
```json
{
  "data": [
    {
      "id": "cleanup-job-6f8b3d2a-1234-5678-9abc-def012345678",
      "type": "cleanup-job",
      "attributes": {
        "status": "completed",
        "strategy": "retain_days",
        "params": {
          "days": 90
        },
        "dry_run": false,
        "executed_by": "admin@example.com",
        "created_at": "2026-07-04T10:15:00Z",
        "completed_at": "2026-07-04T10:18:45Z",
        "duration_seconds": 225,
        "tables_affected": ["knx_events"],
        "statistics": {
          "rows_deleted": 1234567,
          "size_freed_bytes": 89123456,
          "size_freed_pretty": "85 MB"
        }
      }
    },
    {
      "id": "cleanup-job-9a1b2c3d-4567-890a-bcde-f01234567890",
      "type": "cleanup-job",
      "attributes": {
        "status": "completed",
        "strategy": "older_than_date",
        "params": {
          "before_date": "2026-04-01T00:00:00Z"
        },
        "dry_run": true,
        "executed_by": "admin@example.com",
        "created_at": "2026-06-15T08:30:00Z",
        "completed_at": "2026-06-15T08:32:10Z",
        "duration_seconds": 130,
        "tables_affected": ["knx_events", "subscription_events"],
        "statistics": {
          "rows_deleted": 3456789,
          "size_freed_bytes": 234567890,
          "size_freed_pretty": "223 MB"
        }
      }
    }
  ],
  "meta": {
    "pagination": {
      "offset": 0,
      "limit": 20,
      "total": 34
    }
  ]
}
```

---

## 🎨 Dashboard UI Design

The API supports a dashboard overlay with interactive tiles and controls:

### Storage Info Tiles

Display the current database state with real-time metrics:

```
┌─────────────────────────────────────────────────────────────────┐
│ 📊 DATABASE MAINTENANCE DASHBOARD                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  CURRENT STATUS                                                 │
│  ├─ Backend: PostgreSQL 16.0 + TimescaleDB 2.14.1               │
│  ├─ Size on Disk: 2.7 GB (2,876,543 KB)                         │
│  ├─ Total Telegrams: 15,234,891                                 │
│  └─ Data Coverage: 6 months (552 days)                          │
│                                                                 │
│  TIMELINE INFO                                                  │
│  ├─ Oldest Event:   🕐 2025-01-01 08:00:00 UTC                  │
│  ├─ Newest Event:   🕐 2026-07-06 14:30:45 UTC                  │
│  ├─ Avg Events/Day: 📈 27,630 events                            │
│  └─ Configured Retention: ⏰ 90 days (recommended)              │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  🗑️  PURGE OLD EVENTS (Retention Policy)                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Quick Presets:                                                 │
│  [ 30 days ] [ 90 days ✓ ] [ 365 days ] [ Custom ]              │
│                                                                 │ 
│  Custom Retention Date:                                         │
│  ┌──────────────────────────────────┐                           │
│  │ 2026-04-08 12:00:00 UTC         │ [Edit] [Today]             │
│  └──────────────────────────────────┘                           │
│                                                                 │
│  Actions:                                                       │
│  [Preview] [Dry-Run] [Execute] [⚠️ Delete All]                   │
│                                                                 │
│  Expected Results (dry-run):                                    │                              
│  └─ Would delete: 2,191,356 events (10.2% of data)              │
│  └─ Would free: ~160 MB disk space                              │
│  └─ Time to execute: ~4 minutes                                 │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  ⚙️  OPTIMIZE DATABASE (Reclaim Disk Space)                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │                                                   
│  Current Disk Usage:                                            │
│  [████████░░] 2.7 GB / 4 GB (67.5%)                             │
│                                                                 │
│  VACUUM ANALYZE (online - recommended daily):                   │
│  [ Run VACUUM ANALYZE ]                                         │
│  ├─ Reclaims: ~80-95% of freed space                            │
│  ├─ API Status: ✅ Online during operation                      │
│  ├─ Recording Status: ✅ Continues normally                     │
│  ├─ Lock Type: Shared (non-exclusive)                           │
│  └─ Duration: 2-10 minutes                                      │
│                                                                 │
│  VACUUM FULL (maintenance windows only):                        │
│  [ Schedule VACUUM FULL ]   [ Last Run: 2026-07-01 03:15 UTC ]  │
│  ├─ Reclaims: 100% of freed space                               │
│  ├─ API Status: 🔴 **OFFLINE** during operation                 │
│  ├─ Recording Status: 🔴 **STOPPED** during operation           │
│  ├─ Lock Type: Exclusive (blocks all access)                    │
│  ├─ Duration: 10-30 minutes                                     │
│  ├─ Freed Last Time: 612 MB (22.3%)                             │
│  └─ ⚠️ Schedule only during maintenance windows!                 │
│                                                                 │
│  Last Optimization:                                             │
│  Date: 2026-07-06 02:15 UTC  |  Method: VACUUM ANALYZE          │
│  Space Freed: 186 MB (6.8%)  |  Duration: 150 seconds           │
│  Status: ✅ Completed        |  API Status: ✅ Was online      │
│                                                                 │
│  [View Optimization History] [Configure Schedule]               │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  📋 RECENT MAINTENANCE HISTORY                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  • 2026-07-06 14:35:00  | PURGE (90 days)     | ✅ Completed    │
│  • 2026-07-06 02:15:00  | VACUUM ANALYZE      | ✅ Completed    │
│  • 2026-07-01 03:15:00  | VACUUM FULL         | ✅ Completed    │
│  • 2026-06-15 08:32:00  | PURGE (custom)      | ✅ Completed    │
│                                                                 │
│  [View Full History] [Export Report] [Configure Alerts]         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### UI Capability Flags

Some features depend on backend support:

```javascript
{
  "backend": "postgresql",
  "capabilities": {
    "supports_size_stats": true,       // GET /database/info works
    "supports_optimize": true,         // POST /database/optimize works
    "supports_vacuum_full": true,      // Full vacuum available
    "supports_compression": true,      // TimescaleDB compress
    "supports_dry_run": true,          // Dry-run preview available
    "supports_presets": true           // Retention presets available
  }
}
```

---

## 🛠️ VACUUM & Disk Space Reclamation

### How VACUUM Works

PostgreSQL `VACUUM` reclaims disk space from deleted rows:

```
Before VACUUM:
┌──────────────────────────┐
│ Table File: 100 MB       │
│ ├─ Active rows: 80 MB    │
│ └─ Dead space: 20 MB     │
└──────────────────────────┘

After VACUUM:
┌──────────────────────────┐
│ Table File: 82 MB        │
│ ├─ Active rows: 80 MB    │
│ └─ Unused: 2 MB          │
└──────────────────────────┘

Freed: 18 MB (18%)
```

### VACUUM Options

| Option | Speed | Space Reclaim | Impact | Notes |
|--------|-------|---------------|--------|-------|
| `VACUUM` | Fast | Partial | None | Can run during operation |
| `VACUUM ANALYZE` | Fast | Partial | None | + updates query planner stats |
| **`VACUUM FULL`** | **Slow** | **Complete** | **🔴 API Offline** | **Requires exclusive lock + downtime** |

**Recommendation:** Use `VACUUM ANALYZE` (default) for daily operations:
- ✅ Can run while app is online
- ✅ Reclaims most space (80–95%)
- ✅ Updates statistics for better queries
- ✅ No impact on KNX recording
- ❌ Takes longer than basic VACUUM

**`VACUUM FULL` — Maintenance Windows Only:**
- ❌ API goes offline (all requests fail)
- ❌ KNX telegram recording stops
- ❌ Requires exclusive database lock
- ✅ Frees maximum disk space (100%)
- ✅ Use only after large purge operations (>50% deleted)
- ✅ Schedule during the planned maintenance window
- ⏱️ Typical duration: 10–30 minutes (depends on DB size)

### Typical Reclamation

After purging 2M old events:

| Database Size | Space Freed | Percentage |
|---------------|------------|-----------|
| 500 MB | 45 MB | 9% |
| 2 GB | 150 MB | 7% |
| 10 GB | 650 MB | 6.5% |

---

### VACUUM FULL: Maintenance Windows Only

⚠️ **Critical Impact on Operations**

`VACUUM FULL` acquires an **exclusive lock** on tables and causes:

```
BEFORE VACUUM FULL:
┌─────────────────────────────────────────┐
│ API Status:     🟢 ONLINE               │
│ Telegram Recording: 🟢 RECORDING        │
│ Database:       🟢 ACCEPTING QUERIES    │
└─────────────────────────────────────────┘

DURING VACUUM FULL (10-30 minutes):
┌─────────────────────────────────────────┐
│ API Status:     🔴 OFFLINE              │
│ Telegram Recording: 🔴 STOPPED          │
│ Database:       🔴 LOCKED (no access)   │
│ Clients:        🔴 CONNECTION TIMEOUT   │
│ WebSockets:     🔴 DISCONNECTED         │
└─────────────────────────────────────────┘

AFTER VACUUM FULL:
┌─────────────────────────────────────────┐
│ API Status:     🟢 ONLINE               │
│ Telegram Recording: 🟢 RECORDING        │
│ Database:       🟢 ACCEPTING QUERIES    │
│ Disk Space:     ✅ FREED (100%)         │
└─────────────────────────────────────────┘
```

**When to use VACUUM FULL:**

✅ Schedule during the planned maintenance window (e.g., Sunday 03:00 UTC)  
✅ After large purge operations (deleted >50% of data)  
✅ If disk space is critically low  
✅ Notify users/systems beforehand  

**When NOT to use VACUUM FULL:**

❌ During business hours or active KNX installations  
❌ For routine optimization (use VACUUM ANALYZE instead)  
❌ If continuous data recording is required  
❌ On production systems without testing first  

**Alternative for online optimization:**

Use `VACUUM ANALYZE` instead (default):
- Runs while API is online
- Reclaims ~80–95% of space
- No impact on telegram recording
- Can be scheduled daily at 02:00 UTC

**VACUUM FULL Execution Example:**

```bash
# ⚠️ Schedule during maintenance window only!
# Sunday 03:00 UTC (everyone sleeping)

curl -X POST http://localhost:3000/api/v2/database/optimize \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/vnd.api+json" \
  -d '{
    "data": {
      "type": "optimize-request",
      "attributes": {
        "full": true,
        "analyze": true
      }
    }
  }'

# ⚠️ WARNING: This will take the system OFFLINE! Duration: 10-30 minutes
# Expected response: 202 Accepted
# Monitor /api/v2/database/cleanup-jobs to track progress
```

---

## 📐 Architecture & Implementation

### Implementation Strategy

The implementation uses a facade pattern to abstract backend-specific details:

```
┌─────────────────────────────────────┐
│  Express Routes (database.js)       │
│  ├─ GET /info                       │
│  ├─ POST /purge                     │
│  ├─ POST /optimize                  │
│  └─ GET /cleanup-jobs               │
└────────────┬────────────────────────┘
             │
┌────────────▼────────────────────────┐
│  DatabaseManager (high-level logic) │
│  ├─ getPurgePreview()               │
│  ├─ executePurge()                  │
│  ├─ optimizeDatabase()              │
│  └─ getCapabilities()               │
└────────────┬────────────────────────┘
             │
┌────────────▼────────────────────────┐
│  Backend-specific (PostgreSQL)      │
│  ├─ DELETE FROM knx_events          │
│  ├─ VACUUM ANALYZE                  │
│  └─ pg_database_size()              │
└─────────────────────────────────────┘
```

### New Components

#### 1. `src/storage/database-manager.js`

Core business logic for database maintenance:

```javascript
export class DatabaseManager {
  constructor(db) {
    this.db = db;
    this.logger = createLogger('DatabaseManager');
  }

  // Purge operations
  async getPurgePreview(preset, customDate = null) {
    // Calculate what would be deleted
    // Return rows_to_delete, size_to_free, etc.
  }

  async executePurge(preset, customDate = null) {
    // Delete old events
    // Update audit log
    // Return results
  }

  // Optimize operations
  async optimizeDatabase(options = {}) {
    // Execute VACUUM
    // Return space freed
  }

  // Capabilities
  async detectCapabilities() {
    // Return supported features
  }

  // Query operations
  async getStats() {
    // Get database statistics for tiles
  }
}
```

#### 2. `src/api/routes/database.js`

REST endpoints:

```javascript
export function createDatabaseRouter(db, postgresClient) {
  const router = Router();
  const dbManager = new DatabaseManager(db);

  // GET /api/v2/database/info
  router.get('/info', bearer('read'), async(req, res) => {
    const stats = await postgresClient.getStatistics();
    const capabilities = await dbManager.detectCapabilities();
    
    res.json({
      data: {
        id: 'database-info',
        type: 'database-info',
        attributes: { ...stats, capabilities }
      }
    });
  });

  // POST /api/v2/database/purge
  router.post('/purge', bearer('delete:database'), async(req, res) => {
    const { preset, older_than, purge_all, dry_run, confirm } = req.body.data.attributes;
    
    // Validate
    if (purge_all && !dry_run && !confirm) {
      return res.status(409).json({
        errors: [{
          status: '409',
          title: 'Confirmation Required',
          detail: 'Call with confirm=true after reviewing preview'
        }]
      });
    }
    
    // Preview
    if (dry_run || !confirm) {
      const preview = await dbManager.getPurgePreview(preset, older_than);
      return res.json({ data: { type: 'purge-result', attributes: { dry_run: true, preview } } });
    }
    
    // Execute
    const result = await dbManager.executePurge(preset, older_than);
    res.status(202).json({ data: { type: 'purge-result', attributes: result } });
  });

  // POST /api/v2/database/optimize
  router.post('/optimize', bearer('delete:database'), async(req, res) => {
    const { full, analyze } = req.body.data.attributes;
    const result = await dbManager.optimizeDatabase({ full, analyze });
    res.status(202).json({ data: { type: 'optimize-result', attributes: result } });
  });

  // GET /api/v2/database/cleanup-jobs
  router.get('/cleanup-jobs', bearer('read'), async(req, res) => {
    // ... existing implementation ...
  });

  return router;
}
```

#### 3. Purge Presets Configuration

```javascript
const PURGE_PRESETS = {
  '30_days': {
    label: 'Last 30 days',
    days: 30,
  },
  '90_days': {
    label: 'Last 90 days (Recommended)',
    days: 90,
  },
  '365_days': {
    label: 'Last 365 days (1 year)',
    days: 365,
  },
  'custom': {
    label: 'Custom date',
    days: null,  // User provides ISO date
  },
  'purge_all': {
    label: '⚠️ Delete All',
    days: null,  // Special flag
  },
};
```

#### 4. Audit Table

Persistent log of purge/optimize operations:

```sql
CREATE TABLE database_maintenance_log (
  id              TEXT PRIMARY KEY,
  operation       TEXT NOT NULL,  -- 'purge' or 'optimize'
  preset          TEXT,           -- '30_days', '90_days', 'custom', etc.
  older_than      TIMESTAMPTZ,
  purge_all       BOOLEAN,
  dry_run         BOOLEAN NOT NULL DEFAULT FALSE,
  executed_by     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  status          TEXT NOT NULL,  -- 'pending', 'running', 'completed', 'failed'
  results         JSONB,
  error_message   TEXT,
  INDEX idx_status ON database_maintenance_log (status, created_at DESC),
  INDEX idx_created ON database_maintenance_log (created_at DESC)
);
```

---

## 🔌 Integration Points

### 1. REST API Registration

In `src/api/rest-api.js`:

```javascript
import { createDatabaseRouter } from './routes/database.js';

// Register at startup
app.use(`${API_BASE}/database`, createDatabaseRouter(db, postgresClient));
```

### 2. OpenAPI Documentation

Update `docs/knxiot_api_openapi.yaml`:

```yaml
/database/info:
  get:
    summary: Get database statistics and capabilities
    security:
      - OAuth2: ['read']
    tags:
      - Database Management (Vendor Extension)

/database/purge:
  post:
    summary: Purge old events or all events
    security:
      - OAuth2: ['delete:database']
    tags:
      - Database Management (Vendor Extension)

/database/optimize:
  post:
    summary: Optimize database (VACUUM)
    security:
      - OAuth2: ['delete:database']
    tags:
      - Database Management (Vendor Extension)

/database/cleanup-jobs:
  get:
    summary: Query maintenance audit log
    security:
      - OAuth2: ['read']
    tags:
      - Database Management (Vendor Extension)
```

### 3. OAuth2 Scopes

Add to OAuth2 configuration:

```javascript
OAUTH2_SCOPES = [
  'read',              // Existing
  'write',             // Existing
  'delete:database'    // NEW: Admin-only maintenance access
]
```

---

## 📈 Performance & TimescaleDB Compression

### New Components

#### 1. `src/storage/database-manager.js`

Abstraction layer for database maintenance operations.

**Methods:**

```javascript
// Query statistics
async getTableInfo(tableName)          // Size, row count, indexes
async getHypertableInfo()              // Chunk count, compression status
async getEventTimings()                // Min/max timestamps, coverage

// Cleanup operations
async deleteEventsBefore(beforeDate, tables)        // Delete old rows
async retainLastDays(days, tables)                  // Retention policy
async retainLastCount(count, table)                 // Size-bounded
async dryRunCleanup(beforeDate, tables)             // Preview changes

// Maintenance
async compressOldChunks(olderThan = '30 days')     // TimescaleDB compression
async analyzeTablesForVacuum()                      // VACUUM & ANALYZE

// Audit logging
async logCleanupJob(jobId, strategy, results)      // Store in cleanup_jobs table
async getCleanupHistory(options)                    // Query cleanup audit log
```

#### 2. `src/api/routes/database.js`

Express router implementing the three endpoints.

```javascript
export function createDatabaseRouter(db, postgresClient)
  // GET /info      → getStatistics() + getTimings() + getHypertableInfo()
  // DELETE /cleanup → executeCleanupJob(strategy, params, dryRun)
  // GET /cleanup-jobs → getCleanupHistory(pagination, filters)
```

#### 3. `src/storage/cleanup_jobs` Table

Persistent audit log of all cleanup operations.

```sql
CREATE TABLE cleanup_jobs (
  id              TEXT PRIMARY KEY,
  strategy        TEXT NOT NULL,
  params          JSONB NOT NULL,
  tables_affected TEXT[] NOT NULL,
  dry_run         BOOLEAN NOT NULL DEFAULT FALSE,
  executed_by     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending, running, completed, failed
  results         JSONB,
  error_message   TEXT,
  INDEX idx_cleanup_status ON cleanup_jobs (status, created_at DESC),
  INDEX idx_cleanup_created ON cleanup_jobs (created_at DESC)
);
```

---

### Integration Points

#### 1. REST API Registration

In `src/api/rest-api.js`:

```javascript
import { createDatabaseRouter } from './routes/database.js';

// Register at startup
app.use(`${API_BASE}/database`, createDatabaseRouter(db, postgresClient));
```

#### 2. OpenAPI Documentation

Update `docs/knxiot_api_openapi.yaml`:

```yaml
/database/info:
  get:
    summary: Get database statistics
    security:
      - OAuth2: ['read']
    tags:
      - Database Management (Vendor Extension)

/database/cleanup:
  delete:
    summary: Execute database cleanup
    security:
      - OAuth2: ['delete:database']
    tags:
      - Database Management (Vendor Extension)

/database/cleanup-jobs:
  get:
    summary: Query cleanup history
    security:
      - OAuth2: ['read']
    tags:
      - Database Management (Vendor Extension)
```

#### 3. OAuth2 Scopes

Add to OAuth2 configuration:

```javascript
OAUTH2_SCOPES = [
  'read',              // Existing
  'write',             // Existing
  'delete:database'    // NEW: Admin-only cleanup access
]
```

---

## 🛡️ Security & Compliance

### Access Control

| Endpoint | Scope | Role | Notes |
|----------|-------|------|-------|
| `GET /database/info` | `read` | User | Read-only statistics |
| `DELETE /database/cleanup` | `delete:database` | Admin | Destructive operation |
| `GET /database/cleanup-jobs` | `read` | User | Audit trail visibility |

### Audit Requirements

✅ **All cleanup operations logged** → `cleanup_jobs` table with `executed_by`  
✅ **Dry-run support** → `dry_run=true` prevents actual deletion  
✅ **Immutable history** → Cleanup jobs never modified, only queried  
✅ **User attribution** → OAuth2 subject ID recorded with each operation  

### Data Protection

⚠️ **Irreversible operation** — Deleted events cannot be recovered  
💾 **Backup first** — Document recommends backup before cleanup  
✔️ **Confirm via API** — No auto-cleanup; all operations explicit  

---

## 📊 Deployment & Retention Strategies

### Strategy 1: Time-Based Retention with Presets (Recommended)

Use preset: `90_days` (keep last 90 days):

```bash
# Step 1: Dry-run preview
curl -X POST http://localhost:3000/api/v2/database/purge \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/vnd.api+json" \
  -d '{
    "data": {
      "type": "purge-request",
      "attributes": {
        "preset": "90_days",
        "dry_run": true,
        "confirm": false
      }
    }
  }'

# Step 2: If satisfied, execute
curl -X POST http://localhost:3000/api/v2/database/purge \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/vnd.api+json" \
  -d '{
    "data": {
      "type": "purge-request",
      "attributes": {
        "preset": "90_days",
        "dry_run": false,
        "confirm": true
      }
    }
  }'
```

**Available Presets:**
- `30_days` — Keep last 30 days
- `90_days` — Keep last 90 days (recommended)
- `365_days` — Keep last 365 days
- `custom` — User-specified date
- `purge_all` — Delete everything ⚠️

**Use case**: Standard deployments where you want a rolling window of recent history.

---

### Strategy 2: Custom Date Purge

Delete everything before a specific date:

```bash
# Delete events before 2026-04-08
curl -X POST http://localhost:3000/api/v2/database/purge \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/vnd.api+json" \
  -d '{
    "data": {
      "type": "purge-request",
      "attributes": {
        "preset": "custom",
        "older_than": "2026-04-08T00:00:00Z",
        "dry_run": false,
        "confirm": true
      }
    }
  }'
```

**Use case**: One-off cleanup after project archival or migration.

---

### Strategy 3: Reclaim Disk Space

Run VACUUM ANALYZE to reclaim disk space from deleted rows (**online operation**):

```bash
# Safe online optimization (API stays online)
curl -X POST http://localhost:3000/api/v2/database/optimize \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/vnd.api+json" \
  -d '{
    "data": {
      "type": "optimize-request",
      "attributes": {
        "full": false,
        "analyze": true
      }
    }
  }'

# full: false = Online VACUUM (recommended for daily operations)
# analyze: true = Update query planner statistics
```

**Expected result:** 6–9% space reclamation from table files (inline).

**Use case:** After running a large purge operation (daily scheduled or ad-hoc).

**For maximum space reclamation:** See the "VACUUM FULL: Maintenance Windows Only" section (requires downtime).

---

### Strategy 4: Automated Retention Policy (Future)

**Recommendation**: Add optional scheduled cleanup via Cron or AWS Lambda.

```env
# Optional: Enable automatic retention policy
DATABASE_RETENTION_ENABLED=true
DATABASE_RETENTION_STRATEGY=retain_days    # or: retain_count
DATABASE_RETENTION_DAYS=90                 # or: DATABASE_RETENTION_COUNT=10000000
DATABASE_CLEANUP_SCHEDULE=0 2 * * *        # 2 AM daily (cron format)
```

---

## 📈 Performance & TimescaleDB Compression

### Compression Benefits

TimescaleDB automatically compresses old chunks (tuples → columnar format):

| Metric | Uncompressed | Compressed | Ratio |
|--------|--------------|-----------|-------|
| Size | 1000 MB | 300 MB | 3.3:1 |
| Query Speed | Baseline | -5% to +15% | Usually faster |
| Insert Speed | N/A | -1% to 2% | Minimal impact |

### Compression Strategy

**Recommended settings** (in `src/storage/postgres.js`):

```javascript
// Compress chunks older than 14 days automatically
const AUTO_COMPRESS_INTERVAL = '14 days';

// In TimescaleDB config:
ALTER TABLE knx_events SET (
  timescaledb.compress,
  timescaledb.compress_orderby = 'ts DESC'
);

SELECT add_compression_policy('knx_events', INTERVAL '14 days');
```

---

## 🧪 Testing & Examples

### Dry-Run Before Deleting

Always test first with `dry_run: true`:

```bash
# Step 1: Dry run to see what would be deleted
CLEANUP_JOB=$(curl -s -X DELETE http://localhost:3000/api/v2/database/cleanup \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/vnd.api+json" \
  -d '{
    "data": {
      "type": "cleanup-request",
      "attributes": {
        "strategy": "retain_days",
        "dry_run": true,
        "tables": ["knx_events"],
        "params": { "days": 90 }
      }
    }
  }' | jq -r '.data.attributes.results')

echo "Would delete: $CLEANUP_JOB"

# Step 2: If satisfied, execute for real (dry_run: false)
curl -s -X DELETE http://localhost:3000/api/v2/database/cleanup \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/vnd.api+json" \
  -d '{
    "data": {
      "type": "cleanup-request",
      "attributes": {
        "strategy": "retain_days",
        "dry_run": false,
        "tables": ["knx_events"],
        "params": { "days": 90 }
      }
    }
  }'
```

### Query Cleanup History

```bash
# Last 10 completed cleanups
curl -s http://localhost:3000/api/v2/database/cleanup-jobs?limit=10&status=completed \
  -H "Authorization: Bearer $TOKEN" | jq '.data[] | {id, strategy, status, size_freed: .attributes.totals.total_freed_pretty}'
```

---

## 🔄 Future Enhancements

### Phase 2: Backup & Restore Integration

*Note: Covered in separate `DATABASE_BACKUP_RESTORE.md` document.*

- Full database snapshots
- Point-in-time recovery
- S3/cloud storage integration
- Encryption at rest

### Phase 3: Advanced Monitoring

- TimescaleDB Prometheus metrics export
- Grafana dashboards for database health
- Alerting on database size thresholds
- Automatic retention triggers

### Phase 4: Data Archival

- Export old events to Parquet/CSV
- S3 cold storage integration
- Query archived data via external tables
- Compliance-grade audit trails

---

## 📋 Admin Runbook: Database Maintenance Operations

### Daily Operations (Automated)

✅ **Runs automatically via Docker Cron:**

1. **02:00 UTC** — `PURGE` (retain last 90 days)
   - Deletes events older than 90 days
   - Runs in the background, API stays online
   
2. **02:15 UTC** — `VACUUM ANALYZE` (online optimization)
   - Reclaims ~80–95% of freed space
   - Updates query optimizer statistics
   - API stays online

**No manual intervention is required.**

---

### Monthly Operations (Manual, Maintenance Window)

⚠️ **Requires downtime scheduling:**

**Step 1: Plan Maintenance Window**
```
Date: [Second Sunday of month]
Time: 03:00 UTC (adjust for your timezone)
Duration: 15-30 minutes (depending on DB size)
Notify: All users/integrations that system will be offline
```

**Step 2: Execute VACUUM FULL**
```bash
# During maintenance window only!
curl -X POST http://localhost:3000/api/v2/database/optimize \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/vnd.api+json" \
  -d '{
    "data": {
      "type": "optimize-request",
      "attributes": {
        "full": true,
        "analyze": true
      }
    }
  }'

# ⚠️ WARNING: This causes COMPLETE SYSTEM DOWNTIME
# Duration: 10-30 minutes depending on database size
```# Expected HTTP 202 Accepted
# Monitor status: curl http://localhost:3000/api/v2/database/cleanup-jobs
```

**Step 3: Verify Operation Completed**
```bash
# Query last cleanup job
curl -s "http://localhost:3000/api/v2/database/cleanup-jobs?limit=1&status=completed" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.data[0].attributes | {
    completed_at,
    duration_seconds,
    space_freed_pretty,
    method
  }'

# Expected: Shows "VACUUM FULL" and freed space percentage
```

**Step 4: Notify Users**
```
System is back online. Database optimized and freed [XX MB] disk space.
```

---

### Emergency Procedures

**If disk space is critically low (<10% free):**

1. **Quick fix (online):** Execute daily `VACUUM ANALYZE` manually
   ```bash
   # No downtime required
   curl -X POST http://localhost:3000/api/v2/database/optimize \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -d '{"data":{"type":"optimize-request","attributes":{"full":false,"analyze":true}}}'
   ```

2. **If still critical:** Schedule immediate VACUUM FULL during maintenance window
   - Expected space freed: 6-15% additional
   - If needed, also run emergency purge (30_days instead of 90_days)

**If API is offline unexpectedly:**
- Check if VACUUM FULL is running: `curl http://localhost:3000/api/v2/database/cleanup-jobs`
- If in progress, wait for completion (check `completed_at` field)
- If hung, restart the database container

---

## 📝 Migration Checklist

- [ ] Implement `DatabaseManager` class in `src/storage/database-manager.js`
- [ ] Create `cleanup_jobs` audit table in `src/storage/postgres.js`
- [ ] Implement database routes in `src/api/routes/database.js`
- [ ] Register router in `src/api/rest-api.js`
- [ ] Update OpenAPI spec (`docs/knxiot_api_openapi.yaml`)
- [ ] Add OAuth2 scopes for `delete:database`
- [ ] Add warning/downtime_warning fields to optimize response schema
- [ ] Write unit tests for cleanup strategies
- [ ] Document in API Testing guide
- [ ] Add example shell scripts
- [ ] Create an admin runbook for cleanup operations
- [ ] **⚠️ Document VACUUM FULL maintenance window schedule** (see "Admin Runbook" section)
- [ ] Add monitoring/alerts for database size thresholds
- [ ] Train admins on when to use VACUUM vs VACUUM FULL

---

## 🚀 Deployment

### First Run

```bash
# Check current database size
curl http://localhost:3000/api/v2/database/info \
  -H "Authorization: Bearer $TOKEN" | jq '.data.attributes.database'

# Expected output:
# {
#   "name": "knx",
#   "size_bytes": 2876543210,
#   "size_pretty": "2.7 GB"
# }
```

### Scheduled Cleanup (Docker Cron)

```bash
# Add to docker-compose.yml
  cleanup-scheduler:
    image: mcuadros/ofelia:latest
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    command: daemon --docker
    environment:
      # Daily purge at 02:00 UTC (keep last 90 days)
      OFELIA_JOB_EXEC_DAILY_PURGE: |
        job-exec "semantic-knx-runtime" \
        /usr/bin/curl -X POST http://localhost:3000/api/v2/database/purge \
        -H "Authorization: Bearer $CLEANUP_TOKEN" \
        -H "Content-Type: application/vnd.api+json" \
        -d '{"data":{"type":"purge-request","attributes":{"preset":"90_days","dry_run":false,"confirm":true}}}'
      OFELIA_JOB_EXEC_DAILY_PURGE_SCHEDULE: "0 2 * * *"
      
      # Daily optimization at 02:15 UTC (VACUUM ANALYZE - online, safe)
      # ⚠️ NEVER use full: true in automated jobs!
      OFELIA_JOB_EXEC_DAILY_OPTIMIZE: |
        job-exec "semantic-knx-runtime" \
        /usr/bin/curl -X POST http://localhost:3000/api/v2/database/optimize \
        -H "Authorization: Bearer $CLEANUP_TOKEN" \
        -H "Content-Type: application/vnd.api+json" \
        -d '{"data":{"type":"optimize-request","attributes":{"full":false,"analyze":true}}}'
      OFELIA_JOB_EXEC_DAILY_OPTIMIZE_SCHEDULE: "0 2 15 * * *"
      
      # MANUAL MAINTENANCE WINDOW ONLY (not automated):
      # Sunday 03:00 UTC - VACUUM FULL for complete cleanup
      # Requires explicit admin curl command (no automation!)
      # See: "VACUUM FULL: Maintenance Windows Only" section in docs
```

**Important Notes:**

- ✅ Daily `VACUUM ANALYZE` (online) — scheduled automatically
- ✅ Daily `PURGE` (90-day retention) — scheduled automatically  
- ❌ `VACUUM FULL` — **NEVER scheduled automatically!**
- ⚠️ `VACUUM FULL` requires manual execution during a maintenance window
- 📋 Document VACUUM FULL schedule in runbook

---

## 📚 Related Documentation

- [../ARCHITECTURE.md](../ARCHITECTURE.md) — Database schema overview
- [../CONFIGURATION.md](../CONFIGURATION.md) — Environment variables
- `DATABASE_BACKUP_RESTORE.md` *(planned)* — Backup strategies
- [../API-TESTING.md](../API-TESTING.md) — Test examples

---

## 📞 Support & Questions

- GitHub Issues: [semantic-knx-gateway/issues](https://github.com/Noschvie/semantic-knx-gateway/issues)
- Documentation: https://schema.knx.org/2020/api
- KNX Association: https://www.knx.org

---

**Last Updated**: 2026-07-08  
**Status**: ✅ Design Complete (with VACUUM FULL warnings) / ⏳ Implementation Pending  
**Version**: 1.1-DRAFT (Enhanced with maintenance window documentation)

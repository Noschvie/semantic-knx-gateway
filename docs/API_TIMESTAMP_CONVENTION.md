# API Timestamp Convention

**Status:** Standardized as of 2026-07-11  
**Applies to:** All REST API endpoints (v1, v2)

---

## Overview

To ensure consistency across the API and improve client compatibility, we follow a clear convention for timestamp formatting based on the endpoint type.

---

## Convention Rules

### 1. KNX IoT Specification Endpoints

**Scope:** Endpoints defined in the official KNX IoT API specification

**Rule:** Return **UTC only** using ISO 8601 format

**Field name:** `timestamp` or `<field>_at`

**Format:** ISO 8601 UTC string  
Example: `2026-07-11T09:53:33.895Z`

**Rationale:**
- KNX Spec standard requires UTC
- International standard for machine processing
- Timezone-agnostic for global deployments
- Client can convert to local timezone as needed

**Affected Endpoints:**
- `GET /api/v1/node`
- `GET /api/v2/datapoints`
- `POST /api/v2/datapoints`
- `GET /api/v1/events`
- WebSocket messages (`type: 'writeResult'`, `type: 'datapoint'`)

**Example Response:**
```json
{
  "data": {
    "type": "datapoint",
    "attributes": {
      "value": "23.5",
      "timestamp": "2026-07-11T09:53:33.895Z"
    }
  }
}
```

---

### 2. Vendor Extensions / Custom Endpoints

**Scope:** Endpoints not covered by the KNX IoT specification (prefixed with vendor-specific features)

**Rule:** Return **BOTH formats** for better UX:
- `<field>` — Human-readable local time (Europe/Berlin timezone)
- `<field>_iso` — Machine-readable UTC (ISO 8601)

**Field naming pattern:**
```
created_at        → Human-readable (local)
created_at_iso    → ISO UTC (machine)

started_at        → Human-readable (local)
started_at_iso    → ISO UTC (machine)

completed_at      → Human-readable (local)
completed_at_iso  → ISO UTC (machine)

timestamp         → Human-readable (local)
timestampISO      → ISO UTC (machine)
```

**Local Timezone:** Always `Europe/Berlin` (as configured in `utils/timezone.js`)

**Rationale:**
- Improves developer experience in logs/debugging
- Provides a UTC option for programmatic clients
- Maintains consistency with internal operations
- Easier to read in API responses during manual testing

**Affected Endpoints:**
- `GET /api/v2/stats`
- `GET /api/v2/database/info`
- `POST /api/v2/database/purge`
- `POST /api/v2/database/optimize`
- `GET /api/v2/database/cleanup-jobs`

**Example Response (Database Info):**
```json
{
  "data": {
    "type": "database-info",
    "attributes": {
      "timestamp": "13. Juli 2026 11:53:33",
      "timestampISO": "2026-07-11T09:53:33.895Z",
      "database": {
        "name": "knxdb",
        "size_pretty": "28.7 MB"
      }
    }
  }
}
```

**Example Response (Cleanup Jobs):**
```json
{
  "data": [
    {
      "type": "cleanup-job",
      "attributes": {
        "created_at": "13. Juli 2026 09:51:46",
        "created_at_iso": "2026-07-11T09:51:46.042Z",
        "completed_at": "13. Juli 2026 09:51:47",
        "completed_at_iso": "2026-07-11T09:51:47.254Z",
        "duration_seconds": 1,
        "status": "completed"
      }
    }
  ]
}
```

---

## Implementation Guide

### For Spec-Compliant Endpoints

```javascript
// ✅ CORRECT - UTC only
res.json({
  data: {
    type: 'datapoint',
    attributes: {
      value: '23.5',
      timestamp: new Date().toISOString()  // "2026-07-11T09:53:33.895Z"
    }
  }
});
```

### For Vendor Extension Endpoints

```javascript
import { formatTimestamp } from '../../utils/timezone.js';

// ✅ CORRECT - Local + UTC
const now = new Date();
res.json({
  data: {
    type: 'database-info',
    attributes: {
      timestamp: formatTimestamp(now),      // "13. Juli 2026 11:53:33"
      timestampISO: now.toISOString(),      // "2026-07-11T09:53:33.895Z"
      // ... more attributes
    }
  }
});
```

### For Field-Specific Timestamps

```javascript
import { formatTimestamp } from '../../utils/timezone.js';

// ✅ CORRECT - Dual fields for each timestamp
const createdAt = new Date(row.created_at);
const completedAt = new Date(row.completed_at);

res.json({
  attributes: {
    created_at: formatTimestamp(createdAt),
    created_at_iso: createdAt.toISOString(),
    completed_at: formatTimestamp(completedAt),
    completed_at_iso: completedAt.toISOString(),
    // ... more attributes
  }
});
```

---

## Client Usage Guide

### For Spec Endpoints
Clients should parse `timestamp` as UTC and convert to local timezone if needed:

```javascript
const utcTime = new Date('2026-07-11T09:53:33.895Z');
const berlinTime = utcTime.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
// → "11.7.2026, 11:53:33"
```

### For Vendor Endpoints
Clients can use `timestamp` directly for display (already in local time) or use `<field>_iso` for programmatic operations:

```javascript
// For display - use the local version directly
const displayTime = response.timestamp;  // "13. Juli 2026 11:53:33"

// For processing - use the ISO version
const processTime = new Date(response.timestampISO);
const unixTime = processTime.getTime();
```

---

## Timezone Handling

### Timezone Utility Functions

Located in `src/utils/timezone.js`:

- **`formatTimestamp(timestamp)`** — Format to local time (de-DE format)
  - Returns: `"13. Juli 2026 11:53:33"`
  
- **`toLocalISO(timestamp)`** — Format to local ISO 8601 with offset
  - Returns: `"2026-07-11T11:53:33+01:00"` (not used in API, but available)

- **`nowLocal()`** — Get current timestamp in local format
  - Returns: `"13. Juli 2026 11:53:33"`

### Daylight Saving Time

The timezone is hardcoded to `Europe/Berlin` which automatically handles DST:
- Winter: UTC+1
- Summer: UTC+2 (CEST)

No manual DST adjustment is needed.

---

## Validation Checklist

When adding new endpoints, ask:

- [ ] Is this endpoint defined in the KNX IoT specification?
  - **Yes** → Use `toISOString()` only (UTC)
  - **No** → Use both `formatTimestamp()` and `toISOString()` (local + UTC)

- [ ] Have I imported `formatTimestamp` from `src/utils/timezone.js`?

- [ ] For multiple timestamps, are field names consistent?
  - `created_at` / `created_at_iso`
  - `started_at` / `started_at_iso`
  - `completed_at` / `completed_at_iso`

- [ ] Have I tested the response with a client in a different timezone?

---

## References

- **KNX IoT API Specification:** Defines Spec endpoints (e.g., `/api/v2/datapoints`)
- **Timezone Utilities:** `src/utils/timezone.js`
- **Database Manager:** `src/storage/database-manager.js` (vendor extension examples)
- **Statistics Router:** `src/api/routes/statistics.js` (first implementation of dual timestamps)

---

## Changelog

- **2026-07-11:** Convention established and documented
  - Standardized database management endpoints (`/api/v2/database/*`)
  - Fixed `formatBytes()` negative number handling
  - All vendor endpoints now follow a dual-format convention

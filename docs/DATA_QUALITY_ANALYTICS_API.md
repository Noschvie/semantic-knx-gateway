# Data Quality Analytics API – Phase 1

**Scope:** Vendor-extension endpoints for anomaly detection and data quality analysis  
**Base URL:** `/api/v2/stats/`  
**Authentication:** Bearer token with `read` scope

---

## Overview

The Data Quality Analytics API provides three advanced endpoints for monitoring sensor data integrity, detecting anomalies, and performing time-series analysis on KNX datapoints.

**Three Main Use Cases:**

1. **Anomaly Detection** — Find temperature/value jumps that indicate sensor malfunctions
2. **NULL Pattern Analysis** — Distinguish synchronized polling issues from sensor communication errors
3. **Time-Series Summary** — Analyze trends, statistical distributions, and data completeness

---

## Endpoint: GET /api/v2/stats/anomalies

Detects sudden changes in sensor values using SQL `LAG()` window function.

### Request

```http
GET /api/v2/stats/anomalies?dpt=9.001&delta=2.0&hours=24&limit=50
Authorization: Bearer <token>
```

### Query Parameters

| Parameter | Type | Default | Range | Description |
|-----------|------|---------|-------|-------------|
| `dpt` | string | `9.001` | comma-separated | DPT type(s) to analyze (e.g., `9.001,9.007` for temperature sensors) |
| `delta` | float | `2.0` | ≥ 0.1 | Absolute change threshold to trigger anomaly (e.g., 2.0°C) |
| `hours` | integer | `24` | 1–8760 | Lookback period in hours (max 1 year) |
| `limit` | integer | `50` | 1–1000 | Maximum anomalies to return |

### Response (200 OK)

```json
{
  "meta": {
    "collection": {
      "total": 42,
      "returned": 42,
      "period_hours": 24
    },
    "query": {
      "dpt": "9.001",
      "delta": 2.0,
      "severity_filter": "all"
    }
  },
  "data": [
    {
      "id": "anom-dp-123-1721065800000",
      "type": "anomaly",
      "attributes": {
        "timestamp": "2026-07-15T14:30:00.000Z",
        "timestamp_local": "15. Juli 2026 16:30:00",
        "datapointId": "dp-123",
        "ga": "3/6/1",
        "dpt": "9.001",
        "previousValue": 21.5,
        "currentValue": 24.2,
        "delta": 2.7,
        "deltaPercent": 12.56,
        "severity": "high",
        "timeGapSeconds": 120,
        "source": "knx-tunnel"
      }
    }
  ],
  "summary": {
    "high": 8,
    "medium": 15,
    "low": 19,
    "total": 42,
    "timeRange": {
      "since": "2026-07-14T14:30:00.000Z",
      "until": "2026-07-15T14:30:00.000Z"
    }
  }
}
```

### Response Explanation

**meta object:**
- `collection.total` — Total anomalies found (before limit)
- `collection.returned` — Actual count returned
- `collection.period_hours` — Query time window
- `query` — Echo of request parameters

**data array (ordered by delta DESC):**
- `timestamp` / `timestamp_local` — Dual-format timestamp per convention
- `delta` — Absolute change (e.g., 2.7°C)
- `deltaPercent` — Relative percentage change
- `severity` — Classification:
  - `high` — delta > threshold
  - `medium` — delta > threshold/2
  - `low` — delta > threshold/2 but borderline
- `timeGapSeconds` — Seconds since previous measurement

**summary object:**
- Severity distribution (high/medium/low counts)
- Total anomalies found
- Time range of analysis

### Example Requests

**Find large temperature jumps (> 3°C) in last 7 days:**
```bash
curl -H "Authorization: Bearer token" \
  "http://localhost:3000/api/v2/stats/anomalies?dpt=9.001&delta=3.0&hours=168"
```

**Find humidity AND temperature anomalies:**
```bash
curl -H "Authorization: Bearer token" \
  "http://localhost:3000/api/v2/stats/anomalies?dpt=9.001,9.007&delta=2.0"
```

**Get only top 10 anomalies from last 12 hours:**
```bash
curl -H "Authorization: Bearer token" \
  "http://localhost:3000/api/v2/stats/anomalies?hours=12&limit=10"
```

### Error Responses

| Status | Description |
|--------|-------------|
| 400 | Invalid query parameters (e.g., `delta < 0.1`, `hours > 8760`) |
| 401 | Missing or invalid Bearer token |
| 500 | Database error during query |

---

## Endpoint: GET /api/v2/stats/null-patterns

Analyzes NULL value patterns to distinguish sensor communication errors from polling issues.

### Request

```http
GET /api/v2/stats/null-patterns?dpts=9.001,9.007&hours=24
Authorization: Bearer <token>
```

### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `dpts` | string | `9.001,9.007` | Comma-separated DPT types to analyze |
| `hours` | integer | `24` | Lookback period in hours (1–8760) |

### Response (200 OK)

```json
{
  "meta": {
    "period_hours": 24,
    "analysis_timestamp": "2026-07-15T14:30:00.000Z",
    "analysis_timestamp_local": "15. Juli 2026 16:30:00"
  },
  "temporal_patterns": {
    "description": "NULL values grouped by minute of hour",
    "synchronized": true,
    "pattern": [
      {
        "minute_of_hour": 0,
        "null_count": 1247,
        "affected_ga_count": 42,
        "sample_gas": ["3/6/1", "3/6/2", "3/6/3"],
        "percentage_of_total": 18.5
      }
    ]
  },
  "spatial_patterns": {
    "description": "NULL values grouped by group address",
    "concentrated": false,
    "pattern": [
      {
        "ga": "3/6/1",
        "datapoint_id": "dp-123",
        "null_count": 156,
        "hours_affected": 18,
        "percent_of_all_events": 12.3,
        "first_null": "2026-07-14T14:30:00.000Z",
        "first_null_local": "14. Juli 2026 16:30:00",
        "last_null": "2026-07-15T14:20:00.000Z",
        "last_null_local": "15. Juli 2026 16:20:00"
      }
    ]
  },
  "diagnosis": {
    "likely_cause": "synchronized_polling_issue",
    "confidence": 0.92,
    "recommendation": "Check device polling intervals and KNX gateway connectivity"
  }
}
```

### Response Explanation

**temporal_patterns object:**
- `synchronized` — `true` if NULLs cluster at specific minutes (e.g., every hour at :00)
- Pattern entries sorted by null_count DESC
- `percentage_of_total` — Percentage of all events for this DPT type

**spatial_patterns object:**
- `concentrated` — `true` if most NULLs come from a few group addresses (> 5% of events)
- Pattern entries sorted by null_count DESC
- `hours_affected` — Number of distinct hours with NULL values

**diagnosis object:**
- `likely_cause`:
  - `synchronized_polling_issue` — If temporal sync detected (all devices fail at same minute)
  - `sensor_communication_error` — If NULLs scattered across time/space
- `confidence` — 0.0–1.0 confidence in diagnosis
- `recommendation` — Actionable next step

### Interpretation Guide

| Scenario | Temporal | Spatial | Likely Cause | Action |
|----------|----------|---------|--------------|--------|
| All devices NULL at :00 every hour | Synchronized | Concentrated | Gateway polling cycle | Check KNX gateway config / polling interval |
| Random NULLs across time/space | Scattered | Scattered | Sensor communication errors | Check individual sensor cables and addresses |
| One sensor always NULL | Scattered | Concentrated (1 GA) | Sensor malfunction or offline | Replace sensor or check device config |
| Batch of sensors all NULL at same time | Synchronized | Concentrated (multiple GAs) | Network/gateway issue | Restart gateway or check KNX line |

### Example Requests

**Analyze all float DPTs:**
```bash
curl -H "Authorization: Bearer token" \
  "http://localhost:3000/api/v2/stats/null-patterns?dpts=9.001,9.007,9.020"
```

**Analyze last 7 days:**
```bash
curl -H "Authorization: Bearer token" \
  "http://localhost:3000/api/v2/stats/null-patterns?hours=168"
```

---

## Endpoint: GET /api/v2/stats/datapoints/:id

Comprehensive time-series statistics for a single datapoint.

### Request

```http
GET /api/v2/stats/datapoints/3/6/1?hours=24
Authorization: Bearer <token>
```

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `:id` | string | Datapoint ID or group address (e.g., `dp-123` or `3/6/1`) |

### Query Parameters

| Parameter | Type | Default | Range | Description |
|-----------|------|---------|-------|-------------|
| `hours` | integer | `24` | 1–8760 | Lookback period for statistics |

### Response (200 OK)

```json
{
  "data": {
    "id": "3/6/1",
    "type": "datapoint",
    "attributes": {
      "datapointId": "dp-123",
      "ga": "3/6/1",
      "dpt": "9.001"
    }
  },
  "statistics": {
    "last_24h": {
      "period": {
        "since": "2026-07-14T14:30:00.000Z",
        "since_local": "14. Juli 2026 16:30:00",
        "until": "2026-07-15T14:30:00.000Z",
        "until_local": "15. Juli 2026 16:30:00",
        "hours": 24
      },
      "measurements": {
        "count": 1440,
        "missing": 0,
        "null_count": 3,
        "null_percent": "0.2"
      },
      "values": {
        "average": 22.15,
        "minimum": 20.5,
        "maximum": 24.8,
        "range": 4.3,
        "stddev": 1.23,
        "median": 22.0,
        "q1": 21.2,
        "q3": 23.1
      },
      "trend": {
        "direction": "rising",
        "first_value": 20.8,
        "last_value": 23.5,
        "change": 2.7,
        "change_percent": 12.98
      }
    },
    "last_7d": {
      "measurements": {
        "count": 10080
      },
      "values": {
        "average": 21.42,
        "minimum": 18.5,
        "maximum": 26.2,
        "range": 7.7
      },
      "anomalies": 12
    }
  },
  "current": {
    "value": 23.5,
    "timestamp": "2026-07-15T14:30:00.000Z",
    "timestamp_local": "15. Juli 2026 16:30:00",
    "age_seconds": 45,
    "status": "ok"
  }
}
```

### Response Explanation

**last_24h object:**
- `period` — Time window with dual timestamps
- `measurements` — Record count and data completeness
- `values` — Statistical distribution (avg, min, max, quartiles)
- `trend` — Direction and percentage change

**last_7d object:**
- Comparative statistics across a longer window
- `anomalies` — Count of value jumps > 2.0 units

**current object:**
- `value` — Latest measurement
- `age_seconds` — Time since last update
- `status` — `ok`, `stale` (> 1 hour), or `unknown` (no data)

### Interpreting Statistics

**Data Quality:**
```
null_percent < 1%  → Excellent
1% ≤ null_percent < 5%  → Good (minor dropouts)
5% ≤ null_percent < 10%  → Fair (regular issues)
null_percent ≥ 10%  → Poor (investigate sensor)
```

**Stability (stddev):**
```
stddev < 1  → Very stable
1 ≤ stddev < 3  → Stable
3 ≤ stddev < 5  → Variable
stddev ≥ 5  → High variation (check sensor calibration)
```

**Trend Interpretation:**
```
change_percent > 10%  → Significant drift (investigate)
5% < change_percent ≤ 10%  → Moderate drift
-5% ≤ change_percent ≤ 5%  → Stable
anomalies > 5 in 7d  → Frequent jumps (check wiring)
```

### Example Requests

**Get 24-hour stats for room temperature (by GA):**
```bash
curl -H "Authorization: Bearer token" \
  "http://localhost:3000/api/v2/stats/datapoints/3%2F6%2F1"
```

**Get 7-day stats for datapoint (by ID):**
```bash
curl -H "Authorization: Bearer token" \
  "http://localhost:3000/api/v2/stats/datapoints/dp-123?hours=168"
```

**Get 30-day analysis:**
```bash
curl -H "Authorization: Bearer token" \
  "http://localhost:3000/api/v2/stats/datapoints/3%2F6%2F1?hours=720"
```

### Error Responses

| Status | Code | Description |
|--------|------|-------------|
| 404 | Not Found | Datapoint ID or GA not found in database |
| 400 | Bad Request | Invalid hours parameter (not 1–8760) |
| 401 | Unauthorized | Missing or invalid Bearer token |
| 500 | Server Error | Database error |

---

## Timestamp Convention

All three endpoints follow the **vendor-extension timestamp convention** per `API_TIMESTAMP_CONVENTION.md`:

- **UTC (ISO 8601)**: `timestamp` field for machine processing (e.g., `2026-07-15T14:30:00.000Z`)
- **Local (de-DE)**: `timestamp_local` field for human readability (e.g., `15. Juli 2026 16:30:00`)

**Timezone:** Europe/Berlin (UTC+1 or UTC+2 depending on DST)

---

## Authentication & Authorization

All endpoints require:
- **Method:** Bearer token (OAuth2)
- **Scope:** `read`
- **Header:** `Authorization: Bearer <token>`

---

## Use Cases & Examples

### Use Case 1: Monitor Sensor Health

**Problem:** A temperature sensor appears to have stopped working.

**Solution:**
```bash
# Check if sensor is producing NULLs
curl "http://localhost:3000/api/v2/stats/datapoints/3%2F6%2F1?hours=24" | jq '.statistics.last_24h.measurements.null_percent'

# If null_percent > 50%, investigate NULL patterns
curl "http://localhost:3000/api/v2/stats/null-patterns?dpts=9.001&hours=24" | jq '.spatial_patterns.pattern[] | select(.ga=="3/6/1")'
```

**Interpretation:** If concentrated NULLs on one GA → sensor malfunction. If synchronized → gateway issue.

---

### Use Case 2: Detect Wiring Issues

**Problem:** Heating system values are jumping erratically.

**Solution:**
```bash
# Find anomalies on heating GA
curl "http://localhost:3000/api/v2/stats/anomalies?dpt=9.001&hours=168" | jq '.data[] | select(.attributes.ga=="3/1/5")'
```

**Interpretation:** Multiple `high` severity anomalies → wiring noise or device malfunction. Check cable shielding.

---

### Use Case 3: Analyze Temperature Trend

**Problem:** Room temperature trend analysis for comfort control.

**Solution:**
```bash
# Get 7-day statistics
curl "http://localhost:3000/api/v2/stats/datapoints/3%2F6%2F1?hours=168" | jq '.statistics.last_7d'
```

**Interpretation:** Use `trend.direction` and `range` to decide if heating is needed.

---

## Troubleshooting

### No anomalies returned
- Check if `delta` is too high (e.g., 10°C for normal room temperature)
- Verify DPT type exists (check via `GET /api/v2/datapoints`)
- Verify a time window has sufficient data

### Null pattern diagnosis seems wrong
- Ensure time window (`hours`) is large enough (recommend ≥ 24 for temporal patterns)
- If `confidence < 0.7`, manual investigation recommended
- Combine with anomaly detection for better diagnosis

### Datapoint isn’t found (404)
- Verify a GA format: must be URL-encoded (e.g., `3%2F6%2F1` for `3/6/1`)
- Or use datapoint ID instead of GA
- Datapoint must exist in the database with at least one event

---

## Performance Considerations

| Query | Typical Latency | Data Size |
|-------|-----------------|-----------|
| `getAnomalies()` (24h) | 500ms | < 5 KB |
| `getNullPatterns()` (24h) | 200ms | < 10 KB |
| `getDatapointSummary()` (24h) | 300ms | < 3 KB |
| `getDatapointSummary()` (7 days) | 800ms | < 3 KB |

**Optimization Tips:**
- Use the smallest possible time window (`hours` parameter)
- Increase `limit` only if needed (default 50 is usually sufficient)
- Query during off-peak hours for large windows (> 30 days)

---

## Related Documentation

- **API Timestamp Convention:** `docs/API_TIMESTAMP_CONVENTION.md`
- **Database Management API:** `docs/DATABASE_MANAGEMENT.md`
- **KNX Reconnect Resilience:** `docs/KNX_RECONNECT_RESILIENCE.md`
- **Statistics Store API:** `src/storage/statistics-store.js` (inline documentation)

---

## Version History

| Date       | Version | Changes |
|------------|---------|---------|
| 2026-07-12 | 1.0 | Initial Phase 1 release (3 endpoints) |

---

## Support & Feedback

For issues or feature requests, please open an issue on GitHub or contact the development team.

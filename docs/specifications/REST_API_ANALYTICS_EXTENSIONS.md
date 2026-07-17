# REST API Analytics Extensions

**Status:** Design Phase  
**Version:** 1.0 (Proposed)  
**Date:** July 12, 2026  
**Author:** Noschvie / KNX IoT Development Team

---

## Overview

This document specifies new REST API endpoints for advanced temperature and sensor data analytics. These endpoints are designed to support web GUI dashboards, monitoring tools, and real-time anomaly detection without requiring direct SQL database access.

### Motivation

Current limitations:
- ❌ Complex analytics require direct SQL access
- ❌ Web GUIs cannot perform real-time anomaly detection
- ❌ No standardized endpoint for data quality analysis
- ❌ Monitoring tools need direct database connection

### Goals

✅ Provide analytics via REST API (OAuth2 protected)  
✅ Enable web GUI to display real-time insights  
✅ Standardize data quality and anomaly detection  
✅ Support multiple DPT types (not just temperature)  
✅ Maintain backward compatibility with existing endpoints  

---

## Architecture

### Design Principles

1. **Vendor Extension Pattern**: New endpoints under `/api/v2/stats/*`
2. **Pagination Support**: All endpoints support `limit` and `offset` parameters
3. **Time-based Filtering**: All analytics support `hours` parameter for relative time queries
4. **JSON:API Style**: Consistent response format with metadata
5. **OAuth2 Protection**: Require `read` scope for all analytics endpoints

### Implementation Layer

```
┌─────────────────────────────────────────┐
│         REST API Routes Layer           │
│  (new endpoints in statistics.js)       │
└────────────┬────────────────────────────┘
             │
┌────────────v────────────────────────────┐
│    StatisticsStore Methods              │
│    (new SQL query methods)              │
└────────────┬────────────────────────────┘
             │
┌────────────v────────────────────────────┐
│    PostgreSQL + TimescaleDB             │
│    (raw SQL with Window Functions)      │
└─────────────────────────────────────────┘
```

---

## New Endpoints Specification

### 1. GET `/api/v2/stats/anomalies`

Detect temperature jumps and other anomalies based on configurable thresholds.

#### Request

```bash
GET /api/v2/stats/anomalies?dpt=9.001&delta=2&hours=24&limit=50
Authorization: Bearer <read-token>
Content-Type: application/vnd.api+json
```

#### Query Parameters

| Parameter | Type | Default | Range | Description |
|-----------|------|---------|-------|-------------|
| `dpt` | string | required | - | DPT type (e.g., "9.001", "1.001") or comma-separated |
| `delta` | float | 2.0 | 0.1 - 100 | Temperature/value change threshold |
| `hours` | int | 24 | 1 - 8760 | Time window in hours |
| `limit` | int | 50 | 1 - 1000 | Max results returned |
| `severity` | string | all | high, medium, low | Filter by severity |

#### Response (200 OK)

```json
{
  "meta": {
    "collection": {
      "total": 42,
      "returned": 50,
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
      "id": "anom-329-2026071516",
      "type": "anomaly",
      "attributes": {
        "timestamp": "2026-07-15T16:30:00Z",
        "datapointId": "GA-329",
        "ga": "3/6/1",
        "title": "Living Room Temperature",
        "dpt": "9.001",
        "unit": "°C",
        "previousValue": 22.3,
        "currentValue": 24.8,
        "delta": 2.5,
        "deltaPercent": 11.2,
        "severity": "high",
        "timeGapSeconds": 300,
        "source": "1.1.230"
      }
    }
  ],
  "summary": {
    "high": 8,
    "medium": 15,
    "low": 19,
    "total": 42,
    "timeRange": {
      "since": "2026-07-14T16:30:00Z",
      "until": "2026-07-15T16:30:00Z"
    }
  }
}
```

#### Severity Calculation

```
delta <= 1.0         → low
1.0 < delta <= 3.0   → medium
delta > 3.0          → high
```

#### Implementation Notes

- Uses SQL `LAG()` window function to compare consecutive values
- Group by `datapoint_id` to analyze per-sensor
- Filter by time and DPT type
- Sorted by `delta DESC` by default

---

### 2. GET `/api/v2/stats/null-patterns`

Analyze NULL value distribution for data quality assessment.

#### Request

```bash
GET /api/v2/stats/null-patterns?dpt=9.001,9.007&hours=24
Authorization: Bearer <read-token>
```

#### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `dpt` | string | required | DPT types (comma-separated) |
| `hours` | int | 24 | Time window |
| `min_count` | int | 0 | Minimum NULL count threshold |

#### Response (200 OK)

```json
{
  "meta": {
    "period_hours": 24,
    "analysis_timestamp": "2026-07-15T16:30:00Z"
  },
  "temporal_patterns": {
    "description": "NULL values grouped by minute of hour",
    "synchronized": true,
    "pattern": [
      {
        "minute_of_hour": 5,
        "null_count": 127,
        "affected_gas_count": 2,
        "sample_gas": ["3/6/21", "3/7/42"],
        "percentage_of_total": 23.4
      },
      {
        "minute_of_hour": 35,
        "null_count": 98,
        "affected_gas_count": 2,
        "sample_gas": ["3/6/21", "3/7/42"],
        "percentage_of_total": 18.0
      }
    ]
  },
  "spatial_patterns": {
    "description": "NULL values grouped by group address",
    "concentrated": true,
    "pattern": [
      {
        "ga": "3/6/21",
        "datapointId": "GA-339",
        "title": "WP Warmwasser Solltemperatur",
        "null_count": 156,
        "hours_affected": 12,
        "percent_of_all_events": 28.6,
        "first_null": "2026-07-14T17:05:00Z",
        "last_null": "2026-07-15T16:05:00Z"
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

#### Implementation Notes

- Query `knx_events WHERE value_float IS NULL`
- Use `EXTRACT(MINUTE FROM ts)` for a temporal pattern
- Group by `ga` for a spatial pattern
- Calculate percentages against total events in the period

---

### 3. GET `/api/v2/stats/datapoint-summary/:datapointId`

Summary statistics for a single datapoint over configurable time windows.

#### Request

```bash
GET /api/v2/stats/datapoint-summary/GA-329?hours=24&include_forecast=false
Authorization: Bearer <read-token>
```

#### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `datapointId` | string | Datapoint ID or GA (e.g., "GA-329" or "3/6/1") |

#### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `hours` | int | 24 | Time window |
| `include_forecast` | bool | false | Include trend forecast |
| `include_raw` | bool | false | Include raw data points |

#### Response (200 OK)

```json
{
  "data": {
    "id": "GA-329",
    "type": "datapoint",
    "attributes": {
      "datapointId": "GA-329",
      "ga": "3/6/1",
      "title": "Living Room Temperature",
      "dpt": "9.001",
      "unit": "°C",
      "source": "1.1.230"
    }
  },
  "statistics": {
    "last_24h": {
      "period": {
        "since": "2026-07-14T16:30:00Z",
        "until": "2026-07-15T16:30:00Z",
        "hours": 24
      },
      "measurements": {
        "count": 1440,
        "missing": 2,
        "null_count": 0,
        "null_percent": 0.0
      },
      "values": {
        "average": 22.4,
        "minimum": 21.8,
        "maximum": 23.6,
        "range": 1.8,
        "stddev": 0.42,
        "median": 22.3,
        "q1": 22.1,
        "q3": 22.7
      },
      "trend": {
        "direction": "stable",
        "first_value": 22.2,
        "last_value": 22.4,
        "change": 0.2,
        "change_percent": 0.9
      }
    },
    "last_7d": {
      "measurements": { "count": 10080 },
      "values": {
        "average": 22.1,
        "minimum": 20.1,
        "maximum": 24.8,
        "range": 4.7
      },
      "anomalies": 5
    }
  },
  "current": {
    "value": 22.4,
    "timestamp": "2026-07-15T16:30:00Z",
    "age_seconds": 45,
    "status": "ok"
  }
}
```

#### Implementation Notes

- Use percentile functions for Q1, Q3
- Calculate trend via linear regression or simple delta
- Distinguish between missing values and NULL values

---

### 4. GET `/api/v2/stats/inactive-sensors`

Identify sensors with no recent measurements (potential failures).

#### Request

```bash
GET /api/v2/stats/inactive-sensors?dpt=9.001&hours=1&min_hours=0.5
Authorization: Bearer <read-token>
```

#### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `dpt` | string | - | Optional DPT filter |
| `hours` | int | 1 | Inactivity threshold in hours |
| `min_hours` | float | 0.5 | Minimum inactivity to report |

#### Response (200 OK)

```json
{
  "meta": {
    "threshold_hours": 1.0,
    "checked_at": "2026-07-15T16:30:00Z",
    "total_sensors": 12,
    "inactive_count": 3
  },
  "data": [
    {
      "id": "GA-362",
      "type": "sensor",
      "attributes": {
        "datapointId": "GA-362",
        "ga": "3/7/21",
        "title": "WP Warmwasser Solltemperatur",
        "dpt": "9.001",
        "unit": "°C",
        "last_measurement": "2026-07-15T14:22:10Z",
        "hours_inactive": 2.1,
        "minutes_inactive": 126,
        "status": "alert",
        "last_value": 0.46
      }
    }
  ],
  "summary": {
    "total_monitored": 12,
    "active": 9,
    "alert": 3,
    "critical": 0,
    "timestamp": "2026-07-15T16:30:00Z"
  }
}
```

#### Status Codes

```
ok       → activity < 1 hour
alert    → activity 1-4 hours
critical → activity > 4 hours
```

---

### 5. GET `/api/v2/stats/aggregated`

Time-bucketed aggregations for charting and trend analysis.

#### Request

```bash
GET /api/v2/stats/aggregated?dpt=9.001&bucket=1h&hours=168&metrics=avg,min,max,count
Authorization: Bearer <read-token>
```

#### Query Parameters

| Parameter | Type | Options | Description |
|-----------|------|---------|-------------|
| `dpt` | string | - | DPT type (required) |
| `bucket` | string | 5m, 15m, 1h, 6h, 1d | Time bucket size |
| `hours` | int | 1-8760 | Total time window |
| `metrics` | string | avg, min, max, count, stddev | Metrics to include |
| `ga` | string | - | Optional: single GA filter |

#### Response (200 OK)

```json
{
  "meta": {
    "aggregation": {
      "bucket_size": "1 hour",
      "bucket_count": 168,
      "period_hours": 168,
      "metrics": ["avg", "min", "max", "count"]
    },
    "timezone": "Europe/Vienna",
    "since": "2026-07-08T16:30:00Z",
    "until": "2026-07-15T16:30:00Z"
  },
  "data": [
    {
      "id": "agg-9001-202607081600",
      "type": "aggregation",
      "attributes": {
        "bucket": "2026-07-08T16:00:00Z",
        "metrics": {
          "avg": 22.3,
          "min": 21.1,
          "max": 23.8,
          "count": 42,
          "stddev": 0.67
        },
        "datapoint_count": 1,
        "null_count": 0
      }
    }
  ]
}
```

#### Implementation Notes

- Use TimescaleDB `time_bucket()` function
- Support for multiple aggregation metrics
- Return arrays for multi-datapoint queries
- Optimize queries using hypertable compression

---

### 6. GET `/api/v2/stats/heatmap`

Matrix view of values across multiple sensors over time (for dashboard visualization).

#### Request

```bash
GET /api/v2/stats/heatmap?dpt=9.001&hours=24&granularity=15m
Authorization: Bearer <read-token>
```

#### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `dpt` | string | required | DPT type |
| `hours` | int | 24 | Time window |
| `granularity` | string | 1h | Cell granularity (15m, 30m, 1h) |
| `limit` | int | 20 | Max sensors in heatmap |

#### Response (200 OK)

```json
{
  "meta": {
    "granularity": "15 minutes",
    "period_hours": 24,
    "sensor_count": 9,
    "time_bins": 96
  },
  "scale": {
    "min": 18.0,
    "max": 26.0,
    "unit": "°C",
    "colors": {
      "min": "#0000ff",
      "mid": "#00ff00",
      "max": "#ff0000"
    }
  },
  "data": [
    {
      "id": "GA-329",
      "type": "heatmap",
      "attributes": {
        "datapointId": "GA-329",
        "ga": "3/6/1",
        "title": "Living Room",
        "values": [
          { "hour": 0, "value": 21.2, "color": "#1e40af" },
          { "hour": 1, "value": 21.0, "color": "#1e3a8a" },
          { "hour": 2, "value": 20.8, "color": "#0c4a6e" }
        ]
      }
    }
  ]
}
```

---

## Error Handling

### Standard Error Response

```json
{
  "errors": [
    {
      "status": "400",
      "title": "Invalid Query Parameter",
      "detail": "Parameter 'delta' must be between 0.1 and 100",
      "source": { "parameter": "delta" }
    }
  ]
}
```

### Common Status Codes

| Code | Scenario |
|------|----------|
| 200 | Success |
| 400 | Invalid query parameter |
| 401 | Missing/invalid OAuth token |
| 403 | Insufficient permissions |
| 404 | Datapoint not found |
| 422 | Unprocessable entity (invalid DPT) |
| 500 | Database error |
| 503 | Database unavailable |

---

## Implementation Plan

### Phase 1: Foundation

- [ ] Add methods to `StatisticsStore`:
  - `getAnomalies(dpt, delta, since, limit)`
  - `getNullPatterns(dpts, since)`
  - `getDatapointSummary(datapointId, since)`
  
- [ ] Create new routes in `statistics.js`
- [ ] Add unit tests for core logic

### Phase 2: Completion

- [ ] Implement inactive sensors endpoint
- [ ] Implement aggregated endpoint with caching
- [ ] Integration tests with an actual database

### Phase 3: Enhancement

- [ ] Implement heatmap endpoint
- [ ] Performance optimization (indexes, caching)
- [ ] API documentation update (OpenAPI spec)

---

## Performance Considerations

### Query Optimization

```sql
-- Create index for anomaly detection
CREATE INDEX idx_knx_events_dpt_ts ON knx_events(dpt, ts DESC);

-- Create index for NULL analysis
CREATE INDEX idx_knx_events_null_dpt_ts ON knx_events(dpt, value_float) WHERE value_float IS NULL;

-- Partitioning (if needed)
-- Already handled by TimescaleDB hypertable chunking
```

### Caching Strategy

- Cache aggregated results for >= 1 hour buckets (TTL: 5 min)
- Cache inactive sensor list (TTL: 2 min)
- No caching for anomalies/real-time data

### Pagination

All endpoints support cursor-based pagination:
```
?limit=50&offset=100
```

---

## Testing Strategy

### Unit Tests

```javascript
// tests/statistics-api.test.js
describe('GET /api/v2/stats/anomalies', () => {
  test('returns anomalies with delta > threshold', async () => {
    // Test LAG function behavior
  });
  
  test('filters by DPT correctly', async () => {
    // Test DPT filtering
  });
});
```

### Integration Tests

```bash
# tests/integration/analytics-api.test.sh

# Test anomaly detection with synthetic data
# Test NULL pattern detection
# Test aggregation accuracy
# Test response format compliance
```

---

## Documentation Requirements

- [ ] OpenAPI/Swagger spec for each endpoint
- [ ] Example curl commands for each endpoint
- [ ] Response schema documentation
- [ ] Error code documentation
- [ ] Performance guidelines (timeout, max results)

---

## Future Enhancements

- 🔮 **Forecasting**: Linear trend prediction using `FORECAST()` function
- 🔮 **Alerting**: Automatic alert rules based on thresholds
- 🔮 **Export**: CSV/JSON export of analytics
- 🔮 **Comparison**: Compare datapoints or time periods
- 🔮 **GraphQL**: Alternative query interface

---

## References

- [KNX IoT 3rd Party API v2.1.0](https://schema.knx.org/2020/api/2.1.0)
- [JSON:API Specification](https://jsonapi.org/)
- [TimescaleDB Documentation](https://docs.timescale.com/)
- [PostgreSQL Window Functions](https://www.postgresql.org/docs/current/windowfuncs.html)

---

## Contact & Questions

**Implementation Lead:** Development Team  
**Status:** Ready for Implementation  
**Last Updated:** July 12, 2026  

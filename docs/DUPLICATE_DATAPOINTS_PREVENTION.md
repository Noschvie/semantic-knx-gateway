# Duplicate Datapoints Prevention Guide

## Problem: "Why are there 3 entries found for GA 10/4/2?"

### Root Cause
When connecting multiple KNX systems to the same database over time, the data can become **inconsistent**:
- **datapoint_mappings** table: Contains 2 entries for GA 10/4/2 (from different systems)
- **current_state** table: Contains 2 states, but one state has NO corresponding mapping (orphaned state)
- **API returns 3 entries** because the union logic includes orphaned states

Example:
```
Mappings:
  - GA-25 → GA 10/4/2 (System 1)
  - GA-293 → GA 10/4/2 (System 2)

States:
  - GA-293 → GA 10/4/2 (has mapping ✓)
  - ga-10-4-2 → GA 10/4/2 (NO mapping ✗)

API Result: 3 entries
  1. Mapping GA-25 (id:GA-25)
  2. Mapping+State GA-293 (id:GA-293)  
  3. Orphaned State ga-10-4-2 (ga:10/4/2)
```

### Solution: Filter Orphaned States (IMPLEMENTED ✓)

The API now **skips states without corresponding mappings**:

**File:** `src/api/routes/datapoints.js`
**Change:** Added check before processing each state:

```javascript
for (const state of allStates) {
    const mapping = mappingByDatapointId.get(state.datapointId)
        ?? mappingByGa.get(state.ga)
        ?? null;

    // Skip orphaned states without a mapping
    // (prevents duplicate/stale datapoints from old KNX systems appearing in API)
    if (!mapping) {
        continue;  // ← ADDED
    }
    
    // ... rest of processing
}
```

**Applied to 3 endpoints:**
1. `GET /api/v2/datapoints` (line ~350)
2. `GET /api/v2/datapoints/:id/timeseries` (line ~524)
3. `GET /api/v2/datapoints/:id` (line ~618)

---

## Prevention Strategy Going Forward

### 1. **Single System = Single Configuration**
- Use **one KNX gateway** per installation
- Don't reconnect different KNX systems to the same database

### 2. **Clean Migrations Between Systems**
If you MUST switch KNX systems:

```bash
# Backup old data
docker exec timescaledb pg_dump -U knxuser knxdb > backup-old-system.sql

# Clear data (CAUTION!)
docker exec timescaledb psql -U knxuser -d knxdb -c "
  DELETE FROM datapoint_mappings;
  DELETE FROM current_state;
  DELETE FROM knx_events;
  VACUUM;
"

# Import fresh TTL file for new system
# (Restart container with new KNX_TTL_FILE env)
```

### 3. **Database Maintenance (Recommended Quarterly)**
Monitor for orphaned states:

```sql
-- Find orphaned states (states without mappings)
SELECT COUNT(*) as orphaned_count
FROM current_state cs
LEFT JOIN datapoint_mappings m ON cs.datapoint_id = m.datapoint_id
WHERE m.datapoint_id IS NULL;

-- Find duplicate GAs with different DPTs (data corruption indicator)
SELECT ga, COUNT(DISTINCT dpt) as dpt_variants
FROM datapoint_mappings
GROUP BY ga
HAVING COUNT(DISTINCT dpt) > 1;

-- Clean orphaned states (if needed)
DELETE FROM current_state cs
WHERE NOT EXISTS (
  SELECT 1 FROM datapoint_mappings m 
  WHERE m.datapoint_id = cs.datapoint_id
);
```

### 4. **Enforce Uniqueness (Optional)**
If you want to prevent multiple mappings per GA entirely:

```sql
-- Add UNIQUE constraint on GA
ALTER TABLE datapoint_mappings 
ADD CONSTRAINT unique_ga UNIQUE (ga);

-- Note: This would reject duplicate GAs during import
-- Only use if you never have legitimate multi-system setups
```

### 5. **Database Backup Strategy**
```bash
# Daily backup of current state
docker exec timescaledb pg_dump -U knxuser knxdb | \
  gzip > volumes/backups/knx-$(date +%Y%m%d-%H%M%S).sql.gz

# Retention: Keep last 30 days
find volumes/backups -name "knx-*.sql.gz" -mtime +30 -delete
```

---

## Deployment Checklist

Before connecting a new KNX system:

- [ ] Fresh database? (`POSTGRES_PASSWORD` differs from prod)
- [ ] Correct TTL file? (Matches the physical KNX installation)
- [ ] No orphaned states from previous system? (Query above)
- [ ] All datapoints have mappings? (Monitor startup logs)
- [ ] Test API filters: `GET /api/v2/datapoints?filter[ga]=1/1/1`

---

## What This Fix Changes

✅ **Before:** 3 entries for GA 10/4/2  
✅ **After:** 1 entry (only the valid one with mapping)

**API Responses:**
```bash
# Before
curl -s "http://localhost:3000/api/v2/datapoints?filter[ga]=10/4/2" | jq '.meta.collection.total'
# → 3

# After
curl -s "http://localhost:3000/api/v2/datapoints?filter[ga]=10/4/2" | jq '.meta.collection.total'
# → 1
```

---

## References
- **Schema:** `ARCHITECTURE.md` → Database section
- **Implementation:** `src/api/routes/datapoints.js`
- **State Engine:** `src/state/state-engine.js`



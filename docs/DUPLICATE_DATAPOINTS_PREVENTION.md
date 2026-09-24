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

## Import-Time Duplicate Detection (Operations Guide)

During TTL import, the `SemanticMapper` (`src/semantic/semantic-mapper.js`)
detects **three duplicate types** and logs them via the logger. These warnings
help operations to catch ETS projection errors and DPT inconsistencies early,
**before** they lead to ambiguous results in the API.

### Overview of the three duplicate types

| # | Type | Trigger | Log level | Source |
|---|------|---------|-----------|--------|
| 1 | **DPT_CHANGE_DETECTED** | Same GA, **different** DPT than in the last import | `warn` | `dptHistory.detectDptConflicts()` |
| 2 | **DUPLICATE_DPT_IN_IMPORT** | Same GA, **multiple different** DPTs in the **same** import | `error` | `dptHistory.detectDptConflicts()` |
| 3 | **Multiply-Mapped GA** | Same GA, **multiple datapoints** (even with the same DPT) | `warn` | `warnMultiplyMappedGAs()` |

---

### Type 1 – `DPT_CHANGE_DETECTED` (DPT change over time)

**What happens:** A group address was created in an earlier import with DPT `A`
and appears in the current import with DPT `B`. The change is recorded in the
DPT history and the import continues.

**Example log line:**
```
[DPT Conflicts] 1 potential conflicts detected: ...
  GA 10/4/2: 1.001 → 5.001 (will be logged in history)
```

**Operational meaning:**
- Usually a **legitimate** change in ETS (e.g. switching → dimming value).
- But it can also indicate a **wrong TTL file**.

**Recommended action:**
1. Check whether the DPT change was intended in ETS.
2. Review the history (see `docs/DPT_CHANGE_HISTORY_GUIDE.md`).
3. On an unintended change: re-import the correct TTL.

---

### Type 2 – `DUPLICATE_DPT_IN_IMPORT` (conflicting DPTs in one import)

**What happens:** Within the **same** TTL import, multiple datapoints reference
the same GA with **different** DPTs. This is a **data error** – the value of a
GA cannot have two DPTs at the same time.

**Example log line:**
```
  GA 10/4/2: Multiple datapoints with different DPTs: 1.001, 5.001
```

**Operational meaning:**
- Almost always an **ETS projection error** or a faulty TTL generation.
- Leads to non-deterministic DPT selection and wrong value decoding.

**Recommended action:**
1. Fix the TTL/ETS projection so the GA has exactly **one** DPT.
2. Repeat the import and check the logs for `error` entries.
3. Optional: run `SELECT ga, COUNT(DISTINCT dpt) ... HAVING COUNT(DISTINCT dpt) > 1`
   (see SQL above) for verification.

---

### Type 3 – Multiply-mapped GA (`warnMultiplyMappedGAs`)

**What happens:** A GA is projected onto **more than one datapoint** – even when
they all share the same DPT. Unlike Type 1/2, this also fires **with the same
DPT** and thus reveals classic ETS double assignments.

**Example log line:**
```
[Projection] ⚠️ GA 10/4/2 is mapped to 2 datapoints: GA-25 ("Licht Küche"), GA-293 ("Licht Küche") — check ETS projection (a group address should map to a single datapoint)
[Projection] 1 group address(es) are mapped to multiple datapoints; the API/BFF must pick one and command/status paths may diverge.
```

**Operational meaning:**
- The API/BFF must pick **one** datapoint non-deterministically.
- The command and status paths may point to **different** datapoints.

**Recommended action:**
1. Check in ETS why two datapoints point to the same GA.
2. Remove the duplicate assignment or merge the datapoints.
3. For re-projected/removed datapoints: **enable pruning** (see below).

---

### Cleaning up orphaned mappings: Pruning (optional)

When a datapoint is **removed** between two TTL versions or **mapped away** from
a GA, the old `datapoint_mappings` row remains as a **stale duplicate**. The
optional prune step deletes mappings (and their `current_state`) whose
`datapoint_id` was **not** part of the current import.

**Activation via environment variable:**
```bash
# docker-compose.yml / .env
IMPORT_PRUNE_ENABLED=true
```

**Safety behavior:**
- **Disabled by default** (`false`).
- Is **skipped** if the import provides no active IDs (empty/failed import) –
  prevents accidentally emptying the table.
- Each removed mapping is logged individually as `warn`:
  ```
  [Prune] Removing orphaned mapping GA-25 (ga=10/4/2, name="Licht Küche") — not present in current TTL
  [Prune] Removed 1 orphaned datapoint mapping(s)
  ```

**Recommendation:**
- **Enable** in stable single-system setups to remove stale data automatically.
- **Leave disabled** in multi-system/test environments to avoid deleting
  legitimate mappings.

---

### Monitoring recommendation

After each import, check the logs for the following markers:

| Marker | Meaning | Priority |
|--------|---------|----------|
| `[DPT Conflicts]` | DPT change or conflicting DPTs | Medium/High |
| `DUPLICATE_DPT_IN_IMPORT` | Conflicting DPTs (data error) | **High** |
| `[Projection] ⚠️` | GA mapped to multiple datapoints | Medium |
| `[Prune] Removing` | Orphaned mapping removed | Info |

Example (Docker):
```bash
docker logs knx-gateway 2>&1 | grep -E "\[DPT Conflicts\]|DUPLICATE_DPT_IN_IMPORT|\[Projection\]|\[Prune\]"
```

---

## Deployment Checklist

Before connecting a new KNX system:

- [ ] Fresh database? (`POSTGRES_PASSWORD` differs from prod)
- [ ] Correct TTL file? (Matches the physical KNX installation)
- [ ] No orphaned states from the previous system? (Query above)
- [ ] All datapoints have mappings? (Monitor startup logs)
- [ ] No import warnings? (`[DPT Conflicts]`, `DUPLICATE_DPT_IN_IMPORT`, `[Projection] ⚠️` – see section above)
- [ ] `IMPORT_PRUNE_ENABLED` set to match the setup? (Single-system: `true`, multi-system/test: `false`)
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
- **Import/Mapping:** `src/semantic/semantic-mapper.js` (Duplicate-Detection & Pruning)
- **DPT-History:** `docs/DPT_CHANGE_HISTORY_GUIDE.md`
- **State Engine:** `src/state/state-engine.js`

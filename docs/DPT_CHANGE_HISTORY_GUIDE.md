# DPT Change History Implementation

**Date:** July 9, 2026  
**Status:** ✅ IMPLEMENTED  
**Strategy:** Option A – Track DPT changes with history

---

## 📋 What Was Implemented

### **1. Database Schema**
**File:** `src/storage/postgres.js`

Added a new table automatically on startup:

```sql
CREATE TABLE dpt_change_log (
  id SERIAL PRIMARY KEY,
  datapoint_id TEXT NOT NULL,
  ga TEXT NOT NULL,
  old_dpt TEXT,
  new_dpt TEXT NOT NULL,
  changed_at TIMESTAMPTZ DEFAULT NOW(),
  changed_by TEXT DEFAULT 'system',
  reason TEXT,
  metadata JSONB,
  FOREIGN KEY (datapoint_id) REFERENCES datapoint_mappings(datapoint_id)
);

-- Indexes for fast lookup
CREATE INDEX idx_dpt_log_ga ON dpt_change_log(ga, changed_at DESC);
CREATE INDEX idx_dpt_log_datapoint_id ON dpt_change_log(datapoint_id, changed_at DESC);
```

### **2. DPT History Manager**
**File:** `src/storage/dpt-history.js`

Provides these methods:

```javascript
// Log a DPT change
await dptHistory.logDptChange(datapointId, ga, oldDpt, newDpt, 'admin', 'Typo fix');

// Get DPT that was active at specific time
const dptAtTime = await dptHistory.getDptAtTime(ga, '2026-06-20 15:06:01');

// Get complete change history for a GA
const history = await dptHistory.getDptHistory(ga);

// Detect conflicts during import
const conflicts = await dptHistory.detectDptConflicts(newMappings);

// Get statistics
const stats = await dptHistory.getStatistics();
```

### **3. Migration Script**
**File:** `src/storage/migrations/001-add-dpt-history.sql`

Standalone migration file for manual execution if needed.

### **4. Diagnostic Tool**
**File:** `scripts/dpt-history-check.sh`

```bash
# View history statistics
./scripts/dpt-history-check.sh

# Show recent changes
./scripts/dpt-history-check.sh --log

# Show detailed stats
./scripts/dpt-history-check.sh --stats
```

---

## 🔄 How It Works

### **When DPT Changes**

```javascript
// Example: GA 10/4/2 changes from DPT 10.001 to 5.001

// 1. Admin updates mapping
await mappings.update('GA-293', { dpt: '5.001' });

// 2. System logs the change
await dptHistory.logDptChange(
  'GA-293',
  '10/4/2',
  '10.001',  // old
  '5.001',   // new
  'admin',   // who
  'Changed from Time to Scaling'  // why
);

// 3. In dpt_change_log:
// {
//   id: 42,
//   datapoint_id: 'GA-293',
//   ga: '10/4/2',
//   old_dpt: '10.001',
//   new_dpt: '5.001',
//   changed_at: '2026-07-09 14:30:00',
//   changed_by: 'admin',
//   reason: 'Changed from Time to Scaling'
// }
```

### **Interpreting Historical Values**

```javascript
// When reading a state from 2026-06-20:
const state = await db.query('SELECT * FROM current_state WHERE ga = $1 AND updated_at = $2', 
  ['10/4/2', '2026-06-20 15:06:01']);

// Find what DPT was active then:
const dptAtCapture = await dptHistory.getDptAtTime('10/4/2', state.updated_at);
// → Returns '10.001' (the old DPT)

// Now interpret the value correctly:
const value = toSpecValue(state.value);  // Uses old DPT context
```

### **Detecting Conflicts**

```javascript
// When importing new TTL file:
const newMappings = ttlLoader.parse(file);
const conflicts = await dptHistory.detectDptConflicts(newMappings);

// Returns:
// [
//   {
//     ga: '10/4/2',
//     type: 'DPT_CHANGE_DETECTED',
//     old_dpt: '10.001',
//     new_dpt: '5.001'
//   }
// ]

// Admin must decide:
// - Accept change? → Log it
// - Reject change? → Use different GA
// - Investigate? → Check history
```

---

## 📊 Database Statistics

Get an overview of DPT changes:

```bash
# Check history status
./scripts/dpt-history-check.sh

# Sample output:
# 1. TABLE STATUS
#    ✓ dpt_change_log table exists
#
# 2. HISTORY STATISTICS
#    Total DPT changes: 3
#    Unique GAs affected: 2
#    Unique Datapoints affected: 2
#    Last change: 2026-07-08 10:30:45
#
# 3. DPT CONSISTENCY CHECK
#    ✓ All mappings match latest DPT changes
```

---

## 🚀 Integration Points (TODO)

To fully activate this feature, integrate at these points:

### **1. State Engine**
**File:** `src/state/state-engine.js`

When updating a mapping:

```javascript
async updateMapping(datapointId, newMapping) {
  const oldMapping = await this.getMapping(datapointId);
  
  // Update datapoint_mappings
  await this.db.update('datapoint_mappings', newMapping);
  
  // Log DPT change if it occurred
  if (oldMapping.dpt !== newMapping.dpt) {
    const dptHistory = new DptHistoryManager(this.db, this.logger);
    await dptHistory.logDptChange(
      datapointId,
      newMapping.ga,
      oldMapping.dpt,
      newMapping.dpt,
      'api',  // who
      null    // reason (from request body?)
    );
  }
}
```

### **2. TTL Loader**
**File:** `src/semantic/ttl-loader.js`

When loading the new TTL file:

```javascript
async loadTtl(filePath) {
  const newMappings = this.parse(filePath);
  
  // Check for conflicts
  const dptHistory = new DptHistoryManager(this.db, this.logger);
  const conflicts = await dptHistory.detectDptConflicts(newMappings);
  
  if (conflicts.length > 0) {
    this.logger.warn('DPT conflicts detected:', conflicts);
    // Option 1: Reject import
    // Option 2: Ask admin for confirmation
    // Option 3: Auto-resolve by creating new GA
  }
  
  // Load mappings...
  
  // Log changes for new mappings
  for (const mapping of newMappings) {
    const oldMapping = await this.getMapping(mapping.datapoint_id);
    if (oldMapping?.dpt !== mapping.dpt) {
      await dptHistory.logDptChange(...);
    }
  }
}
```

### **3. API Response**
**File:** `src/api/routes/datapoints.js`

Include DPT history in responses:

```javascript
function toDatapointResource(state) {
  const dpt = state.dpt;
  
  // Get DPT that was active at state capture time
  const dptAtCapture = await dptHistory.getDptAtTime(state.ga, state.updated_at);
  
  return {
    // ...existing...
    meta: {
      dpt: dpt,           // Current DPT
      dpt_at_capture: dptAtCapture,  // What it was when state was saved
      // Clients can use dpt_at_capture for proper historical interpretation
    }
  };
}
```

---

## 📝 Next Steps

1. **Test the database changes**
   ```bash
   # After restart, verify table exists:
   docker exec timescaledb psql -U knxuser -d knxdb -c "\dt dpt_change_log"
   ```

2. **Integrate in State Engine**
   - Add DptHistoryManager import
   - Call logDptChange() when DPT changes
   
3. **Integrate in TTL Loader**
   - Add conflict detection
   - Ask admin for confirmation on DPT changes

4. **Update API**
   - Add dpt_at_capture to responses
   - Clients use it for historical interpretation

5. **Monitor & Report**
   - Use `dpt-history-check.sh` periodically
   - Alert if DPT changes are detected

---

## ✅ Verification

```bash
# After database restart:
docker exec timescaledb psql -U knxuser -d knxdb -c "
  SELECT * FROM dpt_change_log LIMIT 5;
"
# Should be empty (no changes yet)

# Check the index:
docker exec timescaledb psql -U knxuser -d knxdb -c "
  SELECT indexname FROM pg_indexes WHERE tablename = 'dpt_change_log';
"
# Should show: idx_dpt_log_ga, idx_dpt_log_datapoint_id
```

---

## 💡 Benefits of This Approach

✅ **Auditability** – Every DPT change is logged with timestamp and author  
✅ **Correctness** – Historical values always interpreted with correct DPT  
✅ **Flexibility** – Allows DPT changes without data corruption  
✅ **Transparency** – Admin can see conflict history  
✅ **Reversibility** – Can track back to previous DPT if needed  

---

## References

- DPT Manager: `src/storage/dpt-history.js`
- Schema: `src/storage/postgres.js` (lines ~150)
- Indices: Lines ~258
- Migration: `src/storage/migrations/001-add-dpt-history.sql`
- Diagnostic: `scripts/dpt-history-check.sh`

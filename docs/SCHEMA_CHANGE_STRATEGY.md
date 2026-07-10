# Schema Change Strategy: GA Renaming & DPT Changes

**Status:** Design Document (not yet implemented)  
**Date:** July 9, 2026

---

## Problem Statement

Two critical use cases need proper handling:

1. **GA Renaming:** `name` changes in `datapoint_mappings`
2. **DPT Changes:** `dpt` changes in `datapoint_mappings`

### Current Behavior

```javascript
// In datapoints.js - GET endpoint
const merged = {
    ...mapping,           // ← Latest definition (new name/dpt)
    ...state,             // ← Historical value (old dpt interpretation)
    dpt: state.dpt ?? mapping.dpt,  // Prefers state.dpt if present
    name: state.name ?? mapping.name  // Prefers state.name if present
};
```

**Issue:** When `state.dpt` differs from `mapping.dpt`, the value interpretation becomes ambiguous.

---

## Use Case 1: GA Renaming (LOW RISK)

### Example
```
Before: datapoint_mappings { ga: '10/4/2', dpt: '10.001', name: 'Uhrzeit' }
After:  datapoint_mappings { ga: '10/4/2', dpt: '10.001', name: 'Systemzeit' }
```

### Impact
✅ **Low Risk** – Name is cosmetic, doesn't affect value interpretation
- `current_state` values remain unchanged
- API will show new name immediately
- Historical events keep old name (which is fine)

### Current Implementation
✅ **Already works** – name comes from latest mapping

---

## Use Case 2: DPT Changes (HIGH RISK)

### Example
```
Before: GA 10/4/2 with DPT 10.001 (Time)
        → Raw DB: { "hour": 18, "minute": 16, "second": 3 }

After:  GA 10/4/2 with DPT 5.001 (Scaling)
        → Same value interpreted as: percentage 0-255?
```

### Problem Scenarios

#### **Scenario A: Value is incompatible**
```javascript
// Old state stored as time object
state.value = '{"hour":18,"minute":16,"second":3}'

// But new DPT expects a number 0-255
// toSpecValue() will stringify the object → WRONG!
// Client expects: "70.6%" but gets: "{\"hour\":18...}"
```

#### **Scenario B: Write request fails**
```javascript
// Client sends: PUT with value "150" (DPT 5.001)
// Server tries to decode with mapping.dpt = '5.001'
// But current_state.dpt might still = '10.001'
// → Confusion about what the value means!
```

### Impact
❌ **HIGH RISK** – Data becomes misinterpreted

---

## Proposed Solutions

### **Solution 1: Store DPT History (RECOMMENDED)**

Add version tracking:

```sql
ALTER TABLE current_state ADD COLUMN (
  dpt_version INT DEFAULT 1,
  dpt_changed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Or: New table for DPT history
CREATE TABLE dpt_history (
  datapoint_id TEXT,
  old_dpt TEXT,
  new_dpt TEXT,
  changed_at TIMESTAMPTZ,
  reason TEXT
);
```

**Advantages:**
- Track when DPT changed
- Interpret old states correctly
- Audit trail for debugging

**Implementation:**
- When `dpt` changes in mapping → log to `dpt_history`
- API reads history to find correct interpretation
- Legacy values decoded with their original DPT

---

### **Solution 2: Reject DPT Changes (SAFEST)**

```sql
ALTER TABLE datapoint_mappings 
ADD CONSTRAINT immutable_dpt CHECK (true);
-- Comment: "Once a GA gets a DPT, it cannot change"
```

**Rule:** If DPT needs to change → create NEW datapoint (new GA or new ID)

**Advantages:**
- No ambiguity
- No historical confusion
- Clear audit trail

**Disadvantages:**
- Less flexible
- Requires re-assignment if DPT was wrong

---

### **Solution 3: Immutable Mappings + Shadowing (HYBRID)**

Keep original mapping immutable, allow new versions:

```sql
-- Original mapping (immutable)
datapoint_mappings {
  datapoint_id: 'GA-293',
  ga: '10/4/2',
  dpt: '10.001',
  name: 'Uhrzeit',
  version: 1,
  deprecated: false
}

-- New version (if truly needed)
datapoint_mappings {
  datapoint_id: 'GA-293-v2',  ← NEW ID
  ga: '10/4/2',
  dpt: '5.001',
  name: 'Zeit als Scaling',
  version: 2,
  deprecated: false
}
```

**Advantages:**
- Backward compatible
- Explicit versioning
- API can choose which version to return

---

## Recommended Implementation

### **Phase 1: Immediate (Current Fix)**
✅ Already done: **Skip orphaned states**

### **Phase 2: Short-term (Next Sprint)**
Add **DPT change logging**:

```javascript
// In state-engine.js when mapping.dpt changes
const oldMapping = await getDatapointMappingByUuid(datapointId);
if (oldMapping.dpt !== newMapping.dpt) {
    await logDptChange({
        datapointId,
        old_dpt: oldMapping.dpt,
        new_dpt: newMapping.dpt,
        changed_at: new Date(),
        changed_by: 'admin' // or API user
    });
}
```

### **Phase 3: Long-term (Next Quarter)**
Choose one solution:
- **A:** Full DPT history tracking
- **B:** Reject DPT changes (enforce immutability)
- **C:** Versioned mappings (GA-293-v1, v2, ...)

---

## API Impact

### **What Changes in Responses**

#### **Current (unstable in face of DPT changes):**
```json
{
  "data": {
    "attributes": {
      "value": "18:16:03",
      "knx:groupAddress": 5122
    },
    "meta": {
      "dpt": "10.001"  // ← From mapping (latest)
    }
  }
}
```

#### **Proposed with Solution A (DPT history):**
```json
{
  "data": {
    "attributes": {
      "value": "18:16:03",
      "knx:groupAddress": 5122
    },
    "meta": {
      "dpt": "10.001",           // ← Current mapping
      "dpt_at_capture": "10.001"  // ← What was it when stored?
    }
  }
}
```

#### **Proposed with Solution B (reject changes):**
```json
{
  "data": {
    "attributes": {
      "value": "18:16:03",
      "knx:groupAddress": 5122
    },
    "meta": {
      "dpt": "10.001",
      "immutable_since": "2026-07-09T10:00:00Z"
    }
  }
}
```

---

## Recommendation

**I suggest: Solution B (Reject DPT Changes)**

**Why:**
1. **Simplest** – No complex versioning
2. **Safest** – No data misinterpretation
3. **Clear** – Operators know DPT is fixed
4. **KNX-compliant** – In real KNX, GA/DPT pairing is fixed

**Implementation:**

```sql
-- Add constraint
ALTER TABLE datapoint_mappings 
ADD CONSTRAINT unique_ga UNIQUE (ga);
-- If ga is unique, changing dpt means replacing the whole entry

-- Or: Log and prevent changes
CREATE TABLE dpt_change_log (
  datapoint_id TEXT,
  ga TEXT,
  old_dpt TEXT,
  new_dpt TEXT,
  attempted_at TIMESTAMPTZ,
  rejected_reason TEXT
);
```

**Migration Strategy:**
1. If TTL file defines different DPT for same GA → **ERROR** on import
2. Force admin to choose: keep old DPT or migrate to new GA

---

## Next Steps

1. ✅ **Confirm approach** – Which solution fits your use case?
2. **Implement logging** – Track any DPT change attempts
3. **Update TTL loader** – Reject conflicting definitions
4. **Add admin UI** – Alert on DPT conflicts before import

Would you like me to implement **Solution B (Reject DPT Changes)** with proper logging?



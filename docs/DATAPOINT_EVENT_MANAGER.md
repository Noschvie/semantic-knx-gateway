# DATAPOINT EVENT MANAGER

**Storage Orchestration Layer: Unified Persistence for Semantic Datapoint Events**

Version: 1.0  
Status: Design Complete / Implementation Pending  
Date: 2026-07-14

---

## 📋 Overview

The **DatapointEventManager** is a new orchestration layer in the storage subsystem that encapsulates all persistence operations related to incoming KNX telegrams and their semantic enrichment.

### What It Does

Manages the complete lifecycle of a KNX telegram from network arrival to persistent storage:

```
Incoming Telegram
  │
  ├─ Parse & Enrich with Semantic Context (GA → Datapoint)
  ├─ Store in knx_events (Event Log)
  ├─ Update current_state (Latest Value per Datapoint)
  ├─ Record in dpt_history (Optional: Aggregates/Statistics)
  ├─ Maintain Audit Trail (Timestamps, Sources, Errors)
  └─ Return Enriched Event to Subscribers
```

### Why It Exists

**Before**: Event Bus directly orchestrates 3+ stores → scattered error handling, hard to test, no transaction model

**After**: Single unified interface → cleaner code, testable, ACID guarantees, automatic retry logic

---

## 🎯 Design Principles

### 1. **Single Responsibility**
- Only manages datapoint event persistence
- Does NOT: Parse telegrams, decode DPT values, route subscriptions
- Does: Orchestrate storage across multiple DAOs

### 2. **Clean Abstraction**
- Event Bus → `manager.processTelegram(telegram)` (one call)
- Hides EventStore, StateStore, DptHistory complexity

### 3. **Transaction Safety**
- All operations in a single database transaction (SERIALIZABLE isolation)
- All-or-nothing semantics
- Automatic rollback on error

### 4. **Resilience**
- Exponential backoff retry logic
- Handles transient failures gracefully
- Detailed error logging

### 5. **Composability**
- Builds on existing DAOs (EventStore, StateStore, DptHistory)
- Enhances them with optional `client` parameter for external transactions
- Backward compatible

### 6. **Observability**
- Built-in metrics (processed, failed, retried)
- Detailed logging at each step
- Audit trail for compliance

---

## 🏗️ Architecture

### Conceptual Model

```
Layer 5: Event Bus (Consumer)
  │
  │ telegram
  ▼
╔═══════════════════════════════════════════════╗
║  DatapointEventManager (NEW)                  ║
║  ┌─────────────────────────────────────────┐  ║
║  │ processTelegram(telegram, options)      │  ║
║  │ ├─ Validate input                       │  ║
║  │ ├─ Begin transaction                    │  ║
║  │ ├─ Call: eventStore.storeEvent()        │  ║
║  │ ├─ Call: stateStore.updateState()       │  ║
║  │ ├─ Call: dptHistory.recordHistory()     │  ║
║  │ ├─ Commit transaction                   │  ║
║  │ └─ Return enriched event                │  ║
║  └─────────────────────────────────────────┘  ║
║                                               ║
║  + bulkProcessTelegrams()                     ║
║  + queryHistory()                             ║
║  + getCurrentState()                          ║
║  + getMetrics()                               ║
╚═══════════════════════════════════════════════╝
  │         │                   │
  ▼         ▼                   ▼
EventStore StateStore       DptHistory
  (DAO)     (DAO)            (DAO)
  │         │                   │
  ▼         ▼                   ▼
PostgreSQL / TimescaleDB
```

### Data Flow

```
processTelegram(telegram)
│
├─ Input: {
│   ga: "1/2/3",
│   source: "1.1.10",
│   value: 22.5,
│   dpt: "DPT 9.001",
│   timestamp: "2026-07-14T10:30:00Z",
│   datapointId: "sensor-temp-001" (enriched by Semantic Mapper)
│ }
│
├─ Client = await db.getClient()
│
├─ BEGIN TRANSACTION (SERIALIZABLE)
│
├─ eventStore.storeEvent(telegram, client)
│  └─ INSERT INTO knx_events (ts, ga, datapoint_id, value_float, dpt, ...)
│
├─ stateStore.updateState(datapointId, state, client)
│  └─ INSERT INTO current_state (...) ON CONFLICT DO UPDATE SET ...
│
├─ dptHistory.recordHistory(datapointId, event, client)  [Optional]
│  └─ UPDATE dpt_statistics SET (...) WHERE datapoint_id = ...
│
├─ COMMIT TRANSACTION
│
├─ Emit: eventBus.emit('telegram', enrichedEvent)
│
└─ Return: {
     id: event-uuid,
     datapointId: "sensor-temp-001",
     ga: "1/2/3",
     value: 22.5,
     storedAt: "2026-07-14T10:30:00.123Z",
     duration_ms: 1.2
   }
```

---

## 💾 API Design

### Core Methods

#### 1. `processTelegram(telegram, options = {})`

Process a single incoming telegram with full persistence.

**Parameters:**
```javascript
telegram: {
  ga: string,                    // Group address (e.g., "1/2/3")
  source: string,                // KNX source address (e.g., "1.1.10")
  value: any,                    // Decoded value (bool, float, int, string, object)
  dpt: string,                   // Datapoint type (e.g., "DPT 9.001")
  timestamp: Date | ISO8601,     // Event timestamp
  datapointId: string,           // Semantic datapoint UUID (may be null if unresolved)
  eventType: 'write' | 'read' | 'response' // [Optional] default: 'write'
}

options: {
  maxRetries: 3,                 // Exponential backoff retry attempts
  recordHistory: true,           // Record in dpt_history table
  auditLog: true,                // Record in audit_events table
  skipSubscriptions: false       // [Internal] set by Subscription Dispatcher
}
```

**Returns:**
```javascript
{
  success: true,
  eventId: "event-uuid",
  datapointId: "sensor-temp-001",
  ga: "1/2/3",
  value: 22.5,
  storedAt: "2026-07-14T10:30:00.123Z",
  attempts: 1,
  duration_ms: 1.2,
  cached: false
}
```

**Example:**
```javascript
const result = await manager.processTelegram({
  ga: '1/2/3',
  source: '1.1.10',
  value: 22.5,
  dpt: 'DPT 9.001',
  timestamp: new Date(),
  datapointId: 'sensor-temp-001'
});

console.log(`Stored: ${result.datapointId} = ${result.value}`);
```

---

#### 2. `bulkProcessTelegrams(telegrams, options = {})`

Batch process multiple telegrams efficiently (useful for backlog recovery).

**Parameters:**
```javascript
telegrams: Telegram[]    // Array of telegrams (max 10,000 recommended)

options: {
  concurrency: 10,       // Parallel processing (default: 10)
  abortOnError: false,   // Stop on first failure or continue?
  reportProgress: true   // Call progress callback?
}
```

**Returns:**
```javascript
{
  total: 1000,
  succeeded: 998,
  failed: 2,
  skipped: 0,
  duration_ms: 5234,
  results: {
    succeeded: [ /* 998 events */ ],
    failed: [
      {
        telegram: { ga: "1/2/3", ... },
        error: "Database constraint violated",
        attempt: 3
      }
    ]
  },
  metrics: {
    avg_duration_ms: 5.2,
    min_duration_ms: 0.8,
    max_duration_ms: 12.4,
    events_per_second: 190
  }
}
```

**Example:**
```javascript
const backlog = await fetchBacklogTelegrams();
const result = await manager.bulkProcessTelegrams(backlog, {
  concurrency: 20,
  abortOnError: false
});

console.log(`Processed ${result.succeeded}/${result.total}`);
if (result.failed > 0) {
  console.warn(`${result.failed} failed:`, result.results.failed);
}
```

---

#### 3. `queryHistory(datapointId, options = {})`

Query historical events for a specific datapoint.

**Parameters:**
```javascript
datapointId: string

options: {
  limit: 100,                    // Max records (default: 100, max: 10000)
  offset: 0,                     // Pagination offset
  fromTime: Date | ISO8601,      // Time range start (inclusive)
  toTime: Date | ISO8601,        // Time range end (inclusive)
  orderBy: 'desc'                // 'asc' or 'desc' (default: 'desc')
}
```

**Returns:**
```javascript
{
  datapointId: "sensor-temp-001",
  total: 15234,                  // Total matching events
  returned: 100,                 // Actual count in this page
  timeRange: {
    from: "2026-07-01T00:00:00Z",
    to: "2026-07-14T23:59:59Z"
  },
  events: [
    {
      ts: "2026-07-14T10:30:15Z",
      ga: "1/2/3",
      value: 22.5,
      dpt: "DPT 9.001",
      source: "1.1.10",
      eventType: "write"
    },
    // ... more events ...
  ]
}
```

---

#### 4. `getCurrentState(datapointId)`

Get the latest known state of a datapoint.

**Returns:**
```javascript
{
  datapointId: "sensor-temp-001",
  ga: "1/2/3",
  value: 22.5,
  value_decoded: "22.5°C",
  dpt: "DPT 9.001",
  updated_at: "2026-07-14T10:30:15Z",
  source: "1.1.10"
}
```

---

#### 5. `getMetrics()`

Get performance metrics and statistics.

**Returns:**
```javascript
{
  uptime_seconds: 86400,
  events_processed: 8765432,
  events_failed: 12,
  events_retried: 45,
  
  latency: {
    last_ms: 1.2,
    avg_ms: 1.8,
    p50_ms: 1.5,
    p95_ms: 3.2,
    p99_ms: 5.1
  },
  
  throughput: {
    events_per_second: 101.4,
    events_per_minute: 6084
  },
  
  storage: {
    knx_events_count: 8765432,
    current_state_count: 4321,
    oldest_event: "2026-01-01T00:00:00Z",
    newest_event: "2026-07-14T10:30:15Z"
  },
  
  transactions: {
    total_committed: 8765432,
    total_rolled_back: 12,
    current_active: 0
  }
}
```

---

### Query/Analysis Methods

#### 6. `getStatistics(datapointId, options = {})`

Get aggregated statistics for a datapoint.

```javascript
const stats = await manager.getStatistics('sensor-temp-001', {
  from: '2026-07-01',
  to: '2026-07-14'
});

// Returns:
{
  datapointId: "sensor-temp-001",
  period: { from: "2026-07-01", to: "2026-07-14" },
  count: 1234,
  min: 18.2,
  max: 25.8,
  avg: 21.5,
  stddev: 1.2,
  lastValue: 22.5,
  lastUpdated: "2026-07-14T10:30:15Z"
}
```

---

## 🔌 Integration Points

### 1. Injection into StateEngine

**File: `src/index.js`**

```javascript
import { DatapointEventManager } from './storage/datapoint-event-manager.js';
import { EventStore } from './storage/event-store.js';
import { StateStore } from './storage/state-store.js';
import { DptHistoryManager } from './storage/dpt-history.js';

// Initialize DAOs
const eventStore = new EventStore(db);
const stateStore = new StateStore(db);
const dptHistory = new DptHistoryManager(db, logger);

// Create orchestrator
const datapointEventManager = new DatapointEventManager(
  eventStore,
  stateStore,
  dptHistory,
  db,
  logger
);

// Pass to StateEngine
const stateEngine = new StateEngine(db, datapointEventManager);
```

---

### 2. Updated StateEngine Constructor

**File: `src/state/state-engine.js`**

```javascript
export class StateEngine {
  constructor(db, datapointEventManager) {
    this.logger = createLogger('StateEngine');
    this.db = db;
    this.eventBus = new EventBus();
    this.datapointEventManager = datapointEventManager;  // NEW: use orchestrator
    this.datapointMappings = new Map();
  }

  async processIncomingTelegram(telegram) {
    try {
      // Now simplified: delegate to manager
      const result = await this.datapointEventManager.processTelegram(telegram, {
        recordHistory: true,
        auditLog: true
      });

      // Emit for subscribers (optional, if not done in manager)
      this.eventBus.emit('telegram', result);
      this.eventBus.emit(`ga:${telegram.ga}`, result);
      this.eventBus.emit(`datapoint:${result.datapointId}`, result);

      return result;
    } catch (error) {
      this.logger.error({
        msg: 'Failed to process telegram',
        ga: telegram.ga,
        error: error.message
      });
      throw error;
    }
  }
}
```

---

### 3. API Endpoint Example

**File: `src/api/routes/database.js`**

```javascript
router.get('/history/:datapointId', bearer(), async (req, res, next) => {
  try {
    const { datapointId } = req.params;
    const { limit, offset, from, to } = req.query;

    const result = await datapointEventManager.queryHistory(datapointId, {
      limit: parseInt(limit) || 100,
      offset: parseInt(offset) || 0,
      fromTime: from ? new Date(from) : null,
      toTime: to ? new Date(to) : null
    });

    res.json({ data: result });
  } catch (error) {
    next(error);
  }
});
```

---

## 💾 Implementation Details

### Enhanced DAO Signatures

All existing DAOs get an optional `client` parameter for transaction support:

#### EventStore

```javascript
async storeEvent(event, client = null) {
  const connection = client || await this.db.getClient();
  try {
    const result = await connection.query(
      `INSERT INTO knx_events (ts, ga, datapoint_id, value_float, value_int, value_bool, value_text, dpt, payload, source, event_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [event.ts, event.ga, event.datapointId, event.value_float, ...]
    );
    return result;
  } finally {
    if (!client) connection.release();
  }
}
```

#### StateStore

```javascript
async updateState(datapointId, state, client = null) {
  const connection = client || await this.db.getClient();
  try {
    const result = await connection.query(
      `INSERT INTO current_state (datapoint_id, ga, value, value_decoded, dpt, updated_at, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (datapoint_id) DO UPDATE SET
         value = EXCLUDED.value,
         value_decoded = EXCLUDED.value_decoded,
         updated_at = EXCLUDED.updated_at`,
      [datapointId, state.ga, state.value, ...]
    );
    return result;
  } finally {
    if (!client) connection.release();
  }
}
```

---

### Transaction Model

```javascript
async processTelegram(telegram, options = {}) {
  const { maxRetries = 3, recordHistory = true, auditLog = true } = options;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const client = await this.db.getClient();
    try {
      // Start transaction
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

      // Execute all stores with same client
      await this.eventStore.storeEvent(enrichedTelegram, client);
      await this.stateStore.updateState(telegram.datapointId, state, client);

      if (recordHistory) {
        await this.dptHistory.recordHistory(telegram.datapointId, telegram, client);
      }

      if (auditLog) {
        await client.query(
          `INSERT INTO audit_events (ts, event_type, data)
           VALUES ($1, $2, $3)`,
          [new Date(), 'telegram_processed', JSON.stringify(enrichedTelegram)]
        );
      }

      // Commit all at once
      await client.query('COMMIT');

      this.metrics.processed++;
      return { success: true, eventId: telegram.id, attempts: attempt, duration_ms: Date.now() - startTime };

    } catch (error) {
      await client.query('ROLLBACK');
      lastError = error;

      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt - 1) * 100;  // 100ms, 200ms, 400ms
        await this.#sleep(delay);
        this.metrics.retried++;
      }

    } finally {
      client.release();
    }
  }

  this.metrics.failed++;
  throw new Error(`Failed to process telegram after ${maxRetries} attempts: ${lastError.message}`);
}
```

---

### Metrics Collection

```javascript
class DatapointEventManager {
  constructor(...) {
    this.metrics = {
      processed: 0,
      failed: 0,
      retried: 0,
      lastProcessTime: 0,
      startTime: Date.now(),
      latencies: []  // circular buffer for p95/p99
    };
  }

  getMetrics() {
    const uptime = (Date.now() - this.metrics.startTime) / 1000;
    return {
      uptime_seconds: uptime,
      events_processed: this.metrics.processed,
      events_failed: this.metrics.failed,
      events_retried: this.metrics.retried,
      throughput: {
        events_per_second: this.metrics.processed / uptime
      },
      latency: {
        last_ms: this.metrics.lastProcessTime,
        avg_ms: this.#calculateAvg(this.metrics.latencies),
        p95_ms: this.#calculatePercentile(this.metrics.latencies, 95),
        p99_ms: this.#calculatePercentile(this.metrics.latencies, 99)
      }
    };
  }
}
```

---

## 🧪 Testing Strategy

### Unit Tests

**File: `test/storage/datapoint-event-manager.spec.js`**

```javascript
describe('DatapointEventManager', () => {
  let manager, eventStore, stateStore, dptHistory, db;

  beforeEach(() => {
    // Mock DAOs
    eventStore = {
      storeEvent: jest.fn().mockResolvedValue({ rowCount: 1 })
    };
    stateStore = {
      updateState: jest.fn().mockResolvedValue({ rowCount: 1 })
    };
    dptHistory = {
      recordHistory: jest.fn().mockResolvedValue({ rowCount: 1 })
    };
    db = createMockDatabase();

    manager = new DatapointEventManager(eventStore, stateStore, dptHistory, db, logger);
  });

  test('processTelegram: commits all stores atomically', async () => {
    const telegram = {
      ga: '1/2/3',
      source: '1.1.10',
      value: 22.5,
      dpt: 'DPT 9.001',
      timestamp: new Date(),
      datapointId: 'sensor-temp-001'
    };

    await manager.processTelegram(telegram);

    expect(eventStore.storeEvent).toHaveBeenCalledTimes(1);
    expect(stateStore.updateState).toHaveBeenCalledTimes(1);
    expect(db.query).toHaveBeenCalledWith('BEGIN ISOLATION LEVEL SERIALIZABLE');
    expect(db.query).toHaveBeenCalledWith('COMMIT');
  });

  test('processTelegram: rolls back on error', async () => {
    eventStore.storeEvent.mockRejectedValue(new Error('DB Error'));

    await expect(manager.processTelegram(telegram))
      .rejects.toThrow('DB Error');

    expect(db.query).toHaveBeenCalledWith('ROLLBACK');
  });

  test('processTelegram: retries with exponential backoff', async () => {
    eventStore.storeEvent
      .mockRejectedValueOnce(new Error('Temporary lock'))
      .mockRejectedValueOnce(new Error('Temporary lock'))
      .mockResolvedValueOnce({ rowCount: 1 });

    const result = await manager.processTelegram(telegram, { maxRetries: 3 });

    expect(result.attempts).toBe(3);
    expect(eventStore.storeEvent).toHaveBeenCalledTimes(3);
  });

  test('bulkProcessTelegrams: processes in parallel', async () => {
    const telegrams = Array(100).fill({
      ga: '1/2/3',
      source: '1.1.10',
      value: 22.5,
      dpt: 'DPT 9.001',
      timestamp: new Date(),
      datapointId: 'sensor-temp-001'
    });

    const result = await manager.bulkProcessTelegrams(telegrams, { concurrency: 10 });

    expect(result.succeeded).toBe(100);
    expect(result.failed).toBe(0);
  });
});
```

---

### Integration Tests

```javascript
describe('DatapointEventManager Integration', () => {
  test('Transaction is atomic: if state update fails, event is not stored', async () => {
    // Setup: stateStore will fail on second call
    stateStore.updateState.mockRejectedValueOnce(new Error('Constraint violation'));

    await expect(manager.processTelegram(telegram)).rejects.toThrow();

    // Verify: knx_events should be empty (rolled back)
    const events = await db.query('SELECT COUNT(*) FROM knx_events');
    expect(events.rows[0].count).toBe(0);
  });

  test('Concurrent telegrams are serialized correctly', async () => {
    const telegram1 = { ga: '1/2/3', value: 22.0, datapointId: 'sensor-1' };
    const telegram2 = { ga: '1/2/3', value: 23.0, datapointId: 'sensor-1' };

    await Promise.all([
      manager.processTelegram(telegram1),
      manager.processTelegram(telegram2)
    ]);

    const state = await manager.getCurrentState('sensor-1');
    // Should be one of them, atomically
    expect([22.0, 23.0]).toContain(state.value);
  });
});
```

---

## 📝 Implementation Checklist

- [ ] Create `src/storage/datapoint-event-manager.js`
- [ ] Update `src/storage/event-store.js` signature (add optional `client` parameter)
- [ ] Update `src/storage/state-store.js` signature (add optional `client` parameter)
- [ ] Update `src/storage/dpt-history.js` signature (add optional `client` parameter)
- [ ] Create `audit_events` table in database migrations
- [ ] Update `src/index.js` to instantiate and inject manager
- [ ] Update `src/state/state-engine.js` to use manager
- [ ] Write unit tests for manager (`test/storage/datapoint-event-manager.spec.js`)
- [ ] Write integration tests
- [ ] Update ARCHITECTURE.md to reference this layer
- [ ] Add OpenAPI docs for new query endpoints
- [ ] Performance testing (target: > 100 events/sec, < 2ms p95 latency)
- [ ] Load testing (1000s telegrams/sec)
- [ ] Documentation: deployment guide

---

## 🚀 Migration Path

### Phase 1: Non-Breaking Addition (Week 1)

- Create a manager class
- Update DAO signatures (backward compatible)
- No changes to existing code
- **Risk level: LOW**

### Phase 2: Integration (Week 2)

- Inject manager into StateEngine
- Update telegram processing to use manager
- **Risk level: LOW** (internal refactor only)

### Phase 3: Testing & Validation (Week 3)

- Unit & integration tests pass
- Performance benchmarks OK
- Staging deployment

### Phase 4: Production Rollout (Week 4)

- Canary deployment (5% traffic)
- Monitor metrics
- Full rollout

---

## 🔄 Related Documentation

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — System-level architecture
- **[DATABASE_MANAGEMENT.md](./DATABASE_MANAGEMENT.md)** — Operational management (cleanup, backup)
- **[DATABASE_BACKUP_RESTORE.md](./DATABASE_BACKUP_RESTORE.md)** — Backup strategies
- **[API_TIMESTAMP_CONVENTION.md](./API_TIMESTAMP_CONVENTION.md)** — Timestamp handling

---

## 📊 Performance Targets

| Metric | Target | Notes |
|--------|--------|-------|
| Single telegram latency (p50) | < 1.5 ms | In-process, single transaction |
| Single telegram latency (p95) | < 3 ms | Includes network I/O |
| Single telegram latency (p99) | < 5 ms | Rare spikes acceptable |
| Throughput | ≥ 100 events/sec | Modest hardware (2 cores, 4GB RAM) |
| Retry success rate | > 99.9% | After exponential backoff |
| Transaction rollback overhead | < 0.1ms | Trivial compared to success path |

---

## 🛡️ Error Handling

### Recoverable Errors (Retry)

- Network timeout
- Deadlock detected
- Connection pool exhausted (temporary)
- → Exponential backoff + retry

### Unrecoverable Errors (Fail Fast)

- Constraint violation (FK missing)
- Type mismatch
- Connection permanently closed
- → Log + fail immediately

### Partial Failures (Atomic Rollback)

- If ANY store fails → ALL changes rolled back
- Example: Event stored, but state update fails
  - ✅ Automatic rollback of event
  - ✅ Clean slate for retry

---

## 🎯 Success Criteria

✅ **Functionality**: All 6 methods work as specified  
✅ **Reliability**: 99.9%+ success rate in production  
✅ **Performance**: Meets latency/throughput targets  
✅ **Testing**: 90%+ code coverage, integration tests pass  
✅ **Documentation**: Complete API docs + deployment guide  
✅ **Backward Compatibility**: Existing code unaffected  

---

**Version**: 1.0-DRAFT  
**Status**: ✅ Design Complete / ⏳ Implementation Pending  
**Last Updated**: 2026-07-14

# Database Query Patterns

## Best Practice: Always Use `this.db.query()`, Never Manual `client.connect()`

This document establishes the canonical pattern for database access in the Semantic KNX Runtime Engine.

---

## The Problem

❌ **WRONG – Do NOT use this pattern:**

```javascript
async someMethod() {
    let client;
    try {
        client = await this.pool.connect();
        const result = await client.query('SELECT ...');
        return result.rows;
    } finally {
        if (client) client.release();
    }
}
```

### Why this is wrong:

1. **Race Conditions with `Promise.all()`**
   - When multiple methods using this pattern run in parallel (e.g., via `Promise.all()`), each grabs its own `client` from the pool
   - If queries run simultaneously on the **same logical client**, PostgreSQL pg@8.x emits: 
     ```
     DeprecationWarning: Calling client.query() when the client is already executing a query is deprecated
     ```
   - This can lead to **500 errors** under a concurrent load

2. **Connection Pool Exhaustion**
   - Each method holds a connection for its entire lifetime
   - Under high concurrency, all pool connections get reserved and idle
   - New requests starve and timeout

3. **Boilerplate Code**
   - Every method needs try/finally/release scaffolding
   - Error-prone: forgetting `finally` causes connection leaks

### Real-World Example (Bug Found in Production)

**File:** `src/storage/statistics-store.js`
**Symptom:** GET / returns 500 error with pg deprecation warning during startup

**Root Cause:** `StatisticsLogger.getStats()` calls 12 methods in parallel via `Promise.all()`. Each method was doing:
```javascript
let client = await this.pool.connect();  // Grab own connection
await client.query(...);                  // Run query
client.release();                         // Return connection
```

When 12 queries run simultaneously on different clients, it causes the deprecation warning and crashes.

---

## The Solution

✅ **CORRECT – Always use this pattern:**

```javascript
async someMethod() {
    try {
        const result = await this.db.query('SELECT ...');
        return result.rows;
    } catch (err) {
        this.logger.error('Failed to do something', {error: err.message});
        return [];  // or appropriate default
    }
}
```

### Why this works:

1. **Pool Management is Automatic**
   - `this.db.query()` internally uses `this.pool.query()` from the pg library
   - The pool automatically assigns connections from the pool to each query
   - Connections are returned to the pool immediately after the query completes
   - No manual `connect()` / `release()` needed

2. **True Parallelism**
   - Multiple queries can run simultaneously without holding connections between them
   - The pool efficiently reuses connections from the pool
   - No deprecation warnings

3. **Parallel Queries are Safe**
   ```javascript
   const [result1, result2, result3] = await Promise.all([
       this.db.query('SELECT COUNT(*) FROM table1'),
       this.db.query('SELECT COUNT(*) FROM table2'),
       this.db.query('SELECT COUNT(*) FROM table3'),
   ]);
   ```
   Each query borrows a connection, executes, and returns it immediately. No conflicts.

---

## Architecture

### PostgresClient (`src/storage/postgres.js`)

The `PostgresClient` class wraps the pg library's Pool and provides the central query method:

```javascript
export class PostgresClient {
    constructor() {
        this.pool = new Pool({
            max: 20,                    // Connection pool size
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000,
        });
    }

    // ✅ CANONICAL QUERY METHOD
    async query(text, params) {
        const start = Date.now();
        try {
            const result = await this.pool.query(text, params);
            const duration = Date.now() - start;
            this.logger.debug(`Query executed in ${duration}ms`);
            return result;
        } catch (error) {
            this.logger.error({
                msg: 'Query error',
                query: text,
                params: params,
                errorMessage: error.message,
                // ... detailed error context
            });
            throw error;
        }
    }
}
```

### Usage in Other Layers

All code that needs database access should:

1. **Receive the PostgresClient instance** (dependency injection)
2. **Store it as `this.db`** (not `this.pool`)
3. **Call `this.db.query()`** (never `this.pool.connect()`)

#### Example: StatisticsStore

**Correct Constructor:**
```javascript
export class StatisticsStore {
    constructor(postgresClient) {
        this.db = postgresClient;  // ✅ Store the client object
        this.logger = createLogger('StatisticsStore');
    }
}
```

**Correct Query Method:**
```javascript
async getTotalEventCount() {
    try {
        const result = await this.db.query('SELECT COUNT(*) as count FROM knx_events');
        return parseInt(result.rows[0].count);
    } catch (err) {
        this.logger.error('Failed to get total event count', {error: err.message});
        return 0;
    }
}
```

**Correct Parallel Queries:**
```javascript
async getStatistics() {
    try {
        const results = await Promise.all([
            this.db.query('SELECT COUNT(*) as count FROM knx_events'),
            this.db.query('SELECT COUNT(*) as count FROM current_state'),
            this.db.query('SELECT COUNT(*) as count FROM datapoint_mappings'),
        ]);
        return {
            events: parseInt(results[0].rows[0].count),
            states: parseInt(results[1].rows[0].count),
            mappings: parseInt(results[2].rows[0].count),
        };
    } catch (err) {
        this.logger.error('Failed to get statistics', {error: err.message});
        return { events: 0, states: 0, mappings: 0 };
    }
}
```

---

## Migration Guide

If you find code using the old pattern, update it:

### Before (Wrong)
```javascript
async getTotalEventCount() {
    let client;
    try {
        client = await this.pool.connect();
        const result = await client.query('SELECT COUNT(*) as count FROM knx_events');
        return parseInt(result.rows[0].count);
    } catch (err) {
        this.logger.error('...', err);
        return 0;
    } finally {
        if (client) client.release();
    }
}
```

### After (Correct)
```javascript
async getTotalEventCount() {
    try {
        const result = await this.db.query('SELECT COUNT(*) as count FROM knx_events');
        return parseInt(result.rows[0].count);
    } catch (err) {
        this.logger.error('Failed to get total event count', {error: err.message});
        return 0;
    }
}
```

**Changes:**
1. Remove `let client;`
2. Remove `client = await this.pool.connect();` line
3. Change `client.query()` → `this.db.query()`
4. Remove the `finally` block entirely

---

## Transactions

### When to Use Transactions

**Use transactions ONLY for:**
- Multistep operations where all-or-nothing semantics are required
- Schema initialization (CREATE TABLE, CREATE INDEX, etc.)
- Complex data migrations
- Atomic updates across multiple tables

**Do NOT use transactions for:**
- Single `INSERT`, `UPDATE`, or `DELETE` statements (PostgreSQL auto-commits)
- Read-only queries (SELECT)
- High-frequency operations (telegrams, state updates) — transactions add latency

### Transaction Pattern

For operations requiring transactional semantics, use the `beginTransaction()` helper method:

```javascript
async criticalMultiStepOperation() {
    const txn = await this.db.beginTransaction();
    try {
        // Step 1
        await txn.query('UPDATE table1 SET ...');
        
        // Step 2
        await txn.query('INSERT INTO table2 VALUES (...)');
        
        // Step 3
        const result = await txn.query('SELECT ...');
        
        await txn.commit();  // Automatically releases client
        return result.rows;
    } catch (err) {
        await txn.rollback();  // Automatically releases client
        this.logger.error('Transaction failed', {error: err.message});
        throw err;
    }
}
```

**Advantages over manual `getClient()`:**
- Automatic `BEGIN` statement
- Automatic client release in `commit()` and `rollback()`
- Cleaner error handling
- Less boilerplate code

### Alternative: Manual Transaction with `getClient()`

If you need more control, use `getClient()` directly:

```javascript
async criticalMultiStepOperation() {
    const client = await this.db.getClient();
    try {
        await client.query('BEGIN');
        
        // Step 1
        await client.query('UPDATE table1 SET ...');
        
        // Step 2
        await client.query('INSERT INTO table2 VALUES (...)');
        
        // Step 3
        const result = await client.query('SELECT ...');
        
        await client.query('COMMIT');
        return result.rows;
    } catch (err) {
        await client.query('ROLLBACK');
        this.logger.error('Transaction failed', {error: err.message});
        throw err;
    } finally {
        client.release();
    }
}
```

### Key Rules

1. **Always use `try/catch/finally`** with rollback on error
2. **Call `BEGIN` and `COMMIT` explicitly** (or `ROLLBACK` on error)
3. **Release the client in `finally`** to return it to the pool
4. **Never use parallel queries in transactions** — each operation must be sequential

### Real-World Example: Schema Initialization

**File:** `src/storage/postgres.js` — `initializeSchema()`

```javascript
async initializeSchema() {
    const client = await this.pool.connect();
    try {
        await client.query('BEGIN');
        
        // All schema changes in one transaction
        await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
        await client.query('CREATE TABLE IF NOT EXISTS knx_events (...)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_events_ga ON knx_events(...)');
        await client.query('CREATE TRIGGER ...');
        
        await client.query('COMMIT');
        this.logger.info('✅ Database schema initialized');
    } catch (error) {
        await client.query('ROLLBACK');
        this.logger.error('Failed to initialize schema:', error);
        throw error;
    } finally {
        client.release();
    }
}
```

### Isolation Levels

PostgreSQL defaults to **READ COMMITTED** isolation, which is appropriate for this application:

- **Read-heavy workloads** (stats queries) — no locking issues
- **Write operations** (events, state updates) — single-table operations don't need stricter isolation
- **Schema operations** — always fully isolated regardless of isolation level

**Do NOT change the isolation level** unless there's a specific business requirement (e.g., preventing phantom reads in a complex report query).

---

## Transaction Helper Methods (PostgresClient)

The `PostgresClient` class provides two methods for transaction handling:

### 1. `beginTransaction()` — RECOMMENDED

Returns a transaction context object that manages `BEGIN/COMMIT/ROLLBACK` automatically.

```javascript
const txn = await this.db.beginTransaction();
try {
    await txn.query('UPDATE ...');
    await txn.query('INSERT ...');
    await txn.commit();  // Auto-releases client
} catch (err) {
    await txn.rollback();  // Auto-releases client
    throw err;
}
```

**Advantages:**
- ✅ Minimal boilerplate
- ✅ Auto-releases a client in both success and error paths
- ✅ No `try/catch/finally` scaffolding needed
- ✅ Clear intent: "start a transaction"

### 2. `getClient()` — Manual Control

Returns a raw database client for full transaction control.

```javascript
const client = await this.db.getClient();
try {
    await client.query('BEGIN');
    // ... operations ...
    await client.query('COMMIT');
} catch (err) {
    await client.query('ROLLBACK');
    throw err;
} finally {
    client.release();
}
```

**When to use:**
- ✅ You need more explicit control over the transaction
- ✅ You need to mix transaction code with non-transactional code
- ✅ You have special rollback/recovery logic

**Note:** Always manually call `BEGIN`, `COMMIT`, `ROLLBACK`, and `release()` with this method.



To verify you're using the correct pattern, search for:

```bash
# WRONG - should find 0 results
grep -r "await this\.pool\.connect()" src/

# WRONG - should find 0 results
grep -r "client\.release()" src/

# WRONG - should find 0 results
grep -r "let client;" src/
```

✅ All should return zero matches.

---

## Performance Impact

Pool connection reuse is not just about correctness — it's also about **performance**:

| Metric | Manual `connect()` | `this.db.query()` |
|--------|-------------------|------------------|
| Parallel queries (12x) | ❌ Deprecation warnings, possible timeouts | ✅ No warnings, efficient reuse |
| Connection pool utilization | Low (many idle connections) | High (connections freed immediately) |
| Latency per query | Slightly higher (manual acquire/release) | Lower (implicit pool management) |
| Scalability | Poor (limited by pool size) | Excellent (connections recycled) |

---

## References

- **PostgreSQL pg Library**: [node-postgres.com/api/pool](https://node-postgres.com/api/pool)
- **PostgreSQL Connection Pooling**: [PostgreSQL Docs - Connection Pooling](https://www.postgresql.org/docs/current/sql-createtable.html)
- **Our Implementation**: `src/storage/postgres.js`, `src/storage/statistics-store.js`

---

## Checklist for Code Review

### Query Patterns

- [ ] Constructor receives `postgresClient` (not just `pool`)
- [ ] Stored as `this.db` (not `this.pool`)
- [ ] All queries use `await this.db.query(...)`
- [ ] No `let client;` declarations
- [ ] No `client.connect()` calls
- [ ] No `client.release()` calls
- [ ] No `finally` blocks with release logic
- [ ] Parallel queries use `Promise.all()` with multiple `this.db.query()` calls

### Transaction Patterns (if applicable)

**PREFERRED - Use `beginTransaction()` helper:**
- [ ] Uses `const txn = await this.db.beginTransaction()` (RECOMMENDED)
- [ ] All queries use `await txn.query(...)`
- [ ] Calls `await txn.commit()` to commit and auto-release
- [ ] Calls `await txn.rollback()` on error to rollback and auto-release

**ALTERNATIVE - Use `getClient()` directly (if more control needed):**
- [ ] Uses `const client = await this.db.getClient()` 
- [ ] Wrapped in try/catch/finally
- [ ] Includes explicit `BEGIN` with `client.query('BEGIN')`
- [ ] Includes explicit `COMMIT` with `client.query('COMMIT')`
- [ ] Includes `ROLLBACK` in catch block with `client.query('ROLLBACK')`
- [ ] `client.release()` called in finally block
- [ ] All queries are sequential (no parallel queries)
- [ ] Operations are properly ordered

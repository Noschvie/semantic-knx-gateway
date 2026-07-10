# KNX Reconnect & Resilience Guide

**Date:** July 10, 2026  
**Version:** 1.0  
**Status:** ✅ Implemented

---

## Overview

The KNX Gateway now includes **automatic reconnection**, **health monitoring**, and **outgoing telegram queuing** to ensure reliable operation even during network interruptions.

---

## Features

### 1️⃣ **Automatic Reconnection with Exponential Backoff → Persistent Retry**

When the KNX connection is lost, the system **never gives up**:

**Phase 1: Exponential Backoff (Attempts 1-10)**
```
Connection Lost
    ↓
Attempt 1: Wait 2s, retry
    ↓ (if fails)
Attempt 2: Wait 4s, retry
    ↓ (if fails)
Attempt 3: Wait 6s, retry
    ↓ (continues...)
Attempt 10: Wait 30s, retry
```

**Phase 2: Persistent Reconnect (Attempt 11+)**
```
Attempt 11: Wait 30s, retry
Attempt 12: Wait 30s, retry
Attempt 13: Wait 30s, retry
... (continues indefinitely until connected)
```

**Configuration:**
- Exponential backoff: 10 attempts (constant `MAX_RECONNECT_ATTEMPTS`)
- Initial delay: 2 seconds (constant `INITIAL_RECONNECT_DELAY_MS`)
- Backoff multiplier: 2x (2s, 4s, 6s, ..., 30s max)
- Persistent interval: 30 seconds (constant `PERSISTENT_RECONNECT_INTERVAL_MS`)
- **Never gives up** - keeps retrying indefinitely

**Code Location:** `TunnelManager.scheduleReconnect()` (uses all constants)

---

### 2️⃣ **Outgoing Telegram Queue with FIFO Drop Policy**

When the connection is down, outgoing writes are **queued** instead of failing:

```javascript
// API Request while disconnected
PUT /api/v2/datapoints/by-ga
{
  "data": {
    "meta": { "ga": "1/2/3" },
    "attributes": { "value": "1" }
  }
}

// Response: 200 OK (queued)
// The telegram will be sent once reconnected
```

**Queue Management:**
- Max queue size: 100 (constant `MAX_QUEUE_SIZE`)
- FIFO (First-In-First-Out) processing on reconnect
- **FIFO Drop policy:** When queue is full, oldest telegram is dropped to make room for newest
- Automatically processes queue on reconnection
- Logs success/failure for each telegram
- Logs when old telegrams are dropped due to queue overflow

**Queue Behavior:**
```
Normal operation (connected):
  Write immediately → no queuing

Disconnect occurs:
  T=0s:  Write GA 1/2/3 → queued (queue: 1/100)
  T=1s:  Write GA 1/2/4 → queued (queue: 2/100)
  ...
  T=100s: Write GA 1/2/5 (queue full)
          → Drop oldest: GA 1/2/3 (FIFO Drop)
          → Add newest: GA 1/2/5 (queue: 100/100)

Reconnect:
  Queue processed in FIFO order
  (older telegrams sent first, newer last)
```

**Code Location:**
- Queue class: `src/knx/telegram-queue.js` (FIFO implementation)
- Queue instance: `TunnelManager.telegramQueue` (initialized in constructor)
- Write with queue: `TunnelManager.write()` (uses queue)
- Queue processing: `TunnelManager.processQueuedTelegrams()`

---

### 3️⃣ **Health Check (Periodic Ping)**

Every 30 seconds (constant `HEALTH_CHECK_INTERVAL_MS`), the system verifies the connection is still alive:

```
Every 30s (HEALTH_CHECK_INTERVAL_MS):
  - Check if isConnected === true
  - Check if connection object exists
  - If lost: trigger automatic reconnection
```

**Code Location:** `TunnelManager.startHealthCheck()` (uses `HEALTH_CHECK_INTERVAL_MS`)

---

### 4️⃣ **Event Emission on Max Reconnect Attempts**

When max reconnection attempts (constant `MAX_RECONNECT_ATTEMPTS`, default 10) are exhausted:

```javascript
stateEngine.eventBus.emit('knx:max-reconnect-attempts', {
  timestamp: new Date().toISOString(),
  attempts: 10
});
```

**Use Cases:**
- Alert dashboard to notify admin
- Send email notification
- Log to an external monitoring system
- Trigger fallback behavior

**Code Location:** `TunnelManager.scheduleReconnect()` (uses `MAX_RECONNECT_ATTEMPTS`)

---

## Behavior Matrix

| Scenario | Before | After |
|----------|--------|-------|
| **Connection drops** | Manual restart needed | Auto-reconnect (exponential → persistent) |
| **Write during disconnect** | Error 503 | Queued ✅ |
| **Queue fills up (100+)** | Error thrown | FIFO Drop (oldest removed) ✅ |
| **Connection restored** | Restart | Queue processed automatically |
| **Reconnect fails after 10 attempts** | Silent failure | Persistent retry every 30s |
| **Silent connection loss** | Not detected | Health check detects (30s) |

---

## Usage Examples

### Example 1: Normal Reconnection Flow

```
T=0s:    Connection active ✅
T=5s:    Network cable unplugged
T=5.1s:  'disconnected' event → scheduleReconnect()
T=7.1s:  Attempt 1 - reconnect fails
T=11.1s: Attempt 2 - reconnect fails
T=17.1s: Attempt 3 - RECONNECTED ✅
T=17.2s: Queue processed (any pending writes sent)
```

### Example 2: Write During Disconnect

```javascript
// User clicks "Turn Light On" while reconnecting
const response = await fetch('/api/v2/datapoints/by-ga', {
  method: 'PUT',
  body: JSON.stringify({
    data: {
      meta: { ga: '1/2/3' },
      attributes: { value: '1' }
    }
  })
});

// Response: 200 OK
// Telegram is queued, will be sent on next successful connect
```

### Example 3: Listen for Max Reconnect Event

```javascript
// In your application code
stateEngine.eventBus.on('knx:max-reconnect-attempts', (data) => {
  console.error('🚨 KNX System Down! Max reconnection attempts exhausted');
  // Send alert email
  // Update dashboard status
  // Log incident
});
```

---

## Monitoring & Logs

### Log Patterns to Monitor

**Healthy:**
```
✅ KNX Tunnel connected
✅ State Engine initialized
💓 Health check OK
```

**Disconnection:**
```
❌ KNX Tunnel disconnected
⏳ Reconnecting in 2000ms (attempt 1/10)
```

**Queue Processing:**
```
📋 KNX write queued (not connected): 1/2/3 = 1 (queue: 1/100)
📋 KNX write queued (not connected): 1/2/4 = 0 (queue: 2/100)
📋 Queue full (100), dropping oldest: 1/2/3 = 1
📋 KNX write queued (not connected): 1/2/5 = 1 (queue: 100/100)
📤 Processing 100 queued telegrams...
✅ Queue processing complete: 100 sent, 0 failed
```

**Critical:**
```
❌ Max reconnect attempts reached. Giving up.
```

---

## Configuration

Edit `.env` or deployment config:

```bash
# KNX Connection
KNX_GATEWAY_IP=192.168.1.100
KNX_GATEWAY_PORT=3671
KNX_GATEWAY_PHYS_ADDR=1.1.250
```

### Tunable Parameters (in `src/knx/tunnel-manager.js`)

```javascript
// Constants (top of file)
const HEALTH_CHECK_INTERVAL_MS = 30000;     // Change health check interval
const INITIAL_RECONNECT_DELAY_MS = 2000;    // Initial reconnect delay
const MAX_RECONNECT_DELAY_MS = 30000;       // Maximum reconnect delay
const MAX_RECONNECT_ATTEMPTS = 10;          // Maximum reconnect attempts
const MAX_QUEUE_SIZE = 100;                 // Maximum queue size

// Constructor (line 26-41)
this.maxReconnectAttempts = MAX_RECONNECT_ATTEMPTS;  // Uses constant
this.maxQueueSize = MAX_QUEUE_SIZE;                  // Uses constant
```

---

## Technical Details

### State Transitions

```
┌─────────────────┐
│   NOT_RUNNING   │
└────────┬────────┘
         │ connect()
         ↓
┌─────────────────┐
│   CONNECTING    │
└────────┬────────┘
         │
    ╔════╩════════════════════╗
    ↓                         ↓
SUCCESS                   FAILED
    │                         │
    ↓                         ↓
┌──────────────┐       ┌─────────────────────┐
│ CONNECTED ✅ │       │ RECONNECT_BACKOFF   │
└──────┬───────┘       │ (Attempts 1-10)     │
       │               │ 2s, 4s, 6s, ..., 30s│
       │               └────────┬────────────┘
       │                        │
       │            ┌───────────┘
       │            ↓
       │        ┌────────────────────┐
       │        │ RECONNECT_PERSISTENT│
       │        │ (Attempt 11+)      │
       │        │ Every 30s forever  │
       │        └────────┬───────────┘
       │                 │
   Disconnect            │
       │                 │ (retry loop)
       ↓                 │
   (→ back to RECONNECT_BACKOFF)
   │
   onDisconnected()
```

**Flow:**
1. **CONNECTING** → Try to connect
2. **CONNECTED** ✅ → Health check (every 30s)
3. **RECONNECT_BACKOFF** → Exponential backoff (attempts 1-10)
   - 2s, 4s, 6s, 8s, 10s, 12s, 14s, 16s, 18s, 20s-30s
4. **RECONNECT_PERSISTENT** → Persistent retry (attempt 11+)
   - Every 30s, indefinitely (never gives up!)
5. **Back to CONNECTED** ✅ → When connection restored

**Key Points:**
- No "FAILED" terminal state (never gives up)
- After 10 failed attempts, switch from backoff to persistent 30s interval
- Health check detects silent disconnections
- On any disconnect (even when connected) → go back to RECONNECT_BACKOFF

### Thread Safety

- All state changes are atomic
- `isConnected` + `isConnecting` flags prevent race conditions
- Queue is synchronous (no concurrent access issues)
- `TelegramQueue` class is thread-safe for single-threaded Node.js

---

## TelegramQueue Class

The `TelegramQueue` class implements a FIFO queue with automatic drop policy.

### Usage

```javascript
import { TelegramQueue } from './src/knx/telegram-queue.js';

// Create queue with max 100 items and optional logger
const queue = new TelegramQueue(100, logger);

// Add telegram (automatically drops oldest if full)
queue.push({ groupAddress: '1/2/3', value: 1, dpt: '1.001', timestamp: '...' });

// Remove first telegram (FIFO)
const telegram = queue.shift();

// Get all and clear queue
const allTelegrams = queue.drain();

// Check state
if (queue.isEmpty()) { /* ... */ }
if (queue.isFull()) { /* ... */ }

// Statistics
const stats = queue.getStats();
console.log(stats);
// { size: 50, maxSize: 100, isFull: false, isEmpty: false, utilizationPercent: 50 }
```

### API Reference

| Method | Description | Returns |
|--------|---|---|
| `push(telegram)` | Add telegram (drops oldest if full) | Dropped telegram or null |
| `shift()` | Remove & return first telegram | Telegram or undefined |
| `drain()` | Remove & return all telegrams | Array |
| `clear()` | Remove all telegrams | void |
| `getAll()` | Get all telegrams (no removal) | Array |
| `isEmpty()` | Check if queue is empty | boolean |
| `isFull()` | Check if queue is full | boolean |
| `getStats()` | Get queue statistics | Object |
| `length` | Get current queue size | number |

---

## Troubleshooting

### Problem: "Max reconnect attempts reached"

**Causes:**
1. KNX Gateway IP wrong or unreachable
2. KNX Gateway port blocked by firewall
3. KNX Gateway offline
4. Network switch issue

**Solution:**
```bash
# Test connectivity
ping 192.168.1.100

# Test port
nc -zv 192.168.1.100 3671

# Check logs
docker logs semantic-knx-runtime | grep "KNX"
```

### Problem: Queue drops old telegrams

**Causes:**
1. Connection is down for a long time (>100 new telegrams)
2. Many rapid writes while disconnected

**Behavior:**
- Queue has max 100 telegrams (constant `MAX_QUEUE_SIZE`)
- When the queue is full and a new writing arrives: **oldest telegram is dropped**
- The newest telegram is queued
- Log shows: `📋 Queue full (100), dropping oldest: ...`

**Example:**
```
Connection down 5 minutes with heavy write activity
  → 500+ write requests queued
  → Only last 100 are kept in queue
  → First 400 are dropped (FIFO Drop)
  → After reconnect: last 100 telegrams are sent
```

**Solution:**
If you need more queue capacity:
```javascript
// In src/knx/tunnel-manager.js (top of file)
const MAX_QUEUE_SIZE = 500;  // Increase from 100
```

**Monitoring:**
Watch logs for: `📋 Queue full` messages  
If frequent: increase `MAX_QUEUE_SIZE` or investigate connection stability

### Problem: Queued telegrams not sent

**Causes:**
1. Reconnection failed
2. Telegram syntax invalid

**Solution:**
- Check logs: `📤 Processing X queued telegrams...`
- Verify a telegram format in an API request

---

## Performance Impact

- **Memory:** ~100 telegrams × 200 bytes = 20 KB (minimal)
- **CPU:** Health check runs every 30s (negligible)
- **Network:** One ping every 30s when connected (minimal)

---

## Future Enhancements

1. **Persistent Queue** - Persist queue to disk for system restart resilience
2. **Admin Dashboard** - Visual queue status + reconnect history
3. **Alerting** - Email/SMS on max reconnect attempts
4. **Metrics** - Prometheus metrics for uptime tracking

---

## See Also

- `src/knx/tunnel-manager.js` - KNX connection management
- `src/knx/telegram-queue.js` - FIFO queue implementation
- `src/state/event-bus.js` - Event system
- `.env.example` - Configuration template
- `docs/ARCHITECTURE.md` - System architecture

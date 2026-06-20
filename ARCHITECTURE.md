# Architecture

This document describes the internal structure of the Semantic KNX Runtime Engine.

---

## Overview

The engine is built as a single Node.js process, structured in four clearly separated layers. Each layer has a single responsibility and communicates with the layers above and below it through defined interfaces.

```
                    ┌────────────────────┐
                    │ KNX TP Installation│
                    └─────────┬──────────┘
                              │ UDP 3671
                              ▼
┌─────────────────────────────────────────────────────┐
│           Semantic KNX Runtime Engine               │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │ KNX Runtime Layer                            │   │
│  │  Tunnel Manager · Telegram Decoder           │   │
│  │  DPT Decoder · Reconnect Manager             │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │ Semantic Layer                               │   │
│  │  TTL Parser · Digital Twin Builder           │   │
│  │  Resource Graph · Semantic Mapping           │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │ State Engine                                 │   │
│  │  Current State Cache · Event Processing      │   │
│  │  Subscription Dispatcher                     │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │ API Layer                                    │   │
│  │  KNX IoT REST API · WebSocket · MQTT         │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
                              │
                              ▼
                ┌──────────────────────────┐
                │ TimescaleDB / PostgreSQL │
                └──────────────────────────┘
```

---

## Layers

### KNX Runtime Layer

Handles all communication with the physical KNX/IP interface.

- **Tunnel Manager** — manages the KNXnet/IP tunnelling connection via [KNXUltimate](https://github.com/Supergiovane/KNXUltimate), included as an npm dependency running directly in the same Node.js process. Handles connection lifecycle, reconnect logic, and send/receive of raw telegrams.
- **Telegram Decoder** — parses incoming L_DATA frames and extracts group address, APCI, and raw payload.
- **DPT Decoder** — decodes raw payloads to typed values according to the datapoint type (DPT) defined in the semantic model.

> **Note on KNXnet/IP Tunnelling vs. Routing**
>
> The engine uses KNXnet/IP Tunnelling exclusively. Tunnelling operates over unicast UDP and uses `TUNNELLING_ACK` at the IP protocol level for per-frame acknowledgement. This is distinct from L_DATA.con, which is a TP bus-level primitive. KNXnet/IP Routing (UDP Multicast) is not used — it is fire-and-forget with no IP-level acknowledgement and requires a KNX IP Router on the installation, which is not assumed here.

---

### Semantic Layer

Builds and maintains the Digital Twin from the ETS project export.

- **TTL Loader** — reads the KNX TTL file exported directly from ETS. No intermediate conversion step is required; ETS exports this format natively.
- **Graph Builder** — parses the TTL triples and constructs an in-memory resource graph.
- **Resource Store** — holds the complete graph of locations, devices, functions, and datapoints with their relationships.
- **Semantic Mapper** — resolves incoming group addresses to datapoint resources in the graph, enabling all upstream layers to work with semantic identifiers rather than raw group addresses.

#### Resource Model

The engine is resource-oriented, not group-address-centric. Group addresses are transport bindings only. The internal model follows the KNX information model hierarchy:

```
Location
 └── Device
      └── Function
           └── Datapoint
                └── KNX Binding (Group Address)
```

This means a group address like `1/1/93` is not a primary key anywhere in the system — it is an attribute of a datapoint resource that has its own UUID, type, name, and relationships.

---

### State Engine

Maintains the live state of the installation and dispatches change events.

- **Current State Cache** — in-memory map of `datapointId → {value, timestamp}`, updated on every incoming telegram.
- **Event Bus** — internal pub/sub for decoupled event propagation between layers.
- **Subscription Dispatcher** — manages active HTTP callback subscriptions per the KNX IoT 3rd Party API spec, evaluates which subscriptions are affected by an incoming event, and dispatches outbound notifications.

---

### API Layer

Exposes the engine to external clients.

- **KNX IoT REST API** — implements the [KNX IoT 3rd Party API v2.1.0](https://schema.knx.org/2020/api/2.1.0?visualisation=swagger), including OAuth2 (`client_credentials` grant), all resource endpoints, and the HTTP callback subscription lifecycle (POST/PATCH/DELETE `/subscriptions`).
- **WebSocket** — implements the KNX IoT standard WebSocket interface using the `gw.knx.org` subprotocol as defined in the spec (RFC 6455 upgrade at `/messaging/ws`).
- **MQTT** — publishes datapoint state changes to semantic topics.

---

## Persistence

Events and state are persisted in TimescaleDB (PostgreSQL extension). TimescaleDB is used because telegram history is a natural time-series workload — high insert rate, range queries by time, and optional downsampling.

### Database Schema

#### `knx_events` — TimescaleDB Hypertable

Raw event log. Every incoming telegram is appended here. Partitioned by day.

| Column | Type | Description |
|--------|------|-------------|
| `ts` | `TIMESTAMPTZ` | Event timestamp (partition key) |
| `ga` | `TEXT` | KNX group address |
| `datapoint_id` | `TEXT` | Resolved datapoint UUID (nullable) |
| `source` | `TEXT` | Sender individual address |
| `event_type` | `TEXT` | Telegram type |
| `value_bool` | `BOOLEAN` | Decoded boolean value |
| `value_float` | `DOUBLE PRECISION` | Decoded float value |
| `value_int` | `BIGINT` | Decoded integer value |
| `value_text` | `TEXT` | Decoded text value |
| `dpt` | `TEXT` | Datapoint type |
| `payload` | `JSONB` | Full decoded payload |

Primary key: `(ts, ga)` — Indexes on `(ga, ts DESC)` and `(datapoint_id, ts DESC)`.

---

#### `current_state`

Latest known value per datapoint. Upserted on every incoming event.

| Column | Type | Description |
|--------|------|-------------|
| `datapoint_id` | `TEXT` | Datapoint UUID (PK) |
| `ga` | `TEXT` | KNX group address |
| `value` | `JSONB` | Raw decoded value |
| `value_decoded` | `TEXT` | Human-readable value |
| `dpt` | `TEXT` | Datapoint type |
| `updated_at` | `TIMESTAMPTZ` | Timestamp of last update |
| `source` | `TEXT` | Sender individual address |

---

#### `datapoint_mappings`

Resolves group addresses to semantic datapoint resources.

| Column | Type | Description |
|--------|------|-------------|
| `datapoint_id` | `TEXT` | Datapoint UUID (PK) |
| `ga` | `TEXT` | KNX group address |
| `dpt` | `TEXT` | Datapoint type |
| `name` | `TEXT` | Human-readable name |
| `location_id` | `TEXT` | Associated location UUID |
| `device_id` | `TEXT` | Associated device UUID |
| `function_id` | `TEXT` | Associated function UUID |
| `metadata` | `JSONB` | Additional semantic metadata |

Index on `ga`.

---

#### `semantic_resources`

In-database cache of the full resource graph built from the KNX TTL export.

| Column | Type | Description |
|--------|------|-------------|
| `id` | `TEXT` | Resource UUID (PK) |
| `type` | `TEXT` | Resource type (`location`, `device`, `function`, `datapoint`, ...) |
| `resource` | `JSONB` | Full resource object |
| `created_at` | `TIMESTAMPTZ` | |
| `updated_at` | `TIMESTAMPTZ` | |

Index on `type`.

---

#### `subscriptions`

Active HTTP callback and WebSocket subscriptions.

| Column | Type | Description |
|--------|------|-------------|
| `id` | `TEXT` | Subscription UUID (PK, auto-generated) |
| `type` | `TEXT` | `callback` or `websocket` |
| `url` | `TEXT` | Callback URL (required for `callback` type) |
| `secret` | `TEXT` | HMAC-SHA256 signing secret |
| `ca_cert` | `TEXT` | Optional CA certificate (PEM) |
| `lifetime` | `INTERVAL` | Requested lifetime |
| `created_at` | `TIMESTAMPTZ` | |
| `expires_at` | `TIMESTAMPTZ` | Expiry timestamp |
| `updated_at` | `TIMESTAMPTZ` | Auto-updated via trigger |
| `active` | `BOOLEAN` | Soft-delete flag |

Index on `expires_at` (partial: active only).

#### `subscription_datapoints`

Junction table linking subscriptions to their subscribed datapoints.

| Column | Type | Description |
|--------|------|-------------|
| `subscription_id` | `TEXT` | FK → `subscriptions.id` (cascade delete) |
| `datapoint_id` | `TEXT` | Datapoint UUID |
| `expand` | `BOOLEAN` | If true, expand to subordinated resources |

#### `subscription_installations`

Junction table linking subscriptions to installations.

| Column | Type | Description |
|--------|------|-------------|
| `subscription_id` | `TEXT` | FK → `subscriptions.id` (cascade delete) |
| `installation_id` | `TEXT` | Installation UUID |
| `expand` | `BOOLEAN` | If true, include all installations of the node |

#### `subscription_node`

Links a subscription to the node (at most one per subscription).

| Column | Type | Description |
|--------|------|-------------|
| `subscription_id` | `TEXT` | FK → `subscriptions.id` (cascade delete) |
| `node_id` | `TEXT` | Node UUID |
| `expand` | `BOOLEAN` | If true, include all installations hosted at the node |

#### `subscription_events` — TimescaleDB Hypertable

Delivery log for outbound subscription notifications. Partitioned by day.

| Column | Type | Description |
|--------|------|-------------|
| `ts` | `TIMESTAMPTZ` | Delivery attempt timestamp (partition key) |
| `subscription_id` | `TEXT` | FK → `subscriptions.id` (cascade delete) |
| `datapoint_id` | `TEXT` | Triggering datapoint UUID |
| `trigger_type` | `TEXT` | What triggered the notification |
| `payload` | `JSONB` | Notification payload sent |
| `http_status` | `SMALLINT` | HTTP response status from callback endpoint |
| `delivery_error` | `TEXT` | Error message if delivery failed |
| `delivered_at` | `TIMESTAMPTZ` | Timestamp of successful delivery |

Index on `(subscription_id, ts DESC)`.

---

#### `semantic_relationships`

A flat RDF triple store. Created by `ResourceStore.storeRelationships()` in `src/semantic/resource-store.js` on first TTL load — not part of `initializeSchema()` but created inline via `CREATE TABLE IF NOT EXISTS` during graph persistence.

| Column | Type | Description |
|--------|------|-------------|
| `subject` | `TEXT` | Subject resource URI or ID |
| `predicate` | `TEXT` | Relationship predicate |
| `object` | `TEXT` | Object resource URI or ID |

Primary key: `(subject, predicate, object)` — inserts use `ON CONFLICT DO NOTHING`.

Known predicates include `hasGroupAddress`, `hasDatapoint`, `containsDevice`, and `linkedToDevice`. The full set of predicates is determined by the KNX TTL export content and the Graph Builder's mapping logic.

---

## Startup Sequence

The engine initializes its components in a fixed order to ensure each layer has its dependencies ready before it starts:

```
1. PostgresClient.connect()
   └── initializeSchema()          — creates tables, hypertables, indexes, triggers

2. Semantic Layer
   └── TTL Loader                  — reads KNX TTL export from disk
   └── Graph Builder               — parses RDF triples, builds in-memory resource graph
   └── Semantic Mapper             — builds GA → datapoint UUID lookup table
   └── datapoint_mappings          — populated from graph (GA, DPT, name, location, device, function)
   └── semantic_resources          — populated from graph (full resource objects + relationships)

3. KNX Runtime Layer
   └── Tunnel Manager (KNXUltimate) — opens KNXnet/IP tunnelling connection to KNX/IP interface
   └── Telegram Decoder            — begins listening for incoming L_DATA frames

4. API Layer
   └── REST API server             — binds to API_PORT, all endpoints become available
   └── WebSocket server            — upgrades at /messaging/ws (gw.knx.org subprotocol)
   └── MQTT client                 — connects and begins publishing
```

The KNX tunnel is intentionally started **after** the Semantic Layer is fully loaded, so that the first arriving telegram can already be resolved to a datapoint UUID without a race condition.

---

## Data Flow

### Read Path — Incoming Telegram

What happens when a KNX device sends a group telegram:

```
KNX/IP Interface (UDP 3671)
  │
  ▼
Tunnel Manager (KNXUltimate)
  │  receives raw KNXnet/IP frame, issues TUNNELLING_ACK
  ▼
Telegram Decoder
  │  extracts: GA, APCI (GroupValue_Write / _Read / _Response), raw payload
  ▼
Semantic Mapper
  │  resolves GA → { datapointId, dpt, name, locationId, deviceId, functionId }
  ▼
DPT Decoder
  │  decodes raw payload to typed value (boolean / float / int / string / object)
  ▼
Event Bus
  ├──▶ EventStore.storeEvent()        — appends to knx_events hypertable
  │      typed value split across value_bool / value_float / value_int / value_text
  │      full payload stored as JSONB
  ├──▶ StateStore.updateState()       — upserts current_state (INSERT … ON CONFLICT DO UPDATE)
  │      stores both JSONB value and human-readable value_decoded
  └──▶ Subscription Dispatcher
         │  queries SubscriptionStore.findActiveCallbacksByDatapointId(datapointId)
         │  filters: type='callback', active=TRUE, expires_at > NOW()
         ▼
       HTTP POST to each subscriber's callback URL
         │  signed with HMAC-SHA256 (X-Callback-Signature header)
         └──▶ SubscriptionStore.logDelivery()  — appends to subscription_events hypertable
                records http_status, delivery_error, delivered_at
```

### Write Path — API → KNX Bus

Three write endpoints are available, all implemented via the shared `writeDatapointValue()` helper in `src/api/routes/datapoints.js`:

| Endpoint | Description |
|----------|-------------|
| `PUT /api/v1/datapoints/values` | Spec-compliant bulk write, responds `204 No Content` |
| `PUT /api/v1/datapoints/` | Vendor extension: single datapoint write via JSON:API body |
| `PUT /api/v1/datapoints/by-ga` | Vendor extension: write by group address (used e.g. by Tasmota Berry scripts) |

```
PUT /api/v1/datapoints/values  (or /by-ga or /)
  │
  ▼
Route Handler (src/api/routes/datapoints.js)
  │  validates request body (datapoint id / GA + value)
  ▼
writeDatapointValue()
  │
  ├── stateEngine.getAllStates()         — resolves UUID → { datapointId, ga, dpt }
  │   + getDatapointMappingByUuid()       falls back to datapoint_mappings if no live state
  │
  ├── writable check                     — rejects if explicitly writable=false
  │
  ├── normalizeDpt()                     — resolves DPT name to numeric form (via dpt-map.js)
  │
  ├── decodeValueForKnx()               — encodes string value → native JS value for KNXUltimate
  │   (src/api/routes/helpers/knx-iot-dpt.js)
  │
  ├── tunnelManager.write(ga, value, dpt) — dispatches GroupValue_Write via KNXUltimate
  │   └──▶ KNX/IP Interface → KNX TP bus
  │
  └── stateEngine.updateState()          — optimistic state update (source: 'api')
        updates current_state immediately without waiting for bus echo
```

> **Note on state update strategy:** Unlike a pure bus-echo approach, the write path performs an **optimistic state update** immediately after a successful `tunnelManager.write()`. This ensures the REST API reflects the new value without delay. If the bus subsequently echoes the telegram, the state is updated again via the normal read path — which is idempotent in practice.

---

## Subscription Lifecycle

Subscriptions follow the KNX IoT 3rd Party API spec (POST/GET/PATCH/DELETE `/subscriptions`) and are persisted in PostgreSQL.

**Create** (`POST /subscriptions`): a transaction atomically inserts the master record in `subscriptions` and links datapoints, installations, and/or node in the respective junction tables. Returns the generated UUID.

**Renew** (`PATCH /subscriptions/:id`): only `url`, `secret`, `caCert`, and `lifetime` are patchable per spec. When `lifetime` is updated, `expires_at` is recalculated as `NOW() + lifetime`. The `updated_at` column is maintained automatically via a PostgreSQL trigger.

**Delete** (`DELETE /subscriptions/:id`): implemented as a **soft delete** — `active` is set to `FALSE`, the row is retained. Junction table rows (datapoints, installations, node) and delivery log entries (`subscription_events`) are preserved for audit purposes. Hard cascade deletes only apply if the row is physically deleted.

**Expiry**: subscriptions with a `lifetime` set will have an `expires_at` timestamp. The dispatcher filters these out via `expires_at > NOW()` at query time — no background cleanup job is required for correctness, though one may be added for housekeeping.

---

## Project Structure

```
src/
├── index.js
├── knx/                  # KNX Runtime Layer
│   ├── tunnel-manager.js
│   ├── telegram-decoder.js
│   └── dpt-decoder.js
├── semantic/             # Semantic Layer
│   ├── ttl-loader.js
│   ├── graph-builder.js
│   ├── resource-store.js
│   └── semantic-mapper.js
├── state/                # State Engine
│   ├── state-engine.js
│   ├── event-bus.js
│   └── subscriptions.js
├── storage/              # TimescaleDB persistence
│   ├── postgres.js
│   ├── timescale.js
│   ├── event-store.js
│   └── state-store.js
├── api/                  # API Layer
│   ├── rest-api.js
│   ├── websocket.js
│   ├── mqtt.js
│   └── routes/
└── utils/
```

---

## Design Decisions

### Why a single process?

KNXUltimate runs as an npm dependency in the same Node.js process. This keeps the deployment simple (single container) and avoids IPC overhead for the high-frequency telegram path. If scaling or isolation become requirements in a future phase, the KNX Runtime Layer is designed to be extractable into a separate service.

### Why KNX TTL and not `.knxproj` directly?

The `.knxproj` format is complex, version-dependent, and not publicly specified. ETS's native KNX TTL export is a standards-based RDF/Turtle format that directly reflects the KNX information model — exactly the representation needed to build the resource graph. No conversion tooling is required.

### Why TimescaleDB?

Telegram history is an append-only, time-indexed workload. TimescaleDB hypertables give automatic time partitioning and compression on top of standard PostgreSQL, without requiring a separate database technology. The rest of the schema (subscriptions, resource metadata) is plain relational SQL in the same instance.

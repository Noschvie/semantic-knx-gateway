# Semantic KNX Runtime Engine

## Architecture and Implementation Document

Version: 0.1
Target Platform: Docker + Node.js + TimescaleDB
Basis: KNX Classic + KNX IoT 3rd Party API 2.1.0

---

# Project Goal

Development of a semantic KNX Runtime Engine as a container platform.

The Runtime Engine shall:

* connect classic KNX TP installations
* process ETS KNX IoT TTL exports
* generate a semantic Digital Twin
* manage live states
* store historical values
* implement the KNX IoT 3rd Party REST API
* provide MQTT/WebSocket
* later enable KNX IoT Point API / Matter

The platform is:

```text
not a simple KNX logger
```

but rather:

```text
a semantic KNX Runtime Engine
```

---

# Target Architecture

```text
                    ┌────────────────────┐
                    │ KNX TP Installation│
                    └─────────┬──────────┘
                              │
                              ▼
                    ┌────────────────────┐
                    │ KNX IP Interface   │
                    │ (Tunneling)        │
                    └─────────┬──────────┘
                              │ UDP 3671
                              ▼
┌─────────────────────────────────────────────────────┐
│           Semantic KNX Runtime Engine               │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │ KNX Runtime Layer                            │   │
│  │----------------------------------------------│   │
│  │ • Tunnel Manager                             │   │
│  │ • Telegram Decoder                           │   │
│  │ • DPT Decoder                                │   │
│  │ • Reconnect Manager                          │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │ Semantic Layer                               │   │
│  │----------------------------------------------│   │
│  │ • TTL Parser                                 │   │
│  │ • Digital Twin Builder                       │   │
│  │ • Resource Graph                             │   │
│  │ • Semantic Mapping                           │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │ State Engine                                 │   │
│  │----------------------------------------------│   │
│  │ • Current State Cache                        │   │
│  │ • Event Processing                           │   │
│  │ • Subscription Dispatcher                    │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │ API Layer                                    │   │
│  │----------------------------------------------│   │
│  │ • KNX IoT REST API                           │   │
│  │ • WebSocket                                  │   │
│  │ • MQTT                                       │   │
│  │ • OpenAPI                                    │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
└─────────────────────────────────────────────────────┘
                              │
                              ▼
                ┌──────────────────────────┐
                │ TimescaleDB / PostgreSQL │
                └──────────────────────────┘
```

---

# Core Principles

## 1. Resource-Oriented Design

The Runtime does NOT work group-address-centric.

Internal model:

```text
Location
 └── Device
      └── Function
           └── Datapoint
                └── KNX Binding
```

Group addresses are transport bindings only.

---

# Semantic Digital Twin

The ETS TTL file generates a complete semantic model:

* Buildings
* Floors
* Rooms
* Devices
* Functions
* Datapoints
* Relationships
* DPT Types
* KNX Bindings

---

# KNX Runtime Layer

## Responsibilities

### KNX/IP Tunneling

* Connection to KNX/IP interface
* Tunnel reconnect
* Tunnel monitoring

### Telegram Processing

* Reading all telegrams
* Decoding
* DPT processing
* Event generation

### Telegram Write API

* Writing group values
* Read requests
* Response handling

---

# Semantic Layer

## TTL Parser

Input:

```text
ETS KNX IoT Export (.ttl)
```

Output:

```text
Internal Resource Graph
```

---

# Internal Resources

## Location

```json
{
  "id": "room-bathroom-upper",
  "type": "location",
  "name": "Bathroom Upper Floor"
}
```

---

## Device

```json
{
  "id": "device-1.1.54",
  "type": "device",
  "name": "Switching Actuator Bathroom"
}
```

---

## Datapoint

```json
{
  "id": "dp-light-bathroom-mirror",
  "ga": "1/1/83",
  "dpt": "1.001",
  "valueType": "boolean"
}
```

---

# State Engine

## Responsibilities

* Current state of all datapoints
* Timestamping
* Event queue
* Subscription dispatching
* State persistence

---

# State Model

```json
{
  "datapointId": "dp-light-bathroom-mirror",
  "value": true,
  "timestamp": "2026-05-22T18:00:00Z",
  "source": "1.1.54"
}
```

---

# Persistence

## Database

Using:

```text
TimescaleDB
```

based on PostgreSQL.

---

# Data Model

## events

Append-only telegram history.

```sql
CREATE TABLE knx_events (
    ts TIMESTAMPTZ NOT NULL,
    datapoint_id TEXT,
    ga TEXT,
    source TEXT,
    event_type TEXT,
    value_bool BOOLEAN,
    value_float DOUBLE PRECISION,
    value_text TEXT,
    payload JSONB
);
```

---

## current_state

Current state of all datapoints.

```sql
CREATE TABLE current_state (
    datapoint_id TEXT PRIMARY KEY,
    value_json JSONB,
    updated_at TIMESTAMPTZ
);
```

---

## semantic_resources

Persistent Digital Twin.

```sql
CREATE TABLE semantic_resources (
    id TEXT PRIMARY KEY,
    type TEXT,
    resource JSONB
);
```

---

# API Layer

## Goal

Implementation of the official:

```text
KNX IoT 3rd Party API 2.1.0
```

---

# REST API

## Examples

```http
GET /api/v1/devices
GET /api/v1/datapoints
GET /api/v1/locations
GET /api/v1/functions
GET /api/v1/timeseries
```

---

# Realtime APIs

## WebSocket

Live events.

## MQTT

Semantic MQTT topics.

---

# MQTT Structure

```text
knx/location/bathroom-upper/light/mirror/state
```

or:

```text
knx/datapoint/dp-light-bathroom-mirror/state
```

---

# Docker Architecture

## Containers

```text
semantic-knx-runtime
timescaledb
```

---

# Docker Compose

```yaml
services:

  semantic-knx-runtime:
    build: ../knx-iot

    container_name: semantic-knx-runtime

    restart: unless-stopped

    env_file:
      - .env

    ports:
      - "3000:3000"

    volumes:
      - ./config:/app/config
      - ./logs:/app/logs

    depends_on:
      - timescaledb

  timescaledb:
    image: timescale/timescaledb:latest-pg18

    container_name: timescaledb

    restart: unless-stopped

    environment:
      POSTGRES_DB: knx
      POSTGRES_USER: knx
      POSTGRES_PASSWORD: knx

    volumes:
      - timescale_data:/var/lib/postgresql/data

volumes:
  timescale_data:
```

---

# Environment Variables

## .env

```env
KNX_IP=192.168.7.15
KNX_PORT=3671
KNX_PHYS_ADDR=15.15.200

API_PORT=3000

POSTGRES_HOST=timescaledb
POSTGRES_PORT=5432
POSTGRES_DB=knx
POSTGRES_USER=knx
POSTGRES_PASSWORD=knx

LOG_LEVEL=info
```

---

# Project Structure

```text
src/
├── index.js
│
├── knx/
│   ├── tunnel-manager.js
│   ├── telegram-decoder.js
│   ├── dpt-decoder.js
│   └── telegram-writer.js
│
├── semantic/
│   ├── ttl-loader.js
│   ├── graph-builder.js
│   ├── resource-store.js
│   └── semantic-mapper.js
│
├── state/
│   ├── state-engine.js
│   ├── event-bus.js
│   └── subscriptions.js
│
├── storage/
│   ├── postgres.js
│   ├── timescale.js
│   ├── event-store.js
│   └── state-store.js
│
├── api/
│   ├── rest-api.js
│   ├── websocket.js
│   ├── mqtt.js
│   └── routes/
│
└── utils/
```

---

# Implementation Phases

# Phase 1 — Core Runtime

## Goals

* Docker base
* KNX tunnel
* Telegram reception
* DPT decoding
* Reconnect

## Result

Live KNX Runtime.

---

# Phase 2 — Semantic Engine

## Goals

* TTL parsing
* Resource graph
* Semantic store
* Datapoint mapping

## Result

Digital Twin Runtime.

---

# Phase 3 — State Engine

## Goals

* Current state cache
* Event processing
* State updates

## Result

Live state model.

---

# Phase 4 — TimescaleDB

## Goals

* Event persistence
* Current state persistence
* Resource persistence

## Result

Historization + Analytics.

---

# Phase 5 — KNX IoT REST API

## Goals

* OpenAPI-compliant REST API
* Resource endpoints
* Timeseries endpoints

## Result

KNX IoT 3rd Party API Server.

---

# Phase 6 — Realtime & Integration

## Goals

* WebSocket
* Subscription API
* MQTT

---

# Phase 7 — Extensions

## Goals

* Matter Bridge
* CoAP
* KNX IoT Point API
* Semantic Discovery
* OAuth2/OpenID

---

# Immediate Next Step

## Start of Implementation

First we implement:

1. Docker base
2. Node.js runtime
3. KNX Tunnel Manager
4. Telegram event stream
5. Base project structure

Afterwards:

* Semantic Layer
* State Engine
* TimescaleDB
* REST API

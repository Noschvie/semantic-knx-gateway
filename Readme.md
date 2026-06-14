# Semantic KNX Runtime Engine

> ⚠️ **Status: Work in Progress — v0.1 pre-alpha**

A containerized, resource-oriented KNX backend that connects classic KNX TP installations to a semantic Digital Twin — exposing live state, historical data, and a standards-compliant REST API.

This is **not** a KNX logger. It is a full **semantic runtime engine** for KNX installations.

---

## What it does

- Connects to KNX/IP interfaces via tunnelling (UDP 3671)
- Parses ETS KNX IoT TTL exports to build a semantic Digital Twin
- Maintains live state for all datapoints with real-time event streaming
- Persists telegram history and state in TimescaleDB
- Implements the **KNX IoT 3rd Party REST API v2.1.0**
- Provides WebSocket and MQTT for real-time integration

---

## Architecture

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

### Resource Model

The engine is resource-oriented, not group-address-centric. Group addresses are transport bindings only. The internal model is:

```
Location
 └── Device
      └── Function
           └── Datapoint
                └── KNX Binding
```

---

## Prerequisites

- [Docker](https://www.docker.com/) and Docker Compose
- A KNX/IP interface reachable on the network (tunnelling mode)
- An ETS KNX IoT TTL export of your installation

---

## Getting Started

**1. Clone the repository**

```bash
git clone https://github.com/Noschvie/semantic-knx-gateway.git
cd semantic-knx-gateway
```

**2. Configure the environment**

Copy the example environment file and adjust the values for your setup:

```bash
cp .env.example .env
```

**3. Place your TTL export**

Copy your ETS KNX IoT export to the config directory:

```bash
cp your-installation.ttl config/project-prod.ttl
```

**4. Start the stack**

```bash
docker compose up -d
```

The API will be available at `http://localhost:3000`.

---

## Configuration

All configuration is done via the `.env` file:

```env
# KNX/IP Interface
KNX_IP=192.168.1.100        # IP address of your KNX/IP interface
KNX_PORT=3671               # KNX/IP tunneling port (default: 3671)
KNX_PHYS_ADDR=1.1.200       # Physical address used by the tunnel

# API
API_PORT=3000

# Database
POSTGRES_HOST=timescaledb
POSTGRES_PORT=5432
POSTGRES_DB=knx
POSTGRES_USER=knx
POSTGRES_PASSWORD=knx

# Logging
LOG_LEVEL=info
```

---

## REST API

The engine implements the **KNX IoT 3rd Party API v2.1.0**. Key endpoints:

```http
GET /api/v1/devices
GET /api/v1/datapoints
GET /api/v1/locations
GET /api/v1/functions
GET /api/v1/timeseries
```

Full OpenAPI specification is served at `/api/v1/openapi.json`.

---

## Real-time APIs

**WebSocket** — subscribe to live datapoint events:
```
ws://localhost:3000/ws
```

**MQTT** — semantic topics for datapoint state:
```
knx/location/{location-id}/{function}/state
knx/datapoint/{datapoint-id}/state
```

---

## Project Structure

```
src/
├── index.js
├── knx/                  # KNX runtime layer
│   ├── tunnel-manager.js
│   ├── telegram-decoder.js
│   ├── dpt-decoder.js
│   └── telegram-writer.js
├── semantic/             # Digital Twin & TTL parsing
│   ├── ttl-loader.js
│   ├── graph-builder.js
│   ├── resource-store.js
│   └── semantic-mapper.js
├── state/                # Live state management
│   ├── state-engine.js
│   ├── event-bus.js
│   └── subscriptions.js
├── storage/              # TimescaleDB persistence
│   ├── postgres.js
│   ├── timescale.js
│   ├── event-store.js
│   └── state-store.js
├── api/                  # REST, WebSocket, MQTT
│   ├── rest-api.js
│   ├── websocket.js
│   ├── mqtt.js
│   └── routes/
└── utils/
```

---

## Roadmap

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Core Runtime — KNX tunnel, telegram processing, DPT decoding | 🔄 In Progress |
| 2 | Semantic Engine — TTL parsing, Resource Graph, Digital Twin | 🔄 In Progress |
| 3 | State Engine — live state cache, event processing | 🔄 In Progress |
| 4 | TimescaleDB — event & state persistence, historization | 🔄 In Progress |
| 5 | KNX IoT REST API — OpenAPI-compliant endpoints | 🔄 In Progress |
| 6 | Realtime & Integration — WebSocket, Subscription API | 🔄 In Progress |
| 7 | Extensions — Matter Bridge, CoAP, KNX IoT Point API, OAuth2 | ⏳ Future |

---

## Acknowledgements

- **KNX bus communication** — [KNXUltimate](https://github.com/Supergiovane/KNXUltimate) by [@Supergiovane](https://github.com/Supergiovane), a full-featured KNX/IP tunneling library for Node.js with KNX Secure support
- **Runtime** — [Node.js](https://nodejs.org/)
- **Time-series storage** — [TimescaleDB](https://www.timescale.com/), built on PostgreSQL

---

## License

This project is licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) — free to use and adapt for non-commercial purposes, with attribution and under the same license.


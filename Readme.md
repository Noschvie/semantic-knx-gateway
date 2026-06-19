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

```ini
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
POSTGRES_USERNAME=knx
POSTGRES_PASSWORD=knx

# Logging
LOG_LEVEL=info
```

---

## REST API

The engine implements the **KNX IoT 3rd Party API v2.1.0**. Key endpoints:

```
GET /api/v2/devices
GET /api/v2/datapoints
GET /api/v2/locations
GET /api/v2/functions
GET /api/v2/timeseries
```

Full OpenAPI specification is served at `/api/v2/openapi.json`.

---

## Real-time APIs

**WebSocket** — subscribe to live datapoint events:

```
ws://localhost:3000/messaging/ws
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

| Phase | Description                                                  | Status        |
| ----- | ------------------------------------------------------------ | ------------- |
| 1     | Core Runtime — KNX tunnel, telegram processing, DPT decoding | 🔄 In Progress |
| 2     | Semantic Engine — TTL parsing, Resource Graph, Digital Twin  | 🔄 In Progress |
| 3     | State Engine — live state cache, event processing            | 🔄 In Progress |
| 4     | TimescaleDB — event & state persistence, historization       | 🔄 In Progress |
| 5     | KNX IoT REST API — OpenAPI-compliant endpoints               | 🔄 In Progress |
| 6     | Realtime & Integration — WebSocket, Subscription API         | 🔄 In Progress |
| 7     | Extensions — Matter Bridge, CoAP, KNX IoT Point API, OAuth2  | ⏳ Future      |

---

## Related Example Applications (Reference)

For practical usage scenarios around this ecosystem, I also maintain two small reference projects:

- **KNX Garage + WLED**: https://github.com/Noschvie/knx-garage-wled
- **Tasmota KNX IoT bridge**: https://github.com/Noschvie/tasmota-knx-iot

---

## Acknowledgements

- **KNX bus communication** — [KNXUltimate](https://github.com/Supergiovane/KNXUltimate) by [@Supergiovane](https://github.com/Supergiovane), a full-featured KNX/IP tunneling library for Node.js with KNX Secure support
- **Runtime** — [Node.js](https://nodejs.org/)
- **Time-series storage** — [TimescaleDB](https://www.timescale.com/), built on PostgreSQL

---

## References

### KNX IoT 3rd Party API

- **[KNX IoT API Server – Implementation example for KNX PoC 2.x](https://support.knx.org/hc/en-us/articles/23995369446162-KNX-IoT-API-Server-development-Implementation-example-for-KNX-PoC-2-x-version)**  
  Official KNX Association article covering the development of a KNX IoT API Server according to KNX Standard v3.0.0 (chapter 3_10_4 KNX IoT 3rd Party API).  
  Topics include: core concepts of the KNX IoT API Server, prerequisites for client communication (REST & WebSocket), OAuth2 authentication, and concrete Python implementation examples for REST calls and WebSocket datapoint subscriptions.  
  Reference implementation: [KNX IoT PoC (Docker)](https://gitlab.knx.org/knxiot/kitooling/-/wikis/index/KNX-IoT-3rd-Party-API-Demos/KNX-IoT-3rd-Party-API-Local-Environment) · API spec: [Swagger v2.1.0](https://schema.knx.org/2020/api/2.1.0?visualisation=swagger)

---

## License

This project is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).

Commercial licenses are available on request for organizations that wish to use this software under alternative terms.

See the LICENSE and COMMERCIAL-LICENSE.md files for details.

## Disclaimer

KNX is a trademark of the KNX Association.

This project is an independent implementation and is not affiliated with, endorsed by, or sponsored by the KNX Association.

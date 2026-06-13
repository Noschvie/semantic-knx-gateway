# Semantic KNX Runtime Engine

## Architektur- und Umsetzungsdokument

Version: 0.1
Zielplattform: Docker + Node.js + TimescaleDB
Basis: KNX Classic + KNX IoT 3rd Party API 2.1.0

---

# Projektziel

Entwicklung einer semantischen KNX Runtime Engine als Containerplattform.

Die Runtime Engine soll:

* klassische KNX TP Installationen anbinden
* ETS KNX IoT TTL Exporte verarbeiten
* einen semantischen Digital Twin erzeugen
* Live-Zustände verwalten
* historische Werte speichern
* die KNX IoT 3rd Party REST API implementieren
* MQTT/WebSocket bereitstellen
* später KNX IoT Point API / Matter ermöglichen

Die Plattform ist:

```text id="4fcyii"
kein einfacher KNX Logger
```

sondern:

```text id="n8n1eg"
eine semantische KNX Runtime Engine
```

---

# Zielarchitektur

```text id="rw7wdg"
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

# Grundprinzipien

## 1. Resource-Oriented Design

Die Runtime arbeitet NICHT gruppenadresszentriert.

Internes Modell:

```text id="4l6q5m"
Location
 └── Device
      └── Function
           └── Datapoint
                └── KNX Binding
```

Gruppenadressen sind nur Transportbindungen.

---

# Semantic Digital Twin

Die ETS TTL Datei erzeugt ein vollständiges semantisches Modell:

* Gebäude
* Stockwerke
* Räume
* Geräte
* Funktionen
* Datapoints
* Beziehungen
* DPT Typen
* KNX Bindings

---

# KNX Runtime Layer

## Aufgaben

### KNX/IP Tunneling

* Verbindung zum KNX/IP Interface
* Tunnel-Reconnect
* Tunnel-Monitoring

### Telegram Processing

* Lesen aller Telegramme
* Decode
* DPT Verarbeitung
* Event-Erzeugung

### Telegram Write API

* Schreiben von Gruppenwerten
* Read Requests
* Response Handling

---

# Semantic Layer

## TTL Parser

Input:

```text id="y1j6cx"
ETS KNX IoT Export (.ttl)
```

Output:

```text id="0bjj7s"
Internal Resource Graph
```

---

# Interne Ressourcen

## Location

```json id="sv9f8l"
{
  "id": "room-bad-og",
  "type": "location",
  "name": "Bad OG"
}
```

---

## Device

```json id="7vjlwm"
{
  "id": "device-1.1.54",
  "type": "device",
  "name": "Schaltaktor Bad"
}
```

---

## Datapoint

```json id="s4n4mf"
{
  "id": "dp-light-bad-mirror",
  "ga": "1/1/83",
  "dpt": "1.001",
  "valueType": "boolean"
}
```

---

# State Engine

## Aufgaben

* aktueller Zustand aller Datapoints
* Timestamping
* Event Queue
* Subscription Dispatching
* State Persistence

---

# State Model

```json id="zsmkq0"
{
  "datapointId": "dp-light-bad-mirror",
  "value": true,
  "timestamp": "2026-05-22T18:00:00Z",
  "source": "1.1.54"
}
```

---

# Persistenz

## Datenbank

Verwendung von:

```text id="vjlwmc"
TimescaleDB
```

auf Basis von PostgreSQL.

---

# Datenmodell

## events

Append-only Telegramhistorie.

```sql id="c8p7az"
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

Aktueller Zustand aller Datapoints.

```sql id="e8f10r"
CREATE TABLE current_state (
    datapoint_id TEXT PRIMARY KEY,
    value_json JSONB,
    updated_at TIMESTAMPTZ
);
```

---

## semantic_resources

Persistenter Digital Twin.

```sql id="j3d5jd"
CREATE TABLE semantic_resources (
    id TEXT PRIMARY KEY,
    type TEXT,
    resource JSONB
);
```

---

# API Layer

## Ziel

Implementierung der offiziellen:

```text id="6t2jlwm"
KNX IoT 3rd Party API 2.1.0
```

---

# REST API

## Beispiele

```http id="dbkjlwm"
GET /api/v1/devices
GET /api/v1/datapoints
GET /api/v1/locations
GET /api/v1/functions
GET /api/v1/timeseries
```

---

# Realtime APIs

## WebSocket

Live Events.

## MQTT

Semantische MQTT Topics.

---

# MQTT Struktur

```text id="ffjlwm"
knx/location/bad-og/light/mirror/state
```

oder:

```text id="gxjlwm"
knx/datapoint/dp-light-bad-mirror/state
```

---

# Docker Architektur

## Container

```text id="0ljlwm"
semantic-knx-runtime
timescaledb
```

---

# Docker Compose

```yaml id="e7jlwm"
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

# Environment Variablen

## .env

```env id="4kjlwm"
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

# Projektstruktur

```text id="ozjlwm"
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

# Umsetzungsphasen

# Phase 1 — Core Runtime

## Ziele

* Docker Basis
* KNX Tunnel
* Telegram Empfang
* DPT Decode
* Reconnect

## Ergebnis

Live KNX Runtime.

---

# Phase 2 — Semantic Engine

## Ziele

* TTL Parsing
* Resource Graph
* Semantic Store
* Datapoint Mapping

## Ergebnis

Digital Twin Runtime.

---

# Phase 3 — State Engine

## Ziele

* Current State Cache
* Event Processing
* State Updates

## Ergebnis

Live Zustandsmodell.

---

# Phase 4 — TimescaleDB

## Ziele

* Event Persistenz
* Current State Persistenz
* Resource Persistenz

## Ergebnis

Historisierung + Analytics.

---

# Phase 5 — KNX IoT REST API

## Ziele

* OpenAPI-konforme REST API
* Resource Endpoints
* Timeseries Endpoints

## Ergebnis

KNX IoT 3rd Party API Server.

---

# Phase 6 — Realtime & Integration

## Ziele

* WebSocket
* Subscription API
* MQTT

---

# Phase 7 — Erweiterungen

## Ziele

* Matter Bridge
* CoAP
* KNX IoT Point API
* Semantic Discovery
* OAuth2/OpenID

---

# Sofortiger nächster Schritt

## Start der Implementierung

Als erstes implementieren wir:

1. Docker Basis
2. Node.js Runtime
3. KNX Tunnel Manager
4. Telegram Event Stream
5. Basisprojektstruktur

Danach:

* Semantic Layer
* State Engine
* TimescaleDB
* REST API
---

## License

This project is licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) — free to use and adapt for non-commercial purposes, with attribution and under the same license.

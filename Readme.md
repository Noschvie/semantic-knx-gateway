# Semantic KNX Runtime Engine

> ⚠️ **Status: Work in Progress — v0.1 pre-alpha**

A containerized KNX backend that connects classic KNX TP installations to a semantic Digital Twin — exposing live state, historical data, and a standards-compliant REST API.

This is **not** a KNX logger or a simple group address proxy.
It is a full **semantic runtime engine**: group addresses are just transport bindings. The internal model is built around locations, devices, functions, and datapoints — derived directly from the ETS project.

---

## What it does

- Connects to KNX/IP interfaces via tunnelling (UDP 3671)
- Parses ETS KNX TTL exports to build a semantic Digital Twin
- Maintains live state for all datapoints with real-time event streaming
- Persists telegram history and state in TimescaleDB
- Implements the **KNX IoT 3rd Party REST API v2.1.0**
- Provides WebSocket and MQTT for real-time integration

---

## Getting Started

**1. Clone the repository**

```bash
git clone https://github.com/Noschvie/semantic-knx-gateway.git
cd semantic-knx-gateway
```

**2. Configure the environment**

```bash
cp env.example .env
```

Adjust to a minimum:

```ini
KNX_IP=192.168.1.100       # IP address of your KNX/IP interface
KNX_PHYS_ADDR=1.1.200      # Physical address used by the tunnel
```

**3. Place your TTL export**

```bash
cp your-installation.ttl config/project-prod.ttl
```

**4. Start the stack**

```bash
# Start stack with production overlay
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# Check container status (both must be "Up (healthy)")
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps

# Expected result:
# timescaledb          Up (healthy)
# semantic-knx-runtime Up (healthy)

# Inspect health status in detail
docker inspect semantic-knx-runtime --format='{{json .State.Health}}' | python3 -m json.tool

# Follow logs
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f --tail=50
```

The API will be available at `http://localhost:3000`.
Full OpenAPI specification at `/api/v2/openapi.json`.

---

## Platform Notes

### Raspberry Pi (RPi 4 / RPi 5)

Memory cgroups are not enabled by default on Raspberry Pi OS, which causes TimescaleDB auto-tuning to fail. Set these in your `.env` to bypass it:

```env
TS_TUNE_MEMORY=2GB
TS_TUNE_NUM_CPUS=4
```

To enable full auto-tuning instead, add `cgroup_memory=1 cgroup_enable=memory` to the end of `/boot/firmware/cmdline.txt` and reboot.

---

## Roadmap

| Phase | Description                                                   | Status         |
|-------|---------------------------------------------------------------|----------------|
| 1     | Core Runtime — KNX tunnel, telegram processing, DPT decoding  | 🔄 In Progress |
| 2     | Semantic Engine — TTL parsing, Resource Graph, Digital Twin   | 🔄 In Progress |
| 3     | State Engine — live state cache, event processing             | 🔄 In Progress |
| 4     | TimescaleDB — event & state persistence, historization        | 🔄 In Progress |
| 5     | KNX IoT REST API — OpenAPI-compliant endpoints                | 🔄 In Progress |
| 6     | Realtime & Integration — WebSocket, Subscription API          | 🔄 In Progress |
| 7     | Extensions — Matter Bridge, CoAP, KNX IoT Point API, OAuth2  | ⏳ Future      |

---

## Further Reading

- [Architecture & Resource Model](./ARCHITECTURE.md)
- [Configuration Reference](./CONFIGURATION.md)
- [KNX IoT 3rd Party API v2.1.0 — Swagger](https://schema.knx.org/2020/api/2.1.0?visualisation=swagger)
- [KNX IoT API Server – KNX Association Implementation Guide](https://support.knx.org/hc/en-us/articles/23995369446162)

---

## Related Projects

- **KNX Garage + WLED**: https://github.com/Noschvie/knx-garage-wled
- **Tasmota KNX IoT bridge**: https://github.com/Noschvie/tasmota-knx-iot

---

## Acknowledgements

- **KNX bus communication** — [KNXUltimate](https://github.com/Supergiovane/KNXUltimate) by [@Supergiovane](https://github.com/Supergiovane)
- **Runtime** — [Node.js](https://nodejs.org/)
- **Time-series storage** — [TimescaleDB](https://www.timescale.com/)

---

## License

AGPL-3.0-or-later. Commercial licenses available on request — see [LICENSE](./LICENSE) and [COMMERCIAL-LICENSE.md](./COMMERCIAL-LICENSE.md).

> KNX is a trademark of the KNX Association. This project is independent and not affiliated with or endorsed by the KNX Association.

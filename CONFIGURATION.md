# Configuration Reference

All configuration is done via the `.env` file in the project root. Copy `.env.example` to `.env` and adjust the values for your setup.

```bash
cp .env.example .env
```

---

## ETS TTL Export

The engine optionally loads a KNX TTL export of your ETS project to enable semantic enrichment. According to the KNX Association documentation:

> "A Semantic export can be triggered via the menu item 'Export' and then save the project as 'Turtle File Export (.ttl)' or 'Json Linked Data (.jsonld)'."
>
> Source: KNX Association, [Semantic export](https://support.knx.org/hc/en-us/articles/13991390217362-Semantic-export)

Place your TTL files in the `./config/` directory:

```bash
mkdir -p config
cp your-installation.ttl config/your-project.ttl
cp another-project.ttl config/another-project.ttl
```

---

## Semantic Layer Configuration (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `KNX_TTL_FILE` | *(none)* | Filename of the TTL file in the `./config` directory. Leave empty to disable semantic layer. |

**Examples:**

```env
# Enable semantic layer with a specific TTL file
KNX_TTL_FILE=my-installation.ttl

# Disable semantic layer (leave empty)
KNX_TTL_FILE=
```

If `KNX_TTL_FILE` is not set, the API will start without semantic enrichment and respond with HTTP 503 to semantic endpoints. This is useful for deployments where you only need raw KNX telegram processing.

---

## KNX/IP Interface

| Variable | Default | Description |
|----------|---------|-------------|
| `KNX_GATEWAY_IP` | — | IP address of your KNX/IP interface (tunnelling mode) |
| `KNX_GATEWAY_PORT` | `3671` | KNXnet/IP tunnelling port |
| `KNX_GATEWAY_PHYS_ADDR` | `1.1.200` | Physical address used by the tunnel connection |

> The engine uses KNXnet/IP Tunnelling exclusively. The KNX/IP interface must be reachable on the network and must have a free tunnelling slot available.

---

## API

| Variable | Default | Description |
|----------|---------|-------------|
| `API_PORT` | `3000` | Port the REST API and WebSocket server listen on |

---

## Database (TimescaleDB / PostgreSQL)

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_HOST` | `timescaledb` | Hostname of the TimescaleDB container |
| `POSTGRES_PORT` | `5432` | PostgreSQL port |
| `POSTGRES_DB` | `knx` | Database name |
| `POSTGRES_USERNAME` | `knx` | Database user |
| `POSTGRES_PASSWORD` | `knx` | Database password — **change this in production** |

---

## Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` | Log verbosity: `error`, `warn`, `info`, `debug`, `trace` |

---

## TimescaleDB Tuning

These variables control how TimescaleDB allocates memory and CPU at startup. By default, TimescaleDB attempts to auto-detect these values via cgroups.

| Variable | Default | Description |
|----------|---------|-------------|
| `TS_TUNE_MEMORY` | *(auto)* | Memory allocation for TimescaleDB, e.g. `2GB` |
| `TS_TUNE_NUM_CPUS` | *(auto)* | Number of CPUs for TimescaleDB, e.g. `4` |

Set these explicitly if auto-detection fails (see [Raspberry Pi](#raspberry-pi) below).

---

## Platform Notes

### Raspberry Pi

Memory cgroups are not enabled by default on Raspberry Pi OS. This guide covers RPi 4 and RPi 5. This causes the TimescaleDB auto-tuning script to fail with a cryptic `unary operator expected` error at startup.

**Workaround — set tuning values explicitly:**

```env
TS_TUNE_MEMORY=2GB
TS_TUNE_NUM_CPUS=4
```

This bypasses cgroup detection entirely and works out of the box on RPi 4 and RPi 5.

**Alternative — enable memory cgroups:**

If you want TimescaleDB to auto-detect resources via cgroups, edit `/boot/firmware/cmdline.txt` and append the following to the end of the single line (do not add a newline):

```
cgroup_memory=1 cgroup_enable=memory
```

Then reboot:

```bash
sudo reboot
```

Leave `TS_TUNE_MEMORY` and `TS_TUNE_NUM_CPUS` unset in `.env` to let TimescaleDB auto-detect after the reboot.

---

## Minimal Example

The absolute minimum configuration to get started:

```ini
# KNX/IP Interface
KNX_GATEWAY_IP=192.168.1.100
KNX_GATEWAY_PHYS_ADDR=1.1.200

# Database
POSTGRES_PASSWORD=change-me

# Semantic Layer (optional)
KNX_TTL_FILE=my-installation.ttl
```

All other values fall back to their defaults.

---

## Full Example

```ini
# KNX/IP Interface
KNX_GATEWAY_IP=192.168.1.100
KNX_GATEWAY_PORT=3671
KNX_GATEWAY_PHYS_ADDR=1.1.200

# API
API_PORT=3000

# Database
POSTGRES_HOST=timescaledb
POSTGRES_PORT=5432
POSTGRES_DB=knx
POSTGRES_USERNAME=knx
POSTGRES_PASSWORD=change-me

# Semantic Layer (optional)
KNX_TTL_FILE=my-installation.ttl

# Logging
LOG_LEVEL=info
PRETTY_LOGS=true

# TimescaleDB tuning (set explicitly on Raspberry Pi)
# TS_TUNE_MEMORY=2GB
# TS_TUNE_NUM_CPUS=4
```

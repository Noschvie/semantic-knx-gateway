# Test Procedure: semantic-knx-runtime on Raspberry Pi (arm64)

## Prerequisites

- Raspberry Pi 4 or 5 (arm64 / aarch64)
- Raspberry Pi OS 64-bit (Trixie)
- Docker + Docker Compose installed
- Network access to the KNX/IP interface (KNX gateway)

---

## Phase 1 – Verify the Docker Environment

```bash
# Verify Docker is running and supports arm64
docker info | grep -E "Architecture|Server Version"
# Expected result: Architecture: aarch64

# Check Docker Compose version
docker compose version

# Install jq and curl (required for API tests)
sudo apt-get install -y jq curl
```

---

## Phase 2 – Pull the Image from GHCR

```bash
# Pull image from GitHub Container Registry
# (arm64 will be selected automatically based on the Pi architecture)
docker pull ghcr.io/noschvie/semantic-knx-gateway:development

# Verify architecture
docker inspect ghcr.io/noschvie/semantic-knx-gateway:development \
  | grep -A2 '"Architecture"'
# Expected result: "Architecture": "arm64"
```

---

## Phase 3 – Prepare the Configuration

```bash
# Create project directory and copy Compose files into it
mkdir -p ~/knx-iot-api-test && cd ~/knx-iot-api-test

# Create directories for volumes
mkdir -p config volumes/timescaledb/data

# Copy Compose files from the repository (or transfer via scp/git)
# Required files: docker-compose.yml + docker-compose.prod.yml
# scp *.yml pi@raspberry.local:~/knx-iot-api-test

# Create .env file
cat > .env << 'ENVEOF'
# API Configuration
API_PORT=3000
POSTGRES_HOST=timescaledb
POSTGRES_PORT=5432
POSTGRES_USERNAME=knxuser
POSTGRES_PASSWORD=knxpassword
POSTGRES_DB=knxdb
TIMESCALEDB_ENABLED=true
# Semantic Layer Configuration
# Set to the TTL filename from the ./config directory
KNX_TTL_FILE=project-prod.ttl
# KNX IP Configuration
KNX_GATEWAY_IP=192.168.1.x        # ← adjust
KNX_GATEWAY_PORT=3671
KNX_GATEWAY_PHYS_ADDR=1.1.255
TZ=Europe/Vienna
USER_ID=1000
GROUP_ID=1000
# OAuth2 Configuration
OAUTH_DISABLED=false
OAUTH_CLIENTS={"knx-default-client":{"secret":"change-me-in-production","allowedGrantTypes":["client_credentials"],"allowedScopes":["read","write","manage"]}}
ENVEOF

# Place project file – REQUIRED for semantic layer!
# Without a valid TTL file, semantic endpoints respond with HTTP 503.
# An empty file (touch) is NOT sufficient – use a real TTL file:
cp /path/to/actual/project.ttl config/project-prod.ttl
```

> **Note:** The entire `./config` directory is mounted into the container at `/app/config`.
> The `KNX_TTL_FILE` variable should contain only the filename (e.g., `project-prod.ttl`),
> not the full path. Multiple TTL files can coexist in the `./config` directory.

---

## Phase 4 – Start the Stack and Perform Basic Health Checks

```bash
cd ~/knx-iot-api-test

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

> **Note:** The health check validates `/.well-known/knx`. This endpoint
> returns HTTP 503 as long as no valid TTL file has been loaded →
> `semantic-knx-runtime` remains in the `starting` state.
> Only after the Semantic Engine has been loaded successfully will the status
> switch to `healthy`.
> Check with: `docker logs semantic-knx-runtime 2>&1 | grep "Phase 3"`

---

## Phase 5 – Test API Endpoints

### 5.1 Well-Known / API Information

```bash
#
API_URL="http://localhost:3000"
KNX_IOT_API_URL="$API_URL/api/v2"

# No authentication required
curl -s $API_URL/.well-known/knx | jq .
# Expected result: JSON containing "api" → "version": "2.1.0" or similar.
```

### 5.2 Obtain OAuth Token

```bash
# manage token
MANAGE_TOKEN=$(curl -s -X POST $API_URL/oauth/access \
  -H "Authorization: Basic $(echo -n 'knx-default-client:change-me-in-production' | base64)" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&scope=manage" \
  | jq -r '.access_token')
echo "MANAGE: $MANAGE_TOKEN"

# read token
READ_TOKEN=$(curl -s -X POST $API_URL/oauth/access \
  -H "Authorization: Basic $(echo -n 'knx-default-client:change-me-in-production' | base64)" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&scope=read" \
  | jq -r '.access_token')
echo "READ: $READ_TOKEN"
```

**Expected result:** Both variables contain non-empty token strings.

### 5.3 List Datapoints

```bash
curl -s $KNX_IOT_API_URL/datapoints \
  -H "Authorization: Bearer $READ_TOKEN" | jq '.meta, .data[0]'
```

### 5.4 List Subscriptions

```bash
curl -s $KNX_IOT_API_URL/subscriptions \
  -H "Authorization: Bearer $MANAGE_TOKEN" | jq .
```

---

## Phase 6 – Subscription Create/Renew/Delete (Core Driver Functionality)

```bash
# Create subscription
SUB_RESPONSE=$(curl -s -X POST $KNX_IOT_API_URL/subscriptions \
  -H "Authorization: Bearer $MANAGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "type": "subscription",
      "attributes": {
        "url": "http://127.0.0.1:9999/test_cb",
        "lifetime": {"minutes": 5}
      },
      "relationships": {
        "subscriptionDatapoints": {"data": []}
      }
    }
  }')

echo $SUB_RESPONSE | jq .
SUB_ID=$(echo $SUB_RESPONSE | jq -r '.data.id')
echo "Subscription ID: $SUB_ID"

# Read subscription
curl -s $KNX_IOT_API_URL/subscriptions/$SUB_ID \
  -H "Authorization: Bearer $MANAGE_TOKEN" | jq .

# Renew subscription (PATCH = Renew, as in the Berry driver)
curl -s -X PATCH $KNX_IOT_API_URL/subscriptions/$SUB_ID \
  -H "Authorization: Bearer $MANAGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"data\": {
      \"type\": \"subscription\",
      \"id\": \"$SUB_ID\",
      \"attributes\": {\"lifetime\": {\"minutes\": 5}}
    }
  }" -w "\nHTTP %{http_code}\n"

# Delete subscription
curl -s -X DELETE $KNX_IOT_API_URL/subscriptions/$SUB_ID \
  -H "Authorization: Bearer $MANAGE_TOKEN" -w "\nHTTP %{http_code}\n"
```

---

## Phase 7 – Check Resource Usage on the Pi

```bash
# Monitor CPU and RAM usage of the containers
docker stats --no-stream semantic-knx-runtime timescaledb

# Expected reference values (Raspberry Pi 4, 4 GB RAM):
# semantic-knx-runtime: < 512 MB RAM (limit from docker-compose.prod.yml)
# timescaledb:          < 1 GB RAM   (limit from docker-compose.prod.yml)
```

---

## Phase 8 – Cleanup

```bash
cd ~/knx-iot-api-test
docker compose -f docker-compose.yml -f docker-compose.prod.yml down

# Optional: remove volumes as well (all data will be lost!)
docker compose -f docker-compose.yml -f docker-compose.prod.yml down -v

# Remove image
docker rmi ghcr.io/noschvie/semantic-knx-gateway:development
```

---

## Troubleshooting

| Symptom | Check |
|---|---|
| `exec format error` | Image is not arm64 → check with `docker inspect ... \| grep Architecture` |
| timescaledb does not start | `docker compose logs timescaledb` – permissions: `sudo chown -R 1000:1000 volumes/` |
| `403 Forbidden` during OAuth | Client ID / secret do not match `OAUTH_CLIENTS` in `.env` |
| API does not respond on port 3000 | `docker compose ps` – firewall on Pi: `sudo ufw allow 3000` |
| `/.well-known/knx` returns HTTP 503 | TTL file missing or invalid – check `docker logs semantic-knx-runtime \| grep "Phase 3"`; verify that `config/project-prod.ttl` exists and is a valid TTL file (not empty) |
| `semantic-knx-runtime` remains in `starting` | Consequence of the 503 issue above – health check switches to `healthy` only after successful TTL loading |
| timescaledb image not available for arm64 | Fallback: `image: postgres:18-alpine` + `TIMESCALEDB_ENABLED=false` in `.env` |
| `EISDIR` error when starting container | Old deployment configuration detected – update `.env` to use `KNX_TTL_FILE=filename.ttl` instead of `KNX_TTL_PATH=/full/path` |

# 📊 Database Management Scripts

This directory contains scripts for testing and managing the Semantic KNX Gateway database and its maintenance operations.

## Available Scripts

### 1. `test-database-management-api.sh`
**Full test suite for Database Management API**

- **Tests**: GET /health, /info, /cleanup-jobs, POST /purge, /optimize
- **Usage**: `./scripts/test-database-management-api.sh`
- **Duration**: ~5-10 seconds
- **Output**: JSON responses and formatted results for each endpoint
- **Best for**: API validation and integration testing

### 2. `database-summary.sh` ⭐ NEW
**Generate a comprehensive database health report**

- **Features**:
  - System info (DB name, PostgreSQL version, size)
  - Event statistics (total, coverage, rate)
  - Table breakdown (rows, sizes, types)
  - Growth projections (daily, yearly)
  - Maintenance status (last optimization, job count)
  - Automated recommendations (color-coded)

- **Usage**: `./scripts/database-summary.sh`
- **Duration**: ~2-3 seconds
- **Output**: Formatted report with color-coded recommendations
- **Best for**: Monthly/weekly health checks and capacity planning

### 3. `db-health-check.sh`
**Check database integrity & consistency**

- **Checks**:
  - Orphaned states and stale mappings
  - Duplicate group addresses
  - Database integrity

- **Usage**: `./scripts/db-health-check.sh [--backup] [--cleanup]`
- **Duration**: ~2-5 seconds
- **Output**: Health status + optional backup and cleanup

## Quick Start

```bash
# 1. Navigate to project directory
cd ~/knx-iot-api-test
# or wherever you installed it

# 2. Run the full API test
./scripts/test-database-management-api.sh

# 3. Get a database summary
./scripts/database-summary.sh

# 4. Check database health
./scripts/db-health-check.sh

# 5. Run health check with automatic cleanup
./scripts/db-health-check.sh --backup --cleanup
```

> **First time?** Make sure scripts are executable: `chmod +x ./scripts/*.sh`

## Sample Output

### database-summary.sh Output

```
════════════════════════════════════════════════════════════════════════════
                    📊 DATABASE HEALTH REPORT SUMMARY
════════════════════════════════════════════════════════════════════════════

1️⃣  SYSTEM INFORMATION
────────────────────────────────────────────────────────────────────────────
   Report Generated:       11.07.2026, 13:38:16
   Database Name:          knxdb
   PostgreSQL Version:     18.4
   Current Size:           29.4 MB (30807743 bytes)

2️⃣  EVENT STATISTICS
────────────────────────────────────────────────────────────────────────────
   Total Events:           35,574 telegrams
   Coverage Period:        2 days
   Event Rate:             17,787 events/day (~741 per hour)
   Earliest Event:         2026-07-09T19:59:18.463Z
   Latest Event:           2026-07-11T11:38:13.150Z

3️⃣  TABLE BREAKDOWN
────────────────────────────────────────────────────────────────────────────
   ✅ semantic_resources           112 rows • 80 KB • regular
   ✅ datapoint_mappings           109 rows • 16 KB • regular
   ✅ current_state                 45 rows • 8 KB  • regular

4️⃣  SUBSCRIPTIONS STATUS
────────────────────────────────────────────────────────────────────────────
   Total Subscriptions:    0
   Active Subscriptions:   0
   Expired Subscriptions:  0
   Status:                 ⚪ No active subscriptions (normal for test)

5️⃣  GROWTH & CAPACITY PROJECTIONS
────────────────────────────────────────────────────────────────────────────
   Daily Growth Rate:      ~14.7 KB/day
   Yearly Projection:      ~5.4 MB/year
   Recommended Retention:  90 days (keeps DB ~100-150 MB)
   Auto-Purge Enabled:     ⚪ Not configured (optional)

6️⃣  MAINTENANCE STATUS
────────────────────────────────────────────────────────────────────────────
   Last Optimization:      2026-07-11T11:38:16.735Z
   Total Maintenance Jobs: 6
   Optimization Method:    VACUUM ANALYZE (Online, no downtime)
   Status:                 ✅ All maintenance operations successful

7️⃣  RECOMMENDATIONS
────────────────────────────────────────────────────────────────────────────
   ✅ Database size optimal (<50 MB)
   ✅ Event rate within normal range
   ℹ️  No subscriptions configured - Consider for production
   ℹ️  Suggested Cron: Run VACUUM ANALYZE weekly
   ℹ️  Suggested Cron: Run Purge monthly

════════════════════════════════════════════════════════════════════════════
✅ OVERALL STATUS: Database is HEALTHY and OPTIMIZED
════════════════════════════════════════════════════════════════════════════
```

## Environment Variables

All scripts support these environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `API_URL` | `http://localhost:3000` | API base URL |
| `OAUTH_CLIENT_SECRET` | `change-me-in-production` | OAuth client secret |
| `DB_CONTAINER` | `timescaledb` | Database container name |
| `POSTGRES_USERNAME` | `knxuser` | Database username |
| `POSTGRES_DB` | `knxdb` | Database name |

**Example:**
```bash
API_URL=http://knx.example.com:3000 ./scripts/database-summary.sh
```

## Scheduling with Cron

There are multiple ways to schedule database maintenance tasks. See the **Docker Cron Job Setup** section below for detailed options.

### For Advanced Setup

See the **Docker Cron Job Setup** section for:
- **Option 1**: Docker Container with cron (Professional)
- **Option 2**: Bash Script with Systemd Service (Hybrid)

## Troubleshooting

### Scripts fail or timeout

1. **Ensure Docker containers are running:**
   ```bash
   docker ps | grep knx
   # or check all containers
   docker ps -a
   ```

2. **Check API connectivity:**
   ```bash
   curl http://localhost:3000/api/v2/database/health
   # For remote servers:
   curl http://<your-host>:3000/api/v2/database/health
   ```

3. **Verify OAuth credentials in `.env`:**
   ```bash
   cat .env | grep OAUTH_CLIENT_SECRET
   # or
   grep OAUTH_CLIENT_SECRET .env
   ```

4. **Run with debug output:**
   ```bash
   bash -x ./scripts/database-summary.sh
   ```

5. **Check Docker logs:**
   ```bash
   docker logs semantic-knx-runtime
   docker logs timescaledb
   ```

### "Command not found" errors

1. **Make scripts executable:**
   ```bash
   chmod +x ./scripts/database-summary.sh
   chmod +x ./scripts/test-database-management-api.sh
   chmod +x ./scripts/db-health-check.sh
   ```

2. **Check if dependencies are installed:**
   ```bash
   which curl jq bc
   ```

3. **Run scripts with explicit bash:**
   ```bash
   bash ./scripts/database-summary.sh
   ```

### Permission denied

```bash
# For user running scripts
chmod +x ./scripts/*.sh

# For system-wide cron/service
sudo chmod +x ./scripts/*.sh
sudo chown root:root ./scripts/*.sh  # If running as root
```

### API is not accessible

```bash
# Check if port is listening
sudo netstat -tulpn | grep 3000
# or
sudo lsof -i :3000

# Check Docker network
docker network ls
docker network inspect knx-network

# Test from inside Docker
docker exec semantic-knx-runtime curl http://localhost:3000/api/v2/database/health
```

## Dependencies

**Required tools:**
- `curl` - for HTTP requests
- `jq` - for JSON parsing
- `bc` - for arithmetic calculations
- `bash` - version 4+
- `docker` / `docker-compose` - for container operations

**Install on Debian/Ubuntu/Raspberry Pi OS:**

```bash
sudo apt-get update
sudo apt-get install -y curl jq bc docker.io docker-compose
```

**Install on Fedora/RHEL/CentOS:**

```bash
sudo dnf install -y curl jq bc docker docker-compose
# or
sudo yum install -y curl jq bc docker docker-compose
```

**Install on Alpine (for containers):**

```bash
apk add --no-cache curl jq bc docker docker-compose
```

**Verify installation:**

```bash
curl --version
jq --version
bc --version
docker --version
docker-compose --version
```

## Docker Cron Job Setup

Automate database maintenance with Docker and cron. This works directly on your host without external CI/CD platforms.

### Docker Container with cron (Professional)

Create a cron container that communicates with your existing stack:

**Create: `docker-compose.cron.yml`**

```yaml
# Docker Compose Cron Job for Semantic KNX Gateway Database Maintenance

services:
  cron:
    image: alpine:latest
    container_name: knx-database-cron
    volumes:
      - ./scripts:/app/scripts:ro
      - /etc/localtime:/etc/localtime:ro
    environment:
      - API_URL=http://semantic-knx-runtime:3000
      - OAUTH_CLIENT_SECRET=${OAUTH_CLIENT_SECRET:-change-me-in-production}
      - POSTGRES_USERNAME=${POSTGRES_USERNAME:-knxuser}
      - POSTGRES_DB=${POSTGRES_DB:-knxdb}
    entrypoint: |
      sh -c "
        apk add --no-cache curl jq bc dcron
        
        # Setup crontab
        echo '0 2 * * 1 curl -s -X GET http://semantic-knx-runtime:3000/api/v2/database/info -H \"Authorization: Bearer \$\$(curl -s -X POST http://semantic-knx-runtime:3000/oauth/access -H \"Content-Type: application/x-www-form-urlencoded\" -d \"grant_type=client_credentials&scope=read&client_id=knx-default-client&client_secret=\$$OAUTH_CLIENT_SECRET\" | jq -r .access_token)\" | jq . >> /var/log/db-summary.log' | crontab -
        
        # Start cron daemon
        crond -f -l 2
      "
    networks:
      - knx-network
    depends_on:
      - semantic-knx-runtime
    restart: always
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: 3

networks:
  knx-network:
    external: true
```

**Start:**

```bash
# Start container along with your existing stack
docker-compose -f docker-compose.yml -f docker-compose.cron.yml up -d

# Check status
docker-compose -f docker-compose.cron.yml logs -f cron

# Restart cron container only
docker-compose -f docker-compose.cron.yml restart cron
```

### Log Monitoring

Check the cron job outputs:

```bash
# Docker container logs
docker compose -f docker-compose.cron.yml logs -f cron
```

## Output Interpretation

### Color Codes in `database-summary.sh`

| Color | Meaning | Action |
|-------|---------|--------|
| 🟢 Green `✅` | Healthy, OK | No action needed |
| 🟡 Yellow `⚠️` | Warning | Monitor or plan action |
| 🔴 Red `🔴` | Critical | Take action soon |
| ⚪ Gray `⚪` | Info | For your information |

### Size Recommendations

| Metric | Optimal | Warning | Critical |
|--------|---------|---------|----------|
| DB Size | < 50 MB | 50-200 MB | > 200 MB |
| Event Rate | < 50k/day | 50-100k/day | > 100k/day |
| Coverage | Any | > 365 days | N/A |

## Support & Issues

For issues or questions:
- Check logs: `docker logs semantic-knx-runtime`
- Review API docs: http://localhost:3000/docs
- See architecture: `ARCHITECTURE.md`
- Check database management API: `API-TESTING.md`

---

**Last Updated**: July 11, 2026
**Version**: 1.0

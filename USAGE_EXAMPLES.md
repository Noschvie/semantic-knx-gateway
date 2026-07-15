# Usage Examples: New TTL Configuration Approach

This document provides practical examples for the new Docker TTL configuration system.

---

## Scenario 1: Single KNX Project

**Directory structure:**
```
semantic-knx-gateway/
├── docker-compose.yml
├── docker-compose.prod.yml
├── .env
└── config/
    └── Kindergarten.ttl
```

**Configuration (.env):**
```env
KNX_GATEWAY_IP=192.168.1.100
KNX_GATEWAY_PHYS_ADDR=1.1.200
KNX_TTL_FILE=Kindergarten.ttl
```

**Start:**
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

---

## Scenario 2: Multiple KNX Projects (Same Server)

**Directory structure:**
```
semantic-knx-gateway/
├── docker-compose.yml
├── docker-compose.prod.yml
├── .env
└── config/
    ├── Kindergarten.ttl
    ├── School.ttl
    └── Hospital.ttl
```

**Switch between projects by updating .env:**

**Project 1: Kindergarten**
```env
KNX_TTL_FILE=Kindergarten.ttl
```

**Project 2: School**
```env
KNX_TTL_FILE=School.ttl
```

**Project 3: Hospital**
```env
KNX_TTL_FILE=Hospital.ttl
```

**To switch projects:**
```bash
# Stop current stack
docker compose -f docker-compose.yml -f docker-compose.prod.yml down

# Update .env with new project
vi .env    # Change KNX_TTL_FILE=Hospital.ttl

# Restart with new project
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# Verify correct project loaded
docker logs semantic-knx-runtime | grep "Semantic Layer"
```

**No Docker Compose changes needed!** The configuration file remains identical across all projects.

---

## Scenario 3: Development and Production Environments

**Directory structure:**
```
semantic-knx-gateway/
├── docker-compose.yml
├── docker-compose.dev.yml
├── docker-compose.prod.yml
├── .env.development
├── .env.production
└── config/
    ├── dev-installation.ttl
    └── prod-installation.ttl
```

**Development environment (.env.development):**
```env
KNX_GATEWAY_IP=192.168.1.50      # Dev KNX gateway
KNX_TTL_FILE=dev-installation.ttl
NODE_ENV=development
LOG_LEVEL=debug
```

**Production environment (.env.production):**
```env
KNX_GATEWAY_IP=192.168.1.100     # Prod KNX gateway
KNX_TTL_FILE=prod-installation.ttl
NODE_ENV=production
LOG_LEVEL=info
```

**Start development:**
```bash
cp .env.development .env
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

**Deploy to production:**
```bash
cp .env.production .env
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

---

## Scenario 4: Migrating from Old Configuration

**Old setup:**

*docker-compose.prod.yml (OLD):*
```yaml
volumes:
  - ./config/Kindergarten.ttl:/app/config/project.ttl:ro
```

*.env (OLD):*
```env
KNX_TTL_PATH=/app/config/project.ttl
```

**Migration steps:**

1. Update .env file:
```env
# OLD:
# KNX_TTL_PATH=/app/config/project.ttl

# NEW:
KNX_TTL_FILE=Kindergarten.ttl
```

2. Update docker-compose.prod.yml:
```bash
# Remove these lines from docker-compose.prod.yml:
# volumes:
#   - ./config/Kindergarten.ttl:/app/config/project.ttl:ro

# Keep the base config volumes (already has ./config:/app/config:ro)
```

3. Ensure a TTL file is in the config directory:
```bash
# Verify file exists in config directory
ls -la config/Kindergarten.ttl

# If file is elsewhere:
cp /path/to/Kindergarten.ttl config/
```

4. Verify and restart:
```bash
# Stop old setup
docker compose -f docker-compose.yml -f docker-compose.prod.yml down

# Apply changes
git pull  # or manually update files

# Start new setup
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# Verify
docker logs semantic-knx-runtime | grep "Phase 3"
```

---

## Scenario 5: Disabling Semantic Layer Temporarily

Sometimes you may want to run without semantic enrichment (e.g., troubleshooting).

**Just comment out KNX_TTL_FILE:**

**.env:**
```env
# Temporarily disable semantic layer
# KNX_TTL_FILE=Kindergarten.ttl

# Or leave empty:
KNX_TTL_FILE=
```

**Restart:**
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart
```

**Expected logs:**
```
⚠️  KNX_TTL_FILE not configured – Semantic Engine disabled
To enable the semantic layer, set KNX_TTL_FILE=YourProject.ttl in .env
Phase 3: Skipping Semantic Engine
```

The API will still work for raw KNX telegram processing, but semantic endpoints return HTTP 503.

---

## Scenario 6: Backup and Recovery

**Backup configuration and TTL files:**
```bash
# Backup everything
tar -czf knx-backup-$(date +%Y%m%d).tar.gz \
  .env \
  config/ \
  docker-compose.yml \
  docker-compose.prod.yml

# Verify backup
tar -tzf knx-backup-*.tar.gz | head -10
```

**Restore to another server:**
```bash
# Extract backup
tar -xzf knx-backup-*.tar.gz

# Adjust IP addresses if needed
vi .env

# Start
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

---

## Troubleshooting

### Issue: "TTL file not found"

```
❌ TTL file not found: /app/config/MyProject.ttl
Please place the file in the config directory and set KNX_TTL_FILE=MyProject.ttl in .env
```

**Solution:**
```bash
# List files in config directory
ls -la config/

# Check .env setting
grep KNX_TTL_FILE .env

# Fix and restart
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart
```

---

### Issue: "TTL path is not a regular file"

```
❌ TTL path is not a regular file: /app/config/config
Expected a .ttl file, but found a directory or other file type
```

**Solution:**
```bash
# Check if KNX_TTL_FILE is pointing to a directory
cat .env | grep KNX_TTL_FILE

# Should be a filename, not a path:
# CORRECT:   KNX_TTL_FILE=MyProject.ttl
# WRONG:     KNX_TTL_FILE=config/MyProject.ttl

# Fix and restart
vi .env
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart
```

---

### Issue: API starts but semantic endpoints return 503

```
$ curl http://localhost:3000/api/v2/locations
HTTP/1.1 503 Service Unavailable
```

**Possible causes:**
1. `KNX_TTL_FILE` not set (intentional)
2. File is empty or invalid
3. File is not accessible

**Debug:**
```bash
# Check logs
docker logs semantic-knx-runtime | grep -E "Phase 3|TTL"

# Verify file exists and has content
ls -lh config/*.ttl

# Check configuration
docker exec semantic-knx-runtime env | grep KNX_TTL_FILE
```

---

### Issue: Old `EISDIR` error during startup

This should no longer happen with the new approach. If you see it:

```
Error: EISDIR: illegal operation on a directory, read
```

This means you're still using the old single-file bind mount configuration.

**Solution:**
```bash
# Update docker-compose.prod.yml to remove old volume mounts
# Remove lines like:
#   - ./config/MyProject.ttl:/app/config/project.ttl:ro

# Update .env to use new variable:
# Change: KNX_TTL_PATH=/app/config/project.ttl
# To:     KNX_TTL_FILE=MyProject.ttl

# Restart
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

---

## Performance Considerations

- **File access**: Multiple TTL files in the same directory have no performance impact on startup time
- **Directory mount**: Directory mount is as efficient as file mount
- **Selection**: Switching between projects is instant (just restart with different .env)

---

## Security Considerations

- **Read-only mount**: `./config:/app/config:ro` ensures TTL files cannot be modified by the container
- **No world-writable**: Ensure `config/` directory is not world-writable
- **Backup**: TTL files contain your complete KNX topology – treat as sensitive configuration

```bash
# Secure permissions
chmod 750 config/
chmod 640 config/*.ttl
```

---

## Conclusion

The new TTL configuration approach is simpler, more flexible, and eliminates deployment headaches. You can now:

✅ Run multiple KNX projects on the same server  
✅ Switch projects without Docker Compose changes  
✅ Use version control safely (no hardcoded paths)  
✅ Deploy with clear, actionable error messages  
✅ Scale from single installations to multi-site operations  

---

# Data Quality Analytics API – Usage Examples

The **Data Quality Analytics API** provides three endpoints for monitoring sensor health, detecting anomalies, and analyzing trends. See `docs/DATA_QUALITY_ANALYTICS_API.md` for complete documentation.

## Example 1: Detect Temperature Sensor Anomalies

**Scenario:** Find sudden temperature jumps that might indicate sensor malfunction or wiring issues.

```bash
# Find temperature jumps > 2°C in last 24 hours
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/api/v2/stats/anomalies?dpt=9.001&delta=2.0&hours=24"

# Output example:
# {
#   "meta": { "collection": { "total": 8, "period_hours": 24 } },
#   "summary": { "high": 2, "medium": 4, "low": 2, "total": 8 },
#   "data": [
#     {
#       "attributes": {
#         "ga": "3/6/1",
#         "previousValue": 21.5,
#         "currentValue": 24.2,
#         "delta": 2.7,
#         "severity": "high"
#       }
#     }
#   ]
# }
```

**Interpretation:**
- `high` severity → Large unexplained jump (investigate wiring)
- `medium` severity → Moderate change (check sensor calibration)
- Multiple anomalies on the same GA → Likely sensor malfunction

---

## Example 2: Diagnose NULL Value Issues

**Scenario:** Sensors are reporting NULL values. Is it a gateway polling issue or sensor communication error?

```bash
# Analyze NULL patterns across all temperature sensors
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/api/v2/stats/null-patterns?dpts=9.001&hours=24"

# Response shows diagnosis:
# "diagnosis": {
#   "likely_cause": "synchronized_polling_issue",
#   "confidence": 0.92,
#   "recommendation": "Check device polling intervals and KNX gateway connectivity"
# }
```

**Interpretation:**
- **synchronized_polling_issue** → All devices fail at the same minute (e.g., every :00)
  - **Action:** Check KNX gateway polling configuration or network connectivity
  
- **sensor_communication_error** → NULLs scattered across time/space
  - **Action:** Check individual sensor cables and device configuration

---

## Example 3: Time-Series Analysis for Trend Monitoring

**Scenario:** Analyze room temperature trends for comfort control optimization.

```bash
# Get 7-day statistics for room temperature
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/api/v2/stats/datapoints/3%2F6%2F1?hours=168"

# Extract key metrics:
jq '.statistics.last_7d' <<< "$response"

# Output:
# {
#   "measurements": { "count": 10080 },
#   "values": {
#     "average": 21.42,
#     "minimum": 18.5,
#     "maximum": 26.2,
#     "range": 7.7
#   },
#   "anomalies": 12
# }
```

**Use Cases:**
- **Average 21.42°C** → Set thermostat target to 21-22°C
- **Range 7.7°C** → Large variation → check for broken heating zones
- **12 anomalies in 7 days** → Frequent jumps → investigate sensor/wiring

---

## Example 4: Scripted Health Check Workflow

**Scenario:** Automated daily health check of all temperature sensors.

```bash
#!/bin/bash
set -e

TOKEN="your-bearer-token"
API_BASE="http://localhost:3000/api/v2/stats"

echo "=== Daily Sensor Health Check ==="

# 1. Check for anomalies
echo "Checking for temperature anomalies..."
ANOMALIES=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "$API_BASE/anomalies?dpt=9.001&delta=3.0&hours=24" | jq '.summary.high')

if [ "$ANOMALIES" -gt 0 ]; then
  echo "⚠️  WARNING: $ANOMALIES high-severity anomalies detected"
else
  echo "✓ No anomalies"
fi

# 2. Check NULL patterns
echo "Analyzing NULL patterns..."
CAUSE=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "$API_BASE/null-patterns?hours=24" | jq -r '.diagnosis.likely_cause')

if [ "$CAUSE" != "null" ]; then
  echo "ℹ️  NULL pattern detected: $CAUSE"
else
  echo "✓ No NULL issues"
fi

# 3. Check sensor data quality
echo "Checking sensor data quality..."
curl -s -H "Authorization: Bearer $TOKEN" \
  "$API_BASE/datapoints/3%2F6%2F1?hours=24" | jq '.statistics.last_24h.measurements'

echo "=== Health Check Complete ==="
```

**Output:**
```
=== Daily Sensor Health Check ===
Checking for temperature anomalies...
✓ No anomalies
Analyzing NULL patterns...
✓ No NULL issues
Checking sensor data quality...
{
  "count": 1440,
  "null_count": 3,
  "null_percent": "0.2"
}
=== Health Check Complete ===
```

---

## Example 5: Identify Stale/Inactive Sensors

**Scenario:** Find sensors that haven't been updated recently.

```bash
# Check all temperature sensors
for GA in "3/6/1" "3/6/2" "3/6/3" "3/6/4"; do
  echo "Checking $GA..."
  RESULT=$(curl -s -H "Authorization: Bearer $TOKEN" \
    "http://localhost:3000/api/v2/stats/datapoints/$GA?hours=24")
  
  AGE=$(echo "$RESULT" | jq '.current.age_seconds')
  STATUS=$(echo "$RESULT" | jq -r '.current.status')
  VALUE=$(echo "$RESULT" | jq '.current.value')
  
  if [ "$AGE" -gt 3600 ]; then
    echo "  ⚠️  STALE: Last update $AGE seconds ago"
  elif [ "$STATUS" = "unknown" ]; then
    echo "  ❌ NO DATA"
  else
    echo "  ✓ Active (value: $VALUE, age: ${AGE}s)"
  fi
done
```

---

## Example 6: Monitoring Dashboard Integration

**Scenario:** Update a monitoring dashboard every 5 minutes.

```bash
#!/bin/bash
# Runs every 5 minutes via cron: */5 * * * * /path/to/dashboard-update.sh

TOKEN="your-bearer-token"
API_BASE="http://localhost:3000/api/v2/stats"

# Fetch metrics
ANOMALIES=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "$API_BASE/anomalies?limit=5&hours=24" | jq '.summary')

NULL_PATTERNS=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "$API_BASE/null-patterns?hours=24" | jq '.diagnosis')

# Create JSON report
cat > /var/www/dashboard/sensor-health.json <<EOF
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "anomalies": $ANOMALIES,
  "null_patterns_diagnosis": $NULL_PATTERNS,
  "status": "healthy"
}
EOF

# Notify admin if issues
if [ "$(echo $NULL_PATTERNS | jq '.confidence')" -gt "0.9" ]; then
  echo "Sensor health issue detected" | mail -s "KNX Alert" admin@example.com
fi
```

---

## Authentication Setup

All analytics endpoints require OAuth2 Bearer token with `read` scope:

```bash
# 1. Get token from OAuth provider (if using Keycloak)
TOKEN=$(curl -X POST http://keycloak:8080/token \
  -d "client_id=knx-client&client_secret=secret&grant_type=client_credentials" \
  | jq -r '.access_token')

# 2. Use in API calls
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/api/v2/stats/anomalies"

# 3. Store in environment for scripts
export KNX_API_TOKEN="$TOKEN"
```

---

## Related Documentation

- **Complete API Reference:** `docs/DATA_QUALITY_ANALYTICS_API.md`
- **Timestamp Convention:** `docs/API_TIMESTAMP_CONVENTION.md`
- **Database Management API:** `docs/DATABASE_MANAGEMENT.md`

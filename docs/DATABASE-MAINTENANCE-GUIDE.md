# 📊 Database Maintenance Guide

## Overview

The KNX Gateway provides specialized scripts for database monitoring, diagnosis, and maintenance. Each script serves a specific purpose.

---

## 🗂️ Scripts Overview

### 1. **database-summary.sh** – Management & Monitoring Dashboard
**Purpose:** Complete database health overview for monitoring and reporting

#### When to use:
- Daily/periodic health checks (cron jobs)
- Admin dashboards
- Capacity planning
- Generating reports for stakeholders

#### What it shows:
```
✅ System information (DB name, size, PG version)
✅ Event statistics (timeline, coverage, rates)
✅ Table breakdown (sizes, row counts)
✅ Subscription status
✅ Growth & capacity projections
✅ Data integrity checks (orphaned, duplicates, stale)
✅ Maintenance status
```

#### Example usage:
```bash
# Simple report
./scripts/database-summary.sh

# Automated daily check (add to crontab)
0 2 * * * /path/to/database-summary.sh >> /var/log/knx-db-summary.log
```

#### Output format:
```
════════════════════════════════════════════════════════════════════════════
                    📊 DATABASE HEALTH REPORT SUMMARY
════════════════════════════════════════════════════════════════════════════

1️⃣  SYSTEM INFORMATION
   Report Generated: ...
   Database Name: knx
   PostgreSQL Version: 14.5
   ...

2️⃣  EVENT STATISTICS
   Total Events: 1,234,567
   ...

... (7 sections total)
```

---

### 2. **db-health-check.sh** – Diagnosis & Automated Cleanup
**Purpose:** Specialized tool for identifying and fixing data integrity issues

#### When to use:
- Troubleshooting data consistency issues
- Automatic cleanup of orphaned/stale data
- Investigating duplicate group addresses
- Pre-deployment validation

#### Capabilities:
```
🔍 Diagnose orphaned states
🔍 Diagnose duplicate GAs (data corruption risk)
🔍 Diagnose stale mappings (unused entries)
🧹 List detailed problem entries
🧹 Recommend automated cleanup
```

#### Example usage:
```bash
# Just diagnose (no changes)
./scripts/db-health-check.sh

# Show detailed orphaned states
./scripts/db-health-check.sh --list-orphaned

# Show detailed duplicate GAs
./scripts/db-health-check.sh --list-duplicates

# Show detailed stale mappings
./scripts/db-health-check.sh --list-stale

# Show all details
./scripts/db-health-check.sh --list-orphaned --list-duplicates --list-stale

# Prepare for cleanup (shows what would be cleaned)
./scripts/db-health-check.sh --cleanup
```

#### Output format:
```
═══════════════════════════════════════════════════════════════════════════
🔍 DATABASE HEALTH CHECK & DIAGNOSTIC – Semantic KNX Gateway
═══════════════════════════════════════════════════════════════════════════

📊 HEALTH CHECK SUMMARY
   ✓ Orphaned States Check
      └─ 5 orphaned states (3 GAs affected)
   
   ✓ Duplicate Group Addresses Check
      └─ 0 duplicate GAs found
   
   ✓ Stale Mappings Check
      └─ 12 stale mappings (unused, can be cleaned)

   Data Integrity Score: 96%
   Overall Status: ✅ HEALTHY
```

---

## 🎯 Decision Matrix

| Scenario | Script | Flags |
|----------|--------|-------|
| Daily health check | `database-summary.sh` | (none) |
| Cron job monitoring | `database-summary.sh` | (none) |
| Admin dashboard | `database-summary.sh` | (none) |
| Capacity planning | `database-summary.sh` | (none) |
| Troubleshooting issues | `db-health-check.sh` | (none) |
| Investigate orphaned data | `db-health-check.sh` | `--list-orphaned` |
| Investigate duplicates | `db-health-check.sh` | `--list-duplicates` |
| Investigate stale data | `db-health-check.sh` | `--list-stale` |
| Show all problems | `db-health-check.sh` | `--list-orphaned --list-duplicates --list-stale` |
| Preview cleanup | `db-health-check.sh` | `--cleanup` |

---

## 📋 Data Integrity Checks

Both scripts use the same REST API endpoints for consistency:

### Check 1: Orphaned States
- **What:** States in `current_state` table without corresponding `datapoint_mappings`
- **Risk:** Low (data consistency issue)
- **Action:** Can be safely auto-cleaned
- **Endpoint:** `GET /api/v2/stats/health/orphaned-states`

### Check 2: Duplicate Group Addresses
- **What:** Single GA with multiple datapoint mappings
- **Risk:** HIGH (data corruption - ambiguous interpretation)
- **Action:** Requires manual investigation
- **Endpoint:** `GET /api/v2/stats/health/duplicate-gas`

### Check 3: Stale Mappings
- **What:** Mappings in `datapoint_mappings` without corresponding `current_state`
- **Risk:** Medium (unused data-consuming space)
- **Action:** Can be safely auto-cleaned
- **Endpoint:** `GET /api/v2/stats/health/stale-mappings`

---

## 🔧 Recommended Maintenance Schedule

### Daily (Automatic)
```bash
# Add to crontab
0 2 * * * /path/to/database-summary.sh >> /var/log/knx-db-summary.log
```

### Weekly (Manual)
```bash
# Run health check
./scripts/db-health-check.sh

# If issues found, investigate
./scripts/db-health-check.sh --list-orphaned --list-stale
```

### Monthly (If needed)
```bash
# Preview cleanup
./scripts/db-health-check.sh --cleanup

# If OK, execute cleanup via REST API
curl -X POST http://localhost:3000/api/v2/database/cleanup/orphaned-states \
  -H "Authorization: Bearer $TOKEN"
```

---

## 🚨 Critical Issues

### ⛔ Duplicate Group Addresses (CRITICAL)
If you see duplicate GAs:
1. **Stop all devices** connected to those GAs
2. **Run diagnosis:** `./scripts/db-health-check.sh --list-duplicates`
3. **Investigate manually:** Which mapping should be the correct one?
4. **Delete duplicates** via API:
   ```bash
   DELETE /api/v2/datapoints/{datapoint_id}
   ```
5. **Restart devices** after cleanup

### ⚠️ High Orphaned/Stale Counts (WARNING)
- If orphaned states > 1000: System may have been off for an extended period
- If stale mappings > 500: Many devices configured but not actively used
- **Recommend:** Use `--cleanup` flag to remove safely

---

## 🔐 Authentication

Both scripts require OAuth token with `read` scope:
```bash
CLIENT_ID="knx-default-client"
OAUTH_CLIENT_SECRET="change-me-in-production"
```

Set environment variables:
```bash
export OAUTH_CLIENT_SECRET="your-secret"
export API_URL="http://your-host:3000"
```

---

## 📊 REST API Integration

Both scripts use the REST API for full consistency:

```bash
# Main health check endpoint
GET /api/v2/stats/health/db-checks

# Detailed endpoints
GET /api/v2/stats/health/orphaned-states?limit=50
GET /api/v2/stats/health/duplicate-gas
GET /api/v2/stats/health/stale-mappings?limit=50

# Summary endpoint (used by database-summary.sh)
GET /api/v2/database/info
GET /api/v2/database/cleanup-jobs
```

---

## 💡 Tips

1. **Use pipes for further processing:**
   ```bash
   ./scripts/database-summary.sh | grep "INTEGRITY"
   ```

2. **Log output for audit trail:**
   ```bash
   ./scripts/database-summary.sh | tee -a /var/log/knx-maintenance.log
   ```

3. **Schedule in cron with logging:**
   ```bash
   0 2 * * * /path/to/database-summary.sh >> /var/log/knx-summary.log 2>&1
   0 */6 * * * /path/to/db-health-check.sh >> /var/log/knx-health.log 2>&1
   ```

4. **Use in monitoring (parse JSON from API):**
   ```bash
   curl -s http://localhost:3000/api/v2/stats/health/db-checks | jq '.summary.data_integrity_score'
   ```

---

## ✅ Checklist for New Deployments

- [ ] Run `database-summary.sh` to establish baseline
- [ ] Schedule daily `database-summary.sh` in cron
- [ ] Schedule weekly `db-health-check.sh` in cron
- [ ] Set up log rotation for output files
- [ ] Monitor `data_integrity_score` trend
- [ ] Create alerts for duplicate GAs (immediate action!)
- [ ] Create alerts for orphaned/stale data > thresholds

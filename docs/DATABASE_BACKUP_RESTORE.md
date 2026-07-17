# DATABASE BACKUP & RESTORE

**Backup Strategy & Implementation Guide**

Version: 1.0  
Status: Planning  
Date: 2026-07-06

---

## 📋 Overview

This document describes backup and restore strategies for the Semantic KNX Runtime Engine's PostgreSQL/TimescaleDB database. It adapts proven patterns from IOTstack while adding enterprise-grade features for KNX deployments.

### Key Design Principles

✅ **Data Consistency** — Backups maintain ACID integrity without locking the database  
✅ **Operational Continuity** — Live transactions can continue during backup  
✅ **Disaster Recovery** — Point-in-time recovery support (optional WAL archiving)  
✅ **Automated Scheduling** — Cron-based daily backups  
✅ **Retention Policies** — Automatic cleanup of old backups  
✅ **Encryption & Security** — Optional GPG encryption for sensitive data  
✅ **Cloud Integration** — S3/Minio/RSYNC/SCP upload support  
✅ **Audit Trail** — Complete logging of all backup/restore operations  

---

## ❓ Data Consistency During Backups

### The Short Answer

**No, you do NOT need to stop transactions during backup.**

PostgreSQL's `pg_dumpall` (used by IOTstack approach) works by:

1. **Creating a snapshot** at the moment the dump starts
2. **Reading all data from that snapshot** — consistent point-in-time view
3. **Other transactions continue normally** — they don't see the dump

### Why This Works

PostgreSQL uses **Multi-Version Concurrency Control (MVCC)**:

```
Timeline:
  10:00:00  Backup starts (snapshot established)
  10:00:05  Client A writes UPDATE (on newer version)
  10:00:10  Client B writes INSERT (on newer version)
  10:00:35  Backup completes (used snapshot from 10:00:00)
  ✅ Result: Backup is consistent snapshot from 10:00:00
             Live transactions never blocked
```

**Isolation Level**: `pg_dump` uses `SERIALIZABLE ISOLATION LEVEL`, which guarantees:
- No dirty reads
- No phantom reads
- No lost updates
- Backup is crash-consistent

---

## 🔄 Backup Strategies

### Strategy 1: Logical Backup (pg_dumpall) — Recommended

**What it does:**
```bash
pg_dumpall -U postgres | gzip > backup.sql.gz
```

**Pros:**
- ✅ No locks needed
- ✅ Transactions continue normally
- ✅ Portable (works on any PostgreSQL version)
- ✅ Human-readable SQL format
- ✅ Easy selective restore
- ✅ Good compression ratio (3:1 to 5:1 typical)

**Cons:**
- ❌ Slower for huge databases (> 100GB)
- ❌ Restore takes longer (rows must be parsed and re-inserted)
- ❌ Temporary memory spike during restore

**Best for:** Standard KNX deployments, most IOTstack users

**Typical performance:**
- Backup time: 50–200 seconds (depending on data volume)
- Compression: 80–90% size reduction
- Database size during backup: Minimal impact

---

### Strategy 2: Physical Backup (pg_basebackup) — Enterprise

**What it does:**
```bash
pg_basebackup -D /backup -F tar -z -v
```

**Pros:**
- ✅ Faster (full block copy)
- ✅ Minimal memory overhead
- ✅ Can support incremental backups
- ✅ Faster restore (copy blocks)
- ✅ Better for huge databases (100GB+)

**Cons:**
- ❌ Requires superuser access
- ❌ Produces large files (less compression)
- ❌ Less portable between versions
- ❌ Cannot do selective restore

**Best for:** Large production deployments with dedicated DBA

---

### Strategy 3: Continuous WAL Archiving (PITR) — Advanced

**What it does:**
Archives transaction logs (WAL) continuously, enabling recovery to any point in time.

```
Backup:
  Full backup @ 10:00 (e.g., backup.sql.gz)
  + WAL archive 10:00-10:15 (all transactions)
  + WAL archive 10:15-10:30
  + WAL archive 10:30-10:45
  ...

Recovery:
  Restore from 10:00 backup
  Replay WAL until 10:25 ← recover to exact moment
  OR replay all WAL for latest state
```

**Pros:**
- ✅ Recover to any point in time
- ✅ No data loss even if backup fails
- ✅ Granular recovery (recover to seconds precision)

**Cons:**
- ❌ Requires dedicated infrastructure
- ❌ WAL storage grows quickly (100MB+/day typical)
- ❌ Complex restore procedure
- ❌ More operational overhead

**Best for:** Mission-critical systems where data loss is unacceptable

---

## 🏗️ Recommended Architecture for KNX

We recommend a **hybrid approach**:

```
Tier 1: Daily Logical Backups (pg_dumpall)
├── Full backup daily @ 02:00 UTC
├── Stored locally in ./backups/ for 8 days
├── Compressed (gzip)
├── Uploaded to cloud (S3/RSYNC/SCP) same day
└── Local retention: 8 backups

Tier 2: Optional WAL Archiving (Production only)
├── WAL archive to S3/Minio every 5 minutes
├── Retention: 7 days
└── Enables point-in-time recovery
```

---

## 🛠️ Implementation

### New Components

#### 1. `src/storage/backup-manager.js`

Core backup/restore logic.

```javascript
export class BackupManager {
  constructor(db, postgresClient) {
    this.db = db;
    this.postgresClient = postgresClient;
    this.logger = createLogger('BackupManager');
  }

  // Backup operations
  async createFullBackup(options = {})           // pg_dumpall
  async createLogicalBackup(outputPath)          // Wrapper
  async createPhysicalBackup(outputPath)         // pg_basebackup
  async dryRunBackup()                           // Estimate size

  // Restore operations
  async restoreFromBackup(backupPath, options)   // pg_restore
  async validateBackup(backupPath)               // Verify integrity
  async listBackups()                            // Show available backups

  // Cloud operations
  async uploadBackup(backupPath, cloudPath)      // S3/SCP/RSYNC
  async downloadBackup(cloudPath, localPath)     // Cloud → Local
  async listCloudBackups(cloudPath)              // List remote

  // WAL operations (optional)
  async enableWalArchiving(archivePath)          // Start WAL archiving
  async getWalArchiveStatus()                    // Archive status
  async restoreToPointInTime(backupPath, timestamp)
}
```

#### 2. `scripts/backup-manager.sh`

Main backup orchestration script (adapts IOTstack pattern).

```bash
#!/usr/bin/env bash

# Configuration
SCRIPT=$(basename "$0")
IOTSTACK=${IOTSTACK:-"$HOME/semantic-knx-gateway"}
PROJECT=$(basename ${IOTSTACK,,})
BACKUPSDIR="$IOTSTACK/backups"
RUNTAG=$(date +"%Y-%m-%d_%H%M").$(hostname)

# Read config
CONFIG_YML="$HOME/.config/knx_backup/config.yml"
CLOUD_METHOD=$(shyaml get-value backup.method < "$CONFIG_YML")
CLOUD_PREFIX=$(shyaml get-value backup.prefix < "$CONFIG_YML")
LOCAL_RETAIN=$(shyaml get-value backup.retain < "$CONFIG_YML")

# Create backup
backup_postgres() {
  docker exec timescaledb bash -c \
    'pg_dumpall -U $POSTGRES_USER | gzip > /backup/knx_backup.sql.gz'
}

# Upload to cloud
upload_backup() {
  case "$CLOUD_METHOD" in
    "SCP" | "RSYNC" )
      rsync -vrt "$BACKUPSDIR"/ "$CLOUD_PREFIX/$RUNTAG"
      ;;
    "S3" )
      aws s3 sync "$BACKUPSDIR" "s3://$CLOUD_PREFIX/$RUNTAG"
      ;;
  esac
}

# Retention policy
cleanup_old_backups() {
  ls -t1 "$BACKUPSDIR"/*.sql.gz | tail -n +$((LOCAL_RETAIN+1)) | xargs rm -f
}

# Main
backup_postgres
upload_backup
cleanup_old_backups
```

#### 3. `scripts/restore-manager.sh`

Main restore orchestration script.

```bash
#!/usr/bin/env bash

# Download from cloud if needed
# Verify backup integrity
# Stop the container
# Restore from backup
# Restart container
```

#### 4. Configuration: `~/.config/knx_backup/config.yml`

```yaml
backup:
  method: "RSYNC"  # SCP, RSYNC, S3, MINIO
  prefix: "backup@backup-server.example.com:/mnt/backups/knx"
  options: "-avz --rsh=ssh"
  retain: 8  # Keep 8 local backups

restore:
  method: "RSYNC"
  prefix: "backup@backup-server.example.com:/mnt/backups/knx"
  options: "-avz --rsh=ssh"

# Optional: WAL archiving (advanced)
wal_archive:
  enabled: false
  method: "S3"  # S3, MINIO, SCP
  path: "s3://my-bucket/knx-wal"
  retention_days: 7
  backup_interval_seconds: 300

# Optional: Encryption
encryption:
  enabled: false
  method: "GPG"  # GPG, age, openssl
  recipient: "backup@example.com"
  trust_model: "always"
```

---

## 📊 Backup Scenarios

### Scenario 1: Standard Deployment (Single Server)

**Setup:**
```
semantic-knx-gateway (Docker)
  └── timescaledb container
        └── /backup (volume)
              └── backups stored here

Cron: Daily @ 02:00 UTC
  pg_dumpall → gzip → store locally → delete old ones
```

**Cron job:**
```bash
# Add to crontab
0 2 * * * /path/to/backup-manager.sh

# Expected output:
# 2026-07-07_0200.hostname.general-backup.sql.gz  (1.2 GB → 120 MB)
# 2026-07-07_0200.hostname.backup-log.txt
```

**Restore:**
```bash
./restore-manager.sh 2026-07-07_0200.hostname
```

---

### Scenario 2: Cloud-Backed Deployment (Production)

**Setup:**
```
semantic-knx-gateway (Docker)
  ├── Daily backup @ 02:00
  ├── Local retention: 8 backups
  └── Upload to S3/RSYNC same day
        └── Cloud retention: 30 days
```

**Config:**
```yaml
backup:
  method: "RSYNC"
  prefix: "aws-backup:/mnt/backups/knx-prod"
  retain: 8
```

**Flow:**
```
02:00  Local backup created
02:05  Upload to RSYNC (parallel)
02:15  Old backups cleaned up
       (keep 8 local, older ones on cloud only)
```

---

### Scenario 3: Disaster Recovery (Full Restore)

**Scenario:** Server crashed, need full recovery from cloud backup

**Steps:**
```bash
# 1. Provision new server with Docker
docker pull postgres:16-timescaledb

# 2. Start fresh database
docker run -d --name timescaledb \
  -e POSTGRES_PASSWORD=knx \
  -v ./backups:/backup \
  postgres:16-timescaledb

# 3. Wait for initialization
until docker exec timescaledb pg_isready; do
  sleep 1
done

# 4. Download backup from cloud
./restore-manager.sh 2026-07-06_0200.hostname \
  --from-cloud aws-backup:/mnt/backups/knx-prod

# 5. Restore begins automatically
# ...

# 6. Verify
curl http://localhost:3000/api/v2/database/info

# 7. If all good, restart application
docker compose up -d
```

---

## 🔐 Security & Encryption

### Option 1: GPG Encryption (Recommended)

Encrypt backups before uploading to cloud.

**Setup:**
```bash
# Generate GPG key
gpg --gen-key

# Configure in config.yml
encryption:
  enabled: true
  method: "GPG"
  recipient: "backup@example.com"
```

**Backup script enhancement:**
```bash
pg_dumpall -U postgres | gzip | \
  gpg --encrypt --recipient "$RECIPIENT" > backup.sql.gz.gpg
```

**Restore script enhancement:**
```bash
gpg --decrypt backup.sql.gz.gpg | gunzip | psql ...
```

**Benefits:**
- ✅ Backups encrypted before transmission
- ✅ Cloud provider cannot read data
- ✅ Industry standard (OpenPGP)

---

### Option 2: TLS for Transit

Use SSH/TLS when uploading to cloud.

```yaml
backup:
  method: "RSYNC"
  prefix: "backup@backup-server.example.com:/path"
  options: "--rsh=ssh -e /usr/bin/ssh -i /home/user/.ssh/id_rsa"
```

---

### Option 3: S3 Server-Side Encryption

If using AWS S3 for cloud storage.

```bash
aws s3 sync backups/ s3://my-bucket/knx-backups \
  --sse AES256
```

---

## 📈 Performance Characteristics

### Database Size Impact During Backup

For a typical KNX deployment with 6 months of data:

| Database Size | Backup Time | Compressed Size | Disk I/O | CPU Load |
|--------------|-------------|-----------------|----------|----------|
| 500 MB | 10 sec | 50 MB | Low | Low |
| 5 GB | 30 sec | 500 MB | Low | Low |
| 50 GB | 120 sec | 5 GB | Medium | Medium |
| 100 GB | 250 sec | 10 GB | Medium | High |

### Network Upload Time (Cloud)

Assuming 100 Mbps connection (12.5 MB/sec):

| Backup Size | Upload Time | Notes |
|------------|-------------|-------|
| 50 MB | 4 sec | Typical 1 month data |
| 500 MB | 40 sec | Typical 6 months data |
| 5 GB | 400 sec (6 min) | Typical 3 years data |
| 10 GB | 800 sec (13 min) | Large deployment |

**Recommendation:** Schedule backups during off-peak hours (e.g., 02:00 UTC)

---

## 🧪 Testing & Validation

### Backup Integrity Check

```bash
# Verify backup file is valid SQL
gzip -t backup.sql.gz
echo $?  # 0 = valid, 1 = corrupted

# Dry-run restore (parse SQL without executing)
gunzip -c backup.sql.gz | psql --dry-run postgres
```

### Regular Restore Testing

**Recommendation:** Test restore monthly (in staging environment)

```bash
#!/bin/bash
# Test restore monthly (e.g., first Sunday)

# 1. Get latest backup from cloud
LATEST=$(./restore-manager.sh --list-latest)

# 2. Spin up test container
docker run -d --name test-restore \
  -e POSTGRES_PASSWORD=test \
  -v ./backups:/backup \
  postgres:16-timescaledb

# 3. Restore from backup
./restore-manager.sh "$LATEST" \
  --to test-restore

# 4. Verify
docker exec test-restore psql -U postgres -d knx -c \
  "SELECT COUNT(*) FROM knx_events;"

# 5. Cleanup
docker rm -f test-restore
```

---

## 📝 Cron Setup

### Daily Automatic Backup

Add to system crontab:

```bash
# Backup at 02:00 UTC daily
0 2 * * * /home/user/semantic-knx-gateway/scripts/backup-manager.sh >> /var/log/knx-backup.log 2>&1

# Optional: Verify backups weekly (first Sunday at 03:00)
0 3 * * 0 /home/user/semantic-knx-gateway/scripts/test-restore.sh >> /var/log/knx-restore-test.log 2>&1
```

Or use Docker:

```yaml
# docker-compose.yml addition
  backup-scheduler:
    image: mcuadros/ofelia:latest
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./scripts:/scripts:ro
    command: daemon --docker
    environment:
      OFELIA_JOB_EXEC_KNX_BACKUP: |
        job-exec semantic-knx-runtime /scripts/backup-manager.sh
      OFELIA_JOB_EXEC_KNX_BACKUP_SCHEDULE: "0 2 * * *"  # 02:00 UTC
```

---

## 🔄 Recovery Runbook

### Full Database Restore (Step by Step)

**Situation:** Database corruption or data loss

**Steps:**

1. **Identify the latest good backup**
   ```bash
   ./restore-manager.sh --list
   # Expected: 2026-07-07_0200.hostname.general-backup.sql.gz
   ```

2. **Stop the application**
   ```bash
   docker compose down
   ```

3. **Download backup from the cloud (if needed)**
   ```bash
   ./restore-manager.sh --download 2026-07-07_0200.hostname
   ```

4. **Start a fresh database container**
   ```bash
   docker compose up -d timescaledb
   ```

5. **Wait for initialization**
   ```bash
   while ! docker exec timescaledb pg_isready >/dev/null; do
     sleep 2
   done
   ```

6. **Restore the backup**
   ```bash
   ./restore-manager.sh 2026-07-07_0200.hostname \
     --execute
   ```

7. **Verify restore**
   ```bash
   docker exec timescaledb psql -U postgres -d knx \
     -c "SELECT COUNT(*) FROM knx_events; SELECT MAX(ts) FROM knx_events;"
   ```

8. **Restart application**
   ```bash
   docker compose up -d
   ```

9. **Verify application**
   ```bash
   curl http://localhost:3000/api/v2/database/info
   ```

---

## 📚 Related Documentation

- [DATABASE_MANAGEMENT.md](./DATABASE_MANAGEMENT.md) — Cleanup & statistics
- [../ARCHITECTURE.md](../ARCHITECTURE.md) — Database schema
- [../CONFIGURATION.md](../CONFIGURATION.md) — Environment setup

---

## 🔄 Future Enhancements

### Phase 2: WAL Archiving

Enable point-in-time recovery for production:

```sql
-- In PostgreSQL
ALTER SYSTEM SET wal_level = 'replica';
ALTER SYSTEM SET archive_mode = 'on';
ALTER SYSTEM SET archive_command = 'aws s3 cp %p s3://bucket/wal/%f';
```

### Phase 3: Incremental Backups

Speed up large database backups:

```bash
# Only backup changed blocks since last full backup
pg_basebackup -D /backup -F tar --incremental
```

### Phase 4: Backup Verification Dashboard

Add an API endpoint to check the backup status:

```
GET /api/v2/database/backups
GET /api/v2/database/backups/{id}/verify
POST /api/v2/database/restore/{id}
```

---

## ❓ FAQ

### Q: Can I stop transactions during backup for consistency?

**A:** Not needed! PostgreSQL's MVCC ensures consistency without locking. `pg_dumpall` creates a consistent snapshot while other transactions continue.

### Q: What if a transaction is running when backup starts?

**A:** The backup will wait for the transaction to complete before capturing its changes. This is transparent to both backup and transaction.

### Q: How much disk space do I need for backups?

**A:** Typically 10% of database size (after gzip compression). E.g., 50GB database → 5GB backup.

### Q: Can I restore a backup while the application is running?

**A:** No, the database must be stopped. The restore script handles this automatically.

### Q: What's the difference between `pg_dump` and `pg_dumpall`?

**A:** `pg_dumpall` dumps all databases, roles, and global settings. `pg_dump` dumps a single database. We use `pg_dumpall` for complete restore.

### Q: How do I verify a backup is valid?

**A:**
```bash
# Quick check
gzip -t backup.sql.gz && echo "Valid"

# Full validation (parse all SQL)
gunzip -c backup.sql.gz | psql --dry-run postgres
```

### Q: Can I back up only specific tables?

**A:** Yes, use `pg_dump -t tablename` instead of `pg_dumpall`. Useful for selective recovery.

---

## 📞 Support

- GitHub Issues: https://github.com/Noschvie/semantic-knx-gateway/issues
- PostgreSQL Docs: https://www.postgresql.org/docs/current/backup.html
- TimescaleDB Docs: https://docs.timescale.com/

---

**Last Updated**: 2026-07-06  
**Status**: ✅ Design Completes / ⏳ Implementation Pending  
**Version**: 1.0-DRAFT

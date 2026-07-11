#!/usr/bin/env bash
# Database Health Check & Cleanup Script for Semantic KNX Gateway
# Usage: ./scripts/db-health-check.sh [--cleanup] [--backup]

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
DB_CONTAINER="${DB_CONTAINER:-timescaledb}"
DB_USER="${POSTGRES_USERNAME:-knxuser}"
DB_NAME="${POSTGRES_DB:-knxdb}"
BACKUP_DIR="./volumes/backups"

# Flags
DO_CLEANUP=false
DO_BACKUP=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --cleanup) DO_CLEANUP=true; shift ;;
    --backup)  DO_BACKUP=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo "═══════════════════════════════════════════════════════════════"
echo "🔍 Database Health Check – Semantic KNX Gateway"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# Check if container is running
if ! docker ps | grep -q "$DB_CONTAINER"; then
  echo -e "${RED}❌ Container '$DB_CONTAINER' is not running${NC}"
  exit 1
fi

# Function to run SQL query
run_sql() {
  docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tc "$1"
}

# 1. General Statistics
echo -e "${YELLOW}1. DATABASE STATISTICS${NC}"
echo "─────────────────────────────────────────────────────────────"

STATS=$(run_sql "
  SELECT
    (SELECT COUNT(*) FROM datapoint_mappings) as mappings,
    (SELECT COUNT(DISTINCT ga) FROM datapoint_mappings) as unique_gas,
    (SELECT COUNT(*) FROM current_state) as states,
    (SELECT COUNT(DISTINCT ga) FROM current_state) as state_gas
")

IFS=' ' read -r MAPPINGS UNIQUE_GAS STATES STATE_GAS <<< "$STATS"
echo "  Datapoint Mappings: $MAPPINGS entries"
echo "  Unique GAs (mappings): $UNIQUE_GAS"
echo "  Current States: $STATES entries"
echo "  Unique GAs (states): $STATE_GAS"
echo ""

# 2. Orphaned States Check
echo -e "${YELLOW}2. ORPHANED STATES CHECK${NC}"
echo "─────────────────────────────────────────────────────────────"

ORPHANED=$(run_sql "
  SELECT COUNT(*)
  FROM current_state cs
  LEFT JOIN datapoint_mappings m ON cs.datapoint_id = m.datapoint_id
  WHERE m.datapoint_id IS NULL
" | xargs)

if [ -z "$ORPHANED" ]; then ORPHANED=0; fi

if [ "$ORPHANED" -gt 0 ]; then
  echo -e "${RED}⚠️  FOUND $ORPHANED orphaned states (states without mappings)${NC}"

  echo "  Details:"
  run_sql "
    SELECT
      '    - ' || cs.datapoint_id || ' (GA ' || cs.ga || ')'
    FROM current_state cs
    LEFT JOIN datapoint_mappings m ON cs.datapoint_id = m.datapoint_id
    WHERE m.datapoint_id IS NULL
    LIMIT 10
  " | head -10

  if [ "$ORPHANED" -gt 10 ]; then
    echo "    ... and $((ORPHANED - 10)) more"
  fi
else
  echo -e "${GREEN}✓ No orphaned states found${NC}"
fi
echo ""

# 3. Duplicate GAs Check
echo -e "${YELLOW}3. DUPLICATE GROUP ADDRESSES CHECK${NC}"
echo "─────────────────────────────────────────────────────────────"

DUPLICATES=$(run_sql "
  SELECT COUNT(*)
  FROM (
    SELECT ga, COUNT(*) FROM datapoint_mappings GROUP BY ga HAVING COUNT(*) > 1
  ) t
" | xargs)

if [ -z "$DUPLICATES" ]; then DUPLICATES=0; fi

if [ "$DUPLICATES" -gt 0 ]; then
  echo -e "${RED}⚠️  FOUND $DUPLICATES GAs with multiple entries${NC}"

  echo "  Top problematic GAs:"
  run_sql "
    SELECT
      '    GA ' || ga || ': ' || COUNT(*) || 'x (DPTs: ' || STRING_AGG(DISTINCT dpt, ', ') || ')'
    FROM datapoint_mappings
    GROUP BY ga
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC
    LIMIT 5
  "
else
  echo -e "${GREEN}✓ All GAs are unique${NC}"
fi
echo ""

# 4. Stale Mappings Check
echo -e "${YELLOW}4. STALE MAPPINGS CHECK${NC}"
echo "─────────────────────────────────────────────────────────────"

STALE=$(run_sql "
  SELECT COUNT(*)
  FROM datapoint_mappings m
  LEFT JOIN current_state cs ON m.datapoint_id = cs.datapoint_id
  WHERE cs.datapoint_id IS NULL
" | xargs)

if [ -z "$STALE" ]; then STALE=0; fi

if [ "$STALE" -gt 0 ]; then
  echo -e "${YELLOW}ℹ️  Found $STALE mappings without current state${NC}"
  echo "  (These are old/unused entries, can be cleaned up)"
else
  echo -e "${GREEN}✓ All mappings have current states${NC}"
fi
echo ""

# 5. Backup (if requested)
if [ "$DO_BACKUP" = true ]; then
  echo -e "${YELLOW}5. DATABASE BACKUP${NC}"
  echo "─────────────────────────────────────────────────────────────"

  mkdir -p "$BACKUP_DIR"
  BACKUP_FILE="$BACKUP_DIR/knx-$(date +%Y%m%d-%H%M%S).sql.gz"

  echo "  Creating backup: $BACKUP_FILE"
  docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" "$DB_NAME" | gzip > "$BACKUP_FILE"
  SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
  echo -e "  ${GREEN}✓ Backup created ($SIZE)${NC}"

  # Cleanup old backups (keep 30 days)
  find "$BACKUP_DIR" -name "knx-*.sql.gz" -mtime +30 -delete
  echo "  Old backups (>30d) cleaned up"
  echo ""
fi

# 6. Cleanup (if requested)
if [ "$DO_CLEANUP" = true ]; then
  echo -e "${YELLOW}6. CLEANUP OPERATIONS${NC}"
  echo "─────────────────────────────────────────────────────────────"

  CLEANUP_DONE=false

  if [ "$DO_BACKUP" = false ]; then
    echo -e "${RED}⚠️  Creating backup before cleanup...${NC}"
    mkdir -p "$BACKUP_DIR"
    BACKUP_FILE="$BACKUP_DIR/knx-before-cleanup-$(date +%Y%m%d-%H%M%S).sql.gz"
    docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" "$DB_NAME" | gzip > "$BACKUP_FILE"
    echo "  Backup: $BACKUP_FILE"
  fi

  # Cleanup orphaned states
  if [ "$ORPHANED" -gt 0 ]; then
    echo "  Deleting $ORPHANED orphaned states..."
    run_sql "
      DELETE FROM current_state cs
      WHERE NOT EXISTS (
        SELECT 1 FROM datapoint_mappings m
        WHERE m.datapoint_id = cs.datapoint_id
      );
    " > /dev/null

    REMAINING=$(run_sql "
      SELECT COUNT(*)
      FROM current_state cs
      LEFT JOIN datapoint_mappings m ON cs.datapoint_id = m.datapoint_id
      WHERE m.datapoint_id IS NULL
    " | xargs)

    if [ -z "$REMAINING" ]; then REMAINING=0; fi

    if [ "$REMAINING" -eq 0 ]; then
      echo -e "  ${GREEN}✓ All orphaned states removed${NC}"
    else
      echo -e "  ${RED}⚠️  $REMAINING states still orphaned (???)${NC}"
    fi
    CLEANUP_DONE=true
  fi

  # Cleanup stale mappings
  if [ "$STALE" -gt 0 ]; then
    echo "  Deleting $STALE stale mappings (without current state)..."
    run_sql "
      DELETE FROM datapoint_mappings m
      WHERE NOT EXISTS (
        SELECT 1 FROM current_state cs
        WHERE cs.datapoint_id = m.datapoint_id
      );
    " > /dev/null
    echo -e "  ${GREEN}✓ Stale mappings removed${NC}"
    CLEANUP_DONE=true
  fi

  if [ "$CLEANUP_DONE" = true ]; then
    echo -e "  ${GREEN}✓ Cleanup complete${NC}"
  else
    echo -e "  ${YELLOW}ℹ️  Nothing to cleanup${NC}"
  fi
  echo ""
fi

# Summary
echo "═══════════════════════════════════════════════════════════════"
if [ "$ORPHANED" -eq 0 ] && [ "$DUPLICATES" -eq 0 ]; then
  echo -e "${GREEN}✅ Database is healthy!${NC}"
else
  echo -e "${YELLOW}⚠️  Issues found – review above${NC}"
  [ "$ORPHANED" -gt 0 ] && echo "   • $ORPHANED orphaned states"
  [ "$DUPLICATES" -gt 0 ] && echo "   • $DUPLICATES duplicate GAs"
  [ "$STALE" -gt 0 ] && echo "   • $STALE stale mappings"
  echo ""
  echo "  Run with --cleanup to fix:"
  echo "    ./scripts/db-health-check.sh --cleanup --backup"
fi
echo "═══════════════════════════════════════════════════════════════"

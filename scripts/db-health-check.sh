#!/usr/bin/env bash
# Database Health Check & Cleanup Script for Semantic KNX Gateway
# Usage: ./scripts/db-health-check.sh [--cleanup] [--backup] [--local]
#
# Modes:
#   Default: Uses REST API (requires API_URL env var or defaults to localhost:3000)
#   --local: Uses direct Docker database access (requires running container)

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
API_BASE_URL="${API_URL:-http://localhost:3000}"
DB_CONTAINER="${DB_CONTAINER:-timescaledb}"
DB_USER="${POSTGRES_USERNAME:-knxuser}"
DB_NAME="${POSTGRES_DB:-knxdb}"
BACKUP_DIR="./volumes/backups"

# Flags
DO_CLEANUP=false
DO_BACKUP=false
USE_LOCAL=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --cleanup) DO_CLEANUP=true; shift ;;
    --backup)  DO_BACKUP=true; shift ;;
    --local)   USE_LOCAL=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo "═══════════════════════════════════════════════════════════════"
echo "🔍 Database Health Check – Semantic KNX Gateway"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# Determine mode
if [ "$USE_LOCAL" = true ]; then
  # Check if container is running
  if ! docker ps | grep -q "$DB_CONTAINER"; then
    echo -e "${RED}❌ Container '$DB_CONTAINER' is not running${NC}"
    exit 1
  fi
  MODE="local"
  echo "📍 Mode: Local database access (docker)"
else
  MODE="api"
  echo "📍 Mode: REST API access (${API_BASE_URL})"
fi
echo ""

# Function to run SQL query (local mode only)
run_sql() {
  docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tc "$1"
}

# Function to get OAuth token (API mode)
get_api_token() {
  TOKEN_RESPONSE=$(curl -s -X POST ${API_BASE_URL}/oauth/access \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "grant_type=client_credentials&scope=read,delete:database&client_id=knx-default-client&client_secret=${OAUTH_CLIENT_SECRET:-change-me-in-production}")

  TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.access_token')
  if [ -z "$TOKEN" ] || [ "$TOKEN" == "null" ]; then
    echo -e "${RED}❌ Failed to obtain OAuth token${NC}"
    exit 1
  fi
  echo "$TOKEN"
}

# Function to get health check data from API
get_api_health_check() {
  local token="$1"
  curl -s -X GET "${API_BASE_URL}/api/v2/stats/health/db-checks" \
    -H "Authorization: Bearer $token"
}

# 1. General Statistics
echo -e "${YELLOW}1. DATABASE STATISTICS${NC}"
echo "─────────────────────────────────────────────────────────────"

if [ "$MODE" = "api" ]; then
  TOKEN=$(get_api_token)
  HEALTH_DATA=$(get_api_health_check "$TOKEN")

  # Extract stats from API response (correct paths from /api/v2/stats/health/db-checks)
  MAPPINGS=$(echo "$HEALTH_DATA" | jq -r '.summary.total_mappings // 0')
  UNIQUE_GAS=$(echo "$HEALTH_DATA" | jq -r '.summary.unique_gas_mappings // 0')
  STATES=$(echo "$HEALTH_DATA" | jq -r '.summary.total_states // 0')
  STATE_GAS=$(echo "$HEALTH_DATA" | jq -r '.summary.unique_gas_states // 0')

  ORPHANED=$(echo "$HEALTH_DATA" | jq -r '.summary.orphaned_states // 0')
  DUPLICATES=$(echo "$HEALTH_DATA" | jq -r '.summary.duplicate_ga // 0')
  STALE=$(echo "$HEALTH_DATA" | jq -r '.summary.stale_mappings // 0')
else
  # Local mode: use SQL queries
  # Use format: value1|value2|value3|value4 for reliable parsing
  STATS=$(run_sql "
    SELECT
      (SELECT COUNT(*) FROM datapoint_mappings)::text || '|' ||
      (SELECT COUNT(DISTINCT ga) FROM datapoint_mappings)::text || '|' ||
      (SELECT COUNT(*) FROM current_state)::text || '|' ||
      (SELECT COUNT(DISTINCT ga) FROM current_state)::text
  " | tr -d ' ')

  IFS='|' read -r MAPPINGS UNIQUE_GAS STATES STATE_GAS <<< "$STATS"
fi

# Ensure variables are set
MAPPINGS=${MAPPINGS:-0}
UNIQUE_GAS=${UNIQUE_GAS:-0}
STATES=${STATES:-0}
STATE_GAS=${STATE_GAS:-0}
ORPHANED=${ORPHANED:-0}
DUPLICATES=${DUPLICATES:-0}
STALE=${STALE:-0}

echo "  Datapoint Mappings: $MAPPINGS entries"
echo "  Unique GAs (mappings): $UNIQUE_GAS"
echo "  Current States: $STATES entries"
echo "  Unique GAs (states): $STATE_GAS"
echo ""

# 2. Orphaned States Check
echo -e "${YELLOW}2. ORPHANED STATES CHECK${NC}"
echo "─────────────────────────────────────────────────────────────"

if [ "$MODE" = "api" ]; then
  # API mode: data already loaded
  if [ "$ORPHANED" -gt 0 ]; then
    echo -e "${RED}⚠️  FOUND $ORPHANED orphaned states (states without mappings)${NC}"
    echo "  Details:"
    echo "    (Use --local mode or call /api/v2/stats/health/orphaned-states for detailed list)"
  else
    echo -e "${GREEN}✓ No orphaned states found${NC}"
  fi
else
  # Local mode: SQL query
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
fi
echo ""

# 3. Duplicate GAs Check
echo -e "${YELLOW}3. DUPLICATE GROUP ADDRESSES CHECK${NC}"
echo "─────────────────────────────────────────────────────────────"

if [ "$MODE" = "api" ]; then
  # API mode: data already loaded
  if [ "$DUPLICATES" -gt 0 ]; then
    echo -e "${RED}⚠️  FOUND $DUPLICATES GAs with multiple entries${NC}"
    echo "  Top problematic GAs:"
    echo "    (Use --local mode or call /api/v2/stats/health/duplicate-gas for detailed list)"
  else
    echo -e "${GREEN}✓ All GAs are unique${NC}"
  fi
else
  # Local mode: SQL query
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
fi
echo ""

# 4. Stale Mappings Check
echo -e "${YELLOW}4. STALE MAPPINGS CHECK${NC}"
echo "─────────────────────────────────────────────────────────────"

if [ "$MODE" = "api" ]; then
  # API mode: data already loaded
  if [ "$STALE" -gt 0 ]; then
    echo -e "${YELLOW}ℹ️  Found $STALE mappings without current state${NC}"
    echo "  (These are old/unused entries, can be cleaned up)"
  else
    echo -e "${GREEN}✓ All mappings have current states${NC}"
  fi
else
  # Local mode: SQL query
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
fi
echo ""

# 5. Backup (if requested)
if [ "$DO_BACKUP" = true ]; then
  if [ "$MODE" = "api" ]; then
    echo -e "${RED}❌ Backup is only available in --local mode${NC}"
    exit 1
  fi

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
  if [ "$MODE" = "api" ]; then
    echo -e "${RED}❌ Cleanup is only available in --local mode${NC}"
    exit 1
  fi

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
  if [ "$MODE" = "local" ]; then
    echo "  Run with --cleanup to fix:"
    echo "    ./scripts/db-health-check.sh --cleanup --backup"
  else
    echo "  ℹ️  Use --local mode to perform cleanup operations"
  fi
fi
echo "═══════════════════════════════════════════════════════════════"

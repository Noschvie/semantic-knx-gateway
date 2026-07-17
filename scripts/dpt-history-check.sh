#!/usr/bin/env bash
# DPT Change History Diagnostics
# Usage: ./scripts/dpt-history-check.sh [--log] [--stats]

set -e

# Configuration
DB_CONTAINER="${DB_CONTAINER:-timescaledb}"
DB_USER="${POSTGRES_USERNAME:-knxuser}"
DB_NAME="${POSTGRES_DB:-knxdb}"

# Colors
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

# Flags
SHOW_LOG=false
SHOW_STATS=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --log)   SHOW_LOG=true; shift ;;
    --stats) SHOW_STATS=true; shift ;;
    *) shift ;;
  esac
done

echo "═══════════════════════════════════════════════════════════════"
echo "🔍 DPT Change History – Diagnostic Report"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# Function to run SQL
run_sql() {
  docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tc "$1" 2>/dev/null || echo ""
}

# 1. Check if DPT History table exists
echo -e "${YELLOW}1. TABLE STATUS${NC}"
echo "─────────────────────────────────────────────────────────────"

TABLE_EXISTS=$(run_sql "
  SELECT 1 FROM information_schema.tables
  WHERE table_name = 'dpt_change_log'
")

if [ -z "$TABLE_EXISTS" ]; then
  echo -e "${RED}❌ dpt_change_log table does not exist${NC}"
  echo "   Run migration first:"
  echo "   docker compose exec -T semantic-knx-runtime npm run migrate"
  exit 1
else
  echo -e "${GREEN}✓ dpt_change_log table exists${NC}"
fi
echo ""

# 2. Statistics
echo -e "${YELLOW}2. HISTORY STATISTICS${NC}"
echo "─────────────────────────────────────────────────────────────"

STATS=$(run_sql "
  SELECT
    COUNT(*) as total_changes,
    COUNT(DISTINCT ga) as unique_gas,
    COUNT(DISTINCT datapoint_id) as unique_datapoints,
    MAX(changed_at) as last_change
  FROM dpt_change_log
")

echo "$STATS" | awk '{
  print "  Total DPT changes: " $1
  print "  Unique GAs affected: " $2
  print "  Unique Datapoints affected: " $3
  print "  Last change: " $4
}'

if [ "$SHOW_STATS" = true ]; then
  echo ""
  echo "  Top GAs with most changes:"
  run_sql "
    SELECT
      '    ' || ga || ': ' || COUNT(*) || ' changes'
    FROM dpt_change_log
    GROUP BY ga
    ORDER BY COUNT(*) DESC
    LIMIT 5
  "
fi
echo ""

# 3. Detect Current DPT Mismatches
echo -e "${YELLOW}3. DPT CONSISTENCY CHECK${NC}"
echo "─────────────────────────────────────────────────────────────"

MISMATCH=$(run_sql "
  SELECT COUNT(*)
  FROM datapoint_mappings m
  WHERE EXISTS (
    SELECT 1 FROM dpt_change_log log
    WHERE log.datapoint_id = m.datapoint_id
      AND log.new_dpt != m.dpt
  )
")

if [ -z "$MISMATCH" ] || [ "$MISMATCH" -eq 0 ]; then
  echo -e "${GREEN}✓ All mappings match latest DPT changes${NC}"
else
  echo -e "${YELLOW}⚠️  $MISMATCH datapoints have DPT mismatches${NC}"
  echo ""
  echo "  Affected datapoints:"
  run_sql "
    SELECT
      '    ' || m.ga || ' (ID ' || m.datapoint_id || '): ' ||
      'mapped=' || m.dpt || ' vs changed_to=' ||
      (SELECT new_dpt FROM dpt_change_log WHERE datapoint_id = m.datapoint_id
       ORDER BY changed_at DESC LIMIT 1)
    FROM datapoint_mappings m
    WHERE EXISTS (
      SELECT 1 FROM dpt_change_log log
      WHERE log.datapoint_id = m.datapoint_id
        AND log.new_dpt != m.dpt
    )
    LIMIT 10
  "
fi
echo ""

# 4. Historical View
if [ "$SHOW_LOG" = true ]; then
  echo -e "${YELLOW}4. RECENT CHANGES${NC}"
  echo "─────────────────────────────────────────────────────────────"

  run_sql "
    SELECT
      TO_CHAR(changed_at, 'YYYY-MM-DD HH:MM:SS') || ' | ' ||
      ga || ' | ' ||
      COALESCE(old_dpt, 'NEW') || ' → ' || new_dpt || ' | ' ||
      changed_by ||
      CASE WHEN reason IS NOT NULL THEN ' (' || reason || ')' ELSE '' END
    FROM dpt_change_log
    ORDER BY changed_at DESC
    LIMIT 20
  " | while IFS= read -r line; do
    echo "  $line"
  done
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo -e "${GREEN}Report complete.${NC} Run with --log to see full history."
echo "═══════════════════════════════════════════════════════════════"

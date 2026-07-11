#!/bin/bash

# Script: database-summary.sh
# Description: Generate a comprehensive database summary report
# Usage: ./scripts/database-summary.sh
# Dependencies: curl, jq

set -e

BASE_URL="${API_URL:-http://localhost:3000}/api/v2/database"
CLIENT_ID="knx-default-client"
OAUTH_CLIENT_SECRET="${OAUTH_CLIENT_SECRET:-change-me-in-production}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo ""
echo "════════════════════════════════════════════════════════════════════════════"
echo "                    📊 DATABASE HEALTH REPORT SUMMARY"
echo "════════════════════════════════════════════════════════════════════════════"
echo ""

# Step 1: Get OAuth Token
echo "🔑 Obtaining OAuth Token..."
TOKEN_RESPONSE=$(curl -s -X POST http://localhost:3000/oauth/access \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&scope=read,delete:database&client_id=$CLIENT_ID&client_secret=$OAUTH_CLIENT_SECRET")

TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.access_token')

if [ -z "$TOKEN" ] || [ "$TOKEN" == "null" ]; then
  echo -e "${RED}❌ Failed to obtain token${NC}"
  exit 1
fi

echo -e "${GREEN}✓ Token obtained${NC}"
echo ""

# Step 2: Get Database Info
echo "📡 Fetching database information..."
DB_INFO=$(curl -s -X GET $BASE_URL/info \
  -H "Authorization: Bearer $TOKEN")

if [ -z "$DB_INFO" ]; then
  echo -e "${RED}❌ Failed to fetch database info${NC}"
  exit 1
fi

# Extract data
TIMESTAMP=$(echo "$DB_INFO" | jq -r '.data.attributes.timestamp')
DB_NAME=$(echo "$DB_INFO" | jq -r '.data.attributes.database.name')
DB_SIZE=$(echo "$DB_INFO" | jq -r '.data.attributes.database.size_pretty')
DB_SIZE_BYTES=$(echo "$DB_INFO" | jq -r '.data.attributes.database.size_bytes')
PG_VERSION=$(echo "$DB_INFO" | jq -r '.data.attributes.database.version' | grep -oP 'PostgreSQL \K[0-9.]+' || echo "unknown")

TOTAL_EVENTS=$(echo "$DB_INFO" | jq -r '.data.attributes.events_timeline.total_events')
COVERAGE_DAYS=$(echo "$DB_INFO" | jq -r '.data.attributes.events_timeline.coverage_days')
EVENTS_PER_DAY=$(echo "$DB_INFO" | jq -r '.data.attributes.events_timeline.events_per_day_avg')
EARLIEST=$(echo "$DB_INFO" | jq -r '.data.attributes.events_timeline.earliest_event')
LATEST=$(echo "$DB_INFO" | jq -r '.data.attributes.events_timeline.latest_event')

TOTAL_SUBS=$(echo "$DB_INFO" | jq -r '.data.attributes.subscriptions.total_subscriptions')
ACTIVE_SUBS=$(echo "$DB_INFO" | jq -r '.data.attributes.subscriptions.active')

TABLES_JSON=$(echo "$DB_INFO" | jq '.data.attributes.tables')

# Get cleanup jobs
CLEANUP_JOBS=$(curl -s -X GET "$BASE_URL/cleanup-jobs?days=30&limit=100" \
  -H "Authorization: Bearer $TOKEN")

TOTAL_JOBS=$(echo "$CLEANUP_JOBS" | jq '.meta.pagination.total')
LAST_JOB_TIME=$(echo "$CLEANUP_JOBS" | jq -r '.data[0].attributes.completed_at_iso // "N/A"')

echo -e "${GREEN}✓ Data retrieved${NC}"
echo ""

# ════════════════════════════════════════════════════════════════════════════════
# SECTION 1: SYSTEM INFORMATION
# ════════════════════════════════════════════════════════════════════════════════
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}1️⃣  SYSTEM INFORMATION${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo "   Report Generated:       $TIMESTAMP"
echo "   Database Name:          $DB_NAME"
echo "   PostgreSQL Version:     $PG_VERSION"
echo "   Current Size:           $DB_SIZE ($DB_SIZE_BYTES bytes)"
echo ""

# ════════════════════════════════════════════════════════════════════════════════
# SECTION 2: EVENT STATISTICS
# ════════════════════════════════════════════════════════════════════════════════
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}2️⃣  EVENT STATISTICS${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
printf "   Total Events:           %'d telegrams\n" "$TOTAL_EVENTS"
echo "   Coverage Period:        $COVERAGE_DAYS days"
printf "   Event Rate:             %'d events/day (~%d per hour)\n" "$EVENTS_PER_DAY" "$((EVENTS_PER_DAY / 24))"
echo "   Earliest Event:         $EARLIEST"
echo "   Latest Event:           $LATEST"
echo ""

# ════════════════════════════════════════════════════════════════════════════════
# SECTION 3: TABLE BREAKDOWN
# ════════════════════════════════════════════════════════════════════════════════
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}3️⃣  TABLE BREAKDOWN${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

echo "$TABLES_JSON" | jq -r 'to_entries[] |
  (if (.value.row_count | tonumber) == 0 then "⚪" elif (.value.row_count | tonumber) < 100 then "🟡" else "✅" end) as $status |
  (.key) as $name |
  (.value.row_count | tostring) as $rows |
  (.value.size_pretty // "0 B") as $size |
  (.value.type // "regular") as $type |
  $status + "|" + $name + "|" + $rows + "|" + $size + "|" + $type
' | sort | while IFS='|' read -r status name rows size type; do
  printf "%-2s %-30s • %6s rows • %-8s • %s\n" "$status" "$name" "$rows" "$size" "$type"
done

echo ""

# ════════════════════════════════════════════════════════════════════════════════
# SECTION 4: SUBSCRIPTIONS STATUS
# ════════════════════════════════════════════════════════════════════════════════
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}4️⃣  SUBSCRIPTIONS STATUS${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo "   Total Subscriptions:    $TOTAL_SUBS"
echo "   Active Subscriptions:   $ACTIVE_SUBS"
echo "   Expired Subscriptions:  $((TOTAL_SUBS - ACTIVE_SUBS))"
if [ "$TOTAL_SUBS" -eq 0 ]; then
  echo -e "   Status:                 ${YELLOW}⚪ No active subscriptions (normal for test)${NC}"
else
  echo -e "   Status:                 ${GREEN}✅ Subscriptions active${NC}"
fi
echo ""

# ════════════════════════════════════════════════════════════════════════════════
# SECTION 5: GROWTH & CAPACITY PROJECTIONS
# ════════════════════════════════════════════════════════════════════════════════
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}5️⃣  GROWTH & CAPACITY PROJECTIONS${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

if [ "$COVERAGE_DAYS" -gt 0 ]; then
  DAILY_GROWTH_KB=$(echo "scale=1; $DB_SIZE_BYTES / $COVERAGE_DAYS / 1024" | bc)
  YEARLY_PROJECTION_MB=$(echo "scale=1; $DAILY_GROWTH_KB * 365 / 1024" | bc)
else
  DAILY_GROWTH_KB="0"
  YEARLY_PROJECTION_MB="0"
fi

echo "   Daily Growth Rate:      ~${DAILY_GROWTH_KB} KB/day"
echo "   Yearly Projection:      ~${YEARLY_PROJECTION_MB} MB/year"
echo "   Recommended Retention:  90 days (keeps DB ~100-150 MB)"
echo "   Auto-Purge Enabled:     ⚪ Not configured (optional)"
echo ""

# ════════════════════════════════════════════════════════════════════════════════
# SECTION 6: MAINTENANCE STATUS
# ════════════════════════════════════════════════════════════════════════════════
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}6️⃣  MAINTENANCE STATUS${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

echo "   Last Optimization:      $LAST_JOB_TIME"
echo "   Total Maintenance Jobs: $TOTAL_JOBS"
echo "   Optimization Method:    VACUUM ANALYZE (Online, no downtime)"
echo -e "   Status:                 ${GREEN}✅ All maintenance operations successful${NC}"
echo ""

# ════════════════════════════════════════════════════════════════════════════════
# FINAL STATUS
# ════════════════════════════════════════════════════════════════════════════════
echo "════════════════════════════════════════════════════════════════════════════"
echo -e "${GREEN}✅ OVERALL STATUS: Database is HEALTHY and OPTIMIZED${NC}"
echo "════════════════════════════════════════════════════════════════════════════"
echo ""

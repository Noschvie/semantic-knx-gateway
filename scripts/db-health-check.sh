#!/usr/bin/env bash

# Script: db-health-check.sh
# Description: Diagnose and fix database integrity issues via REST API
# Usage: ./scripts/db-health-check.sh [--cleanup] [--list-orphaned] [--list-duplicates] [--list-stale]
#
# This script is specialized for diagnosis and automated cleanup of data integrity issues.
# It uses the REST API for consistency and integrates with the monitoring endpoints.
#
# Examples:
#   ./scripts/db-health-check.sh              # Just diagnose
#   ./scripts/db-health-check.sh --list-orphaned  # Show details
#   ./scripts/db-health-check.sh --cleanup        # Auto-fix issues
#   ./scripts/db-health-check.sh --list-orphaned --list-stale  # Multiple details

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
API_BASE="${API_URL:-http://localhost:3000}"
CLIENT_ID="knx-default-client"
OAUTH_CLIENT_SECRET="${OAUTH_CLIENT_SECRET:-change-me-in-production}"

# Flags
DO_CLEANUP=false
LIST_ORPHANED=false
LIST_DUPLICATES=false
LIST_STALE=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --cleanup) DO_CLEANUP=true; shift ;;
    --list-orphaned) LIST_ORPHANED=true; shift ;;
    --list-duplicates) LIST_DUPLICATES=true; shift ;;
    --list-stale) LIST_STALE=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo ""
echo "═══════════════════════════════════════════════════════════════════════════"
echo "🔍 DATABASE HEALTH CHECK & DIAGNOSTIC – Semantic KNX Gateway"
echo "═══════════════════════════════════════════════════════════════════════════"
echo ""

# Step 1: Get OAuth Token
echo "🔑 Obtaining OAuth Token..."
TOKEN_RESPONSE=$(curl -s -X POST "$API_BASE/oauth/access" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&scope=read,delete:database&client_id=$CLIENT_ID&client_secret=$OAUTH_CLIENT_SECRET")

TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.access_token // empty')

if [ -z "$TOKEN" ]; then
  echo -e "${RED}❌ Failed to obtain OAuth token${NC}"
  exit 1
fi

echo -e "${GREEN}✓ Token obtained${NC}"
echo ""

# Step 2: Get Health Checks
echo "📡 Fetching health checks from API..."
HEALTH_RESPONSE=$(curl -s -X GET "$API_BASE/api/v2/stats/health/db-checks" \
  -H "Authorization: Bearer $TOKEN")

if [ -z "$HEALTH_RESPONSE" ]; then
  echo -e "${RED}❌ Failed to fetch health checks${NC}"
  exit 1
fi

echo -e "${GREEN}✓ Health checks retrieved${NC}"
echo ""

# Extract data with null defaults
HEALTH_STATUS=$(echo "$HEALTH_RESPONSE" | jq -r '.status // "UNKNOWN"')
ORPHANED_COUNT=$(echo "$HEALTH_RESPONSE" | jq -r '.checks.orphaned_states.orphaned_count // 0')
ORPHANED_GAS=$(echo "$HEALTH_RESPONSE" | jq -r '.checks.orphaned_states.affected_gas // 0')
DUPLICATE_GAS=$(echo "$HEALTH_RESPONSE" | jq -r '.checks.duplicate_ga.duplicate_ga_count // 0')
STALE_COUNT=$(echo "$HEALTH_RESPONSE" | jq -r '.checks.stale_mappings.stale_count // 0')
DATA_INTEGRITY_SCORE=$(echo "$HEALTH_RESPONSE" | jq -r '.summary.data_integrity_score // 0')

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 1: HEALTH CHECK SUMMARY
# ═══════════════════════════════════════════════════════════════════════════════
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}📊 HEALTH CHECK SUMMARY${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Determine status indicators
ORPHANED_COUNT=${ORPHANED_COUNT//[!0-9]/}  # Remove non-numeric chars
DUPLICATE_GAS=${DUPLICATE_GAS//[!0-9]/}
STALE_COUNT=${STALE_COUNT//[!0-9]/}
ORPHANED_GAS=${ORPHANED_GAS//[!0-9]/}
ORPHANED_COUNT=${ORPHANED_COUNT:-0}  # Default to 0 if empty
DUPLICATE_GAS=${DUPLICATE_GAS:-0}
STALE_COUNT=${STALE_COUNT:-0}
ORPHANED_GAS=${ORPHANED_GAS:-0}

if [ "$ORPHANED_COUNT" -eq 0 ]; then
  ORPHANED_STATUS="${GREEN}✓${NC}"
else
  ORPHANED_STATUS="${YELLOW}⚠️${NC}"
fi

if [ "$DUPLICATE_GAS" -eq 0 ]; then
  DUPLICATE_STATUS="${GREEN}✓${NC}"
else
  DUPLICATE_STATUS="${RED}⚠️${NC}"
fi

if [ "$STALE_COUNT" -eq 0 ]; then
  STALE_STATUS="${GREEN}✓${NC}"
else
  STALE_STATUS="${YELLOW}⚠️${NC}"
fi

echo -e "   ${ORPHANED_STATUS} Orphaned States Check"
printf "      └─ %d orphaned states (%d GAs affected)\n" "$ORPHANED_COUNT" "$ORPHANED_GAS"

echo ""
echo -e "   ${DUPLICATE_STATUS} Duplicate Group Addresses Check"
printf "      └─ %d duplicate GAs found (DATA CORRUPTION RISK!)\n" "$DUPLICATE_GAS"

echo ""
echo -e "   ${STALE_STATUS} Stale Mappings Check"
printf "      └─ %d stale mappings (unused, can be cleaned)\n" "$STALE_COUNT"

echo ""
echo "   Data Integrity Score:   $DATA_INTEGRITY_SCORE%"

if [ "$HEALTH_STATUS" = "HEALTHY" ]; then
  echo -e "   Overall Status:         ${GREEN}✅ HEALTHY${NC}"
else
  echo -e "   Overall Status:         ${YELLOW}⚠️ WARNING${NC}"
fi

echo ""

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 2: DETAILED INFORMATION (if requested)
# ═══════════════════════════════════════════════════════════════════════════════

if [ "$LIST_ORPHANED" = true ]; then
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BLUE}📋 DETAILED ORPHANED STATES (up to 50)${NC}"
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""

  ORPHANED_DETAILS=$(curl -s -X GET "$API_BASE/api/v2/stats/health/orphaned-states?limit=50" \
    -H "Authorization: Bearer $TOKEN")

  echo "$ORPHANED_DETAILS" | jq -r '.states[] |
    "   • GA: \(.ga) (DPT: \(.dpt))\n" +
    "     ID: \(.datapointId) | Source: \(.source) | Value: \(.value)\n" +
    "     Last Update: \(.lastUpdate)\n"'

  echo ""
fi

if [ "$LIST_DUPLICATES" = true ]; then
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BLUE}🚨 DETAILED DUPLICATE GROUP ADDRESSES${NC}"
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""

  if [ "$DUPLICATE_GAS" -eq 0 ]; then
    echo -e "   ${GREEN}✓ No duplicate GAs found${NC}"
  else
    DUPLICATE_DETAILS=$(curl -s -X GET "$API_BASE/api/v2/stats/health/duplicate-gas" \
      -H "Authorization: Bearer $TOKEN")

    echo "$DUPLICATE_DETAILS" | jq -r '.duplicates[] |
      "   • GA: \(.ga) (\(.mappingCount) mappings, \(.dptCount) DPT types)\n" +
      "     DPTs: \(.dpts)\n" +
      "     Names: \(.names)\n" +
      "     Devices: \(.deviceIds)\n"'
  fi

  echo ""
fi

if [ "$LIST_STALE" = true ]; then
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BLUE}📭 DETAILED STALE MAPPINGS (up to 50)${NC}"
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""

  STALE_DETAILS=$(curl -s -X GET "$API_BASE/api/v2/stats/health/stale-mappings?limit=50" \
    -H "Authorization: Bearer $TOKEN")

  echo "$STALE_DETAILS" | jq -r '.mappings[] |
    "   • GA: \(.ga) (\(.dpt)) – \(.name)\n" +
    "     ID: \(.datapointId) | Device: \(.deviceId) | Has State: \(.hasState)\n"'

  echo ""
fi

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 3: CLEANUP RECOMMENDATIONS
# ═══════════════════════════════════════════════════════════════════════════════

if [ "$DO_CLEANUP" = true ]; then
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BLUE}🧹 CLEANUP OPERATIONS${NC}"
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""

  CLEANUP_NEEDED=false
  ISSUES_FOUND=""

  if [ "$DUPLICATE_GAS" -gt 0 ]; then
    echo -e "${RED}❌ Cannot auto-cleanup duplicate GAs (data corruption risk)${NC}"
    echo "   This requires manual investigation and resolution!"
    echo ""
    CLEANUP_NEEDED=true
    ISSUES_FOUND="$ISSUES_FOUND   • $DUPLICATE_GAS duplicate GAs (manual fix required)\n"
  fi

  if [ "$ORPHANED_COUNT" -gt 0 ]; then
    echo -e "${YELLOW}🧹 Would cleanup $ORPHANED_COUNT orphaned states${NC}"
    echo "   (States without corresponding datapoint mapping)"
    CLEANUP_NEEDED=true
    ISSUES_FOUND="$ISSUES_FOUND   • $ORPHANED_COUNT orphaned states (can be auto-cleaned)\n"
  fi

  if [ "$STALE_COUNT" -gt 0 ]; then
    echo -e "${YELLOW}🧹 Would cleanup $STALE_COUNT stale mappings${NC}"
    echo "   (Mappings without current state/unused)"
    CLEANUP_NEEDED=true
    ISSUES_FOUND="$ISSUES_FOUND   • $STALE_COUNT stale mappings (can be auto-cleaned)\n"
  fi

  if [ "$CLEANUP_NEEDED" = false ]; then
    echo -e "${GREEN}✓ No cleanup needed (database is clean)${NC}"
  else
    echo ""
    echo -e "${YELLOW}⚠️  To actually perform cleanup, use the REST API:${NC}"
    echo ""
    echo "   Orphaned States:"
    echo "      POST /api/v2/database/cleanup/orphaned-states"
    echo ""
    echo "   Stale Mappings:"
    echo "      POST /api/v2/database/cleanup/stale-mappings"
    echo ""
    echo "   For Duplicate GAs:"
    echo "      • Review: GET /api/v2/stats/health/duplicate-gas"
    echo "      • Manual fix required via PUT /api/v2/datapoints/{id}"
    echo ""
  fi

  echo ""
fi

# ═══════════════════════════════════════════════════════════════════════════════
# FINAL STATUS
# ═══════════════════════════════════════════════════════════════════════════════

echo "═══════════════════════════════════════════════════════════════════════════"

# Determine final status
if [ "$HEALTH_STATUS" = "HEALTHY" ] && [ "$ORPHANED_COUNT" -eq 0 ] && [ "$DUPLICATE_GAS" -eq 0 ] && [ "$STALE_COUNT" -eq 0 ]; then
  echo -e "${GREEN}✅ Database integrity: PERFECT${NC}"
  echo "   No issues detected. All data is consistent."
elif [ "$DUPLICATE_GAS" -gt 0 ]; then
  echo -e "${RED}🚨 CRITICAL: Data corruption risk detected!${NC}"
  echo "   $DUPLICATE_GAS duplicate group addresses found"
  echo "   Investigate immediately with:"
  echo "      ./scripts/db-health-check.sh --list-duplicates"
elif [ "$ORPHANED_COUNT" -gt 100 ] || [ "$STALE_COUNT" -gt 100 ]; then
  echo -e "${YELLOW}⚠️  Database has significant orphaned data${NC}"
  echo "   Consider running cleanup:"
  echo "      ./scripts/db-health-check.sh --cleanup"
elif [ "$ORPHANED_COUNT" -gt 0 ] || [ "$STALE_COUNT" -gt 0 ]; then
  echo -e "${GREEN}✅ Database is operational${NC}"
  echo "   Minor cleanup recommended (use --cleanup flag)"
else
  echo -e "${GREEN}✅ Database is operational${NC}"
fi

echo "═══════════════════════════════════════════════════════════════════════════"
echo ""

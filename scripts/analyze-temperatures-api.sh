#!/usr/bin/env bash

# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Noschvie
# KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

# analyze-temperatures-api.sh
# Temperature data analysis via REST API (KNX IoT 3rd Party API v2.1.0)
# Uses OAuth2 authentication and JSON:API responses

set -e

# Configuration
API_URL="${API_URL:-http://localhost:3000}"
KNX_IOT_API_URL="$API_URL/api/v2"
OAUTH_CLIENT="${OAUTH_CLIENT:-knx-default-client}"
OAUTH_SECRET="${OAUTH_SECRET:-change-me-in-production}"
TZ_LOCAL="${TZ:-UTC}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Functions
info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

success() {
    echo -e "${GREEN}✅ $1${NC}"
}

warn() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

error() {
    echo -e "${RED}❌ $1${NC}"
}

data_point() {
    echo -e "${CYAN}📍 $1${NC}"
}

# Check API connectivity
check_api() {
    if ! curl -sf "$API_URL/health" > /dev/null 2>&1; then
        error "API at $API_URL is not reachable!"
        exit 1
    fi
    success "API at $API_URL is reachable"
}

# Get OAuth access token
get_access_token() {
    local scope="$1"
    local response=$(curl -sf -X POST "$API_URL/oauth/access" \
        -H 'Content-Type: application/x-www-form-urlencoded' \
        -u "$OAUTH_CLIENT:$OAUTH_SECRET" \
        -d "grant_type=client_credentials&scope=$scope")

    echo "$response" | jq -r '.access_token'
}

# Make authenticated API request
api_get() {
    local endpoint="$1"
    local token="$2"
    curl -sf -H "Authorization: Bearer $token" "$endpoint"
}

# Convert UTC ISO timestamp to local time (without milliseconds)
# Portable across Linux, macOS, and Windows (Git Bash/WSL)
convert_to_local_time() {
    local utc_timestamp="$1"
    # Remove milliseconds (.XXX) and Z from timestamp
    # Input: 2026-07-14T16:26:14.369Z
    # Output: 2026-07-14 16:26:14 (in local timezone)
    local ts_clean="${utc_timestamp%.*}"  # Remove .milliseconds part

    # Try different date command variants for portability
    if date -d "$ts_clean" '+%Y-%m-%d %H:%M:%S' 2>/dev/null; then
        return 0
    elif date -jf '%Y-%m-%dT%H:%M:%S' "$ts_clean" '+%Y-%m-%d %H:%M:%S' 2>/dev/null; then
        return 0
    else
        # Fallback: use printf/awk (universally available)
        echo "$utc_timestamp" | awk -F'[T.Z]' '{printf "%s %s\n", $1, $2}'
    fi
}

# Print section header
print_header() {
    echo ""
    echo -e "${MAGENTA}════════════════════════════════════════════════════════${NC}"
    echo -e "${MAGENTA}$1${NC}"
    echo -e "${MAGENTA}════════════════════════════════════════════════════════${NC}"
    echo ""
}

# Main function
main() {
    echo ""
    echo -e "${BLUE}🌡️  TEMPERATURE DATA ANALYSIS (via REST API)${NC}"
    echo -e "${BLUE}═════════════════════════════════════════════${NC}"
    echo "API URL: $KNX_IOT_API_URL"
    echo "Timestamp: $(date)"
    echo "Local Timezone: $TZ_LOCAL"
    echo ""

    check_api

    # Get access token
    info "Authenticating with OAuth2..."
    READ_TOKEN=$(get_access_token "read")
    if [ -z "$READ_TOKEN" ] || [ "$READ_TOKEN" = "null" ]; then
        error "Failed to obtain access token!"
        exit 1
    fi
    success "Authenticated (token: ${READ_TOKEN:0:20}...)"
    echo ""

    # 1. Get all temperature datapoints (and all others for mapping)
    print_header "1️⃣  TEMPERATURE DATAPOINTS (DPT 9.001)"
    info "Fetching all datapoints from semantic model..."

    # Fetch datapoints with larger page size to get complete mapping
    TEMP_DATA=$(api_get "$KNX_IOT_API_URL/datapoints?page%5Bsize%5D=500" "$READ_TOKEN")

    # Build complete GA → title mapping (used for enriching other queries)
    GA_NAME_MAP=$(echo "$TEMP_DATA" | jq -r '.data[] | "\(.meta.ga)|\(.attributes.title // "Unknown")"')

    TEMP_DATAPOINTS=$(echo "$TEMP_DATA" | jq '.data[] |
        select(.meta.dpt == "9.001") | {
            id: .id,
            title: .attributes.title,
            ga: .meta.ga,
            value: .attributes.value,
            timestamp: .attributes.timestamp,
            dpt: .meta.dpt
        }')

    TEMP_COUNT=$(echo "$TEMP_DATAPOINTS" | jq -s 'length')
    TOTAL=$(echo "$TEMP_DATA" | jq '.meta.collection.total // "unknown"')
    echo "Found $TEMP_COUNT temperature sensors (from $TOTAL total datapoints):"
    echo ""

    echo "$TEMP_DATAPOINTS" | jq -r '.ga + " → " + .title + " (" + .value + "°C)"' | head -15

    # 2. Statistics - overall stats
    print_header "2️⃣  OVERALL STATISTICS"
    info "Fetching overall system statistics..."

    STATS=$(api_get "$KNX_IOT_API_URL/stats" "$READ_TOKEN")

    echo "$STATS" | jq '{
        total_events: .counts.events,
        total_states: .counts.states,
        database_size: .database.size,
        first_event: .eventRange.firstEvent,
        last_event: .eventRange.lastEvent
    }'

    # 3. Event statistics (last 24h)
    print_header "3️⃣  EVENT STATISTICS (LAST 24 HOURS)"
    info "Fetching event statistics for the last 24 hours..."

    EVENT_STATS=$(api_get "$KNX_IOT_API_URL/stats/events?hours=24" "$READ_TOKEN")

    echo "$EVENT_STATS" | jq '.summary'

    # 4. Top active datapoints
    print_header "4️⃣  TOP 20 ACTIVE DATAPOINTS (LAST 24 HOURS)"
    info "Ranking by activity (with enriched names)..."

    TOP_ACTIVE=$(api_get "$KNX_IOT_API_URL/stats/top-active?limit=20&hours=24" "$READ_TOKEN")

    # Display with enriched names from GA_NAME_MAP lookup
    {
        echo "GA         | Title                                      | Events  | Current Value"
        echo "-----------|--------------------------------------------|---------|--------------"
        echo "$TOP_ACTIVE" | jq -r '.datapoints[] | "\(.ga)|\(.eventCount)|\(.currentValue)"' | \
        while IFS='|' read GA EVENTS VALUE; do
            TITLE=$(echo "$GA_NAME_MAP" | grep "^$GA|" | cut -d'|' -f2- || echo "Unknown")
            printf "%-10s | %-42s | %7d | %s\n" "$GA" "$TITLE" "$EVENTS" "$VALUE"
        done
    }

    # 5. Detailed temperature datapoint timeseries
    print_header "5️⃣  TIMESERIES: MOST ACTIVE TEMPERATURE SENSOR"
    info "Showing last 50 measurements of the most active sensor..."

    # Get first temperature datapoint ID
    FIRST_TEMP_ID=$(echo "$TEMP_DATA" | jq -r '.data[] |
        select(.meta.dpt == "9.001") | .id' | head -1)

    if [ -n "$FIRST_TEMP_ID" ] && [ "$FIRST_TEMP_ID" != "null" ]; then
        FIRST_TEMP_INFO=$(api_get "$KNX_IOT_API_URL/datapoints/$FIRST_TEMP_ID" "$READ_TOKEN")

        data_point "$(echo "$FIRST_TEMP_INFO" | jq -r '.data.attributes.title') ($(echo "$FIRST_TEMP_INFO" | jq -r '.data.meta.ga'))"

        TIMESERIES=$(api_get "$KNX_IOT_API_URL/datapoints/$FIRST_TEMP_ID/timeseries?limit=50" "$READ_TOKEN")

        echo "$TIMESERIES" | jq -r '.data[] | "\(.attributes.timestamp)|\(.attributes.value)"' | \
        while IFS='|' read TIMESTAMP VALUE; do
            LOCAL_TS=$(convert_to_local_time "$TIMESTAMP")
            printf "%s | %s°C\n" "$LOCAL_TS" "$VALUE"
        done | head -20
    else
        warn "No temperature datapoints found"
    fi

    # 6. Location-based analysis
    print_header "6️⃣  TEMPERATURE DATAPOINTS BY LOCATION"
    info "Grouping temperature sensors by location..."

    LOCATIONS=$(api_get "$KNX_IOT_API_URL/locations" "$READ_TOKEN")

    LOCATION_COUNT=$(echo "$LOCATIONS" | jq '.data | length')
    echo "Total locations: $LOCATION_COUNT"
    echo ""

    # Show locations with temperature sensors
    echo "$LOCATIONS" | jq -r '.data[] |
        select(.attributes.title != null) |
        .attributes.title' | head -10

    # 7. State statistics
    print_header "7️⃣  STATE STATISTICS"
    info "Fetching current state information..."

    STATE_STATS=$(api_get "$KNX_IOT_API_URL/stats/states" "$READ_TOKEN")

    echo "$STATE_STATS" | jq '{
        total_states: .counts.states,
        by_dpt: .byDpt | length,
        by_type: .byType | length
    }'

    # 8. System info
    print_header "8️⃣  SYSTEM INFORMATION"
    info "Fetching semantic layer status..."

    INFO=$(curl -sf "$API_URL/info" | jq)

    echo "$INFO" | jq '{
        name: .name,
        version: .version,
        features: .features
    }'

    # 9. Health check
    print_header "9️⃣  HEALTH CHECK"
    info "Checking service health..."

    HEALTH=$(curl -sf "$API_URL/health")

    echo "$HEALTH" | jq '{
        status: .status,
        timestamp: .timestamp,
        semantic: .semantic
    }'

    # 10. Datapoints count by DPT
    print_header "🔟 DATAPOINT DISTRIBUTION BY DPT"
    info "Counting datapoints by their types..."

    ALL_DP=$(api_get "$KNX_IOT_API_URL/datapoints" "$READ_TOKEN")

    echo "$ALL_DP" | jq '.data | group_by(.meta.dpt) |
        map({
            dpt: .[0].meta.dpt,
            count: length
        }) |
        sort_by(.count) |
        reverse[] |
        "\(.dpt): \(.count) datapoints"' -r | head -15

    # Summary
    print_header "ANALYSIS COMPLETED"
    success "All data retrieved via REST API"
    echo "API Endpoints used:"
    echo "  • GET /api/v2/datapoints"
    echo "  • GET /api/v2/datapoints/:id/timeseries"
    echo "  • GET /api/v2/stats"
    echo "  • GET /api/v2/stats/events"
    echo "  • GET /api/v2/stats/states"
    echo "  • GET /api/v2/stats/top-active"
    echo "  • GET /api/v2/locations"
    echo "  • GET /info"
    echo "  • GET /health"
    echo ""
    echo "Next steps:"
    echo "  • Use WebSocket for real-time updates: wss://localhost:3000/messaging/ws"
    echo "  • Subscribe to changes: POST /api/v2/subscriptions"
    echo "  • Query via SQL if needed: Use analyze-temperatures.sh"
    echo ""
}

# Execution
main "$@"

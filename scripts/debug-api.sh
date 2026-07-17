#!/usr/bin/env bash

# debug-api.sh
# Debug script to check API responses

set -e

API_URL="${API_URL:-http://localhost:3000}"
KNX_IOT_API_URL="$API_URL/api/v2"
OAUTH_CLIENT="${OAUTH_CLIENT:-knx-default-client}"
OAUTH_SECRET="${OAUTH_SECRET:-change-me-in-production}"

# URL encode a string (especially for group addresses with slashes)
urlencode() {
    local string="${1}"
    echo -n "$string" | jq -sRr @uri
}

# Get OAuth access token
get_access_token() {
    local scope="$1"
    local response

    response=$(curl -sf -X POST "$API_URL/oauth/access" \
        -H 'Content-Type: application/x-www-form-urlencoded' \
        -u "$OAUTH_CLIENT:$OAUTH_SECRET" \
        -d "grant_type=client_credentials&scope=$scope") || {
        echo "Failed to fetch OAuth token"
        return 1
    }

    echo "$response" | jq -r '.access_token'
}

# Make authenticated API request with better error handling
api_get() {
    local endpoint="$1"
    local token="$2"
    local response
    local http_code

    response=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer $token" "$endpoint")
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | head -n-1)

    if [[ "$http_code" != "200" ]]; then
        echo "❌ HTTP $http_code"
        echo "$body"
        return 1
    fi

    echo "$body"
}

# Get token
READ_TOKEN=$(get_access_token "read")
echo "✓ Got token: ${READ_TOKEN:0:20}..."
echo ""

# Get first temperature datapoint
echo "=== FETCHING DATAPOINTS ==="
TEMP_DATA=$(api_get "$KNX_IOT_API_URL/datapoints?page%5Bsize%5D=500" "$READ_TOKEN")
FIRST_GA=$(echo "$TEMP_DATA" | jq -r '.data[] | select(.meta.dpt == "9.001") | .meta.ga' | head -1)
echo "First temperature GA: $FIRST_GA"
echo ""

# URL-encode the GA for the API call
ENCODED_GA=$(urlencode "$FIRST_GA")

# Test stats/datapoints endpoint
echo "=== TESTING /stats/datapoints/:ga?hours=1 ==="
echo "Endpoint (URL-encoded): $KNX_IOT_API_URL/stats/datapoints/$ENCODED_GA?hours=1"
STATS_1H=$(api_get "$KNX_IOT_API_URL/stats/datapoints/$ENCODED_GA?hours=1" "$READ_TOKEN") || {
    echo "Failed to fetch stats for $FIRST_GA"
    echo ""
    exit 1
}
echo "✓ Response received"
echo "$STATS_1H" | jq '.' 2>/dev/null || {
    echo "Response (raw):"
    echo "$STATS_1H"
}
echo ""

# Test with direct GA format (new convenience endpoint)
if [[ ! -z "$FIRST_GA" ]]; then
    echo "=== TESTING /stats/datapoints/:a/:b/:c (direct GA format) ==="
    IFS='/' read -r GA_MAIN GA_MID GA_SUB <<< "$FIRST_GA"
    DIRECT_ENDPOINT="$KNX_IOT_API_URL/stats/datapoints/$GA_MAIN/$GA_MID/$GA_SUB?hours=1"
    echo "Endpoint: $DIRECT_ENDPOINT"

    STATS_DIRECT=$(api_get "$DIRECT_ENDPOINT" "$READ_TOKEN")
    echo "✓ Response received"
    echo "$STATS_DIRECT" | jq '.' 2>/dev/null || {
        echo "Response (raw):"
        echo "$STATS_DIRECT"
    }
    echo ""
fi

# Test stats/datapoints endpoint with 24h
echo "=== TESTING /stats/datapoints/:ga?hours=24 ==="
echo "Endpoint: $KNX_IOT_API_URL/stats/datapoints/$ENCODED_GA?hours=24"
STATS_24H=$(api_get "$KNX_IOT_API_URL/stats/datapoints/$ENCODED_GA?hours=24" "$READ_TOKEN")
echo "Response:"
echo "$STATS_24H" | jq '.' 2>/dev/null || echo "Invalid JSON or error"
echo ""

# Test anomalies endpoint
echo "=== TESTING /stats/anomalies ==="
echo "Endpoint: $KNX_IOT_API_URL/stats/anomalies?dpt=9.001&delta=2.0&hours=24&limit=10"
ANOMALIES=$(api_get "$KNX_IOT_API_URL/stats/anomalies?dpt=9.001&delta=2.0&hours=24&limit=10" "$READ_TOKEN")
echo "Response:"
echo "$ANOMALIES" | jq '.' 2>/dev/null || echo "Invalid JSON or error"
echo ""

# Test null-patterns endpoint
echo "=== TESTING /stats/null-patterns ==="
echo "Endpoint: $KNX_IOT_API_URL/stats/null-patterns?dpts=9.001,9.007&hours=24"
NULL_PATTERNS=$(api_get "$KNX_IOT_API_URL/stats/null-patterns?dpts=9.001,9.007&hours=24" "$READ_TOKEN")
echo "Response:"
echo "$NULL_PATTERNS" | jq '.' 2>/dev/null || echo "Invalid JSON or error"
echo ""

# Debug section: Test with GA directly (if desired)
if [[ ! -z "$FIRST_GA" ]]; then
    echo "=== DEBUG: Testing direct GA format ==="
    echo "Testing with raw GA format (no URL encoding): $FIRST_GA"
    echo "Endpoint: $KNX_IOT_API_URL/stats/datapoints/$FIRST_GA?hours=1"
    DEBUG_RESPONSE=$(api_get "$KNX_IOT_API_URL/stats/datapoints/$FIRST_GA?hours=1" "$READ_TOKEN") || {
        echo "Failed to fetch with raw GA"
    }
    if [[ ! -z "$DEBUG_RESPONSE" ]]; then
        echo "$DEBUG_RESPONSE" | jq '.' 2>/dev/null || echo "$DEBUG_RESPONSE"
    fi
    echo ""

    # Query database directly for verification
    if command -v psql &> /dev/null; then
        echo "=== DATABASE VERIFICATION ==="
        echo "Checking if GA '$FIRST_GA' has data in database..."
        # This would require database credentials, so we'll skip for now
    fi
fi

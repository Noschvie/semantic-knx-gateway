#!/usr/bin/env bash

# test-stats-endpoint.sh
# Diagnostic script to test stats/datapoints endpoint with different GA formats

set -e

API_URL="${API_URL:-http://localhost:3000}"
KNX_IOT_API_URL="$API_URL/api/v2"
OAUTH_CLIENT="${OAUTH_CLIENT:-knx-default-client}"
OAUTH_SECRET="${OAUTH_SECRET:-change-me-in-production}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "KNX IoT API - Stats Endpoint Diagnostic"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# URL encode a string
urlencode() {
    local string="${1}"
    echo -n "$string" | jq -sRr @uri
}

# Make authenticated API request with detailed error handling
api_request() {
    local method="$1"
    local endpoint="$2"
    local token="$3"

    echo -e "${YELLOW}→ Request: $method $endpoint${NC}"

    response=$(curl -s -w "\n%{http_code}" -X "$method" \
        -H "Authorization: Bearer $token" \
        -H "Accept: application/vnd.api+json" \
        "$endpoint")

    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | head -n-1)

    if [[ "$http_code" =~ ^2[0-9]{2}$ ]]; then
        echo -e "${GREEN}✓ HTTP $http_code${NC}"
    else
        echo -e "${RED}✗ HTTP $http_code${NC}"
    fi

    echo "$body"
    echo ""

    return 0
}

# Get OAuth access token
echo -e "${YELLOW}Step 1: Obtaining OAuth token...${NC}"
TOKEN_RESPONSE=$(curl -s -X POST "$API_URL/oauth/access" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    -u "$OAUTH_CLIENT:$OAUTH_SECRET" \
    -d "grant_type=client_credentials&scope=read")

READ_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.access_token')

if [[ "$READ_TOKEN" == "null" ]] || [[ -z "$READ_TOKEN" ]]; then
    echo -e "${RED}✗ Failed to get OAuth token${NC}"
    echo "$TOKEN_RESPONSE" | jq '.' 2>/dev/null || echo "$TOKEN_RESPONSE"
    exit 1
fi

echo -e "${GREEN}✓ Got token: ${READ_TOKEN:0:20}...${NC}"
echo ""

# Fetch datapoints
echo -e "${YELLOW}Step 2: Fetching datapoints...${NC}"
DATAPOINTS=$(curl -s -H "Authorization: Bearer $READ_TOKEN" \
    "$KNX_IOT_API_URL/datapoints?page%5Bsize%5D=500")

TEMP_DATAPOINTS=$(echo "$DATAPOINTS" | jq -r '.data[] | select(.meta.dpt == "9.001") | .meta.ga' | head -5)

if [[ -z "$TEMP_DATAPOINTS" ]]; then
    echo -e "${RED}✗ No temperature datapoints (DPT 9.001) found${NC}"
    echo "Available datapoints:"
    echo "$DATAPOINTS" | jq '.data[] | {ga: .meta.ga, dpt: .meta.dpt}' 2>/dev/null | head -20
    exit 1
fi

echo -e "${GREEN}✓ Found temperature datapoints:${NC}"
echo "$TEMP_DATAPOINTS"
echo ""

# Test each GA with different endpoint formats
echo -e "${YELLOW}Step 3: Testing stats/datapoints endpoint with different GA formats...${NC}"
echo ""

FIRST_GA=$(echo "$TEMP_DATAPOINTS" | head -1)
ENCODED_GA=$(urlencode "$FIRST_GA")

echo "Testing GA: $FIRST_GA"
echo "URL-Encoded GA: $ENCODED_GA"
echo ""

# Test 1: URL-encoded GA (correct format)
echo "Test 1: URL-encoded GA (RECOMMENDED)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
api_request "GET" "$KNX_IOT_API_URL/stats/datapoints/$ENCODED_GA?hours=1" "$READ_TOKEN" | jq '.' 2>/dev/null || echo "Response (raw):" && api_request "GET" "$KNX_IOT_API_URL/stats/datapoints/$ENCODED_GA?hours=1" "$READ_TOKEN"
echo ""

# Test 2: Raw GA (this will fail - for demonstration)
echo "Test 2: Raw GA format (NOT RECOMMENDED - will fail)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
api_request "GET" "$KNX_IOT_API_URL/stats/datapoints/$FIRST_GA?hours=1" "$READ_TOKEN" | jq '.' 2>/dev/null || echo "Response (raw):" && api_request "GET" "$KNX_IOT_API_URL/stats/datapoints/$FIRST_GA?hours=1" "$READ_TOKEN"
echo ""

# Test 3: Multiple GAs
echo "Test 3: Testing all found temperature datapoints"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
while IFS= read -r ga; do
    if [[ ! -z "$ga" ]]; then
        enc_ga=$(urlencode "$ga")
        echo "Testing GA: $ga"
        response=$(curl -s -H "Authorization: Bearer $READ_TOKEN" \
            "$KNX_IOT_API_URL/stats/datapoints/$enc_ga?hours=24")

        if echo "$response" | jq -e '.errors' > /dev/null 2>&1; then
            echo -e "${RED}✗ Error:${NC}"
            echo "$response" | jq '.errors'
        elif echo "$response" | jq -e '.data.attributes.ga' > /dev/null 2>&1; then
            echo -e "${GREEN}✓ Success:${NC}"
            echo "$response" | jq '{datapointId: .data.attributes.datapointId, name: .data.attributes.name, ga: .data.attributes.ga, dpt: .data.attributes.dpt, stats_24h: .statistics.last_24h.values, period: .statistics.last_24h.period}'
        else
            echo -e "${YELLOW}? Unexpected response:${NC}"
            echo "$response" | jq '.' 2>/dev/null || echo "$response"
        fi
        echo ""
    fi
done <<< "$TEMP_DATAPOINTS"

echo -e "${YELLOW}Diagnostic complete!${NC}"
echo ""
echo "Troubleshooting tips:"
echo "1. Ensure datapoints have recent data (events in the knx_events table)"
echo "2. URL-encode GA values with slashes: 3/1/1 → 3%2F1%2F1"
echo "3. Check database connectivity: curl -H 'Authorization: Bearer $READ_TOKEN' $KNX_IOT_API_URL/stats"

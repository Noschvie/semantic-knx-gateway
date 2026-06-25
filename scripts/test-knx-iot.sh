#!/bin/bash

# chmod +x test-knx-iot.sh
# ./test-knx-iot.sh
#
# Optional: disable OAuth (local dev only): OAUTH_DISABLED=true ./test-knx-iot.sh
# Optional: override API URL:               API_URL=http://myhost:3000 ./test-knx-iot.sh
# Optional: override OAuth secret:          OAUTH_CLIENT_SECRET=mysecret ./test-knx-iot.sh
# Optional: override read GA:               KNX_TEST_GA_READ=1/1/1 ./test-knx-iot.sh
# Optional: override write GA:              KNX_TEST_GA_WRITE=1/1/1 ./test-knx-iot.sh
# Optional: skip write test:                SKIP_WRITE=true ./test-knx-iot.sh

API_URL="${API_URL:-http://localhost:3000}"
KNX_IOT="$API_URL/api/v2"
OAUTH_CLIENT_SECRET="${OAUTH_CLIENT_SECRET:-change-me-in-production}"
KNX_TEST_GA_WRITE="${KNX_TEST_GA_WRITE:-8/1/1}"

PASS=0
FAIL=0

ok()   { echo "   ✅ $1"; ((PASS++)); }
fail() { echo "   ❌ $1"; ((FAIL++)); }

check() {
  local label="$1"
  local value="$2"
  if [ -n "$value" ] && [ "$value" != "null" ]; then
    ok "$label: $value"
  else
    fail "$label"
  fi
}

echo "🧪 Testing KNX IoT API"
echo "================================"
echo "   API_URL: $API_URL"
echo ""

# ─── 0. Health & Info ────────────────────────────────────────────────────────

echo "0a. Health check..."
HEALTH=$(curl -s "$API_URL/health")
check "status" "$(echo "$HEALTH" | jq -r '.status')"
echo ""

echo "0b. System info..."
INFO=$(curl -s "$API_URL/info")
check "name"    "$(echo "$INFO" | jq -r '.name')"
check "version" "$(echo "$INFO" | jq -r '.version')"
echo ""

# ─── OAuth ───────────────────────────────────────────────────────────────────

if [ "${OAUTH_DISABLED}" = "true" ]; then
  echo "⚠️  OAuth disabled (OAUTH_DISABLED=true) – no token required"
  AUTH_READ=""
  AUTH_WRITE=""
  AUTH_MANAGE=""
  echo ""
else
  echo "🔐 Fetching OAuth tokens..."

  READ_TOKEN=$(curl -s -X POST "$API_URL/oauth/access" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    -u "knx-default-client:$OAUTH_CLIENT_SECRET" \
    -d 'grant_type=client_credentials&scope=read' | jq -r '.access_token')

  WRITE_TOKEN=$(curl -s -X POST "$API_URL/oauth/access" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    -u "knx-default-client:$OAUTH_CLIENT_SECRET" \
    -d 'grant_type=client_credentials&scope=write' | jq -r '.access_token')

  MANAGE_TOKEN=$(curl -s -X POST "$API_URL/oauth/access" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    -u "knx-default-client:$OAUTH_CLIENT_SECRET" \
    -d 'grant_type=client_credentials&scope=manage' | jq -r '.access_token')

  check "read token"   "$READ_TOKEN"
  check "write token"  "$WRITE_TOKEN"
  check "manage token" "$MANAGE_TOKEN"

  AUTH_READ="Authorization: Bearer $READ_TOKEN"
  AUTH_WRITE="Authorization: Bearer $WRITE_TOKEN"
  AUTH_MANAGE="Authorization: Bearer $MANAGE_TOKEN"
  echo ""
fi

# ─── 1. Discovery ─────────────────────────────────────────────────────────────

echo "1. Well-known discovery..."
DISCOVERY=$(curl -s "$API_URL/.well-known/knx")
check "apiVersion" "$(echo "$DISCOVERY" | jq -r '.api.version')"
echo ""

# ─── 2. Statistics ────────────────────────────────────────────────────────────

echo "2a. Stats (general)..."
STATS=$(curl -s -H "$AUTH_READ" "$KNX_IOT/stats")
check "events"  "$(echo "$STATS" | jq -r '.counts.events')"
check "db_size" "$(echo "$STATS" | jq -r '.database.size')"
echo ""

echo "2b. Stats events (last 24h)..."
STATS_EV=$(curl -s -H "$AUTH_READ" "$KNX_IOT/stats/events?hours=24")
check "total events" "$(echo "$STATS_EV" | jq -r '.summary.total // "0"')"
echo ""

echo "2c. Stats states..."
STATS_ST=$(curl -s -H "$AUTH_READ" "$KNX_IOT/stats/states")
check "state count" "$(echo "$STATS_ST" | jq -r '.count // "0"')"
echo ""

echo "2d. Top active datapoints (top 5)..."
TOP=$(curl -s -H "$AUTH_READ" "$KNX_IOT/stats/top-active?limit=5")
TOP_COUNT=$(echo "$TOP" | jq '.datapoints | length')
check "top-active result count" "$TOP_COUNT"
echo ""

# ─── 3. Installations ─────────────────────────────────────────────────────────

echo "3. Installations..."
INST_RESULT=$(curl -s -H "$AUTH_READ" "$KNX_IOT/installations")
INST_TOTAL=$(echo "$INST_RESULT" | jq '.data | length')
INST_ID=$(echo "$INST_RESULT" | jq -r '.data[0].id')
check "installation count" "$INST_TOTAL"
check "first installation id" "$INST_ID"
echo ""

# ─── 4. Datapoints ────────────────────────────────────────────────────────────

echo "4a. Datapoints (collection)..."
DP_RESULT=$(curl -s -H "$AUTH_READ" "$KNX_IOT/datapoints")
DP_TOTAL=$(echo "$DP_RESULT" | jq '.meta.collection.total')
DP_ID=$(echo "$DP_RESULT" | jq -r '.data[0].id')
DP_GA=$(echo "$DP_RESULT" | jq -r '.data[0].attributes["knx:groupAddress"]')
check "total datapoints" "$DP_TOTAL"
check "first UUID"       "$DP_ID"
check "first GA"         "$DP_GA"
echo ""

echo "4b. Single datapoint ($DP_ID)..."
DP_SINGLE=$(curl -s -H "$AUTH_READ" "$KNX_IOT/datapoints/$DP_ID")
check "title"         "$(echo "$DP_SINGLE" | jq -r '.data.attributes.title')"
check "value"         "$(echo "$DP_SINGLE" | jq -r '.data.attributes.value // "null (no value)"')"
check "valueType"     "$(echo "$DP_SINGLE" | jq -r '.data.attributes.valueType')"
check "datapointType" "$(echo "$DP_SINGLE" | jq -r '.data.attributes.datapointType[0]')"
echo ""

echo "4c. Datapoints (pagination – page 0, 10 items)..."
DP_PAGE=$(curl -s -H "$AUTH_READ" "$KNX_IOT/datapoints?page%5Bnumber%5D=0&page%5Bsize%5D=10")
check "page result count" "$(echo "$DP_PAGE" | jq '.data | length')"
echo ""

echo "4d. Datapoints filter by device ($DEV_ID)..."
DEV_ID=$(curl -s -H "$AUTH_READ" "$KNX_IOT/devices" | jq -r '.data[0].id')
DP_FILTERED=$(curl -sg --globoff -H "$AUTH_READ" "$KNX_IOT/datapoints?filter[deviceId]=$DEV_ID")
check "filtered datapoints" "$(echo "$DP_FILTERED" | jq '.meta.collection.total')"
echo ""

echo "4e. Timeseries for first datapoint..."
TS=$(curl -s -H "$AUTH_READ" "$KNX_IOT/datapoints/$DP_ID/timeseries")
TS_COUNT=$(echo "$TS" | jq '.data | length')
check "timeseries entries" "${TS_COUNT:-0}"
echo ""

echo "4f. Datapoints filter by group address..."
# KNX_TEST_GA_READ overrides the auto-selected GA (optional)
FIRST_GA="${KNX_TEST_GA_READ:-$(echo "$DP_RESULT" | jq -r '.data[] | select(.attributes["knx:groupAddress"] != null) | .attributes["knx:groupAddress"]' | head -1)}"
if [ -n "$FIRST_GA" ] && [ "$FIRST_GA" != "null" ]; then
  DP_BY_GA=$(curl -sg --globoff -H "$AUTH_READ" "$KNX_IOT/datapoints?filter[ga]=$FIRST_GA")
  DP_BY_GA_COUNT=$(echo "$DP_BY_GA" | jq '.meta.collection.total // (.data | length) // 0')
  if [ "${DP_BY_GA_COUNT}" -gt 0 ] 2>/dev/null; then
    ok "GA $FIRST_GA found via filter[ga]: $DP_BY_GA_COUNT entry/entries"
    check "GA $FIRST_GA name" "$(echo "$DP_BY_GA" | jq -r '.data[0].attributes.title // "null"')"
    check "GA $FIRST_GA UUID" "$(echo "$DP_BY_GA" | jq -r '.data[0].id // "null"')"
  else
    fail "GA $FIRST_GA not found via filter[ga]"
  fi
else
  ok "no datapoint with GA in collection – filter[ga] test skipped"
fi
echo ""

# ─── 5. Devices ───────────────────────────────────────────────────────────────

echo "5a. Devices (collection)..."
DEV_RESULT=$(curl -s -H "$AUTH_READ" "$KNX_IOT/devices")
DEV_TOTAL=$(echo "$DEV_RESULT" | jq '.meta.collection.total')
DEV_ID=$(echo "$DEV_RESULT" | jq -r '.data[0].id')
check "total devices" "$DEV_TOTAL"
check "first device id" "$DEV_ID"
echo ""

echo "5b. Single device ($DEV_ID)..."
DEV_SINGLE=$(curl -s -H "$AUTH_READ" "$KNX_IOT/devices/$DEV_ID")
check "manufacturer" "$(echo "$DEV_SINGLE" | jq -r '.data.attributes.manufacturer // "n/a"')"
check "relationships" "$(echo "$DEV_SINGLE" | jq -r '.data.relationships | keys | join(", ")')"
echo ""

# ─── 6. Locations ─────────────────────────────────────────────────────────────

echo "6a. Locations (collection)..."
LOC_RESULT=$(curl -s -H "$AUTH_READ" "$KNX_IOT/locations")
LOC_TOTAL=$(echo "$LOC_RESULT" | jq '.meta.collection.total')
LOC_ID=$(echo "$LOC_RESULT" | jq -r '.data[0].id')
check "total locations" "$LOC_TOTAL"
echo ""

echo "6b. Child locations of first entry ($LOC_ID)..."
CHILDREN=$(curl -s -H "$AUTH_READ" "$KNX_IOT/locations/$LOC_ID/childlocations")
CHILD_COUNT=$(echo "$CHILDREN" | jq '.data | length')
if [ "$CHILD_COUNT" -gt 0 ] 2>/dev/null; then
  ok "child count: $CHILD_COUNT"
  echo "$CHILDREN" | jq -r '.data[] | "      - \(.attributes.title) (\(.attributes.subtype))"'
else
  ok "child count: 0 (leaf location)"
fi
echo ""

echo "6c. Building → floors → rooms hierarchy..."
BUILDING_ID=$(curl -s -H "$AUTH_READ" "$KNX_IOT/locations" | \
  jq -r '.data[] | select(.attributes.subtype == "building") | .id' | head -1)
if [ -n "$BUILDING_ID" ] && [ "$BUILDING_ID" != "null" ]; then
  ok "building id: $BUILDING_ID"
  curl -s -H "$AUTH_READ" "$KNX_IOT/locations/$BUILDING_ID/childlocations" | \
    jq -r '.data[] | "      - \(.attributes.title) (\(.attributes.subtype))"'
else
  ok "no building subtype found (different hierarchy)"
fi
echo ""

# ─── 7. Functions ─────────────────────────────────────────────────────────────

echo "7. Functions..."
FN_RESULT=$(curl -s -H "$AUTH_READ" "$KNX_IOT/functions")
FN_TOTAL=$(echo "$FN_RESULT" | jq '.meta.collection.total')
FN_ID=$(echo "$FN_RESULT" | jq -r '.data[0].id')
check "total functions" "$FN_TOTAL"
if [ -n "$FN_ID" ] && [ "$FN_ID" != "null" ]; then
  FN_SINGLE=$(curl -s -H "$AUTH_READ" "$KNX_IOT/functions/$FN_ID")
  check "first function title" "$(echo "$FN_SINGLE" | jq -r '.data.attributes.title')"
fi
echo ""

# ─── 8. Node ──────────────────────────────────────────────────────────────────

echo "8. Node..."
NODE=$(curl -s -H "$AUTH_READ" "$KNX_IOT/node")
check "currentSubscriptions" "$(echo "$NODE" | jq -r '.data.attributes.currentSubscriptions // "0"')"
check "maxSubscriptions"     "$(echo "$NODE" | jq -r '.data.attributes.maxSubscriptions // "n/a"')"
echo ""

# ─── 9. Sites ─────────────────────────────────────────────────────────────────

echo "9. Sites..."
SITES=$(curl -s -H "$AUTH_READ" "$KNX_IOT/sites")
check "sites count" "$(echo "$SITES" | jq '.data | length')"
echo ""

# ─── 10. Events ───────────────────────────────────────────────────────────────

echo "10. Events..."
EVENTS=$(curl -s -H "$AUTH_READ" "$KNX_IOT/events")
EVENTS_COUNT=$(echo "$EVENTS" | jq '.data // .events | length')
check "events returned" "${EVENTS_COUNT:-0}"
echo ""

# ─── 11. Write datapoint (PUT) ───────────────────────────────────────────────

echo "11. Write datapoint (PUT GA $KNX_TEST_GA_WRITE – switch, value '1')..."
if [ "${SKIP_WRITE:-false}" = "true" ]; then
  echo "   ⏭️  Skipped (SKIP_WRITE=true)"
else
  PUT_GA="$KNX_TEST_GA_WRITE"
  PUT_DP_RESULT=$(curl -sg --globoff -H "$AUTH_READ" "$KNX_IOT/datapoints?filter[ga]=$PUT_GA")
  PUT_DP_ID=$(echo "$PUT_DP_RESULT" | jq -r '.data[0].id // empty')
  if [ -z "$PUT_DP_ID" ]; then
    fail "Datapoint for GA $PUT_GA not found – PUT skipped"
  else
    ok "Datapoint UUID for GA $PUT_GA: $PUT_DP_ID"
    PUT_HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$KNX_IOT/datapoints/values" \
      -H "$AUTH_WRITE" \
      -H 'Content-Type: application/vnd.api+json' \
      -d "{\"data\": [{\"id\": \"$PUT_DP_ID\", \"type\": \"datapoint\", \"attributes\": {\"value\": \"1\"}}]}")
    if [[ "$PUT_HTTP" =~ ^2 ]]; then
      ok "HTTP status: $PUT_HTTP"
    else
      fail "HTTP status (erwartet 2xx, got $PUT_HTTP)"
    fi
  fi
fi
echo ""

# ─── 12. Subscriptions (manage scope) ────────────────────────────────────────

echo "12. Subscriptions..."
SUBS=$(curl -s -H "$AUTH_MANAGE" "$KNX_IOT/subscriptions")
check "subscriptions total" "$(echo "$SUBS" | jq -r '.meta.total // (.data | length)')"
echo ""

# ─── Summary ─────────────────────────────────────────────────────────────────

echo "================================"
echo "✅ Passed: $PASS   ❌ Failed: $FAIL"
if [ "$FAIL" -eq 0 ]; then
  echo "🎉 All tests passed"
else
  echo "⚠️  $FAIL test(s) failed – please review output above"
fi

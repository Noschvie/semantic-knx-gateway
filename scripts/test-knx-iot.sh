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
#
# Enhanced test messages to distinguish between:
#   - GA exists in DB/TTL ✅
#   - GA exists BUT has NO current_state ⚠️  (clearly marked)
#   - GA missing completely ❌

API_URL="${API_URL:-http://localhost:3000}"
KNX_IOT="$API_URL/api/v2"
OAUTH_CLIENT_SECRET="${OAUTH_CLIENT_SECRET:-change-me-in-production}"
KNX_TEST_GA_WRITE="${KNX_TEST_GA_WRITE:-8/1/1}"

PASS=0
FAIL=0

ok()   { echo "   ✅ $1"; ((PASS++)); }
fail() { echo "   ❌ $1"; ((FAIL++)); }
warn() { echo "   ⚠️  $1"; }

check() {
  local label="$1"
  local value="$2"
  if [ -n "$value" ] && [ "$value" != "null" ]; then
    ok "$label: $value"
  else
    fail "$label"
  fi
}

# Check for missing current_state (GA exists but no value)
check_state() {
  local label="$1"
  local value="$2"
  if [ -n "$value" ] && [ "$value" != "null" ]; then
    ok "$label (current state): $value"
  else
    warn "$label → GA EXISTS IN DB, BUT: no current_state (value is missing)"
    ((FAIL++))
  fi
}

# ── ctime: curl wrapper with detailed timing breakdown ─────────────────────
#
# Usage:  ctime "<label>" <curl-args...>
#
# - Outputs the response body on stdout (just like curl), so existing
#   patterns like VAR=$(ctime "..." ...) or ctime "..." ... | jq ... keep
#   working unchanged.
# - The timing breakdown (DNS/Connect/TLS/TTFB/Total + HTTP status) goes to
#   stderr, so it does NOT end up in the captured variable/pipe, but is
#   still visible in the terminal.
# - Also sets CTIME_HTTP_CODE in case only the HTTP status is needed
#   (e.g. for PUT requests without JSON body evaluation). This only works
#   if ctime is called WITHOUT $(...) (otherwise it runs in a subshell and
#   the variable is lost).
ctime() {
  local label="$1"
  shift

  # curl's built-in -w format: write timing/status metadata as JSON to a
  # separate variable, while the response body goes to a temp file via -o.
  local fmt='{"http_code":%{http_code},"dns":%{time_namelookup},"connect":%{time_connect},"tls":%{time_appconnect},"ttfb":%{time_starttransfer},"total":%{time_total},"size":%{size_download}}'
  local tmp_body meta
  tmp_body=$(mktemp)

  meta=$(curl -s -o "$tmp_body" -w "$fmt" "$@")

  # Parse the metadata JSON (all curl -w time values are in seconds)
  local http_code dns connect tls ttfb total size
  http_code=$(echo "$meta" | jq -r '.http_code // "000"')
  dns=$(echo "$meta"       | jq -r '.dns // 0')
  connect=$(echo "$meta"   | jq -r '.connect // 0')
  tls=$(echo "$meta"       | jq -r '.tls // 0')
  ttfb=$(echo "$meta"      | jq -r '.ttfb // 0')
  total=$(echo "$meta"     | jq -r '.total // 0')
  size=$(echo "$meta"      | jq -r '.size // 0')

  # Convert seconds -> milliseconds for readability
  local dns_ms connect_ms tls_ms ttfb_ms total_ms
  dns_ms=$(awk -v v="$dns" 'BEGIN{printf "%.1f", v*1000}')
  connect_ms=$(awk -v v="$connect" 'BEGIN{printf "%.1f", v*1000}')
  tls_ms=$(awk -v v="$tls" 'BEGIN{printf "%.1f", v*1000}')
  ttfb_ms=$(awk -v v="$ttfb" 'BEGIN{printf "%.1f", v*1000}')
  total_ms=$(awk -v v="$total" 'BEGIN{printf "%.1f", v*1000}')

  # Flag HTTP error responses (4xx/5xx) with a warning icon
  local icon="⏱ "
  [[ "$http_code" -ge 400 ]] 2>/dev/null && icon="⏱⚠"

  # Print the timing breakdown to stderr (does not pollute stdout/pipes)
  printf "   %s [%-38s] HTTP %-3s | DNS %6sms | Conn %6sms | TLS %6sms | TTFB %7sms | Total %7sms\n" \
    "$icon" "$label" "$http_code" "$dns_ms" "$connect_ms" "$tls_ms" "$ttfb_ms" "$total_ms" >&2

  # Expose the HTTP status code for callers that don't need the JSON body
  CTIME_HTTP_CODE="$http_code"

  # Emit the response body on stdout (as curl itself would) and clean up
  cat "$tmp_body"
  rm -f "$tmp_body"
}

echo "🧪 Testing KNX IoT API"
echo "================================"
echo "   API_URL: $API_URL"
echo ""

# ─── 0. Health & Info ────────────────────────────────────────────────────────

echo "0a. Health check..."
HEALTH=$(ctime "GET /health" "$API_URL/health")
check "status" "$(echo "$HEALTH" | jq -r '.status')"
echo ""

echo "0b. System info..."
INFO=$(ctime "GET /info" "$API_URL/info")
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

  READ_TOKEN=$(ctime "POST /oauth/access (read)" -X POST "$API_URL/oauth/access" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    -u "knx-default-client:$OAUTH_CLIENT_SECRET" \
    -d 'grant_type=client_credentials&scope=read' | jq -r '.access_token')

  WRITE_TOKEN=$(ctime "POST /oauth/access (write)" -X POST "$API_URL/oauth/access" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    -u "knx-default-client:$OAUTH_CLIENT_SECRET" \
    -d 'grant_type=client_credentials&scope=write' | jq -r '.access_token')

  MANAGE_TOKEN=$(ctime "POST /oauth/access (manage)" -X POST "$API_URL/oauth/access" \
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
DISCOVERY=$(ctime "GET /.well-known/knx" "$API_URL/.well-known/knx")
check "apiVersion" "$(echo "$DISCOVERY" | jq -r '.api.version')"
echo ""

# ─── 2. Statistics ────────────────────────────────────────────────────────────

echo "2a. Stats (general)..."
STATS=$(ctime "GET /stats" -H "$AUTH_READ" "$KNX_IOT/stats")
check "events"  "$(echo "$STATS" | jq -r '.counts.events')"
check "db_size" "$(echo "$STATS" | jq -r '.database.size')"
echo ""

echo "2b. Stats events (last 24h)..."
STATS_EV=$(ctime "GET /stats/events" -H "$AUTH_READ" "$KNX_IOT/stats/events?hours=24")
check "total events" "$(echo "$STATS_EV" | jq -r '.summary.total // "0"')"
echo ""

echo "2c. Stats states..."
STATS_ST=$(ctime "GET /stats/states" -H "$AUTH_READ" "$KNX_IOT/stats/states")
STATE_COUNT=$(echo "$STATS_ST" | jq -r '.summary.total_states // "0"')
OLDEST_UPDATE=$(echo "$STATS_ST" | jq -r '.summary.oldest_update // "N/A"')
NEWEST_UPDATE=$(echo "$STATS_ST" | jq -r '.summary.newest_update // "N/A"')
if [ "$STATE_COUNT" -gt 0 ] 2>/dev/null; then
  ok "current_state records: $STATE_COUNT datapoints with active states"
  ok "  └─ oldest update: $OLDEST_UPDATE"
  ok "  └─ newest update: $NEWEST_UPDATE"
else
  warn "current_state records: 0 (no current states recorded in database)"
  ((FAIL++))
fi
echo ""

echo "2d. Top active datapoints (top 5)..."
TOP=$(ctime "GET /stats/top-active" -H "$AUTH_READ" "$KNX_IOT/stats/top-active?limit=5")
TOP_COUNT=$(echo "$TOP" | jq '.datapoints | length')
check "top-active result count" "$TOP_COUNT"
echo ""

# ─── 3. Installations ─────────────────────────────────────────────────────────

echo "3. Installations..."
INST_RESULT=$(ctime "GET /installations" -H "$AUTH_READ" "$KNX_IOT/installations")
INST_TOTAL=$(echo "$INST_RESULT" | jq '.data | length')
INST_ID=$(echo "$INST_RESULT" | jq -r '.data[0].id')
check "installation count" "$INST_TOTAL"
check "first installation id" "$INST_ID"
echo ""

# ─── 4. Datapoints ────────────────────────────────────────────────────────────

echo "4a. Datapoints (collection)..."
DP_RESULT=$(ctime "GET /datapoints" -H "$AUTH_READ" "$KNX_IOT/datapoints")
DP_TOTAL=$(echo "$DP_RESULT" | jq '.meta.collection.total')
DP_ID=$(echo "$DP_RESULT" | jq -r '.data[0].id')
DP_GA=$(echo "$DP_RESULT" | jq -r '.data[0].attributes["knx:groupAddress"]')
check "total datapoints" "$DP_TOTAL"
check "first UUID"       "$DP_ID"
check "first GA"         "$DP_GA"
echo ""

echo "4b. Single datapoint ($DP_ID)..."
DP_SINGLE=$(ctime "GET /datapoints/{id}" -H "$AUTH_READ" "$KNX_IOT/datapoints/$DP_ID")
check "title"         "$(echo "$DP_SINGLE" | jq -r '.data.attributes.title')"
check "value"         "$(echo "$DP_SINGLE" | jq -r '.data.attributes.value // "null (no value)"')"
check "valueType"     "$(echo "$DP_SINGLE" | jq -r '.data.attributes.valueType')"
DPT=$(echo "$DP_SINGLE" | jq -r '.data.attributes.datapointType[0]')
if [ -n "$DPT" ] && [ "$DPT" != "null" ]; then
  ok "datapointType: $DPT"
else
  warn "datapointType: not defined (datapoint has no DPT)"
fi

echo "4c. Datapoints (pagination – page 0, 10 items)..."
DP_PAGE=$(ctime "GET /datapoints (paged)" -H "$AUTH_READ" "$KNX_IOT/datapoints?page%5Bnumber%5D=0&page%5Bsize%5D=10")
check "page result count" "$(echo "$DP_PAGE" | jq '.data | length')"
echo ""

echo "4d. Datapoints filter by device ($DEV_ID)..."
DEV_ID=$(ctime "GET /devices (probe)" -H "$AUTH_READ" "$KNX_IOT/devices" | jq -r '.data[0].id')
DP_FILTERED=$(ctime "GET /datapoints?filter[deviceId]" -g --globoff -H "$AUTH_READ" "$KNX_IOT/datapoints?filter[deviceId]=$DEV_ID")
check "filtered datapoints" "$(echo "$DP_FILTERED" | jq '.meta.collection.total')"
echo ""

echo "4e. Timeseries for first datapoint..."
TS=$(ctime "GET /datapoints/{id}/timeseries" -H "$AUTH_READ" "$KNX_IOT/datapoints/$DP_ID/timeseries")
TS_COUNT=$(echo "$TS" | jq '.data | length')
if [ "$TS_COUNT" -gt 0 ] 2>/dev/null; then
  ok "timeseries history: $TS_COUNT entries found"
else
  warn "timeseries history: empty (no historical events recorded for this datapoint)"
  ((FAIL++))
fi
echo ""

echo "4f. Datapoints filter by group address..."
# KNX_TEST_GA_READ overrides the auto-selected GA (optional)
FIRST_GA="${KNX_TEST_GA_READ:-$(echo "$DP_RESULT" | jq -r '.data[] | select(.attributes["knx:groupAddress"] != null) | .attributes["knx:groupAddress"]' | head -1)}"
if [ -n "$FIRST_GA" ] && [ "$FIRST_GA" != "null" ]; then
  DP_BY_GA=$(ctime "GET /datapoints?filter[ga]" -g --globoff -H "$AUTH_READ" "$KNX_IOT/datapoints?filter[ga]=$FIRST_GA")
  DP_BY_GA_COUNT=$(echo "$DP_BY_GA" | jq '.meta.collection.total // (.data | length) // 0')
  if [ "${DP_BY_GA_COUNT}" -gt 0 ] 2>/dev/null; then
    ok "GA $FIRST_GA: found $DP_BY_GA_COUNT datapoint(s) in database"
    check "  └─ Name" "$(echo "$DP_BY_GA" | jq -r '.data[0].attributes.title // "null"')"
    check "  └─ UUID" "$(echo "$DP_BY_GA" | jq -r '.data[0].id // "null"')"
    # Check if current state exists
    STATE_VALUE=$(echo "$DP_BY_GA" | jq -r '.data[0].attributes.value // empty')
    if [ -n "$STATE_VALUE" ] && [ "$STATE_VALUE" != "null" ]; then
      ok "  └─ Current state (value): $STATE_VALUE"
    else
      warn "  └─ ⚠️  NO CURRENT STATE → GA exists in DB/TTL, but no current_state value recorded"
      ((FAIL++))
    fi
  else
    fail "GA $FIRST_GA not found in database"
  fi
else
  ok "no datapoint with GA in collection – filter[ga] test skipped"
fi
echo ""

# ─── 5. Devices ───────────────────────────────────────────────────────────────

echo "5a. Devices (collection)..."
DEV_RESULT=$(ctime "GET /devices" -H "$AUTH_READ" "$KNX_IOT/devices")
DEV_TOTAL=$(echo "$DEV_RESULT" | jq '.meta.collection.total')
DEV_ID=$(echo "$DEV_RESULT" | jq -r '.data[0].id')
check "total devices" "$DEV_TOTAL"
check "first device id" "$DEV_ID"
echo ""

echo "5b. Single device ($DEV_ID)..."
DEV_SINGLE=$(ctime "GET /devices/{id}" -H "$AUTH_READ" "$KNX_IOT/devices/$DEV_ID")
check "manufacturer" "$(echo "$DEV_SINGLE" | jq -r '.data.attributes.manufacturer // "n/a"')"
check "relationships" "$(echo "$DEV_SINGLE" | jq -r '.data.relationships | keys | join(", ")')"
echo ""

# ─── 6. Locations ─────────────────────────────────────────────────────────────

echo "6a. Locations (collection)..."
LOC_RESULT=$(ctime "GET /locations" -H "$AUTH_READ" "$KNX_IOT/locations")
LOC_TOTAL=$(echo "$LOC_RESULT" | jq '.meta.collection.total')
LOC_ID=$(echo "$LOC_RESULT" | jq -r '.data[0].id')
check "total locations" "$LOC_TOTAL"
echo ""

echo "6b. Child locations of first entry ($LOC_ID)..."
CHILDREN=$(ctime "GET /locations/{id}/childlocations" -H "$AUTH_READ" "$KNX_IOT/locations/$LOC_ID/childlocations")
CHILD_COUNT=$(echo "$CHILDREN" | jq '.data | length')
if [ "$CHILD_COUNT" -gt 0 ] 2>/dev/null; then
  ok "child count: $CHILD_COUNT"
  echo "$CHILDREN" | jq -r '.data[] | "      - \(.attributes.title) (\(.attributes.subtype))"'
else
  ok "child count: 0 (leaf location)"
fi
echo ""

echo "6c. Building → floors → rooms hierarchy..."
BUILDING_ID=$(ctime "GET /locations (probe building)" -H "$AUTH_READ" "$KNX_IOT/locations" | \
  jq -r '.data[] | select(.attributes.subtype == "building") | .id' | head -1)
if [ -n "$BUILDING_ID" ] && [ "$BUILDING_ID" != "null" ]; then
  ok "building id: $BUILDING_ID"
  ctime "GET /locations/{buildingId}/childlocations" -H "$AUTH_READ" "$KNX_IOT/locations/$BUILDING_ID/childlocations" | \
    jq -r '.data[] | "      - \(.attributes.title) (\(.attributes.subtype))"'
else
  ok "no building subtype found (different hierarchy)"
fi
echo ""

# ─── 7. Functions ─────────────────────────────────────────────────────────────

echo "7. Functions..."
FN_RESULT=$(ctime "GET /functions" -H "$AUTH_READ" "$KNX_IOT/functions")
FN_TOTAL=$(echo "$FN_RESULT" | jq '.meta.collection.total')
FN_ID=$(echo "$FN_RESULT" | jq -r '.data[0].id')
check "total functions" "$FN_TOTAL"
if [ -n "$FN_ID" ] && [ "$FN_ID" != "null" ]; then
  FN_SINGLE=$(ctime "GET /functions/{id}" -H "$AUTH_READ" "$KNX_IOT/functions/$FN_ID")
  check "first function title" "$(echo "$FN_SINGLE" | jq -r '.data.attributes.title')"
fi
echo ""

# ─── 8. Node ──────────────────────────────────────────────────────────────────

echo "8. Node..."
NODE=$(ctime "GET /node" -H "$AUTH_READ" "$KNX_IOT/node")
check "currentSubscriptions" "$(echo "$NODE" | jq -r '.data.attributes.currentSubscriptions // "0"')"
check "maxSubscriptions"     "$(echo "$NODE" | jq -r '.data.attributes.maxSubscriptions // "n/a"')"
echo ""

# ─── 9. Sites ─────────────────────────────────────────────────────────────────

echo "9. Sites..."
SITES=$(ctime "GET /sites" -H "$AUTH_READ" "$KNX_IOT/sites")
check "sites count" "$(echo "$SITES" | jq '.data | length')"
echo ""

# ─── 10. Events ───────────────────────────────────────────────────────────────

echo "10. Events..."
EVENTS=$(ctime "GET /events" -H "$AUTH_READ" "$KNX_IOT/events")
EVENTS_COUNT=$(echo "$EVENTS" | jq '.data // .events | length')
check "events returned" "${EVENTS_COUNT:-0}"
echo ""

# ─── 11. Write datapoint (PUT) ───────────────────────────────────────────────

echo "11. Write datapoint (PUT GA $KNX_TEST_GA_WRITE – switch, value '1')..."
if [ "${SKIP_WRITE:-false}" = "true" ]; then
  echo "   ⏭️  Skipped (SKIP_WRITE=true)"
else
  PUT_GA="$KNX_TEST_GA_WRITE"
  PUT_DP_RESULT=$(ctime "GET /datapoints?filter[ga] (PUT-Vorbereitung)" -g --globoff -H "$AUTH_READ" "$KNX_IOT/datapoints?filter[ga]=$PUT_GA")
  PUT_DP_ID=$(echo "$PUT_DP_RESULT" | jq -r '.data[0].id // empty')
  if [ -z "$PUT_DP_ID" ]; then
    fail "Datapoint for GA $PUT_GA not found – PUT skipped"
  else
    ok "Datapoint UUID for GA $PUT_GA: $PUT_DP_ID"
    ctime "PUT /datapoints/values" -X PUT "$KNX_IOT/datapoints/values" \
      -H "$AUTH_WRITE" \
      -H 'Content-Type: application/vnd.api+json' \
      -d "{\"data\": [{\"id\": \"$PUT_DP_ID\", \"type\": \"datapoint\", \"attributes\": {\"value\": \"1\"}}]}" > /dev/null
    PUT_HTTP="$CTIME_HTTP_CODE"
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
SUBS=$(ctime "GET /subscriptions" -H "$AUTH_MANAGE" "$KNX_IOT/subscriptions")
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

#!/bin/bash

# Script test-database-management-api.sh
# Test Script for Database Management API
# Tests: GET /info, GET /health, GET /cleanup-jobs, POST /purge, POST /optimize

BASE_URL="http://localhost:3000/api/v2/database"
CLIENT_ID="knx-default-client"
OAUTH_CLIENT_SECRET="${OAUTH_CLIENT_SECRET:-change-me-in-production}"

cat << 'EOF'
==========================================
Database Management API - Full Test Suite
==========================================

OPERATIONAL IMPACT:
  - GET /health         ✅ No impact (read-only)
  - GET /info           ✅ No impact (read-only)
  - GET /cleanup-jobs   ✅ No impact (read-only)
  - POST /purge         ✅ Minimal impact (row-level locks only)
  - POST /optimize      ✅ Online mode (VACUUM ANALYZE - app stays online)
  - POST /optimize FULL 🔴 DOWNTIME! (exclusive lock - app goes offline)

This test runs online mode by default. VACUUM FULL can be tested
interactively and will ask for confirmation before blocking the app.

EOF

echo ""

# Step 1: Test GET /health (no auth required)
echo "=========================================="
echo "Step 1: Testing GET /health (no auth required)"
echo "=========================================="
echo ""

curl -s -X GET $BASE_URL/health | jq '.'

echo ""
echo ""

# Step 2: Get OAuth Token with delete:database scope
echo "=========================================="
echo "Step 2: Getting OAuth Token with 'delete:database' scope"
echo "=========================================="
echo ""

TOKEN_RESPONSE=$(curl -s -X POST http://localhost:3000/oauth/access \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&scope=read,delete:database&client_id=$CLIENT_ID&client_secret=$OAUTH_CLIENT_SECRET")

echo "Token Response:"
echo "$TOKEN_RESPONSE" | jq '.'
echo ""

TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.access_token')

if [ -z "$TOKEN" ] || [ "$TOKEN" == "null" ]; then
  echo "❌ Failed to obtain token"
  exit 1
fi

echo "✅ Token obtained: ${TOKEN:0:20}..."
echo ""

# Step 3: Test GET /info
echo "=========================================="
echo "Step 3: Testing GET /info (database statistics)"
echo "=========================================="
echo ""

curl -s -X GET $BASE_URL/info \
  -H "Authorization: Bearer $TOKEN" | jq '.data.attributes | {
    timestamp,
    timestampISO,
    database,
    tables: (.tables | to_entries | map({name: .key, size_pretty: .value.size_pretty, row_count: .value.row_count}) | sort_by(.name)),
    events_timeline,
    subscriptions,
    capabilities
  }'

echo ""
echo ""

# Step 4: Test GET /cleanup-jobs (before any operations)
echo "=========================================="
echo "Step 4: Testing GET /cleanup-jobs (before operations)"
echo "=========================================="
echo ""

curl -s -X GET "$BASE_URL/cleanup-jobs?days=30&limit=20" \
  -H "Authorization: Bearer $TOKEN" | jq '.'

echo ""
echo ""

# Step 5: Test PURGE - Dry Run (Preview)
echo "=========================================="
echo "Step 5: Testing POST /purge - DRY RUN (Preview only)"
echo "=========================================="
echo ""

curl -s -X POST $BASE_URL/purge \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/vnd.api+json" \
  -d '{
    "data": {
      "type": "purge-request",
      "attributes": {
        "preset": "90_days",
        "dry_run": true,
        "confirm": false
      }
    }
  }' | jq '.'

echo ""
echo ""

# Step 6: Test PURGE - Execute without confirm (should fail)
echo "=========================================="
echo "Step 6: Testing POST /purge - Should fail (missing confirm)"
echo "=========================================="
echo ""

curl -s -X POST $BASE_URL/purge \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/vnd.api+json" \
  -d '{
    "data": {
      "type": "purge-request",
      "attributes": {
        "preset": "90_days",
        "dry_run": false,
        "confirm": false
      }
    }
  }' | jq '.'

echo ""
echo ""

# Step 7: Test OPTIMIZE - VACUUM ANALYZE (online)
echo "=========================================="
echo "Step 7: Testing POST /optimize - VACUUM ANALYZE (online)"
echo "=========================================="
echo "ℹ️  This uses VACUUM ANALYZE which runs online (app stays online)"
echo ""

OPTIMIZE_RESPONSE=$(curl -s -X POST $BASE_URL/optimize \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/vnd.api+json" \
  -d '{
    "data": {
      "type": "optimize-request",
      "attributes": {
        "full": false,
        "analyze": true
      }
    }
  }')

echo "Raw Response:"
echo "$OPTIMIZE_RESPONSE" | jq '.'

echo ""
echo "Formatted Output:"
echo "$OPTIMIZE_RESPONSE" | jq '.data | {
    id,
    type,
    status: .attributes.status,
    execution: .attributes.execution,
    results: .attributes.results
  }'

echo ""
echo ""

# Step 7b: Optional - Test OPTIMIZE with VACUUM FULL (DOWNTIME!)
echo "=========================================="
echo "Step 7b: Testing POST /optimize - VACUUM FULL (MAINTENANCE WINDOW ONLY)"
echo "=========================================="
echo ""
echo "⚠️  WARNING: VACUUM FULL requires EXCLUSIVE LOCK!"
echo "    The database and app will be OFFLINE during this operation!"
echo "    This should only be run during maintenance windows."
echo ""
read -p "Do you want to test VACUUM FULL? (y/N): " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
  echo "🔴 Starting VACUUM FULL - App will go OFFLINE!"
  echo ""
  VACUUM_FULL_RESPONSE=$(curl -s -X POST $BASE_URL/optimize \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/vnd.api+json" \
    -d '{
      "data": {
        "type": "optimize-request",
        "attributes": {
          "full": true,
          "analyze": true
        }
      }
    }')

  echo "Raw Response:"
  echo "$VACUUM_FULL_RESPONSE" | jq '.'

  echo ""
  echo "Formatted Output:"
  echo "$VACUUM_FULL_RESPONSE" | jq '.data | {
      id,
      type,
      status: .attributes.status,
      execution: .attributes.execution,
      results: .attributes.results
    }'
  echo ""
  echo "✅ VACUUM FULL completed - App is back online"
else
  echo "⏭️  Skipping VACUUM FULL (recommended for normal operation)"
fi

echo ""
echo ""

# Step 8: Get cleanup jobs to see the executed operations
echo "=========================================="
echo "Step 8: Testing GET /cleanup-jobs (after operations)"
echo "=========================================="
echo ""

curl -s -X GET "$BASE_URL/cleanup-jobs?days=1&limit=10&status=completed" \
  -H "Authorization: Bearer $TOKEN" | jq '.data[] | {
    id,
    status: .attributes.status,
    strategy: .attributes.strategy,
    created_at: .attributes.created_at,
    created_at_iso: .attributes.created_at_iso,
    completed_at: .attributes.completed_at,
    completed_at_iso: .attributes.completed_at_iso,
    duration_seconds: .attributes.duration_seconds,
    statistics: .attributes.statistics
  }'

echo ""
echo ""

# Step 9: Test GET /info again to see updated stats
echo "=========================================="
echo "Step 9: Testing GET /info again (updated statistics)"
echo "=========================================="
echo ""

curl -s -X GET $BASE_URL/info \
  -H "Authorization: Bearer $TOKEN" | jq '.data.attributes | {
    timestamp,
    timestampISO,
    database: .database,
    events_timeline,
    subscriptions
  }'

echo ""
echo "=========================================="
echo "✅ All tests completed!"
echo "=========================================="

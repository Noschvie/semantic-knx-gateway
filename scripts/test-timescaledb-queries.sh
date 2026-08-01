#!/bin/bash

# SPDX-License-Identifier: AGPL-3.0-or-later
# Test script for TimescaleDB queries via docker exec
# This script tests different query variants to find a working solution

# Das Skript mit dem korrekten Container ausführen:
# bash scripts/test-timescaledb-queries.sh timescaledb knxdb knxuser

set -e

# Configuration
CONTAINER_NAME="${1:-semantic-knx-runtime}"
DB_NAME="${2:-knxdb}"
DB_USER="${3:-knxuser}"
DB_HOST="localhost"

echo "🔍 Testing TimescaleDB queries..."
echo "Container: $CONTAINER_NAME"
echo "Database: $DB_NAME"
echo ""

# Function to execute SQL in docker container
run_sql() {
    local query="$1"
    docker exec "$CONTAINER_NAME" psql -U "$DB_USER" -d "$DB_NAME" -c "$query" 2>&1 || true
}

# Function to test if view exists
test_view_exists() {
    local schema="$1"
    local view="$2"
    echo "Testing if $schema.$view exists..."
    local result=$(run_sql "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema='$schema' AND table_name='$view');")
    echo "Result: $result"
    echo ""
}

# Function to test if table/view exists and show structure
test_view_structure() {
    local schema="$1"
    local view="$2"
    echo "Testing structure of $schema.$view..."
    run_sql "\d $schema.$view" || echo "❌ View/Table not found"
    echo ""
}

echo "================================"
echo "1️⃣  Testing View Existence"
echo "================================"
echo ""

test_view_exists "timescaledb_information" "hypertables"
test_view_exists "timescaledb_information" "chunks"
test_view_exists "timescaledb_information" "compressed_hypertable_stats"
test_view_exists "_timescaledb_catalog" "hypertable"
test_view_exists "_timescaledb_internal" "compressed_hypertable_stats"

echo "================================"
echo "2️⃣  Testing Hypertables Query"
echo "================================"
echo ""

echo "Test 1: Simple hypertables listing"
echo "---"
run_sql "SELECT table_name FROM timescaledb_information.hypertables LIMIT 5;"
echo ""

echo "Test 2: Hypertables with schema info"
echo "---"
run_sql "SELECT hypertable_schema, hypertable_name FROM timescaledb_information.hypertables LIMIT 5;"
echo ""

echo "Test 3: Hypertables with chunk count (public API only)"
echo "---"
run_sql "
SELECT
    ht.hypertable_schema,
    ht.hypertable_name AS table_name,
    count(c.chunk_name) as chunk_count,
    count(c.chunk_name) FILTER (WHERE c.is_compressed) as compressed_chunks,
    count(c.chunk_name) FILTER (WHERE NOT c.is_compressed) as uncompressed_chunks,
    min(c.range_start) as earliest_chunk,
    max(c.range_end) as latest_chunk
FROM timescaledb_information.hypertables ht
LEFT JOIN timescaledb_information.chunks c
    ON ht.hypertable_schema = c.hypertable_schema
   AND ht.hypertable_name = c.hypertable_name
GROUP BY ht.hypertable_schema, ht.hypertable_name
ORDER BY ht.hypertable_schema, ht.hypertable_name
LIMIT 5;
"
echo ""

echo "================================"
echo "3️⃣  Testing Compression Stats"
echo "================================"
echo ""

echo "Test 1: Check _timescaledb_catalog.hypertable structure"
echo "---"
run_sql "\d _timescaledb_catalog.hypertable" || echo "❌ Catalog table not available"
echo ""

echo "Test 2: Check _timescaledb_internal.compressed_hypertable_stats"
echo "---"
run_sql "\d _timescaledb_internal.compressed_hypertable_stats" || echo "❌ Internal table not available"
echo ""

echo "Test 3: Try to get compression ratio (with error handling)"
echo "---"
run_sql "
SELECT
    COALESCE(
        (SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='knx_events'),
        'N/A'
    ) as table_name,
    'N/A' as compression_ratio;
" || echo "❌ Basic query failed"
echo ""

echo "================================"
echo "4️⃣  Testing Size Functions"
echo "================================"
echo ""

echo "Test: Get table size"
echo "---"
run_sql "
SELECT
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename)) as total_size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname || '.' || tablename) DESC
LIMIT 5;
"
echo ""

echo "================================"
echo "Summary & Recommendations"
echo "================================"
echo ""
echo "✅ If Tests 2 and 3 above work, use the following in your code:"
echo ""
echo "📋 RECOMMENDED HYPERTABLES QUERY:"
cat << 'EOF'
SELECT
    ht.hypertable_schema,
    ht.hypertable_name AS table_name,
    count(c.chunk_name) as chunk_count,
    count(c.chunk_name) FILTER (WHERE c.is_compressed) as compressed_chunks,
    count(c.chunk_name) FILTER (WHERE NOT c.is_compressed) as uncompressed_chunks,
    min(c.range_start) as earliest_chunk,
    max(c.range_end) as latest_chunk
FROM timescaledb_information.hypertables ht
LEFT JOIN timescaledb_information.chunks c
    ON ht.hypertable_schema = c.hypertable_schema
   AND ht.hypertable_name = c.hypertable_name
GROUP BY ht.hypertable_schema, ht.hypertable_name
ORDER BY ht.hypertable_schema, ht.hypertable_name;
EOF
echo ""
echo "📋 RECOMMENDED COMPRESSION RATIO QUERY:"
echo "Return 'N/A' - compression stats are not reliably available in all TimescaleDB versions"
echo ""
echo "✅ Test completed!"


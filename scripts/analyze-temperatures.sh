#!/usr/bin/env bash

# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Noschvie
# KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

# analyze-temperatures.sh
# Comprehensive analysis of temperature data (DPT 9.001) from the database
# Uses TimescaleDB functions for efficient time-series queries

set -e

# Configuration
DB_CONTAINER="${DB_CONTAINER:-timescaledb}"
DB_USER="${POSTGRES_USERNAME:-knxuser}"
DB_NAME="${POSTGRES_DB:-knxdb}"

# Determine local timezone robustly:
# 1. Explicit override via TZ env var (if the caller set one)
# 2. System timezone via timedatectl (systemd) – preferred, always present
# 3. Fallback to /etc/timezone (Debian/Ubuntu)
# 4. Last resort: UTC
detect_timezone() {
    if [ -n "$TZ" ]; then
        echo "$TZ"
        return
    fi
    if command -v timedatectl >/dev/null 2>&1; then
        local tz
        tz="$(timedatectl show -p Timezone --value 2>/dev/null)"
        if [ -n "$tz" ]; then
            echo "$tz"
            return
        fi
    fi
    if [ -r /etc/timezone ]; then
        cat /etc/timezone
        return
    fi
    echo "UTC"
}

DB_TIMEZONE="${DB_TIMEZONE:-$(detect_timezone)}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
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

# Check if container is running
check_container() {
    if ! docker ps | grep -q "$DB_CONTAINER"; then
        error "Container '$DB_CONTAINER' is not running!"
        exit 1
    fi
    success "Database container '$DB_CONTAINER' is available"
}

# Execute SQL query with timezone conversion
run_query() {
    local query="$1"
    docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c "$query"
}

# Header
print_header() {
    echo ""
    echo -e "${BLUE}════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}════════════════════════════════════════════════════════${NC}"
    echo ""
}

# Helper to format timestamps: convert to local timezone AND truncate to whole seconds
# This eliminates sub-second noise in the output while keeping the date/time readable.
# Usage: ts_local <sql-expression>
ts_local() {
    echo "date_trunc('second', ($1) AT TIME ZONE '$DB_TIMEZONE')"
}

# Main function
main() {
    echo ""
    echo -e "${BLUE}🌡️  TEMPERATURE DATA ANALYSIS${NC}"
    echo -e "${BLUE}════════════════════════════════${NC}"
    echo "Timestamp: $(date)"
    echo "Local Timezone: $DB_TIMEZONE (all timestamps in this timezone, truncated to whole seconds)"
    echo ""

    check_container

    # 1. Overview: Current sensors
    print_header "1️⃣  CURRENT SENSORS (Ranking by Temperature)"
    info "Displays the 15 hottest/coldest sensors..."

    run_query "
    SELECT
        datapoint_id,
        ga,
        ROUND(value_float::numeric, 2) as temperature_celsius,
        $(ts_local ts) as last_measurement,
        ROUND(EXTRACT(EPOCH FROM (NOW() - ts))::numeric, 0)::int as seconds_old
    FROM knx_events
    WHERE dpt = '9.001'
        AND ts = (SELECT MAX(ts) FROM knx_events k2 WHERE k2.datapoint_id = knx_events.datapoint_id)
    ORDER BY value_float DESC
    LIMIT 15;
    "

    # 2. Statistics last hour
    print_header "2️⃣  STATISTICS (LAST HOUR)"
    info "Min, max, average for all temperature sensors..."

    run_query "
    SELECT
        datapoint_id,
        ga,
        COUNT(*) as measurements,
        ROUND(AVG(value_float)::numeric, 2) as average,
        ROUND(MIN(value_float)::numeric, 2) as minimum,
        ROUND(MAX(value_float)::numeric, 2) as maximum,
        ROUND((MAX(value_float) - MIN(value_float))::numeric, 2) as range
    FROM knx_events
    WHERE dpt = '9.001' AND ts > NOW() - INTERVAL '1 hour'
    GROUP BY datapoint_id, ga
    ORDER BY maximum DESC;
    "

    # 3. Most active sensors (24h)
    print_header "3️⃣  MOST ACTIVE SENSORS (24 HOURS)"
    info "Ranking by number of measurements..."

    run_query "
    SELECT
        datapoint_id,
        ga,
        COUNT(*) as measurements_24h,
        ROUND(COUNT(*) / 24.0, 1) as average_per_hour,
        $(ts_local "MIN(ts)") as first_measurement,
        $(ts_local "MAX(ts)") as last_measurement
    FROM knx_events
    WHERE dpt = '9.001' AND ts > NOW() - INTERVAL '24 hours'
    GROUP BY datapoint_id, ga
    ORDER BY measurements_24h DESC
    LIMIT 15;
    "

    # 4. Data volume and time span
    print_header "4️⃣  DATA VOLUME AND STORAGE"
    info "Overview of stored temperature data..."

    run_query "
    SELECT
        COUNT(*) as total_measurements,
        COUNT(DISTINCT datapoint_id) as unique_sensors,
        ROUND(AVG(measurements)::numeric, 1) as average_per_sensor,
        $(ts_local "MIN(oldest)") as oldest_measurement,
        $(ts_local "MAX(newest)") as newest_measurement,
        ROUND(EXTRACT(EPOCH FROM (MAX(newest) - MIN(oldest))) / 3600::numeric, 2) as time_span_hours,
        ROUND(EXTRACT(EPOCH FROM (MAX(newest) - MIN(oldest))) / 86400::numeric, 2) as time_span_days
    FROM (
        SELECT
            datapoint_id,
            COUNT(*) as measurements,
            MIN(ts) as oldest,
            MAX(ts) as newest
        FROM knx_events
        WHERE dpt = '9.001'
        GROUP BY datapoint_id
    ) sub;
    "

    # 5. Hourly aggregations (last 24h)
    print_header "5️⃣  HOURLY AGGREGATIONS (LAST 24 HOURS)"
    info "Time-bucket aggregates with TimescaleDB..."

    run_query "
    SELECT
        $(ts_local "time_bucket('1 hour', ts)") as hour,
        COUNT(*) as measurements,
        ROUND(AVG(value_float)::numeric, 2) as average,
        ROUND(MIN(value_float)::numeric, 2) as minimum,
        ROUND(MAX(value_float)::numeric, 2) as maximum,
        COUNT(DISTINCT datapoint_id) as active_sensors
    FROM knx_events
    WHERE dpt = '9.001' AND ts > NOW() - INTERVAL '24 hours'
    GROUP BY time_bucket('1 hour', ts)
    ORDER BY time_bucket('1 hour', ts) DESC;
    "

    # 6. Anomalies: Temperature jumps > 2°C
    print_header "6️⃣  ANOMALIES (TEMPERATURE JUMPS > 2°C)"
    warn "Detects unexpected temperature changes..."

    run_query "
    SELECT
        $(ts_local ts) as local_timestamp,
        datapoint_id,
        ga,
        ROUND((LAG(value_float) OVER (PARTITION BY datapoint_id ORDER BY ts))::numeric, 2) as previous,
        ROUND(value_float::numeric, 2) as current,
        ROUND((value_float - LAG(value_float) OVER (PARTITION BY datapoint_id ORDER BY ts))::numeric, 2) as difference,
        CASE
            WHEN ABS(value_float - LAG(value_float) OVER (PARTITION BY datapoint_id ORDER BY ts)) > 2
            THEN '🚨 ANOMALY'
            ELSE 'OK'
        END as status
    FROM knx_events
    WHERE dpt = '9.001' AND ts > NOW() - INTERVAL '24 hours'
    ORDER BY ts DESC
    LIMIT 50;
    " || warn "No anomalies found or query error"

    # 6b. NULL value analysis: temporal and spatial patterns
    print_header "6️⃣ ᵇ NULL VALUE PATTERNS (Last 24 Hours)"
    warn "Analyzing NULL values: Are they synchronized to time boundaries or specific group addresses?"

    info "Pattern 1: NULL values by minute-of-hour (synchronized timing?)..."
    run_query "
    SELECT
        EXTRACT(MINUTE FROM ts AT TIME ZONE '$DB_TIMEZONE')::int as minute_of_hour,
        COUNT(*) as null_count,
        COUNT(DISTINCT ga) as affected_ga_count,
        STRING_AGG(DISTINCT ga, ', ' ORDER BY ga) as sample_gas
    FROM knx_events
    WHERE dpt IN ('9.001', '9.007')
      AND value_float IS NULL
      AND ts > NOW() - INTERVAL '24 hours'
    GROUP BY EXTRACT(MINUTE FROM ts AT TIME ZONE '$DB_TIMEZONE')
    ORDER BY null_count DESC
    LIMIT 15;
    "

    info "Pattern 2: Which group addresses have the most NULLs (spatial concentration)?"
    run_query "
    SELECT
        ga,
        COUNT(*) as null_count,
        COUNT(DISTINCT EXTRACT(HOUR FROM ts AT TIME ZONE '$DB_TIMEZONE')) as hours_affected,
        ROUND(100.0 * COUNT(*) / (SELECT COUNT(*) FROM knx_events WHERE dpt IN ('9.001', '9.007') AND ts > NOW() - INTERVAL '24 hours'), 2) as percent_of_all_events
    FROM knx_events
    WHERE dpt IN ('9.001', '9.007')
      AND value_float IS NULL
      AND ts > NOW() - INTERVAL '24 hours'
    GROUP BY ga
    ORDER BY null_count DESC
    LIMIT 10;
    "

    # 7. Top 10 hottest locations (Maximum values)
    print_header "7️⃣  TOP 10 HOTTEST LOCATIONS (Max Values 24h)"
    info "Hottest locations in the last 24 hours..."

    run_query "
    SELECT
        datapoint_id,
        ga,
        ROUND(MAX(value_float)::numeric, 2) as max_temperature,
        ROUND(AVG(value_float)::numeric, 2) as average,
        COUNT(*) as measurements,
        $(ts_local "MAX(ts)") as last_measurement
    FROM knx_events
    WHERE dpt = '9.001' AND ts > NOW() - INTERVAL '24 hours'
    GROUP BY datapoint_id, ga
    ORDER BY MAX(value_float) DESC
    LIMIT 10;
    "

    # 8. Top 10 coldest locations (Minimum values)
    print_header "8️⃣  TOP 10 COLDEST LOCATIONS (Min Values 24h)"
    info "Coldest locations in the last 24 hours..."

    run_query "
    SELECT
        datapoint_id,
        ga,
        ROUND(MIN(value_float)::numeric, 2) as min_temperature,
        ROUND(AVG(value_float)::numeric, 2) as average,
        COUNT(*) as measurements,
        $(ts_local "MAX(ts)") as last_measurement
    FROM knx_events
    WHERE dpt = '9.001' AND ts > NOW() - INTERVAL '24 hours'
    GROUP BY datapoint_id, ga
    ORDER BY MIN(value_float) ASC
    LIMIT 10;
    "

    # 9. Inactive sensors (no measurement > 1h)
    print_header "9️⃣  POTENTIALLY FAULTY SENSORS (No Measurement > 1h)"
    warn "Sensors that have not provided data for a long time..."

    run_query "
    SELECT
        datapoint_id,
        ga,
        $(ts_local "MAX(ts)") as last_measurement,
        ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(ts))) / 3600::numeric, 1) as hours_inactive
    FROM knx_events
    WHERE dpt = '9.001'
    GROUP BY datapoint_id, ga
    HAVING MAX(ts) < NOW() - INTERVAL '1 hour'
    ORDER BY MAX(ts) DESC;
    " || success "All sensors are active!"

    # 10. Detailed chronology of one sensor
    print_header "🔟 EXAMPLE: CHRONOLOGY OF ONE SENSOR (Last 20 Measurements)"
    info "Shows the last 20 measurements of the most active sensor..."

    run_query "
    SELECT
        $(ts_local ts) as local_timestamp,
        datapoint_id,
        ga,
        ROUND(value_float::numeric, 2) as temperature,
        source,
        ROUND(EXTRACT(EPOCH FROM (NOW() - ts))::numeric, 0)::int as seconds_old
    FROM knx_events
    WHERE dpt = '9.001'
        AND datapoint_id = (
            SELECT datapoint_id FROM knx_events
            WHERE dpt = '9.001'
            GROUP BY datapoint_id
            ORDER BY COUNT(*) DESC
            LIMIT 1
        )
    ORDER BY ts DESC
    LIMIT 20;
    "

    # Summary
    print_header "ANALYSIS COMPLETED"
    success "All temperature data has been analyzed"
    echo "Next steps:"
    echo "  • Graphical visualization: Use the REST API /api/v2/datapoints/:id/timeseries"
    echo "  • WebSocket streaming: wss://localhost:3000/messaging/ws for live updates"
    echo "  • MQTT integration: New values on knx/datapoint/GA-XXX/value"
    echo ""
}

# Execution
main "$@"

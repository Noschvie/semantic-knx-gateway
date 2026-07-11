// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import { Router } from 'express';
import { formatTimestamp } from '../../utils/timezone.js';
import { formatDPTValue } from '../../utils/dpt-formatter.js';
import { bearer } from '../middleware/oauth-bearer.js';

// ── Vendor-Extension: Statistics Endpoints ────────────────────────────────────────
// These endpoints are NOT defined in the KNX IoT spec.
// Registered under /api/v2/stats/...

function parseHours(raw, defaultVal = 24, max = 8760) {
    const n = parseInt(raw);
    return isNaN(n) ? defaultVal : Math.min(max, Math.max(1, n));
}

function parseLimit(raw, defaultVal = 20, max = 1000) {
    const n = parseInt(raw);
    return isNaN(n) ? defaultVal : Math.min(max, Math.max(1, n));
}

export function statisticsRouter(stateEngine, db) {
    const router = Router();

    // GET /api/v2/stats - Database statistics
    router.get('/', bearer('read'), async(req, res) => {
        try {
            // Count records in all tables
            const [events, states, datapoints, resources] = await Promise.all([
                db.query('SELECT COUNT(*) as count FROM knx_events'),
                db.query('SELECT COUNT(*) as count FROM current_state'),
                db.query('SELECT COUNT(*) as count FROM datapoint_mappings'),
                db.query('SELECT COUNT(*) as count FROM semantic_resources'),
            ]);

            // Get date range of events
            const eventRange = await db.query(`
                SELECT MIN(ts) as first_event, MAX(ts) as last_event
                FROM knx_events
            `);

            // Get most active group addresses (24h window)
            const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
            const topGAs = await db.query(`
                SELECT ga, COUNT(*) as event_count, MAX(ts) as last_seen
                FROM knx_events
                WHERE ts >= $1
                GROUP BY ga
                ORDER BY event_count DESC
                LIMIT 10
            `, [twentyFourHoursAgo]);

            // Get database size
            const dbSize = await db.query(`
                SELECT pg_size_pretty(pg_database_size(current_database())) as size
            `);

            const firstEvent = eventRange.rows[0]?.first_event;
            const lastEvent  = eventRange.rows[0]?.last_event;

            res.json({
                timestamp:    formatTimestamp(new Date()),
                timestampISO: new Date().toISOString(),
                counts: {
                    events:            parseInt(events.rows[0].count),
                    states:            parseInt(states.rows[0].count),
                    datapointMappings: parseInt(datapoints.rows[0].count),
                    semanticResources: parseInt(resources.rows[0].count),
                },
                eventRange: {
                    firstEvent:    formatTimestamp(firstEvent),
                    lastEvent:     formatTimestamp(lastEvent),
                    firstEventISO: firstEvent,
                    lastEventISO:  lastEvent,
                },
                topGroupAddresses: topGAs.rows.map(row => ({
                    ga:         row.ga,
                    eventCount: parseInt(row.event_count),
                    lastSeen:   formatTimestamp(row.last_seen),
                    lastSeenISO: row.last_seen,
                })),
                database: {
                    size: dbSize.rows[0].size,
                },
            });
        } catch (error) {
            res.status(500).json({ errors: [{ status: '500', title: 'Internal Server Error', detail: error.message }] });
        }
    });

    // GET /api/v2/stats/events - Event statistics
    router.get('/events', bearer('read'), async(req, res) => {
        try {
            const hours = parseHours(req.query.hours);
            const since = new Date(Date.now() - hours * 60 * 60 * 1000);

            const stats = await db.query(`
                SELECT
                    COUNT(*)                    as total_events,
                    COUNT(DISTINCT ga)          as unique_gas,
                    COUNT(DISTINCT source)      as unique_sources,
                    COUNT(DISTINCT datapoint_id) as unique_datapoints
                FROM knx_events
                WHERE ts >= $1
            `, [since]);

            // Events per hour
            const hourly = await db.query(`
                SELECT time_bucket('1 hour', ts) AS hour, COUNT(*) as count
                FROM knx_events
                WHERE ts >= $1
                GROUP BY hour
                ORDER BY hour DESC
            `, [since]);

            // Events by type
            const byType = await db.query(`
                SELECT event_type, COUNT(*) as count
                FROM knx_events
                WHERE ts >= $1
                GROUP BY event_type
            `, [since]);

            res.json({
                period: {
                    hours,
                    since:    formatTimestamp(since),
                    sinceISO: since.toISOString(),
                },
                summary: stats.rows[0],
                hourly: hourly.rows.map(row => ({
                    hour:    formatTimestamp(row.hour),
                    hourISO: row.hour,
                    count:   parseInt(row.count),
                })),
                byType: byType.rows,
            });
        } catch (error) {
            res.status(500).json({ errors: [{ status: '500', title: 'Internal Server Error', detail: error.message }] });
        }
    });

    // GET /api/v2/stats/states - Current state statistics
    router.get('/states', bearer('read'), async(req, res) => {
        try {
            const stats = await db.query(`
                SELECT
                    COUNT(*)                                    as total_states,
                    COUNT(DISTINCT ga)                          as unique_gas,
                    COUNT(DISTINCT source)                      as unique_sources,
                    COUNT(CASE WHEN dpt IS NOT NULL THEN 1 END) as states_with_dpt,
                    MIN(updated_at)                             as oldest_update,
                    MAX(updated_at)                             as newest_update
                FROM current_state
            `);

            // States by DPT
            const byDpt = await db.query(`
                SELECT COALESCE(dpt, 'unknown') as dpt, COUNT(*) as count
                FROM current_state
                GROUP BY dpt
                ORDER BY count DESC
                LIMIT 10
            `);

            const summary = stats.rows[0];
            res.json({
                summary: {
                    ...summary,
                    oldest_update:     formatTimestamp(summary.oldest_update),
                    newest_update:     formatTimestamp(summary.newest_update),
                    oldest_update_iso: summary.oldest_update,
                    newest_update_iso: summary.newest_update,
                },
                byDpt: byDpt.rows,
            });
        } catch (error) {
            res.status(500).json({ errors: [{ status: '500', title: 'Internal Server Error', detail: error.message }] });
        }
    });

    // GET /api/v2/stats/top-active - Most active datapoints
    router.get('/top-active', bearer('read'), async(req, res) => {
        try {
            const hours = parseHours(req.query.hours);
            const limit = parseLimit(req.query.limit);
            const since = new Date(Date.now() - hours * 60 * 60 * 1000);

            const active = await db.query(`
                SELECT
                    e.ga,
                    e.datapoint_id,
                    COUNT(*)       as event_count,
                    MAX(e.ts)      as last_event,
                    (
                        SELECT s.value_decoded
                        FROM current_state s
                        WHERE s.ga = e.ga
                        ORDER BY s.updated_at DESC
                        LIMIT 1
                    ) as current_value,
                    dm.name as datapoint_name,
                    dm.dpt
                FROM knx_events e
                LEFT JOIN datapoint_mappings dm ON dm.ga = e.ga
                WHERE e.ts >= $1
                GROUP BY e.ga, e.datapoint_id, dm.name, dm.dpt
                ORDER BY event_count DESC
                LIMIT $2
            `, [since, limit]);

            res.json({
                period: {
                    hours,
                    since:    formatTimestamp(since),
                    sinceISO: since.toISOString(),
                },
                datapoints: active.rows.map(row => ({
                    ga:            row.ga,
                    datapointId:   row.datapoint_id,
                    eventCount:    parseInt(row.event_count),
                    lastEvent:     formatTimestamp(row.last_event),
                    lastEventISO:  row.last_event,
                    currentValue:  formatDPTValue(row.current_value),
                    datapointName: row.datapoint_name,
                    dpt:           row.dpt,
                })),
            });
        } catch (error) {
            res.status(500).json({ errors: [{ status: '500', title: 'Internal Server Error', detail: error.message }] });
        }
    });

    // GET /api/v2/stats/health/db-checks - Complete database integrity checks
    router.get('/health/db-checks', bearer('read'), async(req, res) => {
        try {
            const now = new Date();

            // 1. ORPHANED STATES CHECK
            const orphanedStates = await db.query(`
                SELECT COUNT(*) as count, COUNT(DISTINCT ga) as affected_gas
                FROM current_state cs
                LEFT JOIN datapoint_mappings m ON cs.datapoint_id = m.datapoint_id
                WHERE m.datapoint_id IS NULL
            `);

            const orphanedCount = parseInt(orphanedStates.rows[0].count || 0);
            const orphanedGAs = parseInt(orphanedStates.rows[0].affected_gas || 0);

            // 2. DUPLICATE GROUP ADDRESSES CHECK
            const duplicateGAs = await db.query(`
                SELECT 
                    COUNT(*) as duplicate_count,
                    STRING_AGG(DISTINCT ga, ', ') as affected_gas
                FROM (
                    SELECT ga, COUNT(*) as mapping_count
                    FROM datapoint_mappings
                    GROUP BY ga
                    HAVING COUNT(*) > 1
                ) duplicates
            `);

            const duplicateMapping = duplicateGAs.rows[0];
            const duplicateCount = parseInt(duplicateMapping.duplicate_count || 0);

            // 3. STALE MAPPINGS CHECK
            const staleMappings = await db.query(`
                SELECT COUNT(*) as count
                FROM datapoint_mappings m
                LEFT JOIN current_state cs ON m.datapoint_id = cs.datapoint_id
                WHERE cs.datapoint_id IS NULL
            `);

            const staleCount = parseInt(staleMappings.rows[0].count || 0);

            // Get general statistics
            const stats = await db.query(`
                SELECT
                    (SELECT COUNT(*) FROM datapoint_mappings) as total_mappings,
                    (SELECT COUNT(DISTINCT ga) FROM datapoint_mappings) as unique_gas,
                    (SELECT COUNT(*) FROM current_state) as total_states
            `);

            const statsRow = stats.rows[0];
            const totalMappings = parseInt(statsRow.total_mappings || 0);
            const uniqueGAs = parseInt(statsRow.unique_gas || 0);
            const totalStates = parseInt(statsRow.total_states || 0);

            // Determine overall health status
            const hasIssues = orphanedCount > 0 || duplicateCount > 0 || staleCount > 0;
            const healthStatus = hasIssues ? 'WARNING' : 'HEALTHY';

            res.json({
                timestamp: formatTimestamp(now),
                timestampISO: now.toISOString(),
                status: healthStatus,
                checks: {
                    orphaned_states: {
                        check: 'ORPHANED STATES CHECK',
                        description: 'States without corresponding datapoint mapping',
                        status: orphanedCount === 0 ? '✓' : '⚠️',
                        orphaned_count: orphanedCount,
                        affected_gas: orphanedGAs,
                        severity: orphanedCount === 0 ? 'none' : (orphanedCount > 100 ? 'high' : 'medium'),
                        recommendation: orphanedCount > 0 ? 'Run cleanup-orphaned-datapoints.sql to remove orphaned states' : 'No action needed',
                    },
                    duplicate_gas: {
                        check: 'DUPLICATE GROUP ADDRESSES CHECK',
                        description: 'Group addresses with multiple datapoint mappings (data corruption risk)',
                        status: duplicateCount === 0 ? '✓' : '⚠️',
                        duplicate_ga_count: duplicateCount,
                        affected_gas: duplicateMapping.affected_gas || null,
                        severity: duplicateCount === 0 ? 'none' : 'high',
                        recommendation: duplicateCount > 0 ? 'Investigate and fix conflicting mappings manually' : 'No action needed',
                    },
                    stale_mappings: {
                        check: 'STALE MAPPINGS CHECK',
                        description: 'Datapoint mappings without current state (unused)',
                        status: staleCount === 0 ? '✓' : '⚠️',
                        stale_count: staleCount,
                        severity: staleCount === 0 ? 'none' : (staleCount > 50 ? 'high' : 'medium'),
                        recommendation: staleCount > 0 ? 'Consider removing stale mappings or check if devices are still active' : 'No action needed',
                    },
                },
                summary: {
                    total_mappings: totalMappings,
                    unique_gas: uniqueGAs,
                    total_states: totalStates,
                    orphaned_states: orphanedCount,
                    duplicate_gas: duplicateCount,
                    stale_mappings: staleCount,
                    data_integrity_score: Math.round(((totalMappings - staleCount) / Math.max(1, totalMappings)) * 100),
                },
                notes: 'Run periodic database maintenance to ensure optimal performance and data integrity',
            });
        } catch (error) {
            res.status(500).json({ errors: [{ status: '500', title: 'Internal Server Error', detail: error.message }] });
        }
    });

    // GET /api/v2/stats/health/orphaned-states - Detailed orphaned states
    router.get('/health/orphaned-states', bearer('read'), async(req, res) => {
        try {
            const limit = parseLimit(req.query.limit);

            const orphanedStates = await db.query(`
                SELECT
                    cs.datapoint_id,
                    cs.ga,
                    cs.dpt,
                    cs.updated_at,
                    cs.source,
                    cs.value_decoded
                FROM current_state cs
                LEFT JOIN datapoint_mappings m ON cs.datapoint_id = m.datapoint_id
                WHERE m.datapoint_id IS NULL
                ORDER BY cs.updated_at DESC
                LIMIT $1
            `, [limit]);

            const countResult = await db.query(`
                SELECT COUNT(*) as count
                FROM current_state cs
                LEFT JOIN datapoint_mappings m ON cs.datapoint_id = m.datapoint_id
                WHERE m.datapoint_id IS NULL
            `);

            res.json({
                timestamp: formatTimestamp(new Date()),
                total_orphaned: parseInt(countResult.rows[0].count || 0),
                limit,
                states: orphanedStates.rows.map(row => ({
                    datapointId: row.datapoint_id,
                    ga: row.ga,
                    dpt: row.dpt,
                    lastUpdate: formatTimestamp(row.updated_at),
                    lastUpdateISO: row.updated_at,
                    source: row.source,
                    value: row.value_decoded,
                })),
            });
        } catch (error) {
            res.status(500).json({ errors: [{ status: '500', title: 'Internal Server Error', detail: error.message }] });
        }
    });

    // GET /api/v2/stats/health/duplicate-gas - Detailed duplicate GA check
    router.get('/health/duplicate-gas', bearer('read'), async(req, res) => {
        try {
            const duplicates = await db.query(`
                SELECT
                    ga,
                    COUNT(*) as mapping_count,
                    COUNT(DISTINCT dpt) as dpt_count,
                    STRING_AGG(DISTINCT dpt, ', ') as dpts,
                    STRING_AGG(DISTINCT name, ' | ') as names,
                    STRING_AGG(DISTINCT device_id, ', ') as device_ids
                FROM datapoint_mappings
                GROUP BY ga
                HAVING COUNT(*) > 1
                ORDER BY COUNT(*) DESC
            `);

            const countResult = await db.query(`
                SELECT COUNT(*) as count FROM (
                    SELECT ga FROM datapoint_mappings
                    GROUP BY ga HAVING COUNT(*) > 1
                ) duplicates
            `);

            res.json({
                timestamp: formatTimestamp(new Date()),
                total_duplicate_gas: parseInt(countResult.rows[0].count || 0),
                duplicates: duplicates.rows.map(row => ({
                    ga: row.ga,
                    mappingCount: parseInt(row.mapping_count),
                    dptCount: parseInt(row.dpt_count),
                    dpts: row.dpts,
                    names: row.names,
                    deviceIds: row.device_ids,
                })),
                severity: duplicates.rows.length > 0 ? 'HIGH - Data corruption risk!' : 'OK',
            });
        } catch (error) {
            res.status(500).json({ errors: [{ status: '500', title: 'Internal Server Error', detail: error.message }] });
        }
    });

    // GET /api/v2/stats/health/stale-mappings - Detailed stale mappings
    router.get('/health/stale-mappings', bearer('read'), async(req, res) => {
        try {
            const limit = parseLimit(req.query.limit);

            const staleMappings = await db.query(`
                SELECT
                    m.datapoint_id,
                    m.ga,
                    m.dpt,
                    m.name,
                    m.device_id,
                    COALESCE(cs.updated_at, NOW() - INTERVAL '999 years') as last_state_update
                FROM datapoint_mappings m
                LEFT JOIN current_state cs ON m.datapoint_id = cs.datapoint_id
                WHERE cs.datapoint_id IS NULL
                ORDER BY m.ga
                LIMIT $1
            `, [limit]);

            const countResult = await db.query(`
                SELECT COUNT(*) as count
                FROM datapoint_mappings m
                LEFT JOIN current_state cs ON m.datapoint_id = cs.datapoint_id
                WHERE cs.datapoint_id IS NULL
            `);

            res.json({
                timestamp: formatTimestamp(new Date()),
                total_stale: parseInt(countResult.rows[0].count || 0),
                limit,
                mappings: staleMappings.rows.map(row => ({
                    datapointId: row.datapoint_id,
                    ga: row.ga,
                    dpt: row.dpt,
                    name: row.name,
                    deviceId: row.device_id,
                    hasState: row.last_state_update.getFullYear && row.last_state_update.getFullYear() > 2050 ? false : true,
                })),
            });
        } catch (error) {
            res.status(500).json({ errors: [{ status: '500', title: 'Internal Server Error', detail: error.message }] });
        }
    });

    return router;
}

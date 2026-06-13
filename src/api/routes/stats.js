// SPDX-License-Identifier: CC-BY-NC-SA-4.0
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import { Router } from 'express';
import { formatTimestamp } from '../../utils/timezone.js';
import { bearer } from '../middleware/oauth-bearer.js';

// ── Vendor-Extension: Stats Endpoints ────────────────────────────────────────
// These endpoints are NOT defined in the KNX IoT spec.
// Registered under /api/v1/stats/...

function parseHours(raw, defaultVal = 24, max = 8760) {
    const n = parseInt(raw);
    return isNaN(n) ? defaultVal : Math.min(max, Math.max(1, n));
}

function parseLimit(raw, defaultVal = 20, max = 1000) {
    const n = parseInt(raw);
    return isNaN(n) ? defaultVal : Math.min(max, Math.max(1, n));
}

export function statsRouter(stateEngine, db) {
    const router = Router();

    // GET /api/v1/stats - Database statistics
    router.get('/', bearer('read'), async (req, res) => {
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

    // GET /api/v1/stats/events - Event statistics
    router.get('/events', bearer('read'), async (req, res) => {
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

    // GET /api/v1/stats/states - Current state statistics
    router.get('/states', bearer('read'), async (req, res) => {
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

    // GET /api/v1/stats/top-active - Most active datapoints
    router.get('/top-active', bearer('read'), async (req, res) => {
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
                    currentValue:  row.current_value,
                    datapointName: row.datapoint_name,
                    dpt:           row.dpt,
                })),
            });
        } catch (error) {
            res.status(500).json({ errors: [{ status: '500', title: 'Internal Server Error', detail: error.message }] });
        }
    });

    return router;
}

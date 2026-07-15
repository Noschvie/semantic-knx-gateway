// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import { createLogger } from '../utils/logger.js';
import { formatTimestamp } from '../utils/timezone.js';

/**
 * StatisticsStore - Abstraction layer for statistics database operations
 *
 * Provides encapsulated access to:
 * - Event counts and timestamps
 * - Current state statistics
 * - Datapoint mapping statistics
 * - Semantic resource statistics
 * - Data integrity checks (orphaned states, duplicates, stale mappings)
 * - Database size and health
 */
export class StatisticsStore {
    constructor(postgresClient) {
        this.db = postgresClient;
        this.logger = createLogger('StatisticsStore');
    }

    /**
     * Get total count of events
     * @returns {Promise<number>} Total event count
     */
    async getTotalEventCount() {
        try {
            const result = await this.db.query('SELECT COUNT(*) as count FROM knx_events');
            return this.#parseInt(result.rows[0].count);
        } catch (err) {
            this.logger.error('Failed to get total event count', { error: err.message });
            return 0;
        }
    }

    /**
     * Get total count of current states
     * @returns {Promise<number>} Total state count
     */
    async getTotalStateCount() {
        try {
            const result = await this.db.query('SELECT COUNT(*) as count FROM current_state');
            return this.#parseInt(result.rows[0].count);
        } catch (err) {
            this.logger.error('Failed to get total state count', { error: err.message });
            return 0;
        }
    }

    /**
     * Get total count of datapoint mappings
     * @returns {Promise<number>} Total mapping count
     */
    async getTotalMappingCount() {
        try {
            const result = await this.db.query('SELECT COUNT(*) as count FROM datapoint_mappings');
            return this.#parseInt(result.rows[0].count);
        } catch (err) {
            this.logger.error('Failed to get total mapping count', { error: err.message });
            return 0;
        }
    }

    /**
     * Get total count of semantic resources
     * @returns {Promise<number>} Total resource count
     */
    async getTotalResourceCount() {
        try {
            const result = await this.db.query('SELECT COUNT(*) as count FROM semantic_resources');
            return this.#parseInt(result.rows[0].count);
        } catch (err) {
            this.logger.error('Failed to get total resource count', { error: err.message });
            return 0;
        }
    }

    /**
     * Get count of unique group addresses
     * @returns {Promise<number>} Unique GA count
     */
    async getUniqueGroupAddressCount() {
        try {
            const result = await this.db.query('SELECT COUNT(DISTINCT ga) as count FROM current_state');
            return this.#parseInt(result.rows[0].count);
        } catch (err) {
            this.logger.error('Failed to get unique GA count', { error: err.message });
            return 0;
        }
    }

    /**
     * Get event timeline information
     * @returns {Promise<{oldest: Date|null, latest: Date|null}>} Event timestamps
     */
    async getEventTimeline() {
        try {
            const result = await this.db.query(`
                SELECT MIN(ts) as oldest,
                       MAX(ts) as latest
                FROM knx_events
            `);
            return {
                oldest: result.rows[0]?.oldest || null,
                latest: result.rows[0]?.latest || null,
            };
        } catch (err) {
            this.logger.error('Failed to get event timeline', { error: err.message });
            return { oldest: null, latest: null };
        }
    }

    /**
     * Get database size
     * @returns {Promise<string>} Human-readable database size
     */
    async getDatabaseSize() {
        try {
            const result = await this.db.query('SELECT pg_size_pretty(pg_database_size(current_database())) as size');
            return result.rows[0]?.size || 'N/A';
        } catch (err) {
            this.logger.error('Failed to get database size', { error: err.message });
            return 'N/A';
        }
    }

    /**
     * Get top active group addresses in the given time range
     * @param {Date} startTime - Start timestamp
     * @param {number} limit - Maximum results
     * @returns {Promise<Array>} Top GAs with event counts and current values
     */
    async getTopActiveGroupAddresses(startTime, limit = 5) {
        try {
            const result = await this.db.query(`
                SELECT e.ga,
                       COUNT(*) as count,
                    MAX(e.ts) as last_seen,
                    (
                        SELECT cs.value_decoded
                        FROM current_state cs
                        WHERE cs.ga = e.ga
                        ORDER BY cs.updated_at DESC
                        LIMIT 1
                    ) as current_value
                FROM knx_events e
                WHERE e.ts >= $1
                GROUP BY e.ga
                ORDER BY count DESC
                    LIMIT $2
            `, [startTime, limit]);
            return result.rows.map(row => ({
                ga: row.ga,
                count: this.#parseInt(row.count),
                lastSeen: row.last_seen,
                currentValue: row.current_value,
            }));
        } catch (err) {
            this.logger.error('Failed to get top active group addresses', { error: err.message });
            return [];
        }
    }

    /**
     * Get count of orphaned states (states without mappings)
     * @returns {Promise<{count: number, affectedGAs: number}>} Orphaned state info
     */
    async getOrphanedStatesInfo() {
        try {
            const result = await this.db.query(`
                SELECT COUNT(*) as count, COUNT(DISTINCT cs.ga) as affected_gas
                FROM current_state cs
                    LEFT JOIN datapoint_mappings m
                ON cs.datapoint_id = m.datapoint_id
                WHERE m.datapoint_id IS NULL
            `);
            return {
                count: this.#parseInt(result.rows[0]?.count || 0),
                affectedGAs: this.#parseInt(result.rows[0]?.affected_gas || 0),
            };
        } catch (err) {
            this.logger.error('Failed to get orphaned states info', { error: err.message });
            return { count: 0, affectedGAs: 0 };
        }
    }

    /**
     * Get count of duplicate group addresses (GAs with multiple mappings)
     * @returns {Promise<number>} Duplicate GA count
     */
    async getDuplicateGroupAddressCount() {
        try {
            const result = await this.db.query(`
                SELECT COUNT(*) as duplicate_count
                FROM (SELECT ga, COUNT(*) as mapping_count
                      FROM datapoint_mappings
                      GROUP BY ga
                      HAVING COUNT(*) > 1) duplicates
            `);
            return this.#parseInt(result.rows[0]?.duplicate_count || 0);
        } catch (err) {
            this.logger.error('Failed to get duplicate GA count', { error: err.message });
            return 0;
        }
    }

    /**
     * Get count of stale mappings (mappings without current states)
     * @returns {Promise<number>} Stale mapping count
     */
    async getStaleMappingCount() {
        try {
            const result = await this.db.query(`
                SELECT COUNT(*) as count
                FROM datapoint_mappings m
                    LEFT JOIN current_state cs
                ON m.datapoint_id = cs.datapoint_id
                WHERE cs.datapoint_id IS NULL
            `);
            return this.#parseInt(result.rows[0]?.count || 0);
        } catch (err) {
            this.logger.error('Failed to get stale mapping count', { error: err.message });
            return 0;
        }
    }

    /**
     * Calculate data integrity score
     * @returns {Promise<number>} Integrity score as percentage (0-100)
     */
    async getDataIntegrityScore() {
        try {
            const result = await this.db.query(`
                SELECT COUNT(*) as total_count
                FROM datapoint_mappings
            `);
            const totalMappings = this.#parseInt(result.rows[0]?.total_count || 0);

            if (totalMappings === 0) {
                return 100;
            }

            const staleCount = await this.getStaleMappingCount();
            return Math.round(((totalMappings - staleCount) / totalMappings) * 100);
        } catch (err) {
            this.logger.error('Failed to calculate data integrity score', { error: err.message });
            return 0;
        }
    }

    /**
     * Helper: Safe parseInt with radix 10 and default value 0
     */
    #parseInt(value) {
        const parsed = parseInt(value, 10);
        return Number.isNaN(parsed) ? 0 : parsed;
    }

    /**
     * Get all comprehensive statistics for GET /api/v2/stats
     * @returns {Promise<Object>} Complete stats object
     */
    async getAllStats() {
        try {
            // Count records in all tables
            const [events, states, datapoints, resources] = await Promise.all([
                this.db.query('SELECT COUNT(*) as count FROM knx_events'),
                this.db.query('SELECT COUNT(*) as count FROM current_state'),
                this.db.query('SELECT COUNT(*) as count FROM datapoint_mappings'),
                this.db.query('SELECT COUNT(*) as count FROM semantic_resources'),
            ]);

            // Get date range of events
            const eventRange = await this.db.query(`
                SELECT MIN(ts) as first_event, MAX(ts) as last_event
                FROM knx_events
            `);

            // Get most active group addresses (24h window)
            const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
            const topGAs = await this.db.query(`
                SELECT ga, COUNT(*) as event_count, MAX(ts) as last_seen
                FROM knx_events
                WHERE ts >= $1
                GROUP BY ga
                ORDER BY event_count DESC LIMIT 10
            `, [twentyFourHoursAgo]);

            // Get database size
            const dbSize = await this.db.query(`
                SELECT pg_size_pretty(pg_database_size(current_database())) as size
            `);

            const firstEvent = eventRange.rows[0]?.first_event;
            const lastEvent = eventRange.rows[0]?.last_event;

            return {
                counts: {
                    events: this.#parseInt(events.rows[0].count),
                    states: this.#parseInt(states.rows[0].count),
                    datapointMappings: this.#parseInt(datapoints.rows[0].count),
                    semanticResources: this.#parseInt(resources.rows[0].count),
                },
                eventRange: {
                    firstEvent,
                    lastEvent,
                },
                topGroupAddresses: topGAs.rows.map(row => ({
                    ga: row.ga,
                    eventCount: this.#parseInt(row.event_count),
                    lastSeen: row.last_seen,
                })),
                dbSize: dbSize.rows[0]?.size || 'N/A',
            };
        } catch (err) {
            this.logger.error('Failed to get all stats', { error: err.message });
            return {
                counts: { events: 0, states: 0, datapointMappings: 0, semanticResources: 0 },
                eventRange: { firstEvent: null, lastEvent: null },
                topGroupAddresses: [],
                dbSize: 'N/A',
            };
        }
    }

    async getEventStatistics(hours = 24) {
        try {
            const since = new Date(Date.now() - hours * 60 * 60 * 1000);

            const stats = await this.db.query(`
                SELECT COUNT(*)                     as total_events,
                       COUNT(DISTINCT ga)           as unique_gas,
                       COUNT(DISTINCT source)       as unique_sources,
                       COUNT(DISTINCT datapoint_id) as unique_datapoints
                FROM knx_events
                WHERE ts >= $1
            `, [since]);

            // Events per hour
            const hourly = await this.db.query(`
                SELECT time_bucket('1 hour', ts) AS hour, COUNT(*) as count
                FROM knx_events
                WHERE ts >= $1
                GROUP BY hour
                ORDER BY hour DESC
            `, [since]);

            // Events by type
            const byType = await this.db.query(`
                SELECT event_type, COUNT(*) as count
                FROM knx_events
                WHERE ts >= $1
                GROUP BY event_type
            `, [since]);

            return {
                summary: {
                    total_events: this.#parseInt(stats.rows[0]?.total_events),
                    unique_gas: this.#parseInt(stats.rows[0]?.unique_gas),
                    unique_sources: this.#parseInt(stats.rows[0]?.unique_sources),
                    unique_datapoints: this.#parseInt(stats.rows[0]?.unique_datapoints),
                },
                hourly: hourly.rows.map(row => ({
                    hour: row.hour,
                    count: this.#parseInt(row.count),
                })),
                byType: byType.rows,
            };
        } catch (err) {
            this.logger.error('Failed to get event statistics', { error: err.message });
            return { summary: {}, hourly: [], byType: [] };
        }
    }

    /**
     * Get current state statistics
     * @returns {Promise<Object>} State statistics
     */
    async getStateStatistics() {
        try {
            const stats = await this.db.query(`
                SELECT COUNT(*)                                    as total_states,
                       COUNT(DISTINCT ga)                          as unique_gas,
                       COUNT(DISTINCT source)                      as unique_sources,
                       COUNT(CASE WHEN dpt IS NOT NULL THEN 1 END) as states_with_dpt,
                       MIN(updated_at)                             as oldest_update,
                       MAX(updated_at)                             as newest_update
                FROM current_state
            `);

            // States by DPT
            const byDpt = await this.db.query(`
                SELECT COALESCE(dpt, 'unknown') as dpt, COUNT(*) as count
                FROM current_state
                GROUP BY dpt
                ORDER BY count DESC
                    LIMIT 10
            `);

            const summary = stats.rows[0];
            return {
                summary: {
                    total_states: this.#parseInt(summary?.total_states),
                    unique_gas: this.#parseInt(summary?.unique_gas),
                    unique_sources: this.#parseInt(summary?.unique_sources),
                    states_with_dpt: this.#parseInt(summary?.states_with_dpt),
                    oldest_update: summary?.oldest_update,
                    newest_update: summary?.newest_update,
                },
                byDpt: byDpt.rows,
            };
        } catch (err) {
            this.logger.error('Failed to get state statistics', { error: err.message });
            return { summary: {}, byDpt: [] };
        }
    }

    /**
     * Get top active datapoints for a given time period
     * @param {Date} startTime - Start timestamp
     * @param {number} limit - Maximum results
     * @returns {Promise<Array>} Top datapoints with event counts and current values
     */
    async getTopActiveDatapoints(startTime, limit = 20) {
        try {
            const active = await this.db.query(`
                SELECT e.ga,
                       e.datapoint_id,
                       COUNT(*)  as event_count,
                       MAX(e.ts) as last_event,
                       (SELECT s.value_decoded
                        FROM current_state s
                        WHERE s.ga = e.ga
                        ORDER BY s.updated_at DESC
                                    LIMIT 1 ) as current_value,
                    dm.name as datapoint_name,
                    dm.dpt
                FROM knx_events e
                    LEFT JOIN datapoint_mappings dm
                ON dm.ga = e.ga
                WHERE e.ts >= $1
                GROUP BY e.ga, e.datapoint_id, dm.name, dm.dpt
                ORDER BY event_count DESC
                    LIMIT $2
            `, [startTime, limit]);

            return active.rows.map(row => ({
                ga: row.ga,
                datapointId: row.datapoint_id,
                eventCount: this.#parseInt(row.event_count),
                lastEvent: row.last_event,
                currentValue: row.current_value,
                datapointName: row.datapoint_name,
                dpt: row.dpt,
            }));
        } catch (err) {
            this.logger.error('Failed to get top active datapoints', { error: err.message });
            return [];
        }
    }

    /**
     * Get detailed health check results
     * @returns {Promise<Object>} Complete health check data
     */
    async getHealthCheckDetails() {
        try {
            // Get orphaned states
            const orphanedResult = await this.db.query(`
                SELECT COUNT(*) as count, COUNT(DISTINCT cs.ga) as affected_gas
                FROM current_state cs
                    LEFT JOIN datapoint_mappings m
                ON cs.datapoint_id = m.datapoint_id
                WHERE m.datapoint_id IS NULL
            `);

            // Get duplicate GAs
            const duplicateResult = await this.db.query(`
                SELECT COUNT(*) as duplicate_count
                FROM (SELECT ga, COUNT(*) as mapping_count
                      FROM datapoint_mappings
                      GROUP BY ga
                      HAVING COUNT(*) > 1) duplicates
            `);

            // Get stale mappings
            const staleResult = await this.db.query(`
                SELECT COUNT(*) as count
                FROM datapoint_mappings m
                    LEFT JOIN current_state cs
                ON m.datapoint_id = cs.datapoint_id
                WHERE cs.datapoint_id IS NULL
            `);

            // Get general statistics
            const statsResult = await this.db.query(`
                SELECT (SELECT COUNT(*) FROM datapoint_mappings)           as total_mappings,
                       (SELECT COUNT(DISTINCT ga) FROM datapoint_mappings) as unique_gas_mappings,
                       (SELECT COUNT(*) FROM current_state)                as total_states,
                       (SELECT COUNT(DISTINCT ga) FROM current_state)      as unique_gas_states
            `);

            const statsRow = statsResult.rows[0];
            const orphanedRow = orphanedResult.rows[0];
            const duplicateRow = duplicateResult.rows[0];
            const staleRow = staleResult.rows[0];

            const totalMappings = this.#parseInt(statsRow?.total_mappings);
            const staleCount = this.#parseInt(staleRow?.count);

            return {
                orphanedCount: this.#parseInt(orphanedRow?.count),
                orphanedGAs: this.#parseInt(orphanedRow?.affected_gas),
                duplicateCount: this.#parseInt(duplicateRow?.duplicate_count),
                staleCount,
                totalMappings,
                uniqueGASMappings: this.#parseInt(statsRow?.unique_gas_mappings),
                totalStates: this.#parseInt(statsRow?.total_states),
                uniqueGASStates: this.#parseInt(statsRow?.unique_gas_states),
                dataIntegrityScore: totalMappings > 0
                    ? Math.round(((totalMappings - staleCount) / totalMappings) * 100)
                    : 100,
            };
        } catch (err) {
            this.logger.error('Failed to get health check details', { error: err.message });
            return {
                orphanedCount: 0,
                orphanedGAs: 0,
                duplicateCount: 0,
                staleCount: 0,
                totalMappings: 0,
                uniqueGASMappings: 0,
                totalStates: 0,
                uniqueGASStates: 0,
                dataIntegrityScore: 100,
            };
        }
    }

    /**
     * Get detailed orphaned states
     * @param {number} limit - Maximum results
     * @returns {Promise<Object>} Orphaned states details
     */
    async getDetailedOrphanedStates(limit = 20) {
        try {
            const orphanedStates = await this.db.query(`
                SELECT cs.datapoint_id,
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

            const countResult = await this.db.query(`
                SELECT COUNT(*) as count
                FROM current_state cs
                    LEFT JOIN datapoint_mappings m
                ON cs.datapoint_id = m.datapoint_id
                WHERE m.datapoint_id IS NULL
            `);

            return {
                totalOrphaned: this.#parseInt(countResult.rows[0]?.count),
                states: orphanedStates.rows.map(row => ({
                    datapointId: row.datapoint_id,
                    ga: row.ga,
                    dpt: row.dpt,
                    lastUpdate: row.updated_at,
                    source: row.source,
                    value: row.value_decoded,
                })),
            };
        } catch (err) {
            this.logger.error('Failed to get detailed orphaned states', { error: err.message });
            return { totalOrphaned: 0, states: [] };
        }
    }

    /**
     * Get detailed duplicate group addresses
     * @returns {Promise<Object>} Duplicate GAs details
     */
    async getDetailedDuplicateGAs() {
        try {
            const duplicates = await this.db.query(`
                SELECT ga,
                       COUNT(*)                       as mapping_count,
                       COUNT(DISTINCT dpt)            as dpt_count,
                       STRING_AGG(DISTINCT dpt, ', ') as dpts,
                       STRING_AGG(DISTINCT name, ' | ') as names,
                    STRING_AGG(DISTINCT device_id, ', ') as device_ids
                FROM datapoint_mappings
                GROUP BY ga
                HAVING COUNT (*) > 1
                ORDER BY COUNT (*) DESC
            `);

            const countResult = await this.db.query(`
                SELECT COUNT(*) as count
                FROM (
                    SELECT ga FROM datapoint_mappings
                    GROUP BY ga HAVING COUNT (*) > 1
                    ) duplicates
            `);

            return {
                totalDuplicateGAs: this.#parseInt(countResult.rows[0]?.count),
                duplicates: duplicates.rows.map(row => ({
                    ga: row.ga,
                    mappingCount: this.#parseInt(row.mapping_count),
                    dptCount: this.#parseInt(row.dpt_count),
                    dpts: row.dpts,
                    names: row.names,
                    deviceIds: row.device_ids,
                })),
            };
        } catch (err) {
            this.logger.error('Failed to get detailed duplicate GAs', { error: err.message });
            return { totalDuplicateGAs: 0, duplicates: [] };
        }
    }

    /**
     * Get detailed stale mappings
     * @param {number} limit - Maximum results
     * @returns {Promise<Object>} Stale mappings details
     */
    async getDetailedStaleMappings(limit = 20) {
        try {
            const staleMappings = await this.db.query(`
                SELECT m.datapoint_id,
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

            const countResult = await this.db.query(`
                SELECT COUNT(*) as count
                FROM datapoint_mappings m
                    LEFT JOIN current_state cs
                ON m.datapoint_id = cs.datapoint_id
                WHERE cs.datapoint_id IS NULL
            `);

            return {
                totalStale: this.#parseInt(countResult.rows[0]?.count),
                mappings: staleMappings.rows.map(row => ({
                    datapointId: row.datapoint_id,
                    ga: row.ga,
                    dpt: row.dpt,
                    name: row.name,
                    deviceId: row.device_id,
                    hasState: !(row.last_state_update && row.last_state_update.getFullYear() > 2050),
                })),
            };
        } catch (err) {
            this.logger.error('Failed to get detailed stale mappings', { error: err.message });
            return { totalStale: 0, mappings: [] };
        }
    }

    /**
     * PHASE 1: Get anomalies (temperature jumps > delta threshold)
     * Detects sudden changes in sensor values using LAG window function
     * @param {string} dpt - DPT type(s) to analyze (comma-separated, e.g., '9.001,9.007')
     * @param {number} delta - Change a threshold to trigger anomaly (e.g., 2.0 for 2°C)
     * @param {Date} since - Start timestamp for time window
     * @param {number} limit - Maximum anomalies to return
     * @returns {Promise<Object>} Anomalies with metadata and summary
     */
    async getAnomalies(dpt = '9.001', delta = 2.0, since = null, limit = 50) {
        try {
            if (!since) {
                since = new Date(Date.now() - 24 * 60 * 60 * 1000); // Default: 24h
            }

            // Parse DPT list
            const dptList = dpt.split(',').map(d => d.trim());
            const placeholders = dptList.map((_, i) => `$${i + 3}`).join(',');

            const anomaliesQuery = `
                WITH ranked_events AS (
                    SELECT 
                        ts,
                        datapoint_id,
                        ga,
                        value_float,
                        dpt,
                        source,
                        LAG(value_float) OVER (PARTITION BY datapoint_id ORDER BY ts) as prev_value,
                        LAG(ts) OVER (PARTITION BY datapoint_id ORDER BY ts) as prev_ts
                    FROM knx_events
                    WHERE ts >= $1
                        AND dpt IN (${placeholders})
                        AND value_float IS NOT NULL
                )
                SELECT 
                    ts,
                    datapoint_id,
                    ga,
                    prev_value as previous_value,
                    value_float as current_value,
                    ABS(value_float - prev_value) as delta,
                    ROUND((ABS(value_float - prev_value) / NULLIF(ABS(prev_value), 0) * 100)::numeric, 2) as delta_percent,
                    EXTRACT(EPOCH FROM (ts - prev_ts))::int as time_gap_seconds,
                    dpt,
                    source,
                    CASE 
                        WHEN ABS(value_float - prev_value) > $2 THEN 'high'
                        WHEN ABS(value_float - prev_value) > ($2 * 0.5) THEN 'medium'
                        ELSE 'low'
                    END as severity
                FROM ranked_events
                WHERE prev_value IS NOT NULL
                    AND ABS(value_float - prev_value) > ($2 * 0.5)
                ORDER BY delta DESC, ts DESC
                LIMIT $${dptList.length + 3}
            `;

            const result = await this.db.query(anomaliesQuery, [since, delta, ...dptList, limit]);

            // Count by severity
            const severityCounts = { high: 0, medium: 0, low: 0 };
            result.rows.forEach(row => {
                severityCounts[row.severity]++;
            });

            return {
                meta: {
                    collection: {
                        total: result.rows.length,
                        returned: Math.min(result.rows.length, limit),
                        period_hours: Math.round((Date.now() - since) / (60 * 60 * 1000)),
                    },
                    query: {
                        dpt,
                        delta,
                        severity_filter: 'all',
                    },
                },
                data: result.rows.map(row => ({
                    id: `anom-${row.datapoint_id}-${row.ts.getTime()}`,
                    type: 'anomaly',
                    attributes: {
                        timestamp: row.ts.toISOString(),
                        timestamp_local: formatTimestamp(row.ts),
                        datapointId: row.datapoint_id,
                        ga: row.ga,
                        dpt: row.dpt,
                        previousValue: parseFloat(row.previous_value || 0),
                        currentValue: parseFloat(row.current_value || 0),
                        delta: parseFloat(row.delta || 0),
                        deltaPercent: parseFloat(row.delta_percent || 0),
                        severity: row.severity,
                        timeGapSeconds: row.time_gap_seconds || 0,
                        source: row.source,
                    },
                })),
                summary: {
                    high: severityCounts.high,
                    medium: severityCounts.medium,
                    low: severityCounts.low,
                    total: result.rows.length,
                    timeRange: {
                        since: since.toISOString(),
                        until: new Date().toISOString(),
                    },
                },
            };
        } catch (err) {
            this.logger.error('Failed to get anomalies', { error: err.message, dpt, delta });
            return {
                meta: { collection: { total: 0, returned: 0 }, query: { dpt, delta } },
                data: [],
                summary: { high: 0, medium: 0, low: 0, total: 0 },
            };
        }
    }

    /**
     * PHASE 1: Get NULL value patterns for data quality analysis
     * Analyzes NULL values both temporally (by minute of hour) and spatially (by GA)
     * @param {string} dpts - DPT type(s) to analyze (comma-separated)
     * @param {Date} since - Start timestamp for time window
     * @returns {Promise<Object>} Temporal and spatial NULL patterns with diagnosis
     */
    async getNullPatterns(dpts = '9.001,9.007', since = null) {
        try {
            if (!since) {
                since = new Date(Date.now() - 24 * 60 * 60 * 1000); // Default: 24h
            }

            const dptList = dpts.split(',').map(d => d.trim());
            const placeholders = dptList.map((_, i) => `$${i + 2}`).join(',');

            // Temporal patterns: NULL values by minute of hour
            const temporalQuery = `
                SELECT
                    EXTRACT(MINUTE FROM ts)::int as minute_of_hour,
                    COUNT(*) as null_count,
                    COUNT(DISTINCT ga) as affected_ga_count,
                    STRING_AGG(DISTINCT ga, ', ' ORDER BY ga) as sample_gas
                FROM knx_events
                WHERE ts >= $1
                    AND dpt IN (${placeholders})
                    AND value_float IS NULL
                GROUP BY EXTRACT(MINUTE FROM ts)
                ORDER BY null_count DESC
                LIMIT 15
            `;

            // Spatial patterns: NULL values by GA
            const spatialQuery = `
                SELECT
                    ga,
                    datapoint_id,
                    COUNT(*) as null_count,
                    COUNT(DISTINCT EXTRACT(HOUR FROM ts)) as hours_affected,
                    MIN(ts) as first_null,
                    MAX(ts) as last_null
                FROM knx_events
                WHERE ts >= $1
                    AND dpt IN (${placeholders})
                    AND value_float IS NULL
                GROUP BY ga, datapoint_id
                ORDER BY null_count DESC
                LIMIT 10
            `;

            // Get total events count for percentage calculation
            const totalQuery = `
                SELECT COUNT(*) as total
                FROM knx_events
                WHERE ts >= $1
                    AND dpt IN (${placeholders})
            `;

            const [temporalResult, spatialResult, totalResult] = await Promise.all([
                client.query(temporalQuery, [since, ...dptList]),
                client.query(spatialQuery, [since, ...dptList]),
                client.query(totalQuery, [since, ...dptList]),
            ]);

            const totalEvents = this.#parseInt(totalResult.rows[0]?.total || 1);

            // Analyze patterns
            const isTemporallySync = temporalResult.rows.length > 0 && temporalResult.rows[0].minute_of_hour !== null;
            const isSpatiallyConcent = spatialResult.rows.length > 0 && spatialResult.rows[0].null_count > (totalEvents * 0.05);

            return {
                meta: {
                    period_hours: Math.round((Date.now() - since) / (60 * 60 * 1000)),
                    analysis_timestamp: new Date().toISOString(),
                    analysis_timestamp_local: formatTimestamp(new Date()),
                },
                temporal_patterns: {
                    description: 'NULL values grouped by minute of hour',
                    synchronized: isTemporallySync,
                    pattern: temporalResult.rows.map(row => ({
                        minute_of_hour: row.minute_of_hour,
                        null_count: this.#parseInt(row.null_count),
                        affected_ga_count: this.#parseInt(row.affected_ga_count),
                        sample_gas: (row.sample_gas || '').split(',').map(g => g.trim()).filter(g => g),
                        percentage_of_total: parseFloat(((row.null_count / totalEvents) * 100).toFixed(1)),
                    })),
                },
                spatial_patterns: {
                    description: 'NULL values grouped by group address',
                    concentrated: isSpatiallyConcent,
                    pattern: spatialResult.rows.map(row => ({
                        ga: row.ga,
                        datapoint_id: row.datapoint_id,
                        null_count: this.#parseInt(row.null_count),
                        hours_affected: this.#parseInt(row.hours_affected),
                        percent_of_all_events: parseFloat(((row.null_count / totalEvents) * 100).toFixed(1)),
                        first_null: row.first_null.toISOString(),
                        first_null_local: formatTimestamp(row.first_null),
                        last_null: row.last_null.toISOString(),
                        last_null_local: formatTimestamp(row.last_null),
                    })),
                },
                diagnosis: {
                    likely_cause: isTemporallySync ? 'synchronized_polling_issue' : 'sensor_communication_error',
                    confidence: isTemporallySync ? 0.92 : 0.68,
                    recommendation: isTemporallySync
                        ? 'Check device polling intervals and KNX gateway connectivity'
                        : 'Check sensor communication lines and device configuration',
                },
            };
        } catch (err) {
            this.logger.error('Failed to get NULL patterns', { error: err.message, dpts });
            return {
                meta: { period_hours: 24 },
                temporal_patterns: { description: '', synchronized: false, pattern: [] },
                spatial_patterns: { description: '', concentrated: false, pattern: [] },
                diagnosis: { likely_cause: 'unknown', confidence: 0, recommendation: '' },
            };
        }
    }

    /**
     * PHASE 1: Get comprehensive datapoint summary with statistics
     * Returns time-series statistics for a single datapoint across multiple time windows
     * @param {string} datapointId - Datapoint ID or GA (e.g., 'GA-329' or '3/6/1')
     * @param {Date} since - Start timestamp (default: 24h ago)
     * @returns {Promise<Object>} Detailed statistics and current state
     */
    async getDatapointSummary(datapointId, since = null) {
        try {
            if (!since) {
                since = new Date(Date.now() - 24 * 60 * 60 * 1000); // Default: 24h
            }

            // Find datapoint by ID or GA
            const dpLookup = await this.db.query(`
                SELECT DISTINCT datapoint_id, ga, dpt
                FROM knx_events
                WHERE datapoint_id = $1 OR ga = $1
                LIMIT 1
            `, [datapointId]);

            if (dpLookup.rows.length === 0) {
                return null; // Datapoint not found
            }

            const dpId = dpLookup.rows[0].datapoint_id;
            const ga = dpLookup.rows[0].ga;
            const dpt = dpLookup.rows[0].dpt;

            // Get detailed statistics for 24h period
            const stats24h = await this.db.query(`
                SELECT
                    COUNT(*) as count,
                    COUNT(CASE WHEN value_float IS NULL THEN 1 END) as null_count,
                    AVG(value_float) as average,
                    MIN(value_float) as minimum,
                    MAX(value_float) as maximum,
                    STDDEV(value_float) as stddev,
                    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY value_float) as median,
                    PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY value_float) as q1,
                    PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY value_float) as q3,
                    FIRST_VALUE(value_float) OVER (ORDER BY ts) as first_value,
                    LAST_VALUE(value_float) OVER (ORDER BY ts DESC) as last_value
                FROM knx_events
                WHERE datapoint_id = $1 AND ts >= $2 AND value_float IS NOT NULL
            `, [dpId, since]);

            const stats7d = await this.db.query(`
                SELECT
                    COUNT(*) as count,
                    AVG(value_float) as average,
                    MIN(value_float) as minimum,
                    MAX(value_float) as maximum,
                    COUNT(CASE WHEN value_float IS NULL THEN 1 END) as null_count
                FROM knx_events
                WHERE datapoint_id = $1 
                    AND ts >= $2 - INTERVAL '7 days'
                    AND value_float IS NOT NULL
            `, [dpId, since]);

            // Count anomalies (changes > 2 units)
            const anomalies = await this.db.query(`
                WITH changes AS (
                    SELECT
                        ABS(value_float - LAG(value_float) OVER (ORDER BY ts)) as delta
                    FROM knx_events
                    WHERE datapoint_id = $1 AND ts >= $2 AND value_float IS NOT NULL
                )
                SELECT COUNT(*) as anomaly_count
                FROM changes
                WHERE delta > 2.0
            `, [dpId, since]);

            // Get current state
            const current = await this.db.query(`
                SELECT ts, value_float
                FROM knx_events
                WHERE datapoint_id = $1
                ORDER BY ts DESC
                LIMIT 1
            `, [dpId]);

            const s24 = stats24h.rows[0] || {};
            const s7d = stats7d.rows[0] || {};
            const curr = current.rows[0];

            return {
                data: {
                    id: datapointId,
                    type: 'datapoint',
                    attributes: {
                        datapointId: dpId,
                        ga,
                        dpt,
                    },
                },
                statistics: {
                    last_24h: {
                        period: {
                            since: since.toISOString(),
                            since_local: formatTimestamp(since),
                            until: new Date().toISOString(),
                            until_local: formatTimestamp(new Date()),
                            hours: 24,
                        },
                        measurements: {
                            count: this.#parseInt(s24.count),
                            missing: 0,
                            null_count: this.#parseInt(s24.null_count),
                            null_percent: s24.count > 0 ? (s24.null_count / s24.count * 100).toFixed(1) : 0,
                        },
                        values: {
                            average: parseFloat(s24.average || 0),
                            minimum: parseFloat(s24.minimum || 0),
                            maximum: parseFloat(s24.maximum || 0),
                            range: parseFloat((s24.maximum - s24.minimum) || 0),
                            stddev: parseFloat(s24.stddev || 0),
                            median: parseFloat(s24.median || 0),
                            q1: parseFloat(s24.q1 || 0),
                            q3: parseFloat(s24.q3 || 0),
                        },
                        trend: {
                            direction: s24.last_value > s24.first_value ? 'rising' : (s24.last_value < s24.first_value ? 'falling' : 'stable'),
                            first_value: parseFloat(s24.first_value || 0),
                            last_value: parseFloat(s24.last_value || 0),
                            change: parseFloat((s24.last_value - s24.first_value) || 0),
                            change_percent: s24.first_value !== 0 ? parseFloat(((s24.last_value - s24.first_value) / s24.first_value * 100).toFixed(2)) : 0,
                        },
                    },
                    last_7d: {
                        measurements: {
                            count: this.#parseInt(s7d.count),
                        },
                        values: {
                            average: parseFloat(s7d.average || 0),
                            minimum: parseFloat(s7d.minimum || 0),
                            maximum: parseFloat(s7d.maximum || 0),
                            range: parseFloat((s7d.maximum - s7d.minimum) || 0),
                        },
                        anomalies: this.#parseInt(anomalies.rows[0]?.anomaly_count || 0),
                    },
                },
                current: {
                    value: curr ? parseFloat(curr.value_float) : null,
                    timestamp: curr ? curr.ts.toISOString() : null,
                    timestamp_local: curr ? formatTimestamp(curr.ts) : null,
                    age_seconds: curr ? Math.round((Date.now() - curr.ts) / 1000) : null,
                    status: curr ? 'ok' : 'unknown',
                },
            };
        } catch (err) {
            this.logger.error('Failed to get datapoint summary', { error: err.message, datapointId });
            return null;
        }
    }
}

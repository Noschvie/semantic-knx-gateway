// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import { createLogger } from '../utils/logger.js';

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
        this.pool = postgresClient.pool;
        this.logger = createLogger('StatisticsStore');
    }

    /**
     * Get total count of events
     * @returns {Promise<number>} Total event count
     */
    async getTotalEventCount() {
        let client;
        try {
            client = await this.pool.connect();
            const result = await client.query('SELECT COUNT(*) as count FROM knx_events');
            return this.#parseInt(result.rows[0].count);
        } catch (err) {
            this.logger.error('Failed to get total event count', {error: err.message});
            return 0;
        } finally {
            if (client) client.release();
        }
    }

    /**
     * Get total count of current states
     * @returns {Promise<number>} Total state count
     */
    async getTotalStateCount() {
        let client;
        try {
            client = await this.pool.connect();
            const result = await client.query('SELECT COUNT(*) as count FROM current_state');
            return this.#parseInt(result.rows[0].count);
        } catch (err) {
            this.logger.error('Failed to get total state count', {error: err.message});
            return 0;
        } finally {
            if (client) client.release();
        }
    }

    /**
     * Get total count of datapoint mappings
     * @returns {Promise<number>} Total mapping count
     */
    async getTotalMappingCount() {
        let client;
        try {
            client = await this.pool.connect();
            const result = await client.query('SELECT COUNT(*) as count FROM datapoint_mappings');
            return this.#parseInt(result.rows[0].count);
        } catch (err) {
            this.logger.error('Failed to get total mapping count', {error: err.message});
            return 0;
        } finally {
            if (client) client.release();
        }
    }

    /**
     * Get total count of semantic resources
     * @returns {Promise<number>} Total resource count
     */
    async getTotalResourceCount() {
        let client;
        try {
            client = await this.pool.connect();
            const result = await client.query('SELECT COUNT(*) as count FROM semantic_resources');
            return this.#parseInt(result.rows[0].count);
        } catch (err) {
            this.logger.error('Failed to get total resource count', {error: err.message});
            return 0;
        } finally {
            if (client) client.release();
        }
    }

    /**
     * Get count of unique group addresses
     * @returns {Promise<number>} Unique GA count
     */
    async getUniqueGroupAddressCount() {
        let client;
        try {
            client = await this.pool.connect();
            const result = await client.query('SELECT COUNT(DISTINCT ga) as count FROM current_state');
            return this.#parseInt(result.rows[0].count);
        } catch (err) {
            this.logger.error('Failed to get unique GA count', {error: err.message});
            return 0;
        } finally {
            if (client) client.release();
        }
    }

    /**
     * Get event timeline information
     * @returns {Promise<{oldest: Date|null, latest: Date|null}>} Event timestamps
     */
    async getEventTimeline() {
        let client;
        try {
            client = await this.pool.connect();
            const result = await client.query(`
                SELECT MIN(ts) as oldest,
                       MAX(ts) as latest
                FROM knx_events
            `);
            return {
                oldest: result.rows[0]?.oldest || null,
                latest: result.rows[0]?.latest || null,
            };
        } catch (err) {
            this.logger.error('Failed to get event timeline', {error: err.message});
            return {oldest: null, latest: null};
        } finally {
            if (client) client.release();
        }
    }

    /**
     * Get database size
     * @returns {Promise<string>} Human-readable database size
     */
    async getDatabaseSize() {
        let client;
        try {
            client = await this.pool.connect();
            const result = await client.query('SELECT pg_size_pretty(pg_database_size(current_database())) as size');
            return result.rows[0]?.size || 'N/A';
        } catch (err) {
            this.logger.error('Failed to get database size', {error: err.message});
            return 'N/A';
        } finally {
            if (client) client.release();
        }
    }

    /**
     * Get top active group addresses in the given time range
     * @param {Date} startTime - Start timestamp
     * @param {number} limit - Maximum results
     * @returns {Promise<Array>} Top GAs with event counts and current values
     */
    async getTopActiveGroupAddresses(startTime, limit = 5) {
        let client;
        try {
            client = await this.pool.connect();
            const result = await client.query(`
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
            this.logger.error('Failed to get top active group addresses', {error: err.message});
            return [];
        } finally {
            if (client) client.release();
        }
    }

    /**
     * Get count of orphaned states (states without mappings)
     * @returns {Promise<{count: number, affectedGAs: number}>} Orphaned state info
     */
    async getOrphanedStatesInfo() {
        let client;
        try {
            client = await this.pool.connect();
            const result = await client.query(`
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
            this.logger.error('Failed to get orphaned states info', {error: err.message});
            return {count: 0, affectedGAs: 0};
        } finally {
            if (client) client.release();
        }
    }

    /**
     * Get count of duplicate group addresses (GAs with multiple mappings)
     * @returns {Promise<number>} Duplicate GA count
     */
    async getDuplicateGroupAddressCount() {
        let client;
        try {
            client = await this.pool.connect();
            const result = await client.query(`
                SELECT COUNT(*) as duplicate_count
                FROM (SELECT ga, COUNT(*) as mapping_count
                      FROM datapoint_mappings
                      GROUP BY ga
                      HAVING COUNT(*) > 1) duplicates
            `);
            return this.#parseInt(result.rows[0]?.duplicate_count || 0);
        } catch (err) {
            this.logger.error('Failed to get duplicate GA count', {error: err.message});
            return 0;
        } finally {
            if (client) client.release();
        }
    }

    /**
     * Get count of stale mappings (mappings without current states)
     * @returns {Promise<number>} Stale mapping count
     */
    async getStaleMappingCount() {
        let client;
        try {
            client = await this.pool.connect();
            const result = await client.query(`
                SELECT COUNT(*) as count
                FROM datapoint_mappings m
                    LEFT JOIN current_state cs
                ON m.datapoint_id = cs.datapoint_id
                WHERE cs.datapoint_id IS NULL
            `);
            return this.#parseInt(result.rows[0]?.count || 0);
        } catch (err) {
            this.logger.error('Failed to get stale mapping count', {error: err.message});
            return 0;
        } finally {
            if (client) client.release();
        }
    }

    /**
     * Calculate data integrity score
     * @returns {Promise<number>} Integrity score as percentage (0-100)
     */
    async getDataIntegrityScore() {
        let client;
        try {
            client = await this.pool.connect();
            const result = await client.query(`
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
            this.logger.error('Failed to calculate data integrity score', {error: err.message});
            return 0;
        } finally {
            if (client) client.release();
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
        let client;
        try {
            client = await this.pool.connect();

            // Count records in all tables
            const [events, states, datapoints, resources] = await Promise.all([
                client.query('SELECT COUNT(*) as count FROM knx_events'),
                client.query('SELECT COUNT(*) as count FROM current_state'),
                client.query('SELECT COUNT(*) as count FROM datapoint_mappings'),
                client.query('SELECT COUNT(*) as count FROM semantic_resources'),
            ]);

            // Get date range of events
            const eventRange = await client.query(`
                SELECT MIN(ts) as first_event, MAX(ts) as last_event
                FROM knx_events
            `);

            // Get most active group addresses (24h window)
            const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
            const topGAs = await client.query(`
                SELECT ga, COUNT(*) as event_count, MAX(ts) as last_seen
                FROM knx_events
                WHERE ts >= $1
                GROUP BY ga
                ORDER BY event_count DESC LIMIT 10
            `, [twentyFourHoursAgo]);

            // Get database size
            const dbSize = await client.query(`
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
            this.logger.error('Failed to get all stats', {error: err.message});
            return {
                counts: {events: 0, states: 0, datapointMappings: 0, semanticResources: 0},
                eventRange: {firstEvent: null, lastEvent: null},
                topGroupAddresses: [],
                dbSize: 'N/A',
            };
        } finally {
            if (client) client.release();
        }
    }

    /**
     * Get event statistics for a given time period
     * @param {number} hours - Number of hours to look back
     * @returns {Promise<Object>} Event statistics
     */
    async getEventStatistics(hours = 24) {
        let client;
        try {
            client = await this.pool.connect();
            const since = new Date(Date.now() - hours * 60 * 60 * 1000);

            const stats = await client.query(`
                SELECT COUNT(*)                     as total_events,
                       COUNT(DISTINCT ga)           as unique_gas,
                       COUNT(DISTINCT source)       as unique_sources,
                       COUNT(DISTINCT datapoint_id) as unique_datapoints
                FROM knx_events
                WHERE ts >= $1
            `, [since]);

            // Events per hour
            const hourly = await client.query(`
                SELECT time_bucket('1 hour', ts) AS hour, COUNT(*) as count
                FROM knx_events
                WHERE ts >= $1
                GROUP BY hour
                ORDER BY hour DESC
            `, [since]);

            // Events by type
            const byType = await client.query(`
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
            this.logger.error('Failed to get event statistics', {error: err.message});
            return {summary: {}, hourly: [], byType: []};
        } finally {
            if (client) client.release();
        }
    }

    /**
     * Get current state statistics
     * @returns {Promise<Object>} State statistics
     */
    async getStateStatistics() {
        let client;
        try {
            client = await this.pool.connect();

            const stats = await client.query(`
                SELECT COUNT(*)                                    as total_states,
                       COUNT(DISTINCT ga)                          as unique_gas,
                       COUNT(DISTINCT source)                      as unique_sources,
                       COUNT(CASE WHEN dpt IS NOT NULL THEN 1 END) as states_with_dpt,
                       MIN(updated_at)                             as oldest_update,
                       MAX(updated_at)                             as newest_update
                FROM current_state
            `);

            // States by DPT
            const byDpt = await client.query(`
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
            this.logger.error('Failed to get state statistics', {error: err.message});
            return {summary: {}, byDpt: []};
        } finally {
            if (client) client.release();
        }
    }

    /**
     * Get top active datapoints for a given time period
     * @param {Date} startTime - Start timestamp
     * @param {number} limit - Maximum results
     * @returns {Promise<Array>} Top datapoints with event counts and current values
     */
    async getTopActiveDatapoints(startTime, limit = 20) {
        let client;
        try {
            client = await this.pool.connect();

            const active = await client.query(`
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
            this.logger.error('Failed to get top active datapoints', {error: err.message});
            return [];
        } finally {
            if (client) client.release();
        }
    }

    /**
     * Get detailed health check results
     * @returns {Promise<Object>} Complete health check data
     */
    async getHealthCheckDetails() {
        let client;
        try {
            client = await this.pool.connect();

            // Get orphaned states
            const orphanedResult = await client.query(`
                SELECT COUNT(*) as count, COUNT(DISTINCT cs.ga) as affected_gas
                FROM current_state cs
                    LEFT JOIN datapoint_mappings m
                ON cs.datapoint_id = m.datapoint_id
                WHERE m.datapoint_id IS NULL
            `);

            // Get duplicate GAs
            const duplicateResult = await client.query(`
                SELECT COUNT(*) as duplicate_count
                FROM (SELECT ga, COUNT(*) as mapping_count
                      FROM datapoint_mappings
                      GROUP BY ga
                      HAVING COUNT(*) > 1) duplicates
            `);

            // Get stale mappings
            const staleResult = await client.query(`
                SELECT COUNT(*) as count
                FROM datapoint_mappings m
                    LEFT JOIN current_state cs
                ON m.datapoint_id = cs.datapoint_id
                WHERE cs.datapoint_id IS NULL
            `);

            // Get general statistics
            const statsResult = await client.query(`
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
            this.logger.error('Failed to get health check details', {error: err.message});
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
        } finally {
            if (client) client.release();
        }
    }

    /**
     * Get detailed orphaned states
     * @param {number} limit - Maximum results
     * @returns {Promise<Object>} Orphaned states details
     */
    async getDetailedOrphanedStates(limit = 20) {
        let client;
        try {
            client = await this.pool.connect();

            const orphanedStates = await client.query(`
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

            const countResult = await client.query(`
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
            this.logger.error('Failed to get detailed orphaned states', {error: err.message});
            return {totalOrphaned: 0, states: []};
        } finally {
            if (client) client.release();
        }
    }

    /**
     * Get detailed duplicate group addresses
     * @returns {Promise<Object>} Duplicate GAs details
     */
    async getDetailedDuplicateGAs() {
        let client;
        try {
            client = await this.pool.connect();

            const duplicates = await client.query(`
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

            const countResult = await client.query(`
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
            this.logger.error('Failed to get detailed duplicate GAs', {error: err.message});
            return {totalDuplicateGAs: 0, duplicates: []};
        } finally {
            if (client) client.release();
        }
    }

    /**
     * Get detailed stale mappings
     * @param {number} limit - Maximum results
     * @returns {Promise<Object>} Stale mappings details
     */
    async getDetailedStaleMappings(limit = 20) {
        let client;
        try {
            client = await this.pool.connect();

            const staleMappings = await client.query(`
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

            const countResult = await client.query(`
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
            this.logger.error('Failed to get detailed stale mappings', {error: err.message});
            return {totalStale: 0, mappings: []};
        } finally {
            if (client) client.release();
        }
    }
}

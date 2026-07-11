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
            this.logger.error('Failed to get total event count', { error: err.message });
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
            this.logger.error('Failed to get total state count', { error: err.message });
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
            this.logger.error('Failed to get total mapping count', { error: err.message });
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
            this.logger.error('Failed to get total resource count', { error: err.message });
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
            this.logger.error('Failed to get unique GA count', { error: err.message });
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
                SELECT
                    MIN(ts) as oldest,
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
            this.logger.error('Failed to get database size', { error: err.message });
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
                SELECT
                    e.ga,
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
                LEFT JOIN datapoint_mappings m ON cs.datapoint_id = m.datapoint_id
                WHERE m.datapoint_id IS NULL
            `);
            return {
                count: this.#parseInt(result.rows[0]?.count || 0),
                affectedGAs: this.#parseInt(result.rows[0]?.affected_gas || 0),
            };
        } catch (err) {
            this.logger.error('Failed to get orphaned states info', { error: err.message });
            return { count: 0, affectedGAs: 0 };
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
                FROM (
                    SELECT ga, COUNT(*) as mapping_count
                    FROM datapoint_mappings
                    GROUP BY ga
                    HAVING COUNT(*) > 1
                ) duplicates
            `);
            return this.#parseInt(result.rows[0]?.duplicate_count || 0);
        } catch (err) {
            this.logger.error('Failed to get duplicate GA count', { error: err.message });
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
                LEFT JOIN current_state cs ON m.datapoint_id = cs.datapoint_id
                WHERE cs.datapoint_id IS NULL
            `);
            return this.#parseInt(result.rows[0]?.count || 0);
        } catch (err) {
            this.logger.error('Failed to get stale mapping count', { error: err.message });
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
                SELECT COUNT(*) as total_count FROM datapoint_mappings
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
}

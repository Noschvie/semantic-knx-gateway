// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import { createLogger } from '../utils/logger.js';

export class EventStore {
    constructor(db) {
        this.logger = createLogger('EventStore');
        this.db = db;
    }

    /**
     * Store a KNX event in the TimescaleDB hypertable
     *
     * Timestamp Convention (see docs/API_TIMESTAMP_CONVENTION.md):
     * - Accepts timestamps as ISO 8601 UTC strings (e.g., '2026-07-13T15:30:00.000Z')
     * - Always stores as UTC in the database
     * - Internal database operations use UTC exclusively
     */
    async storeEvent(event) {
        const {
            timestamp,
            datapointId,
            ga,
            source,
            eventType,
            value,
            dpt,
            rawPayload,
        } = event;

        // Handle Buffer objects
        let actualValue = value;
        let valueType = typeof value;

        if (value && typeof value === 'object' && value.type === 'Buffer') {
            const buffer = Buffer.from(value.data);
            actualValue = buffer.toString('hex');
            valueType = 'string';
        } else if (value !== null && typeof value === 'object') {
            // Store objects (e.g. DPT 11.001 date, 10.001 time) as JSON string
            actualValue = JSON.stringify(value);
            valueType = 'string';
        }

        const query = `
          INSERT INTO knx_events (
            ts, datapoint_id, ga, source, event_type,
            value_bool, value_float, value_int, value_text,
            dpt, payload
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `;

        const params = [
            timestamp,
            datapointId,
            ga,
            source,
            eventType || 'GroupValue_Write',
            valueType === 'boolean' ? actualValue : null,
            valueType === 'number' && !Number.isInteger(actualValue) ? actualValue : null,
            valueType === 'number' && Number.isInteger(actualValue) ? actualValue : null,
            valueType === 'string' ? actualValue : null,
            dpt,
            JSON.stringify(rawPayload || {}),
        ];

        try {
            this.logger.debug({
                msg: '💾 Storing event to TimescaleDB',
                ga: ga,
                datapointId: datapointId,
                value: actualValue,
                originalValueType: typeof value,
                valueType: valueType,
            });

            await this.db.query(query, params);
            this.logger.debug(`Event stored: ${ga} = ${actualValue}`);
        } catch (error) {
            this.logger.error({
                msg: 'Failed to store event',
                errorMessage: error.message,
                errorDetail: error.detail,
                errorCode: error.code,
                query: query,
                params: params,
            });
            throw error;
        }
    }

    /**
     * Get events for a specific group address
     *
     * Timestamp Convention:
     * - startTime and endTime should be Date objects representing UTC equivalents
     * - All timestamps in results are returned as UTC ISO 8601 strings
     * - See docs/API_TIMESTAMP_CONVENTION.md for details
     */
    async getEventsByGA(ga, options = {}) {
        const {
            startTime = new Date(Date.now() - 24 * 60 * 60 * 1000),
            endTime = new Date(),
            limit = 1000,
        } = options;

        const query = `
            SELECT
                ts AS timestamp,
                datapoint_id,
                ga,
                source,
                event_type,
                dpt,
                COALESCE(
                        value_text,
                        value_bool::text,
                        value_float::text,
                        value_int::text
                ) AS value
            FROM knx_events
            WHERE ga = $1 AND ts BETWEEN $2 AND $3
            ORDER BY ts DESC
            LIMIT $4
        `;

        const result = await this.db.query(query, [ga, startTime, endTime, limit]);
        return result.rows;
    }

    /**
     * Get events for a specific datapoint
     */
    async getEventsByDatapoint(datapointId, options = {}) {
        const {
            startTime = new Date(Date.now() - 24 * 60 * 60 * 1000),
            endTime = new Date(),
            limit = 1000,
        } = options;

        const query = `
            SELECT
                ts AS timestamp,
                datapoint_id,
                ga,
                source,
                event_type,
                dpt,
                COALESCE(
                        value_text,
                        value_bool::text,
                        value_float::text,
                        value_int::text
                ) AS value
            FROM knx_events
            WHERE datapoint_id = $1 AND ts BETWEEN $2 AND $3
            ORDER BY ts DESC
            LIMIT $4
        `;

        const result = await this.db.query(query, [datapointId, startTime, endTime, limit]);
        return result.rows;
    }

    /**
     * Delete events within a time range (or count them in dry-run mode).
     * Intentionally NOT filtered by group address or datapoint: this operation
     * is intended for bulk cleanup (e.g., re-importing a day replaces all
     * bus traffic logged for that day).
     *
     * @param {Date} startTime - Start of time range (inclusive)
     * @param {Date} endTime - End of time range (exclusive)
     * @param {boolean} [dryRun=false] - If true, count matching events instead of deleting
     * @returns {Promise<number>} - Number of deleted rows (or count in dry-run mode)
     */
    async deleteEventsByTimeRange(startTime, endTime, dryRun = false) {
        if (dryRun) {
            const result = await this.db.query(
                'SELECT COUNT(*) AS count FROM knx_events WHERE ts >= $1 AND ts < $2',
                [startTime, endTime],
            );
            return parseInt(result.rows[0]?.count || '0', 10);
        }

        const result = await this.db.query(
            'DELETE FROM knx_events WHERE ts >= $1 AND ts < $2',
            [startTime, endTime],
        );
        return result.rowCount || 0;
    }

    /**
     * Get aggregated statistics (using TimescaleDB functions)
     */
    async getAggregatedData(datapointId, options = {}) {
        const {
            startTime = new Date(Date.now() - 24 * 60 * 60 * 1000),
            endTime = new Date(),
            interval = '1 hour',
        } = options;

        const query = `
      SELECT 
        time_bucket($1, ts) AS bucket,
        COUNT(*) as count,
        AVG(value_float) as avg_value,
        MIN(value_float) as min_value,
        MAX(value_float) as max_value
      FROM knx_events
      WHERE datapoint_id = $2 AND ts BETWEEN $3 AND $4
      GROUP BY bucket
      ORDER BY bucket DESC
    `;

        const result = await this.db.query(query, [interval, datapointId, startTime, endTime]);
        return result.rows;
    }
}

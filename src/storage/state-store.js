// SPDX-License-Identifier: CC-BY-NC-SA-4.0
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import { createLogger } from '../utils/logger.js';

export class StateStore {
    constructor(db) {
        this.logger = createLogger('StateStore');
        this.db = db;
    }

    /**
     * Normalize a value from DB – convert Buffer-objects to hex strings
     */
    normalizeValue(value) {
        if (value === null || value === undefined) return value;
        if (typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
            return Buffer.from(value.data).toString('hex');
        }
        return value;
    }

    /**
     * Update the current state for a datapoint
     */
    async updateState(datapointId, state) {
        const {ga, value, dpt, source, timestamp} = state;

        // Handle Buffer objects properly
        let valueForJson = value;
        let valueForText = null;

        if (value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) {
            // Store raw buffer as hex string for text representation
            const buffer = Buffer.from(value.data);
            valueForText = buffer.toString('hex');
            // Keep original structure for JSON
            valueForJson = value;
        } else if (Buffer.isBuffer(value)) {
            // Handle actual Buffer instances
            valueForText = value.toString('hex');
            valueForJson = {type: 'Buffer', data: Array.from(value)};
        } else {
            // Regular values
            valueForText = String(value);
            valueForJson = value;
        }

        const query = `
            INSERT INTO current_state (datapoint_id, ga, value, value_decoded, dpt, updated_at, source)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (datapoint_id)
                DO UPDATE SET value         = $3,
                              value_decoded = $4,
                              dpt           = $5,
                              updated_at    = $6,
                              source        = $7
        `;

        const params = [
            datapointId,
            ga,
            JSON.stringify(valueForJson),
            valueForText,
            dpt,
            timestamp,
            source
        ];

        try {
            await this.db.query(query, params);
            this.logger.debug(`State updated: ${datapointId} = ${valueForText || value}`);
        } catch (error) {
            this.logger.error({
                msg: 'Failed to update state',
                errorMessage: error.message,
                errorDetail: error.detail,
                errorCode: error.code,
                datapointId: datapointId,
                ga: ga,
                value: value,
                valueType: typeof value,
                isBufferObject: !!(value && typeof value === 'object' && value.type === 'Buffer'),
                valueForText: valueForText,
                dpt: dpt,
                timestamp: timestamp,
                source: source
            });
            throw error;
        }
    }

    /**
     * Get the current state for a datapoint
     */
    async getState(datapointId) {
        const query = `
            SELECT cs.*, dm.name
            FROM current_state cs
                     LEFT JOIN datapoint_mappings dm ON dm.datapoint_id = cs.datapoint_id
            WHERE cs.datapoint_id = $1
        `;
        const result = await this.db.query(query, [datapointId]);

        if (result.rows.length === 0) return null;

        const row = result.rows[0];
        return {
            datapointId: row.datapoint_id,
            ga: row.ga,
            name: row.name ?? null,
            value: this.normalizeValue(row.value),
            dpt: row.dpt,
            updatedAt: row.updated_at,
            source: row.source
        };
    }

    /**
     * Get all current states, optionally filtered by internal location ID
     */
    async getAllStates({ locationId } = {}) {
        let query;
        let params = [];

        if (locationId) {
            // Determine GAs that belong to devices located in the location
            // Path: location -containsDevice-> device <- linkedToDevice- groupAddress
            query = `
                SELECT cs.*, dm.name, dm.location_id
                FROM current_state cs
                    LEFT JOIN datapoint_mappings dm ON dm.datapoint_id = cs.datapoint_id
                WHERE cs.ga IN (
                    SELECT DISTINCT (ga_res.resource->>'address') AS address
                    FROM semantic_relationships r_room
                    JOIN semantic_relationships r_dev
                        ON r_dev.object = r_room.object
                        AND r_dev.predicate = 'linkedToDevice'
                    JOIN semantic_resources ga_res
                        ON ga_res.id = r_dev.subject
                        AND ga_res.type = 'groupAddress'
                    WHERE r_room.subject = $1
                        AND r_room.predicate = 'containsDevice'
                )
                ORDER BY cs.updated_at DESC
            `;
            params = [locationId];
        } else {
            query = `
                SELECT cs.*, dm.name, dm.location_id
                FROM current_state cs
                    LEFT JOIN datapoint_mappings dm ON dm.datapoint_id = cs.datapoint_id
                ORDER BY cs.updated_at DESC
            `;
        }

        const result = await this.db.query(query, params);

        return result.rows.map(row => ({
            datapointId: row.datapoint_id,
            ga: row.ga,
            name: row.name ?? null,
            value: this.normalizeValue(row.value),
            dpt: row.dpt,
            updatedAt: row.updated_at,
            source: row.source,
            locationId: row.location_id ?? null,
        }));
    }

    /**
     * Get states by group address
     */
    async getStateByGA(ga) {
        const query = `
            SELECT cs.*, dm.name
            FROM current_state cs
                     LEFT JOIN datapoint_mappings dm ON dm.datapoint_id = cs.datapoint_id
            WHERE cs.ga = $1
        `;
        const result = await this.db.query(query, [ga]);

        if (result.rows.length === 0) return null;

        const row = result.rows[0];
        return {
            datapointId: row.datapoint_id,
            ga: row.ga,
            name: row.name ?? null,
            value: this.normalizeValue(row.value),
            dpt: row.dpt,
            updatedAt: row.updated_at,
            source: row.source
        };
    }
}


// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

/**
 * dpt-history.js – DPT Change Tracking & Interpretation
 *
 * Handles:
 * 1. Logging DPT changes for audit trail
 * 2. Finding the DPT that was active at a given timestamp
 * 3. Ensuring correct value interpretation even after DPT changes
 */

export class DptHistoryManager {
    constructor(db, logger) {
        this.db = db;
        this.logger = logger;
    }

    /**
     * Log a DPT change
     * @param {string} datapointId - Datapoint ID
     * @param {string} ga - Group address
     * @param {string} oldDpt - Previous DPT (null if first assignment)
     * @param {string} newDpt - New DPT
     * @param {string} changedBy - Who made the change ('system', 'admin', 'import', etc.)
     * @param {string} reason - Optional reason for change
     * @returns {Promise<void>}
     */
    async logDptChange(datapointId, ga, oldDpt, newDpt, changedBy = 'system', reason = null) {
        try {
            // Only log if DPT actually changed
            if (oldDpt === newDpt) return;

            await this.db.query(
                `INSERT INTO dpt_change_log (datapoint_id, ga, old_dpt, new_dpt, changed_by, reason)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [datapointId, ga, oldDpt || null, newDpt, changedBy, reason]
            );

            this.logger.info(
                `[DPT Change] GA ${ga}: ${oldDpt || 'none'} → ${newDpt} (${changedBy})`
            );
        } catch (error) {
            this.logger.error(`[DPT History] Failed to log change for ${ga}:`, error.message);
        }
    }

    /**
     * Get the DPT that was active at a specific timestamp
     * @param {string} ga - Group address
     * @param {Date|string} timestamp - Point in time
     * @returns {Promise<string|null>} - The DPT that was active at that time
     */
    async getDptAtTime(ga, timestamp) {
        try {
            const result = await this.db.query(
                `SELECT new_dpt FROM dpt_change_log
                 WHERE ga = $1 AND changed_at <= $2
                 ORDER BY changed_at DESC
                 LIMIT 1`,
                [ga, new Date(timestamp)]
            );

            if (result.rows.length === 0) {
                // No change log entry – check current mapping
                const mappingResult = await this.db.query(
                    `SELECT dpt FROM datapoint_mappings WHERE ga = $1`,
                    [ga]
                );
                return mappingResult.rows[0]?.dpt || null;
            }

            return result.rows[0].new_dpt;
        } catch (error) {
            this.logger.error(`[DPT History] Failed to get DPT at time for ${ga}:`, error.message);
            return null;
        }
    }

    /**
     * Get complete history of DPT changes for a GA
     * @param {string} ga - Group address
     * @returns {Promise<Array>} - List of all DPT changes with timestamps
     */
    async getDptHistory(ga) {
        try {
            const result = await this.db.query(
                `SELECT 
                    id,
                    datapoint_id,
                    old_dpt,
                    new_dpt,
                    changed_at,
                    changed_by,
                    reason
                 FROM dpt_change_log
                 WHERE ga = $1
                 ORDER BY changed_at ASC`,
                [ga]
            );

            return result.rows;
        } catch (error) {
            this.logger.error(`[DPT History] Failed to get history for ${ga}:`, error.message);
            return [];
        }
    }

    /**
     * Detect DPT conflicts when loading new mappings
     * Returns violations where same GA gets assigned different DPTs
     * @param {Array} newMappings - New mappings to import
     * @returns {Promise<Array>} - Conflicts found
     */
    async detectDptConflicts(newMappings) {
        try {
            const conflicts = [];
            const gaMap = new Map();

            // Group new mappings by GA
            for (const mapping of newMappings) {
                if (!mapping.ga) continue;
                if (!gaMap.has(mapping.ga)) {
                    gaMap.set(mapping.ga, []);
                }
                gaMap.get(mapping.ga).push(mapping);
            }

            // Check for duplicates within new mappings
            for (const [ga, mappings] of gaMap.entries()) {
                const dpts = new Set(mappings.map(m => m.dpt).filter(Boolean));
                if (dpts.size > 1) {
                    conflicts.push({
                        ga,
                        type: 'DUPLICATE_DPT_IN_IMPORT',
                        dpts: Array.from(dpts),
                        count: mappings.length
                    });
                }
            }

            // Check against existing mappings
            for (const [ga, newMappings] of gaMap.entries()) {
                const currentResult = await this.db.query(
                    `SELECT dpt FROM datapoint_mappings WHERE ga = $1`,
                    [ga]
                );

                if (currentResult.rows.length > 0) {
                    const currentDpt = currentResult.rows[0].dpt;
                    const newDpts = new Set(newMappings.map(m => m.dpt).filter(Boolean));

                    if (newDpts.size === 1) {
                        const newDpt = Array.from(newDpts)[0];
                        if (newDpt !== currentDpt) {
                            conflicts.push({
                                ga,
                                type: 'DPT_CHANGE_DETECTED',
                                old_dpt: currentDpt,
                                new_dpt: newDpt
                            });
                        }
                    }
                }
            }

            return conflicts;
        } catch (error) {
            this.logger.error('[DPT History] Failed to detect conflicts:', error.message);
            return [];
        }
    }

    /**
     * Get statistics about DPT changes
     * @returns {Promise<Object>} - Stats about DPT change frequency
     */
    async getStatistics() {
        try {
            const result = await this.db.query(
                `SELECT 
                    COUNT(*) as total_changes,
                    COUNT(DISTINCT ga) as gas_with_changes,
                    COUNT(DISTINCT datapoint_id) as datapoints_with_changes,
                    MAX(changed_at) as last_change,
                    STRING_AGG(DISTINCT changed_by, ', ') as change_authors
                 FROM dpt_change_log`
            );

            return result.rows[0] || {
                total_changes: 0,
                gas_with_changes: 0,
                datapoints_with_changes: 0,
                last_change: null,
                change_authors: null
            };
        } catch (error) {
            this.logger.error('[DPT History] Failed to get statistics:', error.message);
            return null;
        }
    }
}

export default DptHistoryManager;



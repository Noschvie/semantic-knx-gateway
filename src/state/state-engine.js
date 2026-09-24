// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import { createLogger } from '../utils/logger.js';
import { EventBus } from './event-bus.js';
import { EventStore } from '../storage/event-store.js';
import { StateStore } from '../storage/state-store.js';
import { DptHistoryManager } from '../storage/dpt-history.js';

export class StateEngine {
    constructor(db) {
        this.logger = createLogger('StateEngine');
        this.db = db;
        this.eventBus = new EventBus();
        this.eventStore = new EventStore(db);
        this.stateStore = new StateStore(db);
        this.dptHistory = new DptHistoryManager(db, this.logger);
        this.datapointMappings = new Map(); // GA -> Datapoint mapping
    }

    async initialize() {
        this.logger.info('Initializing State Engine...');

        // Load datapoint mappings from database
        await this.loadDatapointMappings();


        this.logger.info('✅ State Engine initialized');
    }

    /**
     * Load datapoint mappings from a database
     */
    async loadDatapointMappings() {
        try {
            const result = await this.db.query(`
        SELECT datapoint_id, ga, dpt, name FROM datapoint_mappings
      `);

            result.rows.forEach(row => {
                this.datapointMappings.set(row.ga, {
                    datapointId: row.datapoint_id,
                    dpt: row.dpt,
                    name: row.name,
                });
            });

            this.logger.info(`Loaded ${this.datapointMappings.size} datapoint mappings`);
        } catch (error) {
            this.logger.warn('Failed to load datapoint mappings:', error);
        }
    }

    /**
     * Reconciles synthetic fallback current_state rows onto their canonical
     * datapointId. A synthetic row ('ga-<a>-<b>-<c>') is created when a telegram
     * arrives before its mapping exists (e.g., new GAs are commissioned in ETS
     * while the running gateway still has the old TTL). After the TTL is replaced
     * and the container restarted, the canonical mapping exists, so these rows
     * become duplicates.
     *
     * Run this AFTER the TTL import (mappings must exist) and BEFORE connecting
     * the KNX bus. Only synthetic rows that have a matching mapping are touched;
     * genuine unprojected datapoints are left intact.
     *
     * @param {object} [opts]
     * @param {number} [opts.windowMinutes=0] - If > 0, only reconcile rows whose
     *   updated_at is within the last N minutes. 0 = no time limit (all).
     * @returns {Promise<{reconciled: number}>}
     */
    async reconcileFallbackStates({ windowMinutes = 0 } = {}) {
        try {
            const params = [];
            let timeClause = '';
            if (Number.isFinite(windowMinutes) && windowMinutes > 0) {
                timeClause = 'AND cs.updated_at >= NOW() - make_interval(mins => ($1)::int)';
                params.push(windowMinutes);
            }

            const { rows } = await this.db.query(`
                SELECT cs.ga, dm.datapoint_id AS canonical_id
                FROM current_state cs
                JOIN datapoint_mappings dm ON dm.ga = cs.ga
                WHERE cs.datapoint_id = 'ga-' || replace(cs.ga, '/', '-')
                  AND cs.datapoint_id <> dm.datapoint_id
                  ${timeClause}
            `, params);

            if (rows.length === 0) {
                this.logger.info('[Dedup] No synthetic fallback states to reconcile');
                return { reconciled: 0 };
            }

            const scope = windowMinutes > 0 ? ` from the last ${windowMinutes} min` : '';
            this.logger.info(`[Dedup] Reconciling ${rows.length} synthetic fallback state(s)${scope}`);

            let count = 0;
            for (const row of rows) {
                if (await this.migrateFallbackState(row.ga, row.canonical_id)) count++;
            }

            this.logger.info(`[Dedup] Reconciliation complete: ${count} state(s) migrated/cleaned`);
            return { reconciled: count };
        } catch (error) {
            this.logger.warn({ msg: 'reconcileFallbackStates failed', error: error.message });
            return { reconciled: 0, error: error.message };
        }
    }

    /**
     * Migrates a single synthetic fallback row (e.g. "ga-2-4-0") onto the
     * canonical datapointId (e.g. "GA-471"), value-preserving. On conflict the
     * newest value (by updated_at) is kept.
     *
     * @param {string} ga          - Group address, e.g. "2/4/0".
     * @param {string} canonicalId - Projected datapointId, e.g. "GA-471".
     * @returns {Promise<boolean>} true if a synthetic row was migrated/removed.
     */
    async migrateFallbackState(ga, canonicalId) {
        if (!ga || !canonicalId) return false;

        const syntheticId = `ga-${ga.replace(/\//g, '-')}`;
        if (syntheticId === canonicalId) return false;

        try {
            const { rows } = await this.db.query(
                'SELECT datapoint_id, updated_at FROM current_state WHERE datapoint_id IN ($1, $2)',
                [syntheticId, canonicalId],
            );

            const synthetic = rows.find(r => r.datapoint_id === syntheticId);
            if (!synthetic) return false; // nothing to migrate

            const canonical = rows.find(r => r.datapoint_id === canonicalId);

            if (!canonical) {
                // No canonical row yet → rename synthetic to canonical (keeps value).
                await this.db.query(
                    'UPDATE current_state SET datapoint_id = $1 WHERE datapoint_id = $2',
                    [canonicalId, syntheticId],
                );
                this.logger.info(`[Dedup] Migrated ${syntheticId} → ${canonicalId} (GA ${ga})`);
                return true;
            }

            const syntheticNewer =
                new Date(synthetic.updated_at).getTime() > new Date(canonical.updated_at).getTime();

            if (syntheticNewer) {
                // Value-preserving: copy synthetic values onto canonical, drop synthetic.
                await this.db.query(
                    `UPDATE current_state canon
                        SET value         = syn.value,
                            value_decoded = syn.value_decoded,
                            dpt           = syn.dpt,
                            updated_at    = syn.updated_at,
                            source        = syn.source
                       FROM current_state syn
                      WHERE canon.datapoint_id = $1 AND syn.datapoint_id = $2`,
                    [canonicalId, syntheticId],
                );
                await this.db.query('DELETE FROM current_state WHERE datapoint_id = $1', [syntheticId]);
                this.logger.info(`[Dedup] Canonical ${canonicalId} updated from newer ${syntheticId}, synthetic dropped (GA ${ga})`);
            } else {
                await this.db.query('DELETE FROM current_state WHERE datapoint_id = $1', [syntheticId]);
                this.logger.info(`[Dedup] Dropped stale ${syntheticId}, kept ${canonicalId} (GA ${ga})`);
            }
            return true;
        } catch (error) {
            this.logger.warn({ msg: 'migrateFallbackState failed', ga, canonicalId, error: error.message });
            return false;
        }
    }


    /**
     * Register a datapoint mapping
     */
    async registerDatapoint(ga, mapping) {
        const { datapointId, dpt, name, locationId, deviceId, functionId, metadata } = mapping;

        // Get old mapping to detect DPT changes
        const oldMappingResult = await this.db.query(
            'SELECT dpt FROM datapoint_mappings WHERE datapoint_id = $1',
            [datapointId],
        );
        const oldDpt = oldMappingResult.rows[0]?.dpt || null;

        const query = `
      INSERT INTO datapoint_mappings (
        datapoint_id, ga, dpt, name, location_id, device_id, function_id, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (datapoint_id)
      DO UPDATE SET
        ga = $2, dpt = $3, name = $4,
        location_id = $5, device_id = $6, function_id = $7, metadata = $8
    `;

        await this.db.query(query, [
            datapointId,
            ga,
            dpt,
            name,
            locationId,
            deviceId,
            functionId,
            JSON.stringify(metadata || {}),
        ]);

        // Log DPT change if it occurred
        if (oldDpt && oldDpt !== dpt) {
            await this.dptHistory.logDptChange(
                datapointId,
                ga,
                oldDpt,
                dpt,
                'import',
                'DPT changed during mapping update',
            );
            this.logger.warn(`[DPT Change] GA ${ga}: ${oldDpt} → ${dpt}`);
        } else if (dpt && !oldDpt) {
            // First time DPT is assigned
            await this.dptHistory.logDptChange(
                datapointId,
                ga,
                null,
                dpt,
                'import',
                'Initial DPT assignment',
            );
        }

        this.datapointMappings.set(ga, { datapointId, dpt, name });
        this.logger.debug(`Registered datapoint: ${ga} -> ${datapointId}`);
    }

    /**
     * Process incoming KNX telegram
     */
    async processTelegram(telegram) {
        const { timestamp, event, source, ga, value, dpt } = telegram;

        if (!ga) {
            this.logger.warn({ msg: 'Skipping telegram with empty group address', telegram });
            return;
        }

        let datapointId;

        try {
            // Get datapoint mapping
            const mapping = this.datapointMappings.get(ga);
            datapointId = mapping?.datapointId || `ga-${ga.replace(/\//g, '-')}`;
            const effectiveDpt = dpt || mapping?.dpt;

            // Log processing
            this.logger.debug({
                msg: '🔄 Processing telegram',
                ga: ga,
                datapointId: datapointId,
                value: value,
                dpt: effectiveDpt,
                source: source,
                hasMapping: !!mapping,
            });

            // Create enriched event
            const enrichedEvent = {
                timestamp: timestamp || new Date().toISOString(),
                datapointId,
                ga,
                source,
                eventType: event,
                value,
                dpt: effectiveDpt,
                rawPayload: telegram,
            };

            // Store event in TimescaleDB
            await this.eventStore.storeEvent(enrichedEvent);

            // Update current state
            await this.stateStore.updateState(datapointId, {
                ga,
                value,
                dpt: effectiveDpt,
                source,
                timestamp: enrichedEvent.timestamp,
            });

            // Emit to subscribers
            this.eventBus.emit('telegram', enrichedEvent);
            this.eventBus.emit(`ga:${ga}`, enrichedEvent);
            this.eventBus.emit(`datapoint:${datapointId}`, enrichedEvent);

            //this.logger.debug(`Processed: ${ga} (${datapointId}) = ${value}`);
            this.logger.debug({
                msg: '✅ Telegram processed successfully',
                ga: ga,
                datapointId: datapointId,
                value: value,
            });
        } catch (error) {
            this.logger.error({
                msg: 'Error processing telegram',
                errorMessage: error.message,
                errorStack: error.stack,
                telegramGa: telegram?.ga,
                telegramValue: telegram?.value,
                telegramSource: telegram?.source,
                telegramEvent: telegram?.event,
                datapointId: datapointId || 'unknown',
            });
            throw error;
        }
    }

    /**
     * Get current state
     */
    async getCurrentState(datapointId) {
        return await this.stateStore.getState(datapointId);
    }

    /**
     * Update the current state
     */
    async updateState(datapointId, state) {
        return await this.stateStore.updateState(datapointId, state);
    }

    /**
     * Get all current states
     */
    async getAllStates(options = {}) {
        return await this.stateStore.getAllStates(options);
    }

    /**
     * Get historical events
     */
    async getHistory(datapointId, options) {
        return await this.eventStore.getEventsByDatapoint(datapointId, options);
    }

    /**
     * Subscribe to events
     */
    subscribe(event, callback) {
        return this.eventBus.on(event, callback);
    }

    /**
     * Unsubscribe from events
     */
    unsubscribe(event, callback) {
        this.eventBus.off(event, callback);
    }
}

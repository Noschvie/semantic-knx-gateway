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

        // Reconcile any synthetic fallback states left over from telegrams that
        // arrived before their mapping existed, so each GA maps to exactly one
        // canonical datapoint (deterministic across restarts).
        await this.cleanupFallbackStates();

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
     * Reconciles all synthetic fallback current_state rows that already have a
     * projected mapping onto their canonical datapointId. Only rows that are
     * actual duplicates are touched, keeping startup fast.
     */
    async cleanupFallbackStates() {
        try {
            const { rows } = await this.db.query(`
                SELECT cs.ga, dm.datapoint_id AS canonical_id
                FROM current_state cs
                JOIN datapoint_mappings dm ON dm.ga = cs.ga
                WHERE cs.datapoint_id = 'ga-' || replace(cs.ga, '/', '-')
                  AND cs.datapoint_id <> dm.datapoint_id
            `);

            if (rows.length === 0) return;

            this.logger.info(`[Dedup] Reconciling ${rows.length} fallback state(s) with existing mappings`);
            for (const row of rows) {
                await this.migrateFallbackState(row.ga, row.canonical_id);
            }
        } catch (error) {
            this.logger.warn({ msg: 'cleanupFallbackStates failed', error: error.message });
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

        // Fix duplicate datapoints: a telegram received before this mapping was
        // loaded may have persisted a synthetic fallback state ("ga-2-4-0").
        // Migrate it onto the canonical datapointId so the API returns exactly
        // one datapoint per GA.
        await this.migrateFallbackState(ga, datapointId);
    }

    /**
     * Migrates a synthetic fallback current_state row (e.g. "ga-2-4-0") onto the
     * canonical datapointId (e.g. "GA-471") once a projected mapping exists for
     * the group address.
     *
     * Conflict resolution: if a canonical current_state row already exists, the
     * row with the newest updated_at is kept and the other is dropped.
     *
     * @param {string} ga          - Group address, e.g. "2/4/0".
     * @param {string} canonicalId - Projected datapointId, e.g. "GA-471".
     */
    async migrateFallbackState(ga, canonicalId) {
        if (!ga || !canonicalId) return;

        const syntheticId = `ga-${ga.replace(/\//g, '-')}`;
        if (syntheticId === canonicalId) return;

        try {
            const { rows } = await this.db.query(
                `SELECT datapoint_id, updated_at
                   FROM current_state
                  WHERE datapoint_id IN ($1, $2)`,
                [syntheticId, canonicalId],
            );

            const synthetic = rows.find(r => r.datapoint_id === syntheticId);
            if (!synthetic) return; // nothing to migrate

            const canonical = rows.find(r => r.datapoint_id === canonicalId);

            if (!canonical) {
                // No canonical row yet → simply rename the synthetic row.
                await this.db.query(
                    'UPDATE current_state SET datapoint_id = $1 WHERE datapoint_id = $2',
                    [canonicalId, syntheticId],
                );
                this.logger.info(`[Dedup] Migrated fallback state ${syntheticId} → ${canonicalId} (GA ${ga})`);
                return;
            }

            // Both rows exist → keep the one with the newest updated_at.
            const syntheticNewer =
                new Date(synthetic.updated_at).getTime() > new Date(canonical.updated_at).getTime();

            if (syntheticNewer) {
                await this.db.query('DELETE FROM current_state WHERE datapoint_id = $1', [canonicalId]);
                await this.db.query(
                    'UPDATE current_state SET datapoint_id = $1 WHERE datapoint_id = $2',
                    [canonicalId, syntheticId],
                );
                this.logger.info(`[Dedup] Replaced canonical ${canonicalId} with newer fallback ${syntheticId} (GA ${ga})`);
            } else {
                await this.db.query('DELETE FROM current_state WHERE datapoint_id = $1', [syntheticId]);
                this.logger.info(`[Dedup] Dropped stale fallback state ${syntheticId}, kept ${canonicalId} (GA ${ga})`);
            }
        } catch (error) {
            this.logger.warn({ msg: 'migrateFallbackState failed', ga, canonicalId, error: error.message });
        }
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

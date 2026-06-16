// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import { createLogger } from '../utils/logger.js';
import { EventBus } from './event-bus.js';
import { EventStore } from '../storage/event-store.js';
import { StateStore } from '../storage/state-store.js';

export class StateEngine {
    constructor(db) {
        this.logger = createLogger('StateEngine');
        this.db = db;
        this.eventBus = new EventBus();
        this.eventStore = new EventStore(db);
        this.stateStore = new StateStore(db);
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
     * Register a datapoint mapping
     */
    async registerDatapoint(ga, mapping) {
        const { datapointId, dpt, name, locationId, deviceId, functionId, metadata } = mapping;

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

// SPDX-License-Identifier: CC-BY-NC-SA-4.0
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import { createLogger } from '../utils/logger.js';
import { GraphBuilder } from './graph-builder.js';
import { ResourceStore } from './resource-store.js';
import { SemanticMapper } from './semantic-mapper.js';

export class SemanticEngine {
    constructor(db, stateEngine) {
        this.logger = createLogger('SemanticEngine');
        this.db = db;
        this.stateEngine = stateEngine;

        this.graphBuilder = new GraphBuilder();
        this.resourceStore = new ResourceStore(db);
        this.semanticMapper = new SemanticMapper(this.resourceStore, stateEngine);

        this.graph = null;
        this.deviceToGaMap = new Map(); // internalDeviceId → Set<gaAddress>
    }

    /**
     * Initialize semantic engine with a TTL file
     */
    async initialize(ttlFilePath) {
        if (!ttlFilePath) {
            this.logger.info('No TTL file provided, skipping semantic layer initialization');
            return;
        }

        try {
            this.logger.info('Initializing semantic engine...');

            // Build graph from TTL
            this.graph = await this.graphBuilder.buildFromTTL(ttlFilePath);

            // Lookup-Map einmalig aufbauen
            this.deviceToGaMap = this._buildDeviceToGaMap(this.graph.groupAddresses);
            this.logger.info(`Built device→GA map for ${this.deviceToGaMap.size} devices`);

            // Store graph in database
            await this.resourceStore.storeGraph(this.graph);

            // Map to state engine
            await this.semanticMapper.mapDatapointsToStateEngine(this.graph);

            // Reload the StateEngine's in-memory cache after the TTL import
            await this.stateEngine.loadDatapointMappings();

            this.logger.info('✅ Semantic engine initialized');
        } catch (error) {
            this.logger.error('Failed to initialize semantic engine:', error);
            throw error;
        }
    }

    /**
     * Get semantic information for a datapoint
     */
    async getDatapointInfo(datapointId) {
        const datapoint = await this.resourceStore.getResource(datapointId);

        if (!datapoint) {
            return null;
        }

        const semanticPath = await this.semanticMapper.getSemanticPath(datapointId);
        const mqttTopic = await this.semanticMapper.generateMQTTTopic(datapointId);

        return {
            ...datapoint,
            semanticPath,
            mqttTopic
        };
    }

    /**
     * Get location hierarchy
     */
    async getLocationHierarchy() {
        return await this.resourceStore.getLocationHierarchy();
    }

    /**
     * Get a single location by ID or name
     */
    async getLocation(idOrName) {
        // Try by ID first
        let location = await this.resourceStore.getResource(idOrName);

        // Fallback: search by name (case-insensitive)
        if (!location) {
            const all = await this.resourceStore.getResourcesByType('location');
            location = all.find(
                (l) => l.name?.toLowerCase() === idOrName.toLowerCase()
            ) ?? null;
        }

        return location;
    }

    /**
     * Get all devices
     */
    async getAllDevices() {
        return await this.resourceStore.getResourcesByType('device');
    }

    /**
     * Get a device with all its datapoints
     */
    async getDeviceDetails(deviceId) {
        return await this.resourceStore.getDeviceWithDatapoints(deviceId);
    }

    /**
     * Get all functions
     */
    async getAllFunctions() {
        return await this.resourceStore.getResourcesByType('function');
    }

    /**
     * Search across all resources
     */
    async search(query) {
        return await this.resourceStore.searchResources(query);
    }

    /**
     * Enrich a telegram with semantic context
     */
    async enrichTelegram(telegram) {
        return await this.semanticMapper.enrichTelegram(telegram);
    }

    /**
     * Gibt alle GA-Adressen zurück, die mit einem bestimmten Device verbunden sind.
     * @param {string} internalDeviceId - Die interne Device-ID (uri)
     * @returns {Set<string>} Set mit GA-Adressen (z.B. "1/1/83")
     */
    getGasByDevice(internalDeviceId) {
        return this.deviceToGaMap.get(internalDeviceId) ?? new Set();
    }

    /**
     * Baut eine invertierte Map: internalDeviceId → Set<gaAddress>
     * aus der GroupAddress-Liste des Graphen auf.
     * @param {Array} groupAddresses
     * @returns {Map<string, Set<string>>}
     */
    _buildDeviceToGaMap(groupAddresses) {
        const map = new Map();
        for (const ga of groupAddresses) {
            for (const cd of ga.connectedDevices ?? []) {
                const devId = cd.deviceId ?? cd.uri;
                if (!devId) continue;
                if (!map.has(devId)) map.set(devId, new Set());
                map.get(devId).add(ga.address);
            }
        }
        return map;
    }
}
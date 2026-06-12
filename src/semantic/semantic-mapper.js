// SPDX-License-Identifier: CC-BY-NC-SA-4.0
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import { createLogger } from '../utils/logger.js';

export class SemanticMapper {
    constructor(resourceStore, stateEngine) {
        this.logger = createLogger('SemanticMapper');
        this.resourceStore = resourceStore;
        this.stateEngine = stateEngine;
    }

    /**
     * Map datapoints to group addresses in state engine
     */
    async mapDatapointsToStateEngine(graph) {
        this.logger.info('Mapping datapoints to state engine...');

        let mappedCount = 0;

        // Map from datapoints
        for (const datapoint of graph.datapoints) {
            if (datapoint.groupAddress) {
                await this.mapDatapoint(datapoint);
                mappedCount++;
            }
        }

        // Map from group addresses
        for (const ga of graph.groupAddresses) {
            if (ga.address) {
                await this.mapGroupAddress(ga);
                mappedCount++;
            }
        }

        this.logger.info(`✅ Mapped ${mappedCount} datapoints to state engine`);
    }

    /**
     * Map single datapoint to state engine
     */
    async mapDatapoint(datapoint) {
        const ga = this.normalizeGroupAddress(datapoint.groupAddress);

        if (!ga) {
            this.logger.warn(`No valid group address for datapoint ${datapoint.id}`);
            return;
        }

        const mapping = {
            datapointId: datapoint.id,
            dpt: datapoint.dpt,
            name: datapoint.name,
            locationId: datapoint.location,
            deviceId: datapoint.device,
            functionId: datapoint.function,
            metadata: {
                uri: datapoint.uri,
                valueType: datapoint.valueType,
                flags: datapoint.flags,
                properties: datapoint.properties
            }
        };

        await this.stateEngine.registerDatapoint(ga, mapping);

        this.logger.debug(`Mapped: ${datapoint.id} -> ${ga} (${datapoint.dpt})`);
    }

    /**
     * Map group address to state engine
     */
    async mapGroupAddress(ga) {
        const address = this.normalizeGroupAddress(ga.address);

        if (!address) {
            this.logger.warn(`Invalid group address: ${ga.address}`);
            return;
        }

        const mapping = {
            datapointId: ga.id,
            dpt: ga.dpt,
            name: ga.name,
            metadata: {
                uri: ga.uri,
                datapoints: ga.datapoints,
                properties: ga.properties
            }
        };

        await this.stateEngine.registerDatapoint(address, mapping);

        this.logger.debug(`Mapped GA: ${ga.id} -> ${address}`);
    }

    /**
     * Normalize group address to format "X/Y/Z"
     */
    normalizeGroupAddress(ga) {
        if (!ga) return null;

        // Remove common prefixes
        ga = ga.replace(/^(ga:|groupAddress:)/i, '');

        // If already in correct format
        if (/^\d+\/\d+\/\d+$/.test(ga)) {
            return ga;
        }

        // Convert from two-level (X/Y) to three-level (X/Y/0)
        if (/^\d+\/\d+$/.test(ga)) {
            return `${ga}/0`;
        }

        // Convert from integer (e.g., 2561 -> 1/2/1)
        if (/^\d+$/.test(ga)) {
            const num = parseInt(ga);
            const main = (num >> 11) & 0x1F;
            const middle = (num >> 8) & 0x07;
            const sub = num & 0xFF;
            return `${main}/${middle}/${sub}`;
        }

        this.logger.warn(`Could not normalize group address: ${ga}`);
        return null;
    }

    /**
     * Enrich a telegram with semantic information
     */
    async enrichTelegram(telegram) {
        const { ga, datapointId } = telegram;

        // Get datapoint resource
        const datapoint = await this.resourceStore.getResource(datapointId);

        if (!datapoint) {
            return telegram;
        }

        // Get related resources
        const enriched = { ...telegram };

        if (datapoint.device) {
            enriched.device = await this.resourceStore.getResource(datapoint.device);
        }

        if (datapoint.location) {
            enriched.location = await this.resourceStore.getResource(datapoint.location);
        }

        if (datapoint.function) {
            enriched.function = await this.resourceStore.getResource(datapoint.function);
        }

        enriched.datapoint = datapoint;

        return enriched;
    }

    /**
     * Get a semantic path for datapoint
     * Example: "Building / Floor 1 / Living Room / Light / Brightness"
     */
    async getSemanticPath(datapointId) {
        const datapoint = await this.resourceStore.getResource(datapointId);

        if (!datapoint) {
            return null;
        }

        const path = [];

        // For groupAddress resources: find location via relationships
        // Room → containsDevice → Device → linkedToDevice ← GA
        // Simpler: find which room contains a device linked to this GA
        const locationPath = await this.resolveLocationPath(datapointId);
        if (locationPath.length > 0) {
            path.push(...locationPath);
        }

        // Add datapoint name
        path.push(datapoint.name);

        return path.join(' / ');
    }

    /**
     * Resolve a full location path (Building / Floor / Room) for a resource
     * by traversing the relationship table upward via parentId.
     */
    async resolveLocationPath(datapointId) {
        // Find room that contains a device linked to this GA
        const result = await this.resourceStore.db.query(`
                SELECT sr.resource
                FROM semantic_relationships rel_ga      -- GA linkedToDevice → device
                JOIN semantic_relationships rel_room    -- room containsDevice → device
                  ON rel_room.object = rel_ga.object
                 AND rel_room.predicate = 'containsDevice'
                JOIN semantic_resources sr
                  ON sr.id = rel_room.subject
                 AND sr.type = 'location'
                WHERE rel_ga.subject = $1
                  AND rel_ga.predicate = 'linkedToDevice'
                LIMIT 1
            `, [datapointId]);

        if (result.rows.length === 0) {
            return [];
        }

        const room = result.rows[0].resource;
        return this.buildLocationAncestors(room);
    }

    /**
     * Walk up the parentId chain and return [building, floor, room] names.
     */
    async buildLocationAncestors(location) {
        const chain = [location];

        let current = location;
        while (current.parentId) {
            const parent = await this.resourceStore.getResource(current.parentId);
            if (!parent) break;
            chain.unshift(parent);
            current = parent;
        }

        return chain.map((l) => l.name);
    }

    /**
     * Generate MQTT topic from a semantic path
     */
    async generateMQTTTopic(datapointId) {
        const datapoint = await this.resourceStore.getResource(datapointId);

        if (!datapoint) {
            return `knx/datapoint/${datapointId}`;
        }

        const parts = ['knx'];

        // Resolve full location path via relationships
        const locationPath = await this.resolveLocationPath(datapointId);
        for (const name of locationPath) {
            parts.push(this.slugify(name));
        }

        parts.push(this.slugify(datapoint.name));

        return parts.join('/');
    }

    /**
     * Slugify string for use in topics/paths
     */
    slugify(text) {
        return text
            .toLowerCase()
            .replace(/ä/g, 'ae')
            .replace(/ö/g, 'oe')
            .replace(/ü/g, 'ue')
            .replace(/ß/g, 'ss')
            .replace(/à|á|â|ã/g, 'a')
            .replace(/è|é|ê|ë/g, 'e')
            .replace(/ì|í|î|ï/g, 'i')
            .replace(/ò|ó|ô|õ/g, 'o')
            .replace(/ù|ú|û/g, 'u')
            .replace(/[^\w\s-]/g, '')
            .replace(/[\s_]+/g, '-')
            .replace(/^-+|-+$/g, '');
    }
}
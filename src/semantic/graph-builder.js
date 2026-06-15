// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import { createLogger } from '../utils/logger.js';
import { TTLLoader } from './ttl-loader.js';
import { DPT_NAME_MAP } from '../utils/dpt-map.js';

export class GraphBuilder {
    constructor() {
        this.logger = createLogger('GraphBuilder');
        this.ttlLoader = new TTLLoader();

        // KNX IoT Ontology URIs
        this.namespaces = {
            rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
            rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
            xsd: 'http://www.w3.org/2001/XMLSchema#',
            core: 'http://schema.knx.org/2023/en50090-6-2/core#',
            dct: 'http://purl.org/dc/terms/',
            knx: 'http://schema.knx.org/2020/ontology/knx#',
            loc: 'http://schema.knx.org/2023/en50090-6-2/loc#',
            mac: 'http://schema.knx.org/2020/ontology/mac#',
            owl: 'http://www.w3.org/2002/07/owl#',
            tag: 'http://schema.knx.org/2023/en50090-6-2/tag#'
        };
    }

    // ── Public API ───────────────────────────────────────────────────────────

    /**
     * Builds semantic graph from TTL export.
     * @param {string} ttlFilePath - Path to TTL file
     * @returns {Promise<Object>} Semantic graph
     */
    async buildFromTTL(ttlFilePath) {
        this.logger.info('Building semantic graph from TTL...');

        // TTLLoader performs the full parse - we use the result directly
        const {
            topology,
            groupAddresses,
            applicationFunctions,
            deviceMap
        } = await this.ttlLoader.loadTTLFull(ttlFilePath);

        const graph = {
            locations: this.buildLocations(topology),
            devices: this.buildDevices(deviceMap),
            functions: this.buildFunctions(applicationFunctions),
            datapoints: [], // covered via groupAddresses
            groupAddresses: this.buildGroupAddresses(groupAddresses),
            relationships: this.buildRelationships(topology, groupAddresses, applicationFunctions)
        };

        this.logger.info('✅ Semantic graph built:', {
            locations: graph.locations.length,
            devices: graph.devices.length,
            groupAddresses: graph.groupAddresses.length,
            relationships: graph.relationships.length
        });

        return graph;
    }

    // ── Locations from Topology Tree ─────────────────────────────────────────

    /**
     * Builds a flat locations list from topology tree.
     * @param {Object} topology - Topology object
     * @returns {Array} Locations array
     */
    buildLocations(topology) {
        const locations = [];

        for (const building of topology.buildings) {
            locations.push({
                id: this.extractId(building.name),
                type: 'location',
                subtype: 'building',
                uri: building.uri ?? null,
                name: building.name,
                parentId: null
            });

            for (const floor of building.floors) {
                const floorId = `${this.extractId(building.name)}_${this.extractId(floor.name)}`;

                locations.push({
                    id: floorId,
                    type: 'location',
                    subtype: 'floor',
                    uri: floor.uri ?? null,
                    name: floor.name,
                    parentId: this.extractId(building.name)
                });

                for (const room of floor.rooms) {
                    const roomId = `${floorId}_${this.extractId(room.name)}`;

                    locations.push({
                        id: roomId,
                        type: 'location',
                        subtype: 'room',
                        uri: room.uri ?? null,
                        name: room.name,
                        parentId: floorId,
                        deviceCount: room.devices.length,
                        gaCount: room.groupAddresses.length
                    });
                }
            }
        }

        return locations;
    }

    // ── Devices from deviceMap ───────────────────────────────────────────────

    /**
     * Builds sorted devices list from deviceMap.
     * @param {Map} deviceMap - Map with device information
     * @returns {Array} Devices array sorted by physical address
     */
    buildDevices(deviceMap) {
        return [...deviceMap.values()]
            .map((d) => ({
                id: d.uri,
                type: 'device',
                uri: d.uri,
                name: d.label || d.description || d.uri,
                description: d.description,
                manufacturer: d.manufacturer,
                orderNumber: d.orderNumber,
                mediaType: d.mediaType,
                serialNumber: d.serial,
                physAddr: d.physAddr,
                state: d.state,
                lastDl: d.lastDl,
                room: d.room,
                floor: d.floor,
                building: d.building
            }))
            .sort((a, b) => {
                const pa = (a.physAddr ?? '9.9.999').split('.').map(Number);
                const pb = (b.physAddr ?? '9.9.999').split('.').map(Number);
                return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
            });
    }

    // ── GroupAddresses ────────────────────────────────────────────────────────

    /**
     * Builds normalized group addresses list.
     * @param {Array} groupAddresses - Raw group addresses
     * @returns {Array} Normalized group addresses
     */
    buildGroupAddresses(groupAddresses) {
        return groupAddresses.map((ga) => ({
            id: ga.uri,
            type: 'groupAddress',
            uri: ga.uri,
            address: ga.address,
            decimal: ga.decimal,
            name: ga.title,
            dpt: ga.dpt,
            valueType: this.getValueTypeFromDPT(ga.dpt),
            flags: {
                readable: ga.readable === 'True',
                writable: ga.writable === 'True'
            },
            connectedDevices: ga.connectedDevices
        }));
    }

    // ── Relationships ─────────────────────────────────────────────────────────

    /**
     * Builds a relationship list from topology and group addresses.
     * @param {Object} topology - Topology object
     * @param {Array} groupAddresses - Group addresses
     * @returns {Array} Relationships array
     */
    buildRelationships(topology, groupAddresses, applicationFunctions) {
        const relationships = [];

        // Building → Floor → Room
        for (const building of topology.buildings) {
            const buildingId = this.extractId(building.name);

            for (const floor of building.floors) {
                const floorId = `${buildingId}_${this.extractId(floor.name)}`;
                relationships.push({ subject: buildingId, predicate: 'hasFloor', object: floorId });

                for (const room of floor.rooms) {
                    const roomId = `${floorId}_${this.extractId(room.name)}`;
                    relationships.push({ subject: floorId, predicate: 'hasRoom', object: roomId });

                    // Room → Device
                    for (const device of room.devices) {
                        relationships.push({ subject: roomId, predicate: 'containsDevice', object: device.uri });
                    }
                }
            }
        }

        // GA → Device
        for (const ga of groupAddresses) {
            for (const device of ga.connectedDevices) {
                relationships.push({ subject: ga.uri, predicate: 'linkedToDevice', object: device.deviceId });
            }
        }

        // Function → GroupAddress
        for (const fn of applicationFunctions) {
            for (const ga of fn.groupAddresses) {
                relationships.push({
                    subject: fn.uri,
                    predicate: 'hasGroupAddress',
                    object: ga.uri
                });
            }
        }

        return relationships;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    buildFunctions(applicationFunctions) {
        return applicationFunctions.map((fn) => ({
            id: fn.uri,
            type: 'applicationFunction',
            uri: fn.uri,
            name: fn.title,
            functionPointCount: fn.functionPoints.length,
            groupAddressCount: fn.groupAddresses.length
        }));
    }

    /**
     * Extracts normalized ID string from URI or name.
     * @param {string} uri - URI or name
     * @returns {string} Normalized ID string
     */
    extractId(uri) {
        if (!uri) return 'unknown';
        return uri
            .split(/[#/]/)
            .pop()
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
            .replace(/[^\w-]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');
    }

    /**
     * Determines JavaScript value type based on DPT code.
     * @param {string} dpt - DPT code (e.g. "9.001")
     * @returns {string} Value type
     */
    getValueTypeFromDPT(dpt) {
        if (!dpt) return 'unknown';

        // Resolve symbolic name (e.g. "windowDoor" -> "1.019")
        let resolved = dpt;
        if (!/^\d/.test(dpt)) {
            resolved = DPT_NAME_MAP[dpt]
                ?? DPT_NAME_MAP[Object.keys(DPT_NAME_MAP).find(
                    (k) => k.toLowerCase() === dpt.toLowerCase()
                )]
                ?? dpt;
        }

        const main = parseInt(resolved.split('.')[0]);

        const typeMap = {
            1: 'boolean',
            2: 'object',
            3: 'object',
            5: 'number',
            6: 'number',
            7: 'number',
            8: 'number',
            9: 'number',
            10: 'datetime',
            11: 'date',
            12: 'number',
            13: 'number',
            14: 'number',
            16: 'string',
            17: 'number',
            18: 'object',
            19: 'datetime',
            20: 'number'
        };

        return typeMap[main] ?? 'unknown';
    }
}

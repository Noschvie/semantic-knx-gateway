// SPDX-License-Identifier: CC-BY-NC-SA-4.0
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

    // ── Öffentliche API ──────────────────────────────────────────────────────

    /**
     * Erstellt semantischen Graphen aus TTL-Export.
     * @param {string} ttlFilePath - Pfad zur TTL-Datei
     * @returns {Promise<Object>} Semantischer Graph
     */
    async buildFromTTL(ttlFilePath) {
        this.logger.info('Building semantic graph from TTL...');

        // TTLLoader macht den gesamten Parse — wir verwenden das Ergebnis direkt
        const { topology, groupAddresses, deviceMap } = await this.ttlLoader.loadTTLFull(ttlFilePath);

        const graph = {
            locations: this.buildLocations(topology),
            devices: this.buildDevices(deviceMap),
            functions: [], // KNX IoT TTL hat keine brick:Function-Typen
            datapoints: [], // werden über groupAddresses abgedeckt
            groupAddresses: this.buildGroupAddresses(groupAddresses),
            relationships: this.buildRelationships(topology, groupAddresses)
        };

        this.logger.info('✅ Semantic graph built:', {
            locations: graph.locations.length,
            devices: graph.devices.length,
            groupAddresses: graph.groupAddresses.length,
            relationships: graph.relationships.length
        });

        return graph;
    }

    // ── Locations aus Topologie-Baum ──────────────────────────────────────────

    /**
     * Erstellt flache Locations-Liste aus Topologie-Baum.
     * @param {Object} topology - Topologie-Objekt
     * @returns {Array} Locations-Array
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

    // ── Devices aus deviceMap ─────────────────────────────────────────────────

    /**
     * Erstellt sortierte Devices-Liste aus deviceMap.
     * @param {Map} deviceMap - Map mit Device-Informationen
     * @returns {Array} Devices-Array sortiert nach physikalischer Adresse
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
     * Erstellt normalisierte GroupAddresses-Liste.
     * @param {Array} groupAddresses - Rohe Gruppenadressen
     * @returns {Array} Normalisierte GroupAddresses
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
     * Erstellt Relationships-Liste aus Topologie und Gruppenadressen.
     * @param {Object} topology - Topologie-Objekt
     * @param {Array} groupAddresses - Gruppenadressen
     * @returns {Array} Relationships-Array
     */
    buildRelationships(topology, groupAddresses) {
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

        return relationships;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /**
     * Extrahiert normalisierten ID-String aus URI oder Name.
     * @param {string} uri - URI oder Name
     * @returns {string} Normalisierter ID-String
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
     * Bestimmt den JavaScript-Werttyp anhand des DPT-Codes.
     * @param {string} dpt - DPT-Code (z.B. "9.001")
     * @returns {string} Werttyp
     */
    getValueTypeFromDPT(dpt) {
        if (!dpt) return 'unknown';

        // Symbolischen Namen auflösen (z.B. "windowDoor" → "1.019")
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
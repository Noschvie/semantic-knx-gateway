// SPDX-License-Identifier: CC-BY-NC-SA-4.0
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import fs from 'fs';
import fsAsync from 'fs/promises';
import rdf from 'rdf-ext';
import Parser from '@rdfjs/parser-n3';
import { createLogger } from '../utils/logger.js';

const KNX = rdf.namespace('http://schema.knx.org/2020/ontology/knx#');
const RDFS = rdf.namespace('http://www.w3.org/2000/01/rdf-schema#');
const DC = rdf.namespace('http://purl.org/dc/terms/');
const CORE = rdf.namespace('http://schema.knx.org/2023/en50090-6-2/core#');
const LOC = rdf.namespace('http://schema.knx.org/2023/en50090-6-2/loc#');

export class TTLLoader {
    constructor() {
        this.logger = createLogger('TTLLoader');
    }

    // Address Conversion

    /**
     * Converts a hex address to a physical address in format X.X.XXX
     * @param {string} hex - Hexadecimal address
     * @returns {string} Physical address
     */
    toPhysAddress(hex) {
        const n = parseInt(hex, 16);
        return `${(n >> 12) & 0x0f}.${(n >> 8) & 0x0f}.${n & 0xff}`;
    }

    /**
     * Converts a decimal address to a group address in format XX/X/XXX
     * @param {string|number} dec - Decimal address
     * @returns {string} Group address
     */
    toGroupAddress(dec) {
        const n = parseInt(dec);
        return `${(n >> 11) & 0x1f}/${(n >> 8) & 0x07}/${n & 0xff}`;
    }

    /**
     * Sorts physical addresses in ascending order
     * @param {string} a - First address
     * @param {string} b - Second address
     * @returns {number} Sort value
     */
    sortPhys(a, b) {
        const pa = (a ?? '9.9.999').split('.').map(Number);
        const pb = (b ?? '9.9.999').split('.').map(Number);
        return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
    }

    // Helper Functions

    /**
     * Extracts a label from the dataset for a node
     * @param {Object} dataset - RDF Dataset
     * @param {Object} node - RDF Node
     * @returns {string} Label
     */
    getLabel(dataset, node) {
        return (
            [...dataset.match(node, DC.title)][0]?.object?.value ||
            [...dataset.match(node, RDFS.label)][0]?.object?.value ||
            [...dataset.match(node, KNX.label)][0]?.object?.value ||
            node.value.split('#').pop()
        );
    }

    /**
     * Extracts device information from the dataset
     * @param {Object} dataset - RDF Dataset
     * @param {Object} device - Device Node
     * @returns {Object} Device Info Object
     */
    getDeviceInfo(dataset, device) {
        const hexAddr = [...dataset.match(device, KNX.individualAddress)][0]?.object?.value;
        const productUri = [...dataset.match(device, CORE.hasProduct)][0]?.object?.value;

        let manufacturer = '';
        let orderNumber = '';
        let mediaType = '';

        if (productUri) {
            const prod = rdf.namedNode(productUri);
            manufacturer = [...dataset.match(prod, CORE.manufacturer)][0]?.object?.value ?? '';
            orderNumber = [...dataset.match(prod, CORE.orderNumber)][0]?.object?.value ?? '';
            mediaType = [...dataset.match(prod, CORE.mediaType)][0]?.object?.value ?? '';
        }

        return {
            uri: device.value.split('#').pop(),
            label: [...dataset.match(device, DC.title)][0]?.object?.value ?? this.getLabel(dataset, device),
            description: [...dataset.match(device, DC.description)][0]?.object?.value ?? '',
            physAddr: hexAddr ? this.toPhysAddress(hexAddr) : null,
            serial: [...dataset.match(device, CORE.serialNumber)][0]?.object?.value ?? '',
            state: [...dataset.match(device, CORE.state)][0]?.object?.value ?? '',
            lastDl: [...dataset.match(device, CORE.lastDownloaded)][0]?.object?.value ?? '',
            manufacturer,
            orderNumber,
            mediaType
        };
    }

    /**
     * Extracts device ID from URI
     * @param {string} uri - URI String
     * @returns {string|null} Device ID or null
     */
    extractDeviceId(uri) {
        const m = uri.match(/DI-\d+/);
        return m ? m[0] : null;
    }

    // Load Dataset

    /**
     * Loads a TTL file as a rdf-ext dataset.
     * More stable than for-await streaming - resolves cleanly via Promise.
     * @param {string} filePath - Path to TTL file
     * @returns {Promise<Object>} RDF Dataset
     */
    async loadDataset(filePath) {
        await fsAsync.access(filePath);
        const stats = await fsAsync.stat(filePath);
        this.logger.info(`Loading TTL: ${filePath} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);

        const stream = fs.createReadStream(filePath);
        const parser = new Parser();
        const dataset = await rdf.dataset().import(parser.import(stream));

        this.logger.info(`✅ ${dataset.size} triples loaded`);
        return dataset;
    }

    // Public API

    /**
     * Returns a structured group-address list (backward compatibility).
     * @param {string} filePath - Path to TTL file
     * @returns {Promise<Array>} Array of group addresses
     */
    async loadTTL(filePath) {
        const dataset = await this.loadDataset(filePath);
        const { groupAddresses } = await this.parse(dataset);
        this.logger.info(`✅ ${groupAddresses.length} group addresses resolved`);
        return groupAddresses;
    }

    /**
     * Returns complete topology and group addresses.
     * @param {string} filePath - Path to TTL file
     * @returns {Promise<Object>} Object with topology, groupAddresses, deviceMap
     */
    async loadTTLFull(filePath) {
        const dataset = await this.loadDataset(filePath);
        return this.parse(dataset);
    }

    /**
     * Returns the raw RDF dataset (for external SPARQL-like queries).
     * @param {string} filePath - Path to TTL file
     * @returns {Promise<Object>} RDF Dataset
     */
    async loadTTLAsDataset(filePath) {
        return this.loadDataset(filePath);
    }

    // ── Parsing ──────────────────────────────────────────────────────────────

    /**
     * Parses the RDF dataset and extracts topology and group addresses
     * @param {Object} dataset - RDF Dataset
     * @returns {Promise<Object>} Object with topology, groupAddresses, deviceMap
     */
    async parse(dataset) {
        const deviceMap = new Map(); // uri-Fragment → deviceInfo + room/floor context

        // Topology
        const siteNode = [...dataset.match(null, LOC.hasBuilding)][0]?.subject;
        const siteLabel = siteNode ? this.getLabel(dataset, siteNode) : 'Site';
        const topology = { site: siteLabel, buildings: [] };

        for (const bQuad of dataset.match(siteNode, LOC.hasBuilding)) {
            const building = bQuad.object;
            const buildingEntry = { name: this.getLabel(dataset, building), floors: [] };

            for (const fQuad of dataset.match(building, LOC.hasFloor)) {
                const floor = fQuad.object;
                const floorEntry = { name: this.getLabel(dataset, floor), rooms: [] };

                const roomUris = new Set([
                    ...[...dataset.match(floor, LOC.hasRoom)].map((q) => q.object.value),
                    ...[...dataset.match(floor, LOC.hasSpace)].map((q) => q.object.value)
                ]);

                for (const roomUri of roomUris) {
                    const room = rdf.namedNode(roomUri);
                    const roomEntry = {
                        name: this.getLabel(dataset, room),
                        devices: [],
                        groupAddresses: []
                    };

                    for (const eQuad of dataset.match(room, LOC.containsEquipment)) {
                        const info = this.getDeviceInfo(dataset, eQuad.object);
                        roomEntry.devices.push(info);
                        deviceMap.set(info.uri, {
                            ...info,
                            room: roomEntry.name,
                            floor: floorEntry.name,
                            building: buildingEntry.name
                        });
                    }

                    roomEntry.devices.sort((a, b) => this.sortPhys(a.physAddr, b.physAddr));
                    floorEntry.rooms.push(roomEntry);
                }

                floorEntry.rooms.sort((a, b) => a.name.localeCompare(b.name));
                buildingEntry.floors.push(floorEntry);
            }

            topology.buildings.push(buildingEntry);
        }

        // Group Addresses
        const groupAddresses = [];

        for (const gaQuad of dataset.match(null, KNX.groupAddress)) {
            const gaNode = gaQuad.subject;

            const title = [...dataset.match(gaNode, DC.title)][0]?.object?.value ?? '';
            const dpt = [...dataset.match(gaNode, KNX.datapointType)][0]?.object?.value?.split('#').pop() ?? '';
            const readable = [...dataset.match(gaNode, CORE.readable)][0]?.object?.value ?? '';
            const writable = [...dataset.match(gaNode, CORE.writable)][0]?.object?.value ?? '';

            const connectedDevices = [];
            for (const gQuad of dataset.match(gaNode, CORE.groups)) {
                const devId = this.extractDeviceId(gQuad.object.value);
                if (devId && deviceMap.has(devId)) {
                    const d = deviceMap.get(devId);
                    connectedDevices.push({
                        deviceId: devId,
                        label: d.label,
                        physAddr: d.physAddr,
                        room: d.room,
                        floor: d.floor
                    });
                }
            }

            groupAddresses.push({
                uri: gaNode.value.split('#').pop(),
                address: this.toGroupAddress(gaQuad.object.value),
                decimal: gaQuad.object.value,
                title,
                dpt,
                readable,
                writable,
                connectedDevices
            });
        }

        groupAddresses.sort((a, b) => parseInt(a.decimal) - parseInt(b.decimal));

        // Assign GAs to rooms
        const roomGAMap = new Map();
        for (const ga of groupAddresses) {
            for (const d of ga.connectedDevices) {
                if (!roomGAMap.has(d.room)) {
                    roomGAMap.set(d.room, []);
                }
                if (!roomGAMap.get(d.room).find((x) => x.address === ga.address)) {
                    roomGAMap.get(d.room).push(ga);
                }
            }
        }

        for (const b of topology.buildings) {
            for (const f of b.floors) {
                for (const r of f.rooms) {
                    r.groupAddresses = roomGAMap.get(r.name) ?? [];
                }
            }
        }

        return { topology, groupAddresses, deviceMap };
    }
}
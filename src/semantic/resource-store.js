// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import { createLogger } from '../utils/logger.js';
import { stableUuid } from '../api/routes/helpers/knx-iot-uuid.js';

export class ResourceStore {
    constructor(db) {
        this.logger = createLogger('ResourceStore');
        this.db = db;
    }

    /**
     * Store semantic graph in a database
     */
    async storeGraph(graph) {
        this.logger.info('Storing semantic graph in database...');

        const client = await this.db.getClient();

        try {
            await client.query('BEGIN');

            // Store locations
            for (const location of graph.locations) {
                await this.storeResource(client, location);
            }

            // Store devices
            for (const device of graph.devices) {
                await this.storeResource(client, device);
            }

            // Store functions
            for (const func of graph.functions) {
                await this.storeResource(client, func);
            }

            // Store datapoints
            for (const datapoint of graph.datapoints) {
                await this.storeResource(client, datapoint);
            }

            // Store group addresses
            for (const ga of graph.groupAddresses) {
                await this.storeResource(client, ga);
            }

            // Store relationships
            await this.storeRelationships(client, graph.relationships);

            await client.query('COMMIT');

            this.logger.info('✅ Semantic graph stored successfully');
        } catch (error) {
            await client.query('ROLLBACK');
            this.logger.error('Failed to store semantic graph:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Store a single resource
     */
    async storeResource(client, resource) {
        const query = `
      INSERT INTO semantic_resources (id, type, resource, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (id)
      DO UPDATE SET
        resource = $3,
        updated_at = NOW()
    `;

        await client.query(query, [
            resource.id,
            resource.type,
            JSON.stringify(resource),
        ]);
    }

    /**
     * Store relationships
     */
    async storeRelationships(client, relationships) {
        for (const rel of relationships) {
            const insertQuery = `
                INSERT INTO semantic_relationships (subject, predicate, object)
                VALUES ($1, $2, $3)
                ON CONFLICT DO NOTHING
              `;

            await client.query(insertQuery, [rel.subject, rel.predicate, rel.object]);
        }
    }

    /**
     * Safely parse a resource row returned by pg.
     * pg auto-parses JSONB columns, but this guards against string returns
     * in edge cases (e.g. raw SQL clients or test stubs).
     */
    parseResource(row) {
        if (!row?.resource) return null;
        return typeof row.resource === 'string'
            ? JSON.parse(row.resource)
            : row.resource;
    }

    /**
     * Get resource by ID
     */
    async getResource(id) {
        const result = await this.db.query(
            'SELECT resource FROM semantic_resources WHERE id = $1',
            [id],
        );

        if (result.rows.length === 0) {
            return null;
        }

        return this.parseResource(result.rows[0]);
    }

    /**
     * Get resources by type
     */
    async getResourcesByType(type) {
        const result = await this.db.query(
            'SELECT resource FROM semantic_resources WHERE type = $1',
            [type],
        );

        return result.rows.map(row => this.parseResource(row));
    }

    /**
     * Convenience: get application functions stored under the type 'applicationFunction'
     * Enriches each function with its linked group address URIs from the relationships table.
     */
    async getApplicationFunctions() {
        const functions = await this.getResourcesByType('applicationFunction');

        for (const fn of functions) {
            const result = await this.db.query(
                `SELECT object FROM semantic_relationships
                 WHERE subject = $1 AND predicate = 'hasGroupAddress'`,
                [fn.id],
            );
            fn.groupAddressUris = result.rows.map(r => r.object);
        }

        return functions;
    }

    /**
     * Get all locations with hierarchy
     */
    async getLocationHierarchy() {
        const locations = await this.getResourcesByType('location');

        // Build hierarchy tree
        const tree = this.buildHierarchyTree(locations);

        return tree;
    }

    /**
     * Build a hierarchy tree from a flat list
     */
    buildHierarchyTree(items) {
        const itemMap = new Map();
        const rootItems = [];

        // Create map
        items.forEach(item => {
            itemMap.set(item.id, { ...item, children: [] });
        });

        // Build tree
        items.forEach(item => {
            const node = itemMap.get(item.id);
            const parent = item.parentId || item.parent || item.location;

            if (parent && itemMap.has(parent)) {
                itemMap.get(parent).children.push(node);
            } else {
                rootItems.push(node);
            }
        });

        return rootItems;
    }

    /**
     * Get a device with all datapoints
     */
    async getDeviceWithDatapoints(deviceId) {
        const device = await this.getResource(deviceId);

        if (!device) {
            return null;
        }

        // Get related datapoints
        const result = await this.db.query(`
      SELECT sr.resource
      FROM semantic_relationships rel
      JOIN semantic_resources sr ON sr.id = rel.object
      WHERE rel.subject = $1 AND rel.predicate = 'hasDatapoint'
    `, [deviceId]);

        device.datapoints = result.rows.map(row => this.parseResource(row));

        return device;
    }

    /**
     * Search resources by a text term.
     *
     * Uses a pg_trgm GIN index on resource::text for efficient
     * case-insensitive ILIKE '%...%' matching.
     *
     * @param {string} query       - Search term (case-insensitive)
     * @param {string} [type]      - Optional resource type filter
     * @param {number} [limit=100] - Maximum number of results
     * @returns {Promise<object[]>} Array of matching resource objects
     */
    async searchResources(query, type = null, limit = 100) {
        const params = [`%${query}%`, limit];
        const typeClause = type ? `AND type = $3` : '';
        if (type) params.splice(1, 0, type); // insert type before limit

        const sql = `
            SELECT resource
            FROM semantic_resources
            WHERE resource::text ILIKE $1
            ${typeClause}
            ORDER BY updated_at DESC
            LIMIT $${params.length}
        `;

        const result = await this.db.query(sql, params);

        return result.rows.map(row =>
            typeof row.resource === 'string'
                ? JSON.parse(row.resource)
                : row.resource,
        );
    }
}

/**
 * Transforms a function into a JSON:API resource.
 */
export function toFunctionResource(fn) {
    const uuid = stableUuid(fn.id ?? fn.uri ?? '');

    // Build datapoint relationship links for each linked group address
    const groupAddressLinks = (fn.groupAddressUris ?? []).map(gaUri => ({
        id:   stableUuid(gaUri),
        type: 'datapoint',
    }));

    return {
        id:   uuid,
        type: 'function',
        attributes: { title: fn.name ?? '' },
        meta: {
            '@type':     ['knx:function'],
            internalId:  fn.id,
            uri:         fn.uri,
            groupAddressCount: fn.groupAddressUris?.length ?? fn.groupAddressCount ?? 0,
        },
        relationships: {
            datapoints: groupAddressLinks.length > 0
                ? { data: groupAddressLinks }
                : { links: { related: `/api/v1/datapoints?filter[functionId]=${uuid}` } },
        },
    };
}

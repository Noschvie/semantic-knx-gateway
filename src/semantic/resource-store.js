// SPDX-License-Identifier: CC-BY-NC-SA-4.0
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import { createLogger } from '../utils/logger.js';

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
            JSON.stringify(resource)
        ]);
    }

    /**
     * Store relationships
     */
    async storeRelationships(client, relationships) {
        const query = `
      CREATE TABLE IF NOT EXISTS semantic_relationships (
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        PRIMARY KEY (subject, predicate, object)
      )
    `;
        await client.query(query);

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
     * Get resource by ID
     */
    async getResource(id) {
        const result = await this.db.query(
            'SELECT * FROM semantic_resources WHERE id = $1',
            [id]
        );

        if (result.rows.length === 0) {
            return null;
        }

        return result.rows[0].resource;
    }

    /**
     * Get resources by type
     */
    async getResourcesByType(type) {
        const result = await this.db.query(
            'SELECT * FROM semantic_resources WHERE type = $1',
            [type]
        );

        return result.rows.map(row => row.resource);
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

        device.datapoints = result.rows.map(row => row.resource);

        return device;
    }

    /**
     * Search resources
     */
    async searchResources(query) {
        const result = await this.db.query(`
      SELECT * FROM semantic_resources
      WHERE resource::text ILIKE $1
      LIMIT 100
    `, [`%${query}%`]);

        return result.rows.map(row => row.resource);
    }
}
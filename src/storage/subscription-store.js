// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import { createLogger } from '../utils/logger.js';

/**
 *     * SubscriptionStore
 *      *
 *      * Persists HTTP callback and WebSocket subscriptions in PostgreSQL.
 *      * Modelled after the KNX IoT 3rd Party API Spec 2.1.0:
 *      *   - POST   /subscriptions       → create()
 *      *   - GET    /subscriptions       → findAll()
 *      *   - GET    /subscriptions/:id   → findById()
 *      *   - PATCH  /subscriptions/:id   → update()   (url/secret/caCert/lifetime only)
 *      *   - DELETE /subscriptions/:id   → delete()
 *      *   - GET    /subscriptions/:id/datapoints     → findDatapointsBySubId()
 *      *   - GET    /subscriptions/:id/installations  → findInstallationsBySubId()
 *      *   - GET    /subscriptions/:id/node           → findNodeBySubId()
 */
export class SubscriptionStore {
    constructor(db) {
        this.logger = createLogger('SubscriptionStore');
        this.db = db;
    }

    // ------------------------------------------------------------------
    // CREATE
    // ------------------------------------------------------------------

    /**
     * Creates a new subscription (HTTP callback or WebSocket).
     *
     * @param {object} sub
     * @param {string}   sub.type          'callback' | 'websocket'
     * @param {string}   [sub.url]         Callback URL (required for type='callback')
     * @param {string}   [sub.secret]      HMAC secret
     * @param {string}   [sub.caCert]      PEM certificate
     * @param {string}   [sub.lifetime]    PostgreSQL interval e.g. '24 hours'
     * @param {Array}    [sub.datapoints]  [{ datapointId, expand }]
     * @param {Array}    [sub.installations] [{ installationId, expand }]
     * @param {object}   [sub.node]        { nodeId, expand }
     *
     * @returns {Promise<string>} Generated UUID of the new subscription
     */
    async create(sub) {
        const {
            type = 'callback',
            url,
            secret,
            caCert,
            lifetime,
            datapoints = [],
            installations = [],
            node,
        } = sub;

        // this.logger.info(this.db, { depth: 2 });

        const client = await this.db.getClient();

        try {
            await client.query('BEGIN');

            // 1. Insert subscription master record
            const lifetimeInterval =
                lifetime != null
                    ? `${lifetime} seconds`
                    : null;
            const insertSub = `
                INSERT INTO subscriptions (
                    type,
                    url,
                    secret,
                    ca_cert,
                    lifetime,
                    expires_at
                )
                VALUES (
                           $1,
                           $2,
                           $3,
                           $4,
                           $5::INTERVAL,
                           CASE
                               WHEN $5 IS NOT NULL
                                   THEN NOW() + $5::INTERVAL
                               ELSE NULL
                               END
                       )
                RETURNING id
            `;
            const subResult = await client.query(insertSub, [
                type,
                url ?? null,
                secret ?? null,
                caCert ?? null,
                lifetimeInterval,
            ]);
            const id = subResult.rows[0].id;

            // 2. Link datapoints
            if (datapoints.length > 0) {
                const dpValues = datapoints
                    .map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3})`)
                    .join(', ');
                const dpParams = [id, ...datapoints.flatMap(dp => [dp.datapointId, dp.expand ?? false])];
                await client.query(
                    `INSERT INTO subscription_datapoints (subscription_id, datapoint_id, expand)
                     VALUES ${dpValues}`,
                    dpParams,
                );
            }

            // 3. Link installations
            if (installations.length > 0) {
                const instValues = installations
                    .map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3})`)
                    .join(', ');
                const instParams = [id, ...installations.flatMap(inst => [inst.installationId, inst.expand ?? false])];
                await client.query(
                    `INSERT INTO subscription_installations (subscription_id, installation_id, expand)
                     VALUES ${instValues}`,
                    instParams,
                );
            }

            // 4. Link node (at most one per spec)
            if (node) {
                await client.query(
                    `INSERT INTO subscription_node (subscription_id, node_id, expand)
                     VALUES ($1, $2, $3)`,
                    [id, node.nodeId, node.expand ?? false],
                );
            }

            await client.query('COMMIT');

            this.logger.info({ msg: '✅ Subscription created', id, type });
            return id;
        } catch (error) {
            if (client) {
                await client.query('ROLLBACK');
            }
            this.logger.error({ msg: 'Failed to create subscription', error: error.message });
            throw error;
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    // ------------------------------------------------------------------
    // READ
    // ------------------------------------------------------------------

    /**
     * All active subscriptions (without linked resources).
     * Pagination: page (1-based), size
     */
    async findAll({ page = 1, size = 50 } = {}) {
        const offset = (page - 1) * size;
        const query = `
            SELECT id, type, url, lifetime, expires_at, created_at, updated_at, active
            FROM subscriptions
            WHERE active = TRUE
            ORDER BY created_at DESC
            LIMIT $1 OFFSET $2
        `;
        const countQuery = 'SELECT COUNT(*) FROM subscriptions WHERE active = TRUE';

        const [result, countResult] = await Promise.all([
            this.db.query(query, [size, offset]),
            this.db.query(countQuery),
        ]);

        return {
            rows: result.rows,
            total: parseInt(countResult.rows[0].count, 10),
        };
    }

    /**
     * Single subscription by ID.
     * Returns null if not found or inactive.
     */
    async findById(id) {
        const query = `
            SELECT id, type, url, secret, ca_cert, lifetime, expires_at,
                   created_at, updated_at, active
            FROM subscriptions
            WHERE id = $1 AND active = TRUE
        `;
        const result = await this.db.query(query, [id]);
        return result.rows[0] ?? null;
    }

    /**
     * All subscriptions that have subscribed to a specific datapoint.
     * Required by GET /datapoints/:id/subscriptions.
     */
    async findByDatapointId(datapointId) {
        const query = `
            SELECT s.id, s.type, s.url, s.lifetime, s.expires_at, s.created_at
            FROM subscriptions s
            JOIN subscription_datapoints sd ON sd.subscription_id = s.id
            WHERE sd.datapoint_id = $1 AND s.active = TRUE
            ORDER BY s.created_at DESC
        `;
        const result = await this.db.query(query, [datapointId]);
        return result.rows;
    }

    // ------------------------------------------------------------------
    // Sub-resources (for /subscriptions/:id/datapoints etc.)
    // ------------------------------------------------------------------

    async findDatapointsBySubId(subscriptionId, { page = 1, size = 50 } = {}) {
        const offset = (page - 1) * size;
        const query = `
            SELECT datapoint_id AS id, expand
            FROM subscription_datapoints
            WHERE subscription_id = $1
            ORDER BY datapoint_id
            LIMIT $2 OFFSET $3
        `;
        const countQuery = `
            SELECT COUNT(*) FROM subscription_datapoints WHERE subscription_id = $1
        `;
        const [result, countResult] = await Promise.all([
            this.db.query(query, [subscriptionId, size, offset]),
            this.db.query(countQuery, [subscriptionId]),
        ]);
        return {
            rows: result.rows,
            total: parseInt(countResult.rows[0].count, 10),
        };
    }

    async findInstallationsBySubId(subscriptionId, { page = 1, size = 50 } = {}) {
        const offset = (page - 1) * size;
        const query = `
            SELECT installation_id AS id, expand
            FROM subscription_installations
            WHERE subscription_id = $1
            ORDER BY installation_id
            LIMIT $2 OFFSET $3
        `;
        const countQuery = `
            SELECT COUNT(*) FROM subscription_installations WHERE subscription_id = $1
        `;
        const [result, countResult] = await Promise.all([
            this.db.query(query, [subscriptionId, size, offset]),
            this.db.query(countQuery, [subscriptionId]),
        ]);
        return {
            rows: result.rows,
            total: parseInt(countResult.rows[0].count, 10),
        };
    }

    async findNodeBySubId(subscriptionId) {
        const query = `
            SELECT node_id AS id, expand
            FROM subscription_node
            WHERE subscription_id = $1
        `;
        const result = await this.db.query(query, [subscriptionId]);
        return result.rows[0] ?? null;
    }

    // ------------------------------------------------------------------
    // UPDATE (PATCH – callback metadata only, per spec)
    // ------------------------------------------------------------------

    /**
     * Updates patchable fields of a subscription.
     * Per spec, ONLY url, secret, caCert and lifetime are modifiable.
     * Subscribed items (datapoints/installations/node) are NOT modifiable.
     *
     * @param {string} id
     * @param {object} patch  { url?, secret?, caCert?, lifetime? }
     * @returns {Promise<boolean>} true if row was found & updated
     */
    async update(id, patch) {
        const allowed = ['url', 'secret', 'caCert', 'lifetime'];
        const fields = Object.keys(patch).filter(k => allowed.includes(k));

        if (fields.length === 0) {
            this.logger.warn({ msg: 'update() called with no patchable fields', id });
            return false;
        }

        // Mapping camelCase → snake_case
        const columnMap = {
            url: 'url',
            secret: 'secret',
            caCert: 'ca_cert',
            lifetime: 'lifetime',
        };

        const setClauses = fields.map((field, i) => {
            const col = columnMap[field];
            if (field === 'lifetime') {
                // Also, update expires_at when lifetime is changed
                return `${col} = $${i + 2}::INTERVAL, expires_at = CASE WHEN $${i + 2} IS NOT NULL THEN NOW() + $${i + 2}::INTERVAL ELSE NULL END`;
            }
            return `${col} = $${i + 2}`;
        });

        const query = `
            UPDATE subscriptions
            SET ${setClauses.join(', ')}
            WHERE id = $1 AND active = TRUE
        `;
        const params = [id, ...fields.map(f => patch[f] ?? null)];

        try {
            const result = await this.db.query(query, params);
            const updated = result.rowCount > 0;
            if (updated) {
                this.logger.info({ msg: 'Subscription updated', id, fields });
            } else {
                this.logger.warn({ msg: 'Subscription not found for update', id });
            }
            return updated;
        } catch (error) {
            this.logger.error({ msg: 'Failed to update subscription', id, error: error.message });
            throw error;
        }
    }

    // ------------------------------------------------------------------
    // DELETE
    // ------------------------------------------------------------------

    /**
     * Deletes a subscription (soft-delete via active = FALSE).
     * Cascade on subscription_datapoints / _installations / _node
     * applies on hard-delete; soft-delete preserves history.
     *
     * @returns {Promise<boolean>} true if found & deleted
     */
    async delete(id) {
        const query = `
            UPDATE subscriptions
            SET active = FALSE, updated_at = NOW()
            WHERE id = $1 AND active = TRUE
        `;
        try {
            const result = await this.db.query(query, [id]);
            const deleted = result.rowCount > 0;
            if (deleted) {
                this.logger.info({ msg: '🗑️  Subscription deleted (soft)', id });
            } else {
                this.logger.warn({ msg: 'Subscription not found for delete', id });
            }
            return deleted;
        } catch (error) {
            this.logger.error({ msg: 'Failed to delete subscription', id, error: error.message });
            throw error;
        }
    }

    // ------------------------------------------------------------------
    // Delivery Log (subscription_events)
    // ------------------------------------------------------------------

    /**
     * Logs a callback delivery attempt (success or error).
     * Analogous to EventStore.storeEvent().
     */
    async logDelivery({ subscriptionId, datapointId, triggerType, payload, httpStatus, deliveryError }) {
        const query = `
            INSERT INTO subscription_events
                (subscription_id, datapoint_id, trigger_type, payload, http_status, delivery_error, delivered_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW())
        `;
        try {
            await this.db.query(query, [
                subscriptionId,
                datapointId ?? null,
                triggerType,
                JSON.stringify(payload ?? {}),
                httpStatus ?? null,
                deliveryError ?? null,
            ]);
        } catch (error) {
            // Delivery log errors are only logged, not propagated
            this.logger.error({ msg: 'Failed to log delivery', subscriptionId, error: error.message });
        }
    }

    /**
     * Returns all active subscriptions that have subscribed to a specific
     * datapoint – called by the callback dispatcher.
     */
    async findActiveCallbacksByDatapointId(datapointId) {
        const query = `
            SELECT s.id, s.url, s.secret, s.ca_cert, sd.expand
            FROM subscriptions s
            JOIN subscription_datapoints sd ON sd.subscription_id = s.id
            WHERE sd.datapoint_id = $1
              AND s.type = 'callback'
              AND s.active = TRUE
              AND (s.expires_at IS NULL OR s.expires_at > NOW())
        `;
        const result = await this.db.query(query, [datapointId]);
        return result.rows;
    }
}

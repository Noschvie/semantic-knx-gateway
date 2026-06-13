// SPDX-License-Identifier: CC-BY-NC-SA-4.0
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import { Router } from 'express';
import { bearer } from '../middleware/oauth-bearer.js';
import { stableUuid } from './helpers/knx-iot-uuid.js';

const CONTENT_TYPE = 'application/vnd.api+json';

// ------------------------------------------------------------
// JSON:API Formatter-Helpers
// ------------------------------------------------------------

/**
 * Single subscription as JSON:API resource object.
 * Secret and caCert are NOT returned (security).
 */
function serializeSubscription(row, baseUrl) {
    return {
        id: row.id,
        type: 'subscription',

        links: {
            self: `${baseUrl}/${row.id}`,
        },

        attributes: {
            subscriptionType: row.type,

            ...(row.url && {
                url: row.url,
            }),

            ...(row.lifetime !== undefined && {
                lifetime: row.lifetime,
            }),

            ...(row.expires_at && {
                expiresAt: row.expires_at,
            }),

            ...(row.created_at && {
                createdAt: row.created_at,
            }),

            ...(row.updated_at && {
                updatedAt: row.updated_at,
            }),

            ...(row.active !== undefined && {
                active: row.active,
            }),
        },

        relationships: {
            subscriptionDatapoints: {
                links: { related: `${baseUrl}/${row.id}/datapoints` },
            },
            subscriptionInstallations: {
                links: { related: `${baseUrl}/${row.id}/installations` },
            },
            subscriptionNode: {
                links: { related: `${baseUrl}/${row.id}/node` },
            },
        },
    };
}

/** JSON:API Collection Response */
function collectionResponse(rows, total, { page, size }, baseUrl) {
    return {
        meta: {
            total,
            page,
            size,
            pageCount: Math.ceil(total / size),
        },
        data: rows.map(row => serializeSubscription(row, baseUrl)),
    };
}

/** JSON:API Single-Item Response */
function itemResponse(row, baseUrl) {
    return { data: serializeSubscription(row, baseUrl) };
}

/** JSON:API Error Response */
function errorResponse(status, detail) {
    return {
        errors: [{ status: String(status), detail }],
    };
}

/** Read pagination parameters from the query */
function parsePagination(query) {
    const page = Math.max(1, parseInt(query['page[number]'] ?? query.page ?? '1', 10));
    const size = Math.min(100, Math.max(1, parseInt(query['page[size]'] ?? query.size ?? '50', 10)));
    return { page, size };
}

/**
 * Normalizes lifetime to seconds (number) for the store.
 * Accepts:
 *   - number         -> directly (already seconds)
 *   - { seconds }    -> seconds
 *   - { minutes }    -> minutes * 60
 *   - { hours }      -> hours * 3600
 *   - null/undefined -> undefined (store default)
 */
function normalizeLifetime(lifetime) {
    if (lifetime == null) return undefined;
    if (typeof lifetime === 'number') return lifetime;
    if (typeof lifetime === 'object') {
        if (lifetime.seconds != null) return Number(lifetime.seconds);
        if (lifetime.minutes != null) return Number(lifetime.minutes) * 60;
        if (lifetime.hours   != null) return Number(lifetime.hours)   * 3600;
    }
    return undefined;
}

// ------------------------------------------------------------
// Router
// ------------------------------------------------------------

export function subscriptionsRouter(subscriptionStore, stateEngine) {
    const router = Router();

    // Effective scope requirements (according to KNX IoT spec):
    // - GET /subscriptions*
    // - POST /subscriptions
    // - PATCH /subscriptions/:id
    // - DELETE /subscriptions/:id
    // => all require 'manage'
    router.use(bearer('manage'));

    // All responses as application/vnd.api+json
    router.use((req, res, next) => {
        res.setHeader('Content-Type', CONTENT_TYPE);
        next();
    });

    // Base URL for self/related links (without trailing slash)
    function baseUrl(req) {
        return `${req.protocol}://${req.get('host')}/api/v1/subscriptions`;
    }

    // --------------------------------------------------------
    // GET /subscriptions
    // --------------------------------------------------------
    router.get('/', async (req, res) => {
        try {
            const pagination = parsePagination(req.query);
            const { rows, total } = await subscriptionStore.findAll(pagination);

            return res.status(200).json(
                collectionResponse(rows, total, pagination, baseUrl(req))
            );
        } catch (err) {
            return res.status(500).json(errorResponse(500, err.message));
        }
    });

    // --------------------------------------------------------
    // POST /subscriptions  (scope: manage)
    // --------------------------------------------------------
    router.post('/', async (req, res) => {
        try {
            const body = req.body;

            // Minimal JSON:API validation
            if (!body?.data?.type || body.data.type !== 'subscription') {
                return res.status(400).json(
                    errorResponse(400, 'Request body must contain a JSON:API resource object of type "subscription".')
                );
            }

            const attr = body.data.attributes ?? {};
            const rels = body.data.relationships ?? {};

            // subscriptionType default = callback
            const subType = attr.subscriptionType ?? 'callback';

            // Callback requires URL
            if (subType === 'callback' && !attr.url) {
                return res.status(422).json(
                    errorResponse(422, 'Attribute "url" is required for callback subscriptions.')
                );
            }

            // ----------------------------------------------------
            // SPEC-COMPLIANT RELATIONSHIPS
            // ----------------------------------------------------

            // Resolve UUID -> internal datapointId (e.g. 'a0744285-...' -> 'GA-98')
            // so subscription_datapoints consistently stores the internal key
            const allStates = await stateEngine.getAllStates();

            const datapoints = (rels.subscriptionDatapoints?.data ?? []).map(item => {
                if (item.type && item.type !== 'datapoint') {
                    throw new Error(`Invalid relationship type "${item.type}" for subscriptionDatapoints.`);
                }

                const state = allStates.find(s => stableUuid(s.datapointId) === item.id);
                return {
                    datapointId: state?.datapointId ?? item.id, // fallback: keep original
                    expand: item.meta?.expand ?? false,
                };
            });

            const installations = (rels.subscriptionInstallations?.data ?? []).map(item => {
                if (item.type && item.type !== 'installation') {
                    throw new Error(`Invalid relationship type "${item.type}" for subscriptionInstallations.`);
                }

                return {
                    installationId: item.id,
                    expand: item.meta?.expand ?? false,
                };
            });

            const nodeRel = rels.subscriptionNode?.data;

            if (nodeRel?.type && nodeRel.type !== 'node') {
                return res.status(422).json(
                    errorResponse(422, `Invalid relationship type "${nodeRel.type}" for subscriptionNode.`)
                );
            }

            const node = nodeRel
                ? {
                    nodeId: nodeRel.id,
                    expand: nodeRel.meta?.expand ?? false,
                }
                : undefined;

            // At least one resource is required
            if (datapoints.length === 0 && installations.length === 0 && !node) {
                return res.status(422).json(
                    errorResponse(
                        422,
                        'At least one resource (subscriptionDatapoints, subscriptionInstallations or subscriptionNode) must be provided.'
                    )
                );
            }

            let id;
            try {
                id = await subscriptionStore.create({
                    type: subType,
                    url: attr.url,
                    secret: attr.secret,
                    caCert: attr.caCert,
                    lifetime: normalizeLifetime(attr.lifetime),
                    datapoints,
                    installations,
                    node,
                });
            } catch (err) {
                console.error(err);

                return res.status(500).json(
                    errorResponse(500, err.message)
                );
            }

            // 201 + Location header + minimal response object (according to spec)
            res.setHeader('Location', `${baseUrl(req)}/${id}`);

            return res.status(201).json({
                data: {
                    id,
                    type: 'subscription',
                    relationships: {
                        ...(datapoints.length > 0 && {
                            subscriptionDatapoints: {
                                links: {
                                    related: `${baseUrl(req)}/${id}/datapoints`,
                                },
                            },
                        }),
                        ...(installations.length > 0 && {
                            subscriptionInstallations: {
                                links: {
                                    related: `${baseUrl(req)}/${id}/installations`,
                                },
                            },
                        }),
                        ...(node && {
                            subscriptionNode: {
                                links: {
                                    related: `${baseUrl(req)}/${id}/node`,
                                },
                            },
                        }),
                    },
                },
            });
        } catch (err) {
            return res.status(500).json(errorResponse(500, err.message));
        }
    });

    // --------------------------------------------------------
    // GET /subscriptions/:id
    // --------------------------------------------------------
    router.get('/:id', async (req, res) => {
        try {
            const row = await subscriptionStore.findById(req.params.id);

            if (!row) {
                return res.status(404).json(
                    errorResponse(404, `Subscription "${req.params.id}" not found.`)
                );
            }

            return res.status(200).json(itemResponse(row, baseUrl(req)));
        } catch (err) {
            return res.status(500).json(errorResponse(500, err.message));
        }
    });

    // --------------------------------------------------------
    // PATCH /subscriptions/:id
    // Only url, secret, caCert, lifetime are mutable (according to spec).
    // --------------------------------------------------------
    router.patch('/:id', async (req, res) => {
        try {
            const body = req.body;

            // Basic JSON:API validation
            if (!body?.data?.type || body.data.type !== 'subscription') {
                return res.status(400).json(
                    errorResponse(
                        400,
                        'Request body must contain a JSON:API resource object of type "subscription".'
                    )
                );
            }

            // Body ID must match the URL
            if (body.data.id && body.data.id !== req.params.id) {
                return res.status(409).json(
                    errorResponse(
                        409,
                        'Resource id in body does not match URL parameter.'
                    )
                );
            }

            const attr = body.data.attributes ?? {};
            const patch = {};

            if ('url' in attr) {
                patch.url = attr.url;
            }

            if ('secret' in attr) {
                patch.secret = attr.secret;
            }

            if ('caCert' in attr) {
                patch.caCert = attr.caCert;
            }

            if ('lifetime' in attr) {
                patch.lifetime = normalizeLifetime(attr.lifetime);
            }

            // Detect non-patchable fields
            const allowedFields = [
                'url',
                'secret',
                'caCert',
                'lifetime',
            ];

            const invalidFields = Object.keys(attr)
                .filter(key => !allowedFields.includes(key));

            if (invalidFields.length > 0) {
                return res.status(422).json(
                    errorResponse(
                        422,
                        `The following attributes are not patchable: ${invalidFields.join(', ')}`
                    )
                );
            }

            // Empty PATCH
            if (Object.keys(patch).length === 0) {
                return res.status(422).json(
                    errorResponse(
                        422,
                        'No patchable attributes provided (url, secret, caCert, lifetime).'
                    )
                );
            }

            // Relationships cannot be changed according to the spec
            if (body.data.relationships) {
                return res.status(422).json(
                    errorResponse(
                        422,
                        'Relationships cannot be modified via PATCH /subscriptions/:id.'
                    )
                );
            }

            const updated = await subscriptionStore.update(req.params.id, patch);

            if (!updated) {
                return res.status(404).json(
                    errorResponse(
                        404,
                        `Subscription "${req.params.id}" not found.`
                    )
                );
            }

            // Spec-compliant: successful PATCH returns 200.
            return res.status(200).json({ data: null });

        } catch (err) {
            return res.status(500).json(
                errorResponse(500, err.message)
            );
        }
    });

    // --------------------------------------------------------
    // DELETE /subscriptions/:id
    // --------------------------------------------------------
    router.delete('/:id', async (req, res) => {
        try {
            const deleted = await subscriptionStore.delete(req.params.id);
            if (!deleted) {
                return res.status(404).json(
                    errorResponse(404, `Subscription "${req.params.id}" not found.`)
                );
            }
            return res.status(204).send(); // No Content
        } catch (err) {
            return res.status(500).json(errorResponse(500, err.message));
        }
    });

    // --------------------------------------------------------
    // GET /subscriptions/:id/datapoints
    // --------------------------------------------------------
    router.get('/:id/datapoints', async (req, res) => {
        try {
            const exists = await subscriptionStore.findById(req.params.id);

            if (!exists) {
                return res.status(404).json(
                    errorResponse(404, `Subscription "${req.params.id}" not found.`)
                );
            }

            const pagination = parsePagination(req.query);

            const { rows, total } =
                await subscriptionStore.findDatapointsBySubId(req.params.id, pagination);

            return res.status(200).json({
                links: {
                    self: `${baseUrl(req)}/${req.params.id}/datapoints`,
                },

                meta: {
                    total,
                    page: pagination.page,
                    size: pagination.size,
                    pageCount: Math.ceil(total / pagination.size),
                },

                data: rows.map(row => ({
                    id: stableUuid(row.id), // 'GA-98' -> 'a0744285-...' for the client

                    type: 'datapoint',

                    links: {
                        self: `${req.protocol}://${req.get('host')}/api/v1/datapoints/${stableUuid(row.id)}`,
                    },

                    meta: {
                        expand: row.expand ?? false,
                    },
                })),
            });
        } catch (err) {
            return res.status(500).json(
                errorResponse(500, err.message)
            );
        }
    });

    // --------------------------------------------------------
    // GET /subscriptions/:id/installations
    // --------------------------------------------------------
    router.get('/:id/installations', async (req, res) => {
        try {
            const exists = await subscriptionStore.findById(req.params.id);

            if (!exists) {
                return res.status(404).json(
                    errorResponse(404, `Subscription "${req.params.id}" not found.`)
                );
            }

            const pagination = parsePagination(req.query);

            const { rows, total } =
                await subscriptionStore.findInstallationsBySubId(req.params.id, pagination);

            return res.status(200).json({
                links: {
                    self: `${baseUrl(req)}/${req.params.id}/installations`,
                },

                meta: {
                    total,
                    page: pagination.page,
                    size: pagination.size,
                    pageCount: Math.ceil(total / pagination.size),
                },

                data: rows.map(row => ({
                    id: row.id,

                    type: 'installation',

                    links: {
                        self: `${req.protocol}://${req.get('host')}/api/v1/installations/${row.id}`,
                    },

                    meta: {
                        expand: row.expand ?? false,
                    },
                })),
            });
        } catch (err) {
            return res.status(500).json(
                errorResponse(500, err.message)
            );
        }
    });

    // --------------------------------------------------------
    // GET /subscriptions/:id/node
    // --------------------------------------------------------
    router.get('/:id/node', async (req, res) => {
        try {
            const exists = await subscriptionStore.findById(req.params.id);
            if (!exists) {
                return res.status(404).json(
                    errorResponse(404, `Subscription "${req.params.id}" not found.`)
                );
            }

            const node = await subscriptionStore.findNodeBySubId(req.params.id);

            // No node subscribed -> empty data object (according to JSON:API)
            if (!node) {
                return res.status(200).json({ data: null });
            }

            return res.status(200).json({
                data: {
                    id:   node.id,
                    type: 'node',
                    meta: { expand: node.expand },
                },
            });
        } catch (err) {
            return res.status(500).json(errorResponse(500, err.message));
        }
    });

    return router;
}

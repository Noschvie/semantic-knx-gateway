// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

// routes/node.js – KNX IoT Spec §/node endpoint

import { Router } from 'express';
import { bearer } from '../middleware/oauth-bearer.js';
import { stableUuid } from './helpers/knx-iot-uuid.js';

const KNX_SCHEMA_LINK = 'https://schema.knx.org/2020/api';

function knxError(status, title, detail) {
    return { errors: [{ title, links: KNX_SCHEMA_LINK, status: String(status), detail }] };
}

export function nodeRouter(stateEngine) {
    const router = Router();

    // ── GET /api/v1/node ──────────────────────────────────────────────────────
    // Spec §/node: type = "service", no pagination
    router.get('/', bearer('read'), async(req, res) => {
        try {
            const nowIso = new Date().toISOString();
            const nodeId = stableUuid('knx-node-default');

            // Count subscriptions from both persistent (DB) and runtime (WebSocket) sources
            let dbSubscriptions = 0;
            let wsSubscriptions = 0;

            // 1. Count valid (non-expired) subscriptions from DB
            try {
                dbSubscriptions = await stateEngine?.subscriptionStore?.countActive?.({ includeExpired: false }) ?? 0;
            } catch (error) {
                // Log error but don't fail the endpoint
                console.warn('Failed to count DB subscriptions:', error.message);
            }

            // 2. Count active WebSocket client subscriptions from runtime
            try {
                wsSubscriptions = stateEngine?.messagingWebSocket?.getActiveSubscriptionCount?.() ?? 0;
            } catch (error) {
                // Log error but don't fail the endpoint
                console.warn('Failed to count WS subscriptions:', error.message);
            }

            const currentSubscriptions = dbSubscriptions + wsSubscriptions;

            res.json({
                data: {
                    id:   nodeId,
                    type: 'service',
                    attributes: {
                        title:               process.env.INSTALLATION_NAME ?? 'KNX Runtime Node',
                        deviceOrServiceName: process.env.INSTALLATION_NAME ?? 'KNX Runtime Node',
                        vendorOrProvider:    'Semantic KNX Runtime Engine',
                        server:              req.get('host') ?? 'localhost',
                        version: {
                            server: process.env.npm_package_version ?? '0.1.0',
                        },
                        maxSubscriptions:     100,
                        currentSubscriptions,
                        lastModified:         nowIso,
                        currentDateTime:      nowIso,
                    },
                    meta: {
                        '@type':         ['knx:node'],
                        typedescription: `${KNX_SCHEMA_LINK}/work_in_progress?visualisation=swagger#/information/getNode`,
                    },
                    relationships: {
                        nodeSubscriptions: {
                            links: { related: '/api/v1/subscriptions' },
                        },
                    },
                },
            });
        } catch (error) {
            res.status(500).json(knxError(500, 'Internal Server Error', error.message));
        }
    });

    return router;
}

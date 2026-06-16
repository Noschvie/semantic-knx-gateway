// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

// routes/installations.js – KNX IoT Spec §/installations endpoints

import { Router } from 'express';
import { bearer } from '../middleware/oauth-bearer.js';
import { stableUuid, paginate } from './helpers/knx-iot-uuid.js';

const KNX_SCHEMA_LINK = 'https://schema.knx.org/2020/api';

function knxError(status, title, detail) {
    return { errors: [{ title, links: KNX_SCHEMA_LINK, status: String(status), detail }] };
}

/**
 * Builds the default installation resource.
 * The server represents exactly one installation (the configured KNX project).
 */
function defaultInstallationResource() {
    return {
        id:   stableUuid('knx-installation-default'),
        type: 'installation',
        attributes: {
            title:   process.env.INSTALLATION_NAME ?? 'KNX Installation',
            version: '2.1.0',
        },
        meta: {
            '@type': ['knx:installation'],
        },
        relationships: {
            // Spec §/installations/{id}: links to subscriptions
            installationSubscriptions: {
                links: { related: `/api/v1/subscriptions` },
            },
        },
    };
}

export function installationsRouter() {
    const router = Router();

    // ── GET /api/v1/installations ─────────────────────────────────────────────
    // Spec §/installations: page[number], page[size] only (no typeFilter etc.)
    router.get('/', bearer('read'), async (req, res) => {
        try {
            const rawNumber = req.query['page[number]'] ?? req.query.page?.number;
            const rawSize   = req.query['page[size]']   ?? req.query.page?.size;

            const all = [defaultInstallationResource()];
            const { items, total, number, size } = paginate(all, rawNumber, rawSize);

            res.json({ meta: { collection: { number, size, total } }, data: items });
        } catch (error) {
            res.status(500).json(knxError(500, 'Internal Server Error', error.message));
        }
    });

    // ── GET /api/v1/installations/:installationId ─────────────────────────────
    // Spec §/installations/{installationId}
    router.get('/:installationId', bearer('read'), async (req, res) => {
        try {
            const { installationId } = req.params;
            const installation = defaultInstallationResource();

            if (
                installationId !== installation.id &&
                installationId !== 'knx-installation-default'
            ) {
                return res.status(404).json(
                    knxError(404, 'Not Found', `Installation ${installationId} not found`)
                );
            }

            res.json({ data: installation });
        } catch (error) {
            res.status(500).json(knxError(500, 'Internal Server Error', error.message));
        }
    });

    return router;
}

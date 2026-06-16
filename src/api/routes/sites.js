// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

// routes/sites.js – KNX IoT Spec §/sites endpoint

import { Router } from 'express';
import { bearer } from '../middleware/oauth-bearer.js';
import { paginate } from './helpers/knx-iot-uuid.js';
import { toLocationResource, getAllLocations } from './helpers/knx-iot-transform.js';
import { parseFilters, applyAllFilters } from './helpers/knx-iot-filters.js';

const KNX_SCHEMA_LINK = 'https://schema.knx.org/2020/api';

function knxError(status, title, detail) {
    return { errors: [{ title, links: KNX_SCHEMA_LINK, status: String(status), detail }] };
}

export function sitesRouter(semanticEngine) {
    const router = Router();

    // ── GET /api/v1/sites ─────────────────────────────────────────────────────
    // Spec §/sites: root locations only (no parentId), typeFilter, tagFilter, attributeFilter
    router.get('/', bearer('read'), async(req, res) => {
        try {
            const rawNumber = req.query['page[number]'] ?? req.query.page?.number;
            const rawSize   = req.query['page[size]']   ?? req.query.page?.size;

            const allLocations  = await getAllLocations(semanticEngine);
            const rootLocations = allLocations.filter(l => !l.parentId);
            const resources     = rootLocations.map(toLocationResource);

            const filters           = parseFilters(req.query);
            const filteredResources = applyAllFilters(resources, filters);

            const { items, total, number, size } = paginate(filteredResources, rawNumber, rawSize);

            res.json({ meta: { collection: { number, size, total } }, data: items });
        } catch (error) {
            res.status(500).json(knxError(500, 'Internal Server Error', error.message));
        }
    });

    return router;
}

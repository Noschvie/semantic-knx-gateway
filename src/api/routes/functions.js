// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

// routes/functions.js – KNX IoT Spec §/functions endpoints

import { Router } from 'express';
import { bearer } from '../middleware/oauth-bearer.js';
import { stableUuid, paginate } from './helpers/knx-iot-uuid.js';
import { toFunctionResource } from './helpers/knx-iot-transform.js';
import { parseFilters, applyAllFilters } from './helpers/knx-iot-filters.js';

const KNX_SCHEMA_LINK = 'https://schema.knx.org/2020/api';

function knxError(status, title, detail) {
    return { errors: [{ title, links: KNX_SCHEMA_LINK, status: String(status), detail }] };
}

export function functionsRouter(semanticEngine) {
    const router = Router();

    // ── GET /api/v1/functions ─────────────────────────────────────────────────
    // Spec §/functions: page[number], page[size], typeFilter, tagFilter, attributeFilter
    router.get('/', bearer('read'), async(req, res) => {
        try {
            const rawNumber = req.query['page[number]'] ?? req.query.page?.number;
            const rawSize   = req.query['page[size]']   ?? req.query.page?.size;

            const allFunctions      = await semanticEngine.getAllApplicationFunctions();
            const resources         = allFunctions.map(toFunctionResource);
            const filters           = parseFilters(req.query);
            const filteredResources = applyAllFilters(resources, filters);
            const { items, total, number, size } = paginate(filteredResources, rawNumber, rawSize);

            res.json({ meta: { collection: { number, size, total } }, data: items });
        } catch (error) {
            res.status(500).json(knxError(500, 'Internal Server Error', error.message));
        }
    });

    // ── GET /api/v1/functions/:id ─────────────────────────────────────────────
    // Spec §/functions/{functionId}
    router.get('/:id', bearer('read'), async(req, res) => {
        try {
            const { id } = req.params;
            const allFunctions = await semanticEngine.getAllApplicationFunctions();
            const fn = allFunctions.find(
                f => stableUuid(f.id ?? f.uri ?? '') === id || f.id === id,
            );
            if (!fn) {
                return res.status(404).json(knxError(404, 'Not Found', `Function ${id} not found`));
            }
            res.json({ data: toFunctionResource(fn) });
        } catch (error) {
            res.status(500).json(knxError(500, 'Internal Server Error', error.message));
        }
    });

    // ── GET /api/v1/functions/:id/datapoints ─────────────────────────────────
    // Spec §/functions/{functionId}/datapoints: typeFilter, tagFilter, attributeFilter, timeFilter
    router.get('/:id/datapoints', bearer('read'), async(req, res) => {
        try {
            const { id } = req.params;
            const rawNumber = req.query['page[number]'] ?? req.query.page?.number;
            const rawSize   = req.query['page[size]']   ?? req.query.page?.size;

            const allFunctions = await semanticEngine.getAllApplicationFunctions();
            const fn = allFunctions.find(
                f => stableUuid(f.id ?? f.uri ?? '') === id || f.id === id,
            );
            if (!fn) {
                return res.status(404).json(knxError(404, 'Not Found', `Function ${id} not found`));
            }

            const gaUris = fn.groupAddressUris ?? [];
            const data = gaUris.map(gaUri => ({
                id:   stableUuid(gaUri),
                type: 'datapoint',
                attributes: { title: gaUri },
                meta: { '@type': ['knx:FunctionPoint'], internalId: gaUri },
                relationships: {
                    datapointFunctions: { links: { related: `/api/v1/datapoints/${stableUuid(gaUri)}/functions` } },
                },
            }));

            const filters           = parseFilters(req.query);
            const filteredResources = applyAllFilters(data, filters);
            const { items, total, number, size } = paginate(filteredResources, rawNumber, rawSize);

            res.json({ meta: { collection: { number, size, total } }, data: items });
        } catch (error) {
            res.status(500).json(knxError(500, 'Internal Server Error', error.message));
        }
    });

    // ── GET /api/v1/functions/:id/location ───────────────────────────────────
    // Spec §/functions/{functionId}/location – data MAY be null
    router.get('/:id/location', bearer('read'), async(req, res) => {
        try {
            const { id } = req.params;
            const allFunctions = await semanticEngine.getAllApplicationFunctions();
            const fn = allFunctions.find(
                f => stableUuid(f.id ?? f.uri ?? '') === id || f.id === id,
            );
            if (!fn) {
                return res.status(404).json(knxError(404, 'Not Found', `Function ${id} not found`));
            }
            // ETS functions currently have no location mapping
            res.json({ data: null });
        } catch (error) {
            res.status(500).json(knxError(500, 'Internal Server Error', error.message));
        }
    });

    return router;
}

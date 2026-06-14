// SPDX-License-Identifier: CC-BY-NC-SA-4.0
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import { Router } from 'express';
import { bearer } from '../middleware/oauth-bearer.js';
import { paginate, stableUuid } from './helpers/knx-iot-uuid.js';
import { getAllLocations, toLocationResource, toDeviceResource } from './helpers/knx-iot-transform.js';

// KNX IoT Spec §Errors
const KNX_SCHEMA_LINK = 'https://schema.knx.org/2020/api';

function knxError(status, title, detail) {
    return { errors: [{ title, links: KNX_SCHEMA_LINK, status: String(status), detail }] };
}

// Filter Helpers (same as devices.js / datapoints.js)

function parseFilters(query) {
    const filters = [];
    const re = /^filter\[([^\]]+)\](?:\[([^\]]+)\])?$/;
    for (const [param, raw] of Object.entries(query)) {
        const m = param.match(re);
        if (!m) continue;
        const key      = m[1];
        const operator = (m[2] ?? 'eq').toLowerCase();
        const values   = String(raw).split(',').map(v => v.trim()).filter(Boolean);
        filters.push({ key, operator, values });
    }
    return filters;
}

function getField(resource, key) {
    const parts = key.split('.');
    let val = resource;
    for (const p of parts) {
        if (val == null) return undefined;
        val = val[p];
    }
    if (val !== undefined) return val;
    if (parts.length === 1) return resource?.attributes?.[key];
    return undefined;
}

function matchValue(fieldVal, filterVal, operator) {
    if (Array.isArray(fieldVal)) return fieldVal.some(v => matchValue(v, filterVal, operator));
    const a = String(fieldVal ?? '').toLowerCase();
    const b = filterVal.toLowerCase();
    const aStripped = a.includes(':') ? a.split(':').pop() : a;
    const bStripped = b.includes(':') ? b.split(':').pop() : b;
    switch (operator) {
        case 'eq':  return aStripped === bStripped;
        case 'le':  return isNaN(fieldVal) ? a <= b : Number(fieldVal) <= Number(filterVal);
        case 'ge':  return isNaN(fieldVal) ? a >= b : Number(fieldVal) >= Number(filterVal);
        case 'lt':  return isNaN(fieldVal) ? a <  b : Number(fieldVal) <  Number(filterVal);
        case 'gt':  return isNaN(fieldVal) ? a >  b : Number(fieldVal) >  Number(filterVal);
        default:    return aStripped === bStripped;
    }
}

function applyFilter(resources, { key, operator, values }) {
    return resources.filter(resource => {
        const fieldVal = getField(resource, key);
        if (fieldVal === undefined || fieldVal === null) return false;
        if (operator === 'or')  return values.some(v  => matchValue(fieldVal, v, 'eq'));
        if (operator === 'and') return values.every(v => matchValue(fieldVal, v, 'eq'));
        return matchValue(fieldVal, values[0] ?? '', operator);
    });
}

function applyAllFilters(resources, filters) {
    let result = resources;
    for (const filter of filters) result = applyFilter(result, filter);
    return result;
}

// ── Lookup Helper ─────────────────────────────────────────────────────────────

async function findLocation(semanticEngine, id) {
    const allLocations = await getAllLocations(semanticEngine);
    return {
        allLocations,
        loc: allLocations.find(l => stableUuid(l.id ?? l.uri ?? '') === id || l.id === id),
    };
}

// ── Router ────────────────────────────────────────────────────────────────────

export function locationsRouter(semanticEngine) {
    const router = Router();

    // ── GET /api/v1/locations ─────────────────────────────────────────────
    // Spec-Parameter: page[number], page[size], typeFilter, tagFilter, attributeFilter
    router.get('/', bearer('read'), async (req, res) => {
        try {
            const rawNumber = req.query['page[number]'] ?? req.query.page?.number;
            const rawSize   = req.query['page[size]']   ?? req.query.page?.size;

            const allLocations = await getAllLocations(semanticEngine);
            const resources    = allLocations.map(toLocationResource);

            const filters          = parseFilters(req.query);
            const filteredResources = applyAllFilters(resources, filters);

            const { items, total, number, size } = paginate(filteredResources, rawNumber, rawSize);

            res.json({ meta: { collection: { number, size, total } }, data: items });
        } catch (error) {
            res.status(500).json(knxError(500, 'Internal Server Error', error.message));
        }
    });

    // ── GET /api/v1/locations/:id ─────────────────────────────────────────
    router.get('/:id', bearer('read'), async (req, res) => {
        try {
            const { loc } = await findLocation(semanticEngine, req.params.id);

            if (!loc) {
                return res.status(404).json(knxError(404, 'Not Found', `Location ${req.params.id} not found`));
            }

            res.json({ data: toLocationResource(loc) });
        } catch (error) {
            res.status(500).json(knxError(500, 'Internal Server Error', error.message));
        }
    });

    // ── GET /api/v1/locations/:id/parentlocation ──────────────────────────
    // Spec: data MAY be null when no parent location exists
    router.get('/:id/parentlocation', bearer('read'), async (req, res) => {
        try {
            const { allLocations, loc } = await findLocation(semanticEngine, req.params.id);

            if (!loc) {
                return res.status(404).json(knxError(404, 'Not Found', `Location ${req.params.id} not found`));
            }

            if (!loc.parentId) {
                return res.json({ data: null });
            }

            const parent = allLocations.find(l => l.id === loc.parentId);

            res.json({ data: parent ? toLocationResource(parent) : null });
        } catch (error) {
            res.status(500).json(knxError(500, 'Internal Server Error', error.message));
        }
    });

    // ── GET /api/v1/locations/:id/childlocations ──────────────────────────
    // Spec: only directly subordinate locations (no recursive traversal)
    // Spec-Parameter: page[number], page[size], typeFilter, tagFilter, attributeFilter
    router.get('/:id/childlocations', bearer('read'), async (req, res) => {
        try {
            const rawNumber = req.query['page[number]'] ?? req.query.page?.number;
            const rawSize   = req.query['page[size]']   ?? req.query.page?.size;

            const { allLocations, loc } = await findLocation(semanticEngine, req.params.id);

            if (!loc) {
                return res.status(404).json(knxError(404, 'Not Found', `Location ${req.params.id} not found`));
            }

            const children  = allLocations.filter(l => l.parentId === loc.id);
            const resources = children.map(toLocationResource);

            const filters           = parseFilters(req.query);
            const filteredResources = applyAllFilters(resources, filters);

            const { items, total, number, size } = paginate(filteredResources, rawNumber, rawSize);

            res.json({ meta: { collection: { number, size, total } }, data: items });
        } catch (error) {
            res.status(500).json(knxError(500, 'Internal Server Error', error.message));
        }
    });

    // ── GET /api/v1/locations/:id/devices ─────────────────────────────────
    // Spec-Parameter: page[number], page[size], typeFilter, tagFilter, attributeFilter
    router.get('/:id/devices', bearer('read'), async (req, res) => {
        try {
            const rawNumber = req.query['page[number]'] ?? req.query.page?.number;
            const rawSize   = req.query['page[size]']   ?? req.query.page?.size;

            const { loc } = await findLocation(semanticEngine, req.params.id);

            if (!loc) {
                return res.status(404).json(knxError(404, 'Not Found', `Location ${req.params.id} not found`));
            }

            const allDevices     = await semanticEngine.getAllDevices();
            const locationId     = loc.id ?? loc.uri;
            const locationDevices = allDevices.filter(d => d.locationId === locationId || d.room === locationId);
            const resources      = locationDevices.map(toDeviceResource);

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


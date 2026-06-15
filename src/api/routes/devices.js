// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import { Router } from 'express';
import { bearer } from '../middleware/oauth-bearer.js';
import { toDeviceResource } from './helpers/knx-iot-transform.js';
import { paginate, stableUuid } from './helpers/knx-iot-uuid.js';

// ── KNX IoT Spec §Errors ──────────────────────────────────────────────────────
const KNX_SCHEMA_LINK = 'https://schema.knx.org/2020/api';

function knxError(status, title, detail) {
    return { errors: [{ title, links: KNX_SCHEMA_LINK, status: String(status), detail }] };
}

// ── Filter Helpers ────────────────────────────────────────────────────────────

/**
 * Parses all filter[...]-query parameters from req.query.
 *
 * Spec examples:
 *   filter[meta.@type]=Device
 *   filter[meta.@type][or]=Room,Floor
 *   filter[title]=Actuator
 *   filter[state][eq]=Tested
 *   filter[hasTag]=switch
 *
 * @returns {Array<{ key: string, operator: string, values: string[] }>}
 */
function parseFilters(query) {
    const filters = [];
    const re = /^filter\[([^\]]+)\](?:\[([^\]]+)\])?$/;

    for (const [param, raw] of Object.entries(query)) {
        const m = param.match(re);
        if (!m) continue;

        const key      = m[1];                          // e.g. "meta.@type", "title", "hasTag"
        const operator = (m[2] ?? 'eq').toLowerCase();  // eq | or | and | le | ge | lt | gt
        const values   = String(raw).split(',').map(v => v.trim()).filter(Boolean);

        filters.push({ key, operator, values });
    }

    return filters;
}

/**
 * Reads a nested value from an object using a path.
 * Supports: "meta.@type", "attributes.title", "title" (shorthand for attributes.title)
 */
function getField(resource, key) {
    // Direct JSON:API paths: meta.@type, attributes.title, relationships.*
    const parts = key.split('.');

    // Try exact path in the resource object first
    let val = resource;
    for (const p of parts) {
        if (val == null) return undefined;
        val = val[p];
    }
    if (val !== undefined) return val;

    // Shorthand: "title" → resource.attributes.title
    if (parts.length === 1) {
        return resource?.attributes?.[key];
    }

    return undefined;
}

/**
 * Compares two values using the spec operator.
 * String -> lexical, Number -> numeric, Array -> contains check.
 */
function matchValue(fieldVal, filterVal, operator) {
    // Array fields (e.g. meta.@type): at least one element must match
    if (Array.isArray(fieldVal)) {
        return fieldVal.some(v => matchValue(v, filterVal, operator));
    }

    const a = String(fieldVal ?? '').toLowerCase();
    const b = filterVal.toLowerCase();

    // Namespace prefix optional: "Device" matches "knx:device" or "core:Device"
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

/**
 * Applies one filter to an array of JSON:API resources.
 *
 * operator=or  -> field must match one of the values
 * operator=and -> field must match all values
 * all others   -> first value is compared with matchValue
 */
function applyFilter(resources, { key, operator, values }) {
    return resources.filter(resource => {
        const fieldVal = getField(resource, key);

        if (fieldVal === undefined || fieldVal === null) return false;

        if (operator === 'or') {
            return values.some(v => matchValue(fieldVal, v, 'eq'));
        }
        if (operator === 'and') {
            return values.every(v => matchValue(fieldVal, v, 'eq'));
        }

        // eq / le / ge / lt / gt -> first value
        return matchValue(fieldVal, values[0] ?? '', operator);
    });
}

/**
 * Applies all parsed filters sequentially (AND conjunction between filters).
 */
function applyAllFilters(resources, filters) {
    let result = resources;
    for (const filter of filters) {
        result = applyFilter(result, filter);
    }
    return result;
}

// ── Router ────────────────────────────────────────────────────────────────────

export function devicesRouter(semanticEngine) {
    const router = Router();

    // GET /api/v1/devices
    router.get('/', bearer('read'), async (req, res) => {
        try {
            const rawNumber = req.query['page[number]'] ?? req.query.page?.number;
            const rawSize   = req.query['page[size]']   ?? req.query.page?.size;

            const allDevices  = await semanticEngine.getAllDevices();
            const resources   = allDevices.map(toDeviceResource);

            // ── Apply filters (typeFilter / tagFilter / attributeFilter) ─────
            const filters         = parseFilters(req.query);
            const filteredResources = applyAllFilters(resources, filters);

            const { items, total, number, size } = paginate(filteredResources, rawNumber, rawSize);

            res.json({
                meta: { collection: { number, size, total } },
                data: items,
            });
        } catch (error) {
            res.status(500).json(knxError(500, 'Internal Server Error', error.message));
        }
    });

    // GET /api/v1/devices/:id
    router.get('/:id', bearer('read'), async (req, res) => {
        try {
            const { id } = req.params;

            const allDevices = await semanticEngine.getAllDevices();
            const device = allDevices.find(
                d => stableUuid(d.id ?? d.uri ?? '') === id || d.id === id
            );

            if (!device) {
                return res.status(404).json(knxError(404, 'Not Found', `Device ${id} not found`));
            }

            res.json({ data: toDeviceResource(device) });
        } catch (error) {
            res.status(500).json(knxError(500, 'Internal Server Error', error.message));
        }
    });

    return router;
}

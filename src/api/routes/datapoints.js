// SPDX-License-Identifier: CC-BY-NC-SA-4.0
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import { Router } from 'express';
import { bearer } from '../middleware/oauth-bearer.js';
import { paginate, stableUuid } from './helpers/knx-iot-uuid.js';
import { getAllLocations, toDatapointResource } from './helpers/knx-iot-transform.js';
import { decodeValueForKnx, toSpecValue } from './helpers/knx-iot-dpt.js';

// ── KNX IoT Spec §Errors ──────────────────────────────────────────────────────
const KNX_SCHEMA_LINK = 'https://schema.knx.org/2020/api';

function knxError(status, title, detail) {
    return { errors: [{ title, links: KNX_SCHEMA_LINK, status: String(status), detail }] };
}

// ── Filter Helpers (identical to devices.js) ──────────────────────────────────

/**
 * Parses all filter[...][operator] query parameters from req.query.
 *
 * Spec examples:
 *   filter[meta.@type]=DPT_Switch
 *   filter[title][eq]=Light
 *   filter[timestamp][ge]=2021-02-17T17:17:13Z
 *   filter[timestamp][le]=2021-02-17T17:17:17Z
 *   filter[hasTag]=actuator
 *
 * @returns {Array<{ key: string, operator: string, values: string[] }>}
 */
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

/**
 * Reads a field value from a JSON:API resource object.
 * Supports: "meta.@type", "attributes.title", "title" (shorthand).
 */
function getField(resource, key) {
    const parts = key.split('.');

    let val = resource;
    for (const p of parts) {
        if (val == null) return undefined;
        val = val[p];
    }
    if (val !== undefined) return val;

    if (parts.length === 1) {
        return resource?.attributes?.[key];
    }

    return undefined;
}

/**
 * Evaluates a comparison – string lexicographically, number numerically.
 * Namespace prefix (e.g. "knx:") is ignored during comparison.
 */
function matchValue(fieldVal, filterVal, operator) {
    if (Array.isArray(fieldVal)) {
        return fieldVal.some(v => matchValue(v, filterVal, operator));
    }

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

/**
 * Applies a single filter to an array of JSON:API resources.
 * operator=or  → at least one value must match
 * operator=and → all values must match
 */
function applyFilter(resources, { key, operator, values }) {
    return resources.filter(resource => {
        const fieldVal = getField(resource, key);
        if (fieldVal === undefined || fieldVal === null) return false;

        if (operator === 'or')  return values.some(v  => matchValue(fieldVal, v, 'eq'));
        if (operator === 'and') return values.every(v => matchValue(fieldVal, v, 'eq'));

        return matchValue(fieldVal, values[0] ?? '', operator);
    });
}

/**
 * Applies all filters sequentially (AND-conjunction between filters).
 */
function applyAllFilters(resources, filters) {
    let result = resources;
    for (const filter of filters) {
        result = applyFilter(result, filter);
    }
    return result;
}

/**
 * Special handling for filter[timestamp][ge/le/gt/lt]:
 * Filters an array of timeseries entries based on RFC-3339 timestamps.
 *
 * @param {Array}  entries   - Raw history entries with .timestamp
 * @param {Array}  filters   - Parsed filters from parseFilters()
 * @returns {Array}
 */
function applyTimeFilters(entries, filters) {
    const timeFilters = filters.filter(f => f.key === 'timestamp');
    if (timeFilters.length === 0) return entries;

    return entries.filter(entry => {
        const t = new Date(entry.timestamp).getTime();
        if (isNaN(t)) return false;

        return timeFilters.every(({ operator, values }) => {
            const ref = new Date(values[0]).getTime();
            if (isNaN(ref)) return true; // invalid filter → ignore

            switch (operator) {
                case 'ge': return t >= ref;
                case 'gt': return t >  ref;
                case 'le': return t <= ref;
                case 'lt': return t <  ref;
                case 'eq': return t === ref;
                default:   return true;
            }
        });
    });
}

// ── KNX Write Helper ──────────────────────────────────────────────────────────

function normalizeIncomingValue(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value) || (value && typeof value === 'object')) return JSON.stringify(value);
    return String(value);
}

async function writeDatapointValue(uuid, value, stateEngine, tunnelManager) {
    const valueStr = normalizeIncomingValue(value);

    const allStates = await stateEngine.getAllStates().catch(() => []);
    const state = allStates.find(s => stableUuid(s.datapointId) === uuid);

    if (!state) {
        return { error: { status: 404, payload: knxError(404, 'Not Found', `Datapoint with id "${uuid}" not found`) } };
    }

    if (state.writable === false) {
        return { error: { status: 403, payload: knxError(403, 'Forbidden', `Datapoint "${state.name ?? state.ga}" is not writable`) } };
    }

    let nativeValue;
    try {
        nativeValue = decodeValueForKnx(valueStr, state.dpt);
    } catch (err) {
        return { error: { status: 422, payload: knxError(422, 'Unprocessable Entity', err.message) } };
    }

    if (!tunnelManager) {
        return { error: { status: 503, payload: knxError(503, 'Service Unavailable', 'No KNX connection') } };
    }

    try {
        await tunnelManager.write(state.ga, nativeValue, state.dpt);
    } catch (err) {
        return { error: { status: 502, payload: knxError(502, 'Bad Gateway', err.message) } };
    }

    const timestamp = new Date();
    try {
        await stateEngine.updateState(state.datapointId, {
            ga:        state.ga,
            value:     nativeValue,
            dpt:       state.dpt,
            source:    'api',
            timestamp,
        });
    } catch (err) {
        // Non-critical: KNX bus write already succeeded.
        console.warn(`[knx-iot] State update after PUT failed for ${state.ga}: ${err.message}`);
    }

    return {
        data: {
            id:   uuid,
            type: 'datapoint',
            attributes: {
                value:     valueStr,
                valueType: 'string',
                timestamp: timestamp.toISOString(),
            },
            meta: { datapointId: state.datapointId, ga: state.ga, dpt: state.dpt },
        }
    };
}

// ── Router ────────────────────────────────────────────────────────────────────

export function datapointsRouter(stateEngine, tunnelManager) {
    const router = Router();

    // ── GET /api/v1/datapoints ────────────────────────────────────────────
    // Spec parameters: page[number], page[size], typeFilter, tagFilter,
    //                  attributeFilter, timeFilter
    // Vendor extensions: filter[deviceId], filter[locationId], filter[ga],
    //                    filter[datapointId]  (not in Spec, but harmless)
    router.get('/', bearer('read'), async (req, res) => {
        try {
            const rawNumber = req.query['page[number]'] ?? req.query.page?.number;
            const rawSize   = req.query['page[size]']   ?? req.query.page?.size;

            // Vendor filters: applied before resource mapping on raw states
            const filterDeviceId    = req.query['filter[deviceId]']    ?? req.query.filter?.deviceId;
            const filterLocationId  = req.query['filter[locationId]']  ?? req.query.filter?.locationId;
            const filterGa          = req.query['filter[ga]']          ?? req.query.filter?.ga;
            const filterDatapointId = req.query['filter[datapointId]'] ?? req.query.filter?.datapointId;

            // filter[locationId] → resolve internal location ID
            let resolvedLocationId = null;
            if (filterLocationId) {
                const allLocations = await getAllLocations(stateEngine);
                const loc = allLocations.find(
                    l => stableUuid(l.id ?? l.uri ?? '') === filterLocationId
                );
                if (!loc) {
                    return res.json({ meta: { collection: { number: 0, size: 0, total: 0 } }, data: [] });
                }
                resolvedLocationId = loc.id;
            }

            let allStates = await stateEngine.getAllStates(
                resolvedLocationId ? { locationId: resolvedLocationId } : {}
            );

            // Apply vendor filters on raw states
            if (filterGa)          allStates = allStates.filter(s => s.ga === filterGa);
            if (filterDatapointId) allStates = allStates.filter(s => s.datapointId === filterDatapointId);

            if (filterDeviceId) {
                const allDevices  = await stateEngine.semanticEngine?.getAllDevices() ?? [];
                const device = allDevices.find(
                    d => stableUuid(d.id ?? d.uri ?? '') === filterDeviceId
                );
                if (!device) {
                    return res.json({ meta: { collection: { number: 0, size: 0, total: 0 } }, data: [] });
                }
                const deviceGas = stateEngine.getGasByDevice?.(device.id ?? device.uri) ?? new Set();
                allStates = allStates.filter(s => deviceGas.has(s.ga));
            }

            // Build JSON:API resources
            const resources = allStates.map(toDatapointResource);

            // Spec-compliant filters (typeFilter / tagFilter / attributeFilter / timeFilter)
            // filter[timestamp] is applied on resources (attributes.timestamp)
            const filters          = parseFilters(req.query);
            const specFilters      = filters.filter(f => f.key !== 'deviceId' &&
                                                         f.key !== 'locationId' &&
                                                         f.key !== 'ga' &&
                                                         f.key !== 'datapointId');
            const filteredResources = applyAllFilters(resources, specFilters);

            const { items, total, number, size } = paginate(filteredResources, rawNumber, rawSize);

            res.json({
                meta: { collection: { number, size, total } },
                data: items,
            });
        } catch (error) {
            res.status(500).json(knxError(500, 'Internal Server Error', error.message));
        }
    });

    // ── GET /api/v1/datapoints/values (must come BEFORE /:id!) ───────────
    // Not in Spec as GET – vendor extension for bulk-read
    router.get('/values', bearer('read'), async (req, res) => {
        try {
            const allStates = await stateEngine.getAllStates();
            res.json({
                meta: { collection: { total: allStates.length } },
                data: allStates.map(toDatapointResource),
            });
        } catch (error) {
            res.status(500).json(knxError(500, 'Internal Server Error', error.message));
        }
    });

    // ── PUT /api/v1/datapoints/by-ga ──────────────────────────────────────
    // Vendor extension: write value by group address.
    // GA is passed via data.meta.ga (JSON:API-compliant: meta for
    // non-standard fields, no id required since GA-lookup).
    //
    // Request body:
    //   {
    //     "data": {
    //       "type": "datapoint",
    //       "attributes": { "value": "1" },
    //       "meta": { "ga": "1/1/114" }
    //     }
    //   }
    //
    // Response: 200 + written value (analogous to PUT /datapoints)
    router.put('/by-ga', bearer('write'), async (req, res) => {
        const body = req.body;
        const ga    = body?.data?.meta?.ga;
        const value = body?.data?.attributes?.value;

        if (!ga) {
            return res.status(400).json(
                knxError(400, 'Bad Request', 'Body must contain data.meta.ga')
            );
        }

        if (value === undefined) {
            return res.status(400).json(
                knxError(400, 'Bad Request', 'Body must contain data.attributes.value')
            );
        }

        // Resolve GA → state
        const allStates = await stateEngine.getAllStates().catch(() => []);
        const state = allStates.find(s => s.ga === ga);

        if (!state) {
            return res.status(404).json(
                knxError(404, 'Not Found', `No datapoint found for group address "${ga}"`)
            );
        }

        // Write via writeDatapointValue using UUID (unified logic)
        const uuid   = stableUuid(state.datapointId);
        const result = await writeDatapointValue(uuid, value, stateEngine, tunnelManager);
        if (result.error) return res.status(result.error.status).json(result.error.payload);

        return res.status(200).json({ data: result.data });
    });

    // ── GET /api/v1/datapoints/:id/timeseries ─────────────────────────────
    // Spec parameters: page[number], page[size], filter[timestamp][ge/le/gt/lt]
    router.get('/:id/timeseries', bearer('read'), async (req, res) => {
        try {
            const { id } = req.params;
            const rawNumber = req.query['page[number]'] ?? req.query.page?.number;
            const rawSize   = req.query['page[size]']   ?? req.query.page?.size;

            const allStates = await stateEngine.getAllStates();
            const state = allStates.find(
                s => stableUuid(s.datapointId) === id || s.datapointId === id
            );

            if (!state) {
                return res.status(404).json(knxError(404, 'Not Found', `Datapoint ${id} not found`));
            }

            // Load all history entries (without pre-filter – we filter ourselves)
            const history = await stateEngine.getHistory(state.datapointId, { limit: 100_000 });

            // Apply filter[timestamp][ge/le/gt/lt] (RFC 3339)
            const filters        = parseFilters(req.query);
            const filteredHistory = applyTimeFilters(history, filters);

            // Pagination
            const { items, total, number, size } = paginate(filteredHistory, rawNumber, rawSize);

            res.json({
                meta: { collection: { number, size, total } },
                data: items.map(event => ({
                    id:         stableUuid(`${state.datapointId}-${event.timestamp}`),
                    type:       'datapoint',
                    attributes: {
                        timestamp: event.timestamp,
                        ...toSpecValue(event.value),
                    },
                })),
            });
        } catch (error) {
            res.status(500).json(knxError(500, 'Internal Server Error', error.message));
        }
    });

    // ── GET /api/v1/datapoints/:id ────────────────────────────────────────
    router.get('/:id', bearer('read'), async (req, res) => {
        try {
            const { id } = req.params;

            const allStates = await stateEngine.getAllStates();
            const state = allStates.find(
                s => stableUuid(s.datapointId) === id || s.datapointId === id
            );

            if (!state) {
                return res.status(404).json(knxError(404, 'Not Found', `Datapoint ${id} not found`));
            }

            res.json({ data: toDatapointResource(state) });
        } catch (error) {
            res.status(500).json(knxError(500, 'Internal Server Error', error.message));
        }
    });

    // ── GET /api/v1/datapoints/:id/history ───────────────────────────────
    // Vendor extension (not in Spec) – proprietary format for internal use.
    // Supports startTime/endTime as convenience aliases for filter[timestamp].
    router.get('/:id/history', bearer('read'), async (req, res) => {
        try {
            const { id }                        = req.params;
            const { startTime, endTime, limit } = req.query;

            const options = {
                startTime: startTime ? new Date(startTime) : undefined,
                endTime:   endTime   ? new Date(endTime)   : undefined,
                limit:     limit     ? parseInt(limit)     : 1000,
            };

            const history = await stateEngine.getHistory(id, options);

            res.json({ datapointId: id, events: history, count: history.length });
        } catch (error) {
            res.status(500).json(knxError(500, 'Internal Server Error', error.message));
        }
    });

    // ── PUT /api/v1/datapoints/values ─────────────────────────────────────
    // Spec §/datapoints/values – bulk write, responds with 204 No Content
    router.put('/values', bearer('write'), async (req, res) => {
        const body = req.body;

        if (!Array.isArray(body?.data) || body.data.length === 0) {
            return res.status(400).json(
                knxError(400, 'Bad Request', 'Body must contain data[] with datapoint id and attributes.value')
            );
        }

        for (const item of body.data) {
            if (!item?.id || item?.attributes?.value === undefined) {
                return res.status(400).json(
                    knxError(400, 'Bad Request', 'Each data item must contain id and attributes.value')
                );
            }

            const result = await writeDatapointValue(item.id, item.attributes.value, stateEngine, tunnelManager);
            if (result.error) return res.status(result.error.status).json(result.error.payload);
        }

        // Spec §/datapoints/values: 204 No Content for synchronous processing
        return res.status(204).end();
    });

    // ── PUT /api/v1/datapoints ────────────────────────────────────────────
    // Vendor extension: single datapoint write via JSON:API body
    router.put('/', bearer('write'), async (req, res) => {
        const body = req.body;

        if (!body?.data?.id || body?.data?.attributes?.value === undefined) {
            return res.status(400).json(
                knxError(400, 'Bad Request', 'Body must contain data.id and data.attributes.value')
            );
        }

        const result = await writeDatapointValue(body.data.id, body.data.attributes.value, stateEngine, tunnelManager);
        if (result.error) return res.status(result.error.status).json(result.error.payload);

        return res.status(200).json({ data: result.data });
    });

    return router;
}

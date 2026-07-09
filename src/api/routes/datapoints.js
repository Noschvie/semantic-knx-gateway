// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import { Router } from 'express';
import { bearer } from '../middleware/oauth-bearer.js';
import { DPT_NAME_MAP } from '../../utils/dpt-map.js';
import { paginate, stableUuid } from './helpers/knx-iot-uuid.js';
import { toDatapointResource } from './helpers/knx-iot-transform.js';
import { decodeValueForKnx, toSpecValue } from './helpers/knx-iot-dpt.js';
import { parseFilters } from './helpers/knx-iot-filters.js';

// ── KNX IoT Spec §Errors ──────────────────────────────────────────────────────
const KNX_SCHEMA_LINK = 'https://schema.knx.org/2020/api';

function knxError(status, title, detail) {
    return { errors: [{ title, links: KNX_SCHEMA_LINK, status: String(status), detail }] };
}

// ── Filter Helpers (identical to devices.js) ──────────────────────────────────

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

// ── KNX Datapoint Helper ──────────────────────────────────────────────────────────

function normalizeDpt(inputDpt) {
    if (!inputDpt) return null;
    if (/^\d+\.\d+$/.test(inputDpt)) return inputDpt; // already numeric
    return DPT_NAME_MAP[inputDpt] || null;
}

function getDatapointUnionKey(item) {
    const datapointId = item?.datapointId ?? item?.datapoint_id;
    if (datapointId) return `id:${datapointId}`;
    if (item?.ga) return `ga:${item.ga}`;
    return null;
}

async function getDatapointMappings(stateEngine) {
    try {
        const result = await stateEngine.db.query(`
            SELECT datapoint_id AS "datapointId",
                   ga,
                   dpt,
                   name,
                   location_id  AS "locationId",
                   device_id    AS "deviceId"
            FROM datapoint_mappings
        `);
        return result.rows ?? [];
    } catch {
        return [];
    }
}

async function getDatapointMappingByUuid(uuid, stateEngine) {
    const mappings = await getDatapointMappings(stateEngine);
    return mappings.find(m => stableUuid(m.datapointId) === uuid) ?? null;
}

function toDatapointResourceWithStateMeta(state) {
    const resource = toDatapointResource(state);

    resource.meta = {
        ...(resource.meta ?? {}),
        hasCurrentState: state.hasCurrentState === true,
    };

    if (state.hasCurrentState !== true) {
        resource.attributes = {
            ...(resource.attributes ?? {}),
            value: null,
            valueType: 'string',
            timestamp: null,
        };
    }

    return resource;
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
    const currentState = allStates.find(s => stableUuid(s.datapointId) === uuid) ?? null;
    const mapping = await getDatapointMappingByUuid(uuid, stateEngine);

    // If neither a current state nor a mapping exists, > a true 404 error
    if (!currentState && !mapping) {
        return {
            error: {
                status: 404,
                payload: knxError(404, 'Not Found', `Datapoint with id "${uuid}" not found`),
            },
        };
    }

    // Assemble writing context from state + mapping
    const datapointId = currentState?.datapointId ?? mapping?.datapointId;
    const ga = currentState?.ga ?? mapping?.ga;
    const dpt = currentState?.dpt ?? mapping?.dpt;
    const name = currentState?.name ?? mapping?.name ?? ga;

    // Only strictly prohibit writable if explicitly false.
    const writable = currentState?.writable;
    if (writable === false) {
        return {
            error: {
                status: 403,
                payload: knxError(403, 'Forbidden', `Datapoint "${name}" is not writable`),
            },
        };
    }

    // KNX write is not possible without GA/DPT
    if (!ga || !dpt || !datapointId) {
        return {
            error: {
                status: 422,
                payload: knxError(422, 'Unprocessable Entity', `Missing datapoint metadata for "${uuid}" (ga/dpt/datapointId)`),
            },
        };
    }

    const resolvedDpt = normalizeDpt(dpt);
    if (!resolvedDpt) {
        return {
            error: {
                status: 400,
                payload: knxError(400, 'Bad Request', `Unknown or unsupported DPT: ${dpt}`),
            },
        };
    }

    let nativeValue;
    try {
        nativeValue = decodeValueForKnx(valueStr, resolvedDpt);
    } catch (err) {
        return {
            error: {
                status: 422,
                payload: knxError(422, 'Unprocessable Entity', err.message),
            },
        };
    }

    if (!tunnelManager) {
        return {
            error: {
                status: 503,
                payload: knxError(503, 'Service Unavailable', 'No KNX connection'),
            },
        };
    }

    try {
        await tunnelManager.write(ga, nativeValue, resolvedDpt);
    } catch (err) {
        return {
            error: {
                status: 502,
                payload: knxError(502, 'Bad Gateway', err.message),
            },
        };
    }

    const timestamp = new Date();
    try {
        await stateEngine.updateState(datapointId, {
            ga,
            value: nativeValue,
            dpt,
            source: 'api',
            timestamp,
        });
    } catch (err) {
        console.warn(`[knx-iot] State update after PUT failed for ${ga}: ${err.message}`);
    }

    return {
        data: {
            id: uuid,
            type: 'datapoint',
            attributes: {
                value: valueStr,
                valueType: 'string',
                timestamp: timestamp.toISOString(),
            },
            meta: { datapointId, ga, dpt },
        },
    };
}

// ── Router ────────────────────────────────────────────────────────────────────

export function datapointsRouter(stateEngine, tunnelManager) {
    const router = Router();

    // ── GET /api/v2/datapoints ────────────────────────────────────────────
    // Spec parameters: page[number], page[size], typeFilter, tagFilter,
    //                  attributeFilter, timeFilter
    // Vendor extensions: filter[deviceId], filter[locationId], filter[ga],
    //                    filter[datapointId]  (not in Spec, but harmless)
    router.get('/', bearer('read'), async(req, res) => {
        try {
            const rawNumber = req.query['page[number]'] ?? req.query.page?.number;
            const rawSize   = req.query['page[size]']   ?? req.query.page?.size;

            const filterDeviceId    = req.query['filter[deviceId]']    ?? req.query.filter?.deviceId;
            const filterLocationId  = req.query['filter[locationId]']  ?? req.query.filter?.locationId;
            const filterGa          = req.query['filter[ga]']          ?? req.query.filter?.ga;
            const filterDatapointId = req.query['filter[datapointId]'] ?? req.query.filter?.datapointId;

            const [allStates, datapointMappings] = await Promise.all([
                stateEngine.getAllStates(),
                getDatapointMappings(stateEngine),
            ]);

            const mappingByDatapointId = new Map();
            const mappingByGa = new Map();
            const unionByKey = new Map();

            for (const mapping of datapointMappings) {
                if (mapping.datapointId) mappingByDatapointId.set(mapping.datapointId, mapping);
                if (mapping.ga) mappingByGa.set(mapping.ga, mapping);

                const key = getDatapointUnionKey(mapping);
                if (!key) continue;

                unionByKey.set(key, {
                    ...mapping,
                    value: null,
                    updatedAt: null,
                    hasCurrentState: false,
                });
            }

            for (const state of allStates) {
                const mapping = mappingByDatapointId.get(state.datapointId)
                    ?? mappingByGa.get(state.ga)
                    ?? null;

                // Skip orphaned states without a mapping
                // (prevents duplicate/stale datapoints from old KNX systems appearing in API)
                if (!mapping) {
                    continue;
                }

                const merged = {
                    ...mapping,
                    ...state,
                    datapointId: state.datapointId ?? mapping?.datapointId,
                    ga: state.ga ?? mapping?.ga,
                    dpt: state.dpt ?? mapping?.dpt,
                    name: state.name ?? mapping?.name,
                    locationId: state.locationId ?? mapping?.locationId ?? null,
                    deviceId: mapping?.deviceId ?? null,
                    hasCurrentState: true,
                };

                const key = getDatapointUnionKey(merged);
                if (!key) continue;

                unionByKey.set(key, merged);
            }

            let unionDatapoints = Array.from(unionByKey.values());

            if (filterGa) {
                unionDatapoints = unionDatapoints.filter((s) => s.ga === filterGa);
            }

            if (filterDatapointId) {
                unionDatapoints = unionDatapoints.filter((s) =>
                    s.datapointId === filterDatapointId || stableUuid(s.datapointId ?? '') === filterDatapointId,
                );
            }

            if (filterLocationId) {
                unionDatapoints = unionDatapoints.filter(
                    (s) => s.locationId && stableUuid(s.locationId) === filterLocationId,
                );
            }

            if (filterDeviceId) {
                unionDatapoints = unionDatapoints.filter(
                    (s) => s.deviceId && stableUuid(s.deviceId) === filterDeviceId,
                );
            }

            const resources = unionDatapoints.map(toDatapointResourceWithStateMeta);

            const filters = parseFilters(req.query);
            const specFilters = filters.filter(f => f.key !== 'deviceId' &&
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

    // ── GET /api/v2/datapoints/values (must come BEFORE /:id!) ───────────
    // Not in Spec as GET – vendor extension for bulk-read
    router.get('/values', bearer('read'), async(req, res) => {
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

    // ── PUT /api/v2/datapoints/by-ga ──────────────────────────────────────
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
    router.put('/by-ga', bearer('write'), async(req, res) => {
        const body = req.body;
        const ga    = body?.data?.meta?.ga;
        const value = body?.data?.attributes?.value;

        if (!ga) {
            return res.status(400).json(
                knxError(400, 'Bad Request', 'Body must contain data.meta.ga'),
            );
        }

        if (value === undefined) {
            return res.status(400).json(
                knxError(400, 'Bad Request', 'Body must contain data.attributes.value'),
            );
        }

        if (body?.data?.type !== 'datapoint') {
            return res.status(400).json(
                knxError(400, 'Bad Request', `data.type must be "datapoint", got "${body?.data?.type}"`),
            );
        }

        // Resolve GA → state
        const allStates = await stateEngine.getAllStates().catch(() => []);
        const state = allStates.find(s => s.ga === ga);

        if (!state) {
            return res.status(404).json(
                knxError(404, 'Not Found', `No datapoint found for group address "${ga}"`),
            );
        }

        // Write via writeDatapointValue using UUID (unified logic)
        const uuid   = stableUuid(state.datapointId);
        const result = await writeDatapointValue(uuid, value, stateEngine, tunnelManager);
        if (result.error) return res.status(result.error.status).json(result.error.payload);

        return res.status(200).json({ data: result.data });
    });

    // ── GET /api/v2/datapoints/:id/timeseries ─────────────────────────────
    // Spec parameters: page[number], page[size], filter[timestamp][ge/le/gt/lt]
    router.get('/:id/timeseries', bearer('read'), async(req, res) => {
        try {
            const { id } = req.params;
            const rawNumber = req.query['page[number]'] ?? req.query.page?.number;
            const rawSize   = req.query['page[size]']   ?? req.query.page?.size;

            const [allStates, datapointMappings] = await Promise.all([
                stateEngine.getAllStates(),
                getDatapointMappings(stateEngine),
            ]);

            const mappingByDatapointId = new Map();
            const mappingByGa = new Map();
            const unionByKey = new Map();

            for (const mapping of datapointMappings) {
                if (mapping.datapointId) mappingByDatapointId.set(mapping.datapointId, mapping);
                if (mapping.ga) mappingByGa.set(mapping.ga, mapping);

                const key = getDatapointUnionKey(mapping);
                if (!key) continue;

                unionByKey.set(key, {
                    ...mapping,
                    value: null,
                    updatedAt: null,
                    hasCurrentState: false,
                });
            }

            for (const state of allStates) {
                const mapping = mappingByDatapointId.get(state.datapointId)
                    ?? mappingByGa.get(state.ga)
                    ?? null;

                // Skip orphaned states without a mapping
                if (!mapping) {
                    continue;
                }

                const merged = {
                    ...mapping,
                    ...state,
                    datapointId: state.datapointId ?? mapping?.datapointId,
                    ga: state.ga ?? mapping?.ga,
                    dpt: state.dpt ?? mapping?.dpt,
                    name: state.name ?? mapping?.name,
                    locationId: state.locationId ?? mapping?.locationId ?? null,
                    deviceId: mapping?.deviceId ?? null,
                    hasCurrentState: true,
                };

                const key = getDatapointUnionKey(merged);
                if (!key) continue;

                unionByKey.set(key, merged);
            }

            const unionDatapoints = Array.from(unionByKey.values());

            const datapoint = unionDatapoints.find(
                (dp) => stableUuid(dp.datapointId ?? '') === id
                    || dp.datapointId === id
                    || dp.ga === id
                    || stableUuid(dp.ga ?? '') === id,
            );

            if (!datapoint) {
                return res.status(404).json(knxError(404, 'Not Found', `Datapoint ${id} not found`));
            }

            // Load history only if datapoint has current state; offline datapoints have no history
            let history = [];
            if (datapoint.hasCurrentState === true) {
                history = await stateEngine.getHistory(datapoint.datapointId, { limit: 100_000 });
            }

            // Apply filter[timestamp][ge/le/gt/lt] (RFC 3339)
            const filters        = parseFilters(req.query);
            const filteredHistory = applyTimeFilters(history, filters);

            // Pagination
            const { items, total, number, size } = paginate(filteredHistory, rawNumber, rawSize);

            res.json({
                meta: { collection: { number, size, total } },
                data: items.map(event => ({
                    id:         stableUuid(`${datapoint.datapointId}-${event.timestamp}`),
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

    // ── GET /api/v2/datapoints/:id ────────────────────────────────────────
    router.get('/:id', bearer('read'), async(req, res) => {
        try {
            const { id } = req.params;

            const [allStates, datapointMappings] = await Promise.all([
                stateEngine.getAllStates(),
                getDatapointMappings(stateEngine),
            ]);

            const mappingByDatapointId = new Map();
            const mappingByGa = new Map();
            const unionByKey = new Map();

            for (const mapping of datapointMappings) {
                if (mapping.datapointId) mappingByDatapointId.set(mapping.datapointId, mapping);
                if (mapping.ga) mappingByGa.set(mapping.ga, mapping);

                const key = getDatapointUnionKey(mapping);
                if (!key) continue;

                unionByKey.set(key, {
                    ...mapping,
                    value: null,
                    updatedAt: null,
                    hasCurrentState: false,
                });
            }

            for (const state of allStates) {
                const mapping = mappingByDatapointId.get(state.datapointId)
                    ?? mappingByGa.get(state.ga)
                    ?? null;

                // Skip orphaned states without a mapping
                if (!mapping) {
                    continue;
                }

                const merged = {
                    ...mapping,
                    ...state,
                    datapointId: state.datapointId ?? mapping?.datapointId,
                    ga: state.ga ?? mapping?.ga,
                    dpt: state.dpt ?? mapping?.dpt,
                    name: state.name ?? mapping?.name,
                    locationId: state.locationId ?? mapping?.locationId ?? null,
                    deviceId: mapping?.deviceId ?? null,
                    hasCurrentState: true,
                };

                const key = getDatapointUnionKey(merged);
                if (!key) continue;

                unionByKey.set(key, merged);
            }

            const unionDatapoints = Array.from(unionByKey.values());

            const datapoint = unionDatapoints.find(
                (dp) => stableUuid(dp.datapointId ?? '') === id
                    || dp.datapointId === id
                    || dp.ga === id
                    || stableUuid(dp.ga ?? '') === id,
            );

            if (!datapoint) {
                return res.status(404).json(knxError(404, 'Not Found', `Datapoint ${id} not found`));
            }

            res.json({ data: toDatapointResourceWithStateMeta(datapoint) });
        } catch (error) {
            res.status(500).json(knxError(500, 'Internal Server Error', error.message));
        }
    });

    // ── GET /api/v2/datapoints/:id/history ───────────────────────────────
    // Vendor extension (not in Spec) – proprietary format for internal use.
    // Supports startTime/endTime as convenience aliases for filter[timestamp].
    router.get('/:id/history', bearer('read'), async(req, res) => {
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

    // ── PUT /api/v2/datapoints/values ─────────────────────────────────────
    // Spec §/datapoints/values – bulk write, responds with 204 No Content
    router.put('/values', bearer('write'), async(req, res) => {
        const body = req.body;

        if (!Array.isArray(body?.data) || body.data.length === 0) {
            return res.status(400).json(
                knxError(400, 'Bad Request', 'Body must contain data[] with datapoint id and attributes.value'),
            );
        }

        for (const item of body.data) {
            if (!item?.id || item?.attributes?.value === undefined) {
                return res.status(400).json(
                    knxError(400, 'Bad Request', 'Each data item must contain id and attributes.value'),
                );
            }

            if (item.type !== 'datapoint') {
                return res.status(400).json(
                    knxError(400, 'Bad Request', `Each data item must have type "datapoint", got "${item.type}"`),
                );
            }

            const result = await writeDatapointValue(item.id, item.attributes.value, stateEngine, tunnelManager);
            if (result.error) return res.status(result.error.status).json(result.error.payload);
        }

        // Spec §/datapoints/values: 204 No Content for synchronous processing
        return res.status(204).end();
    });

    return router;
}

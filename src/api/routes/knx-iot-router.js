// SPDX-License-Identifier: CC-BY-NC-SA-4.0
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

// knx-iot-router.js – KNX IoT Spec v2.1.0 Layer

import { Router } from 'express';

import { stableUuid, paginate } from './helpers/knx-iot-uuid.js';
import { toLocationResource, toFunctionResource, getAllLocations } from './helpers/knx-iot-transform.js';
import { bearer } from '../middleware/oauth-bearer.js';

// ── KNX IoT Spec §Errors ──────────────────────────────────────────────────────
const KNX_SCHEMA_LINK = 'https://schema.knx.org/2020/api';

function knxError(status, title, detail) {
    return { errors: [{ title, links: KNX_SCHEMA_LINK, status: String(status), detail }] };
}

// ── Filter Helpers (same as devices.js / datapoints.js / locations.js)

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

// ── Installation Resource ─────────────────────────────────────────────────────

function defaultInstallationResource() {
    return {
        id:   stableUuid('knx-installation-default'),
        type: 'installation',
        attributes: {
            title:   process.env.INSTALLATION_NAME ?? 'KNX Installation',
            version: '2.1.0',
        },
        meta: { '@type': ['knx:installation'] },
        relationships: {},
    };
}

// ── Router ────────────────────────────────────────────────────────────────────

export function knxIotRouter(semanticEngine, stateEngine) {
    const router = Router();

    // ── GET /api/v1/functions ─────────────────────────────────────────────
    // Spec-Parameter: page[number], page[size], typeFilter, tagFilter, attributeFilter
    router.get('/functions', bearer('read'), async (req, res) => {
        try {
            const rawNumber = req.query['page[number]'] ?? req.query.page?.number;
            const rawSize   = req.query['page[size]']   ?? req.query.page?.size;

            const allFunctions = await semanticEngine.getAllFunctions();
            const resources    = allFunctions.map(toFunctionResource);

            const filters           = parseFilters(req.query);
            const filteredResources = applyAllFilters(resources, filters);

            const { items, total, number, size } = paginate(filteredResources, rawNumber, rawSize);

            res.json({ meta: { collection: { number, size, total } }, data: items });
        } catch (error) {
            res.status(500).json(knxError(500, 'Internal Server Error', error.message));
        }
    });

    // ── GET /api/v1/functions/:id ─────────────────────────────────────────
    router.get('/functions/:id', bearer('read'), async (req, res) => {
        try {
            const { id } = req.params;

            const allFunctions = await semanticEngine.getAllFunctions();
            const fn = allFunctions.find(
                f => stableUuid(f.id ?? f.uri ?? '') === id || f.id === id
            );

            if (!fn) {
                return res.status(404).json(knxError(404, 'Not Found', `Function ${id} not found`));
            }

            res.json({ data: toFunctionResource(fn) });
        } catch (error) {
            res.status(500).json(knxError(500, 'Internal Server Error', error.message));
        }
    });

    // ── GET /api/v1/node ──────────────────────────────────────────────────
    // Spec: type = "service", attributes including title + version.server as object
    router.get('/node', bearer('read'), async (req, res) => {
        try {
            const nowIso = new Date().toISOString();
            const nodeId = stableUuid('knx-node-default');

            // Determine current subscription count from SubscriptionStore (optional)
            let currentSubscriptions = 0;
            try {
                const subs = await stateEngine?.subscriptionStore?.getAll?.() ?? [];
                currentSubscriptions = subs.length;
            } catch { /* non-critical */ }

            res.json({
                data: {
                    id:   nodeId,
                    type: 'service',   // Spec example: "service", not "node"
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

    // ── GET /api/v1/installations ─────────────────────────────────────────
    // Spec-Parameter: page[number], page[size]
    router.get('/installations', bearer('read'), async (req, res) => {
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

    // ── GET /api/v1/installations/:installationId ─────────────────────────
    router.get('/installations/:installationId', bearer('read'), async (req, res) => {
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

    // ── GET /api/v1/sites ─────────────────────────────────────────────────
    // Spec: only root-level locations (without parentId)
    // Spec-Parameter: page[number], page[size], typeFilter, tagFilter, attributeFilter
    router.get('/sites', bearer('read'), async (req, res) => {
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

// ── GET /.well-known/knx Handler ──────────────────────────────────────────────
//
// Spec §/.well-known/knx:
//  - NO JSON:API format - own schema: api / supportedversions / links / context
//  - Content-Type: application/json (not application/vnd.api+json)
//  - security: [] - no bearer token required
//  - URL must NOT include an API base path (so /.well-known/knx, not /api/v1/...)
//
export function wellKnownKnxHandler() {
    return async (req, res) => {
        // Spec requires application/json (not vnd.api+json)
        res.setHeader('Content-Type', 'application/json');

        res.json({
            api: {
                version: '2.1.0',
                base:    '/api/v1',
            },
            supportedversions: [],
            links: [
                { href: '/installations', contenttype: 'application/vnd.api+json',                        rel: 'installations'  },
                { href: '/node',          contenttype: 'application/vnd.api+json',                        rel: 'node',
                  typedescription: `${KNX_SCHEMA_LINK}/work_in_progress?visualisation=swagger#/information/getNode` },
                { href: '/datapoints',    contenttype: 'application/vnd.api+json',                        rel: 'datapoints'     },
                { href: '/devices',       contenttype: 'application/vnd.api+json',                        rel: 'devices'        },
                { href: '/functions',     contenttype: 'application/vnd.api+json',                        rel: 'functions'      },
                { href: '/locations',     contenttype: 'application/vnd.api+json',                        rel: 'locations'      },
                { href: '/sites',         contenttype: 'application/vnd.api+json',                        rel: 'sites'          },
                { href: '/subscriptions', contenttype: 'application/vnd.api+json',                        rel: 'subscriptions'  },
            ],
            context: [
                { prefix: 'knx', iri: 'http://schema.knx.org/2020/ontology/knx#' },
                { prefix: 'loc', iri: 'http://schema.knx.org/2020/ontology/loc#' },
                { prefix: 'dpa', iri: 'http://schema.knx.org/2020/ontology/dpa#' },
                { prefix: 'tag', iri: 'http://schema.knx.org/2020/ontology/tag#' },
            ],
        });
    };
}


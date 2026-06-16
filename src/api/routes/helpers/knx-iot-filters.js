// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

// helpers/knx-iot-filters.js – Spec-konforme Filter-Helfer

/**
 * Matches JSON:API-style filter query parameters:
 *   filter[key]
 *   filter[key][operator]
 */
const FILTER_QUERY_PARAM_RE = /^filter\[([^][]+)](?:\[([^][]+)])?$/;

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
export function parseFilters(query) {
    return Object.entries(query).flatMap(([param, raw]) => {
        const match = param.match(FILTER_QUERY_PARAM_RE);
        if (!match) return [];

        return [{
            key:      match[1],
            operator: (match[2] ?? 'eq').toLowerCase(),
            values:   String(raw).split(',').map(v => v.trim()).filter(Boolean),
        }];
    });
}

/**
 * Navigates a nested resource object by a dot-separated key path.
 * Falls back to resource.attributes[key] for single-segment keys.
 */
export function getField(resource, key) {
    const parts = key.split('.');
    let val = resource;

    for (const part of parts) {
        if (val == null) return undefined;
        val = val[part];
    }

    if (val !== undefined) return val;
    if (parts.length === 1) return resource?.attributes?.[key];

    return undefined;
}

/**
 * Compares a field value against a filter value using the given operator.
 * Strips namespace prefixes (e.g. "knx:function" → "function") for eq comparison.
 */
export function matchValue(fieldVal, filterVal, operator) {
    if (Array.isArray(fieldVal)) return fieldVal.some(v => matchValue(v, filterVal, operator));

    const a = String(fieldVal ?? '').toLowerCase();
    const b = filterVal.toLowerCase();
    const aStripped = a.includes(':') ? a.split(':').pop() : a;
    const bStripped = b.includes(':') ? b.split(':').pop() : b;

    switch (operator) {
        case 'eq': return aStripped === bStripped;
        case 'le': return isNaN(fieldVal) ? a <= b : Number(fieldVal) <= Number(filterVal);
        case 'ge': return isNaN(fieldVal) ? a >= b : Number(fieldVal) >= Number(filterVal);
        case 'lt': return isNaN(fieldVal) ? a < b : Number(fieldVal) < Number(filterVal);
        case 'gt': return isNaN(fieldVal) ? a > b : Number(fieldVal) > Number(filterVal);
        default:   return aStripped === bStripped;
    }
}

/**
 * Applies a single filter to an array of JSON:API resources.
 */
export function applyFilter(resources, { key, operator, values }) {
    return resources.filter(resource => {
        const fieldVal = getField(resource, key);
        if (fieldVal === undefined || fieldVal === null) return false;

        if (operator === 'or') return values.some(v => matchValue(fieldVal, v, 'eq'));
        if (operator === 'and') return values.every(v => matchValue(fieldVal, v, 'eq'));

        return matchValue(fieldVal, values[0] ?? '', operator);
    });
}

/**
 * Applies all filters sequentially (AND-conjunction between filters).
 */
export function applyAllFilters(resources, filters) {
    return filters.reduce(applyFilter, resources);
}

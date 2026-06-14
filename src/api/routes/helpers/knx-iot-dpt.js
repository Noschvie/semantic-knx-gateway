// SPDX-License-Identifier: CC-BY-NC-SA-4.0
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

// helpers/knx-iot-dpt.js - DPT encoding, GA conversion, spec value mapping

import { DPT_NAME_MAP, DPT_TO_DATAPOINT_TYPE } from '../../../utils/dpt-map.js';

/**
 * Resolves a DPT string to KNX IoT spec-compliant datapointType IRIs.
 * Example: "9.001" -> ["knx:dpa.9.1"]
 */
export function resolveDatapointTypes(dpt) {
    if (!dpt) return [];
    let resolved = dpt;
    if (!/^\d/.test(dpt)) {
        resolved = DPT_NAME_MAP[dpt]
            ?? DPT_NAME_MAP[Object.keys(DPT_NAME_MAP).find(
                (k) => k.toLowerCase() === dpt.toLowerCase()
            )]
            ?? dpt;
    }
    const iri = DPT_TO_DATAPOINT_TYPE[resolved];
    if (iri) return [iri];
    const main = parseInt(resolved.split('.')[0]);
    const sub  = parseInt(resolved.split('.')[1] ?? '0');
    if (!isNaN(main)) return [`knx:dpa.${main}.${sub}`];
    return [];
}

/**
 * Converts GA string "1/5/1" into KNX integer encoding.
 * Formula: main*2048 + middle*256 + sub
 */
export function gaToInteger(gaString) {
    if (!gaString) return null;
    const parts = gaString.split('/').map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return null;
    const [main, middle, sub] = parts;
    return main * 2048 + middle * 256 + sub;
}

/**
 * Converts arbitrary DB values to spec-compliant strings or arrays.
 * Spec: value is ALWAYS string or array (never boolean/number directly).
 * @returns {{ value: string|string[]|null, valueType: 'string'|'object' }}
 */
export function toSpecValue(rawValue) {
    if (rawValue === null || rawValue === undefined) {
        return { value: null, valueType: 'string' };
    }

    // Unpack JSON-parsed strings from the DB
    let val = rawValue;
    if (typeof val === 'string') {
        try {
            val = JSON.parse(val);
        } catch {
            return { value: rawValue, valueType: 'string' };
        }
    }

    // Buffer objects -> hex string
    if (val && typeof val === 'object' && val.type === 'Buffer' && Array.isArray(val.data)) {
        return { value: Buffer.from(val.data).toString('hex'), valueType: 'string' };
    }

    // Arrays -> valueType "object"
    if (Array.isArray(val)) {
        return { value: val.map(String), valueType: 'object' };
    }

    // Objects -> valueType "object", as JSON string
    if (typeof val === 'object') {
        return { value: JSON.stringify(val), valueType: 'object' };
    }

    // Boolean, Number -> String
    return { value: String(val), valueType: 'string' };
}

/**
 * Converts a spec string value into the native type expected by knxultimate.
 * Spec: value is ALWAYS a string ("1", "0", "21.5").
 * knxultimate expects: boolean for DPT 1.x, number for DPT 5.x/9.x, etc.
 */
export function decodeValueForKnx(valueStr, dpt) {
    const str = String(valueStr).trim();

    if (!dpt) {
        if (str === '1' || str === 'true')  return true;
        if (str === '0' || str === 'false') return false;
        const num = Number(str);
        return isNaN(num) ? str : num;
    }

    const [main] = dpt.split('.').map(Number);
    switch (main) {
        case 1:  // Boolean (switching, step, ...)
            if (str === '1' || str === 'true')  return true;
            if (str === '0' || str === 'false') return false;
            throw new Error(`Invalid boolean value for DPT ${dpt}: "${str}"`);
        case 2: case 3: case 5: case 6: case 7: case 8: case 17: case 18: case 20:
            return parseInt(str, 10);
        case 9: case 14:
            return parseFloat(str);
        case 4: case 16:
            return str;
        case 10: case 11: case 19: case 232:
            try { return JSON.parse(str); }
            catch { throw new Error(`Invalid object value for DPT ${dpt}: "${str}"`); }
        default: {
            const num = Number(str);
            return isNaN(num) ? str : num;
        }
    }
}

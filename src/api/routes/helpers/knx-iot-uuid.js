// SPDX-License-Identifier: CC-BY-NC-SA-4.0
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

// helpers/knx-iot-uuid.js – Stabile UUID-Generierung und Paginierung

/**
 * Generates a deterministic UUID v5-like ID from a string.
 * Uses a simple hash (no crypto import required).
 * The UUID is stable and immutable for a given input string.
 */
export function stableUuid(input) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < input.length; i++) {
        const ch = input.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);

    const u32a = (h1 >>> 0).toString(16).padStart(8, '0');
    const u32b = (h2 >>> 0).toString(16).padStart(8, '0');

    // UUID format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    return `${u32a}-${u32b.slice(0, 4)}-4${u32b.slice(4, 7)}-a${u32a.slice(1, 4)}-${u32b}${u32a.slice(0, 4)}`;
}

/**
 * Paginates an array using page[number] and page[size] query parameters.
 * @returns {{ items, total, number, size }}
 */
export function paginate(items, pageNumber, pageSize) {
    const num  = Math.max(0, parseInt(pageNumber) || 0);
    const size = Math.min(1000, Math.max(1, parseInt(pageSize) || 100));
    const total = items.length;
    const start = num * size;
    return { items: items.slice(start, start + size), total, number: num, size };
}
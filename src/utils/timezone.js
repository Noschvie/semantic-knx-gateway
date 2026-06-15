// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

/**
 * Format timestamp to Europe/Berlin timezone
 * @param {string|Date} timestamp - ISO string or Date object
 * @returns {string} Formatted timestamp in de-DE format
 */
export function formatTimestamp(timestamp) {
    if (!timestamp) return null;

    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);

    return date.toLocaleString('de-DE', {
        timeZone: 'Europe/Berlin',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

/**
 * Format ISO timestamp to Europe/Berlin timezone
 * @param {string|Date} timestamp - ISO string or Date object
 * @returns {string} ISO 8601 string in Europe/Berlin timezone
 */
export function toLocalISO(timestamp) {
    if (!timestamp) return null;

    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);

    // Convert to Europe/Berlin timezone and format as ISO
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Europe/Berlin',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });

    const parts = formatter.formatToParts(date);
    const getValue = (type) => parts.find(p => p.type === type)?.value;

    return `${getValue('year')}-${getValue('month')}-${getValue('day')}T${getValue('hour')}:${getValue('minute')}:${getValue('second')}+01:00`;
}

/**
 * Get current timestamp in Europe/Berlin timezone
 * @returns {string} Current timestamp formatted
 */
export function nowLocal() {
    return formatTimestamp(new Date());
}

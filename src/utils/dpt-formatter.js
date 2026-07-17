// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

/**
 * Formats a DPT value for display
 * Extracts the 'formatted' field from decoded DPT objects (DPT 10, 11, 18, 19)
 * Falls back to the original value if not a valid JSON object
 *
 * @param {*} value - The value to format (can be string, object, or any type)
 * @param {*} fallback - Value to return if formatting fails (default: 'N/A')
 * @returns {string} Human-readable formatted value
 */
export function formatDPTValue(value, fallback = 'N/A') {
    if (value === null || value === undefined) {
        return fallback;
    }

    // Handle string values that might be JSON
    if (typeof value === 'string') {
        // Check if it looks like JSON
        if ((value.startsWith('{') || value.startsWith('[')) && value.trim()) {
            try {
                const parsed = JSON.parse(value);
                // Use formatted field if available (for DPT 10, 11, 18, 19)
                if (parsed.formatted) {
                    return parsed.formatted;
                }
                // Return string representation if no formatted field
                return String(parsed);
            } catch (_e) {
                // Keep original string if not valid JSON
                return value;
            }
        }
        // Regular string
        return value;
    }

    // Handle object values directly
    if (typeof value === 'object') {
        if (value.formatted) {
            return value.formatted;
        }
        return JSON.stringify(value);
    }

    // Handle other types
    return String(value);
}

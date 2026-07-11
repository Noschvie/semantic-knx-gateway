// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

// tunnel-options.js
//
// Builds the KNXUltimate connection options object for TunnelManager.
// Supports both Classic KNXnet/IP (Tunnel UDP/TCP) and KNX IP Secure,
// switched purely via environment variables — see
// KNX_IP_Secure_Integration_Specification.md, sections 5, 6 and 8.
//
// Responsibilities (spec §6):
//   - create KNXUltimate configuration
//   - evaluate environment variables
//   - enable Secure when configured
//   - configure secureTunnelConfig
//   - return a fully initialized options object
//
// This module performs NO cryptographic work itself; all secure-session
// handling is delegated to KNXUltimate (spec §2, §8).

import fs from 'fs';

/**
 * Parses a boolean-ish environment variable.
 * Accepts "true" / "1" / "yes" (case-insensitive) as truthy, everything
 * else (including unset) as falsy.
 *
 * @param {string|undefined} value
 * @param {boolean} defaultValue
 * @returns {boolean}
 */
function envBool(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }
    return ['true', '1', 'yes'].includes(String(value).trim().toLowerCase());
}

/**
 * Builds the KNXUltimate client options object based on environment
 * configuration (spec §5):
 *
 *   KNX_SECURE             Enable or disable KNX IP Secure (default: false)
 *   KNX_HOST_PROTOCOL      TunnelUDP or TunnelTCP (default: TunnelUDP)
 *   KNX_KEYRING_FILE       ETS Keyring (.knxkeys) — required if KNX_SECURE=true
 *   KNX_KEYRING_PASSWORD   Password protecting the Keyring — required if KNX_SECURE=true
 *
 * When KNX_SECURE=false the application behaves exactly like the classic
 * (pre-Secure) implementation — no behavioral change, no new required env vars.
 *
 * @param {object} [logger] optional logger (createLogger instance) for
 *        diagnostic connection-mode output (spec §10). Purely informational,
 *        function works without it.
 * @returns {object} options object suitable for `new KNXClient(options)`
 * @throws {Error} if KNX_SECURE=true but required Secure configuration is
 *         missing or invalid (fail fast, before attempting a connection)
 */
export function createTunnelOptions(logger) {
    const secureEnabled = envBool(process.env.KNX_SECURE, false);
    let hostProtocol = process.env.KNX_HOST_PROTOCOL || 'TunnelUDP';

    const baseOptions = {
        ipAddr: process.env.KNX_GATEWAY_IP,
        ipPort: parseInt(process.env.KNX_GATEWAY_PORT, 10),
        physAddr: process.env.KNX_GATEWAY_PHYS_ADDR,
        // Suppress ACKs for LDataReq (reduces telegram traffic during many read requests)
        suppress_ack_ldatareq: true,
        loglevel: 'error',
    };

    // ===== Classic Mode (unchanged behavior) =====
    if (!secureEnabled) {
        const options = {
            ...baseOptions,
            hostProtocol,
        };

        if (logger) {
            logger.info(
                `KNX connection mode: Classic (${options.hostProtocol}) → ${options.ipAddr}:${options.ipPort}`
            );
        }

        return options;
    }

    // ===== KNX IP Secure Mode =====
    const keyringFile = process.env.KNX_KEYRING_FILE;
    const keyringPassword = process.env.KNX_KEYRING_PASSWORD;

    if (!keyringFile) {
        throw new Error(
            'KNX_SECURE=true requires KNX_KEYRING_FILE (path to the exported ETS .knxkeys file) to be set.'
        );
    }
    if (!keyringPassword) {
        throw new Error(
            'KNX_SECURE=true requires KNX_KEYRING_PASSWORD (password protecting the Keyring) to be set.'
        );
    }
    if (!fs.existsSync(keyringFile)) {
        throw new Error(`KNX_KEYRING_FILE not found on disk: ${keyringFile}`);
    }

    // Spec §8: Secure Tunneling requires TCP as transport.
    if (hostProtocol !== 'TunnelTCP') {
        if (logger) {
            logger.warn(
                `KNX_HOST_PROTOCOL="${hostProtocol}" is not valid together with KNX_SECURE=true, forcing "TunnelTCP".`
            );
        }
        hostProtocol = 'TunnelTCP';
    }

    const options = {
        ...baseOptions,
        hostProtocol,
        isSecureKNXEnabled: true,
        secureTunnelConfig: {
            knxkeys_file_path: keyringFile,
            knxkeys_password: keyringPassword,
        },
    };

    if (logger) {
        logger.info(
            `KNX connection mode: Secure (${options.hostProtocol}) → ${options.ipAddr}:${options.ipPort}, keyring="${keyringFile}"`
        );
    }

    return options;
}

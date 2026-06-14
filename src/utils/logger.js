// SPDX-License-Identifier: CC-BY-NC-SA-4.0
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import pino from 'pino';

/**
 * Configure and export a shared pino logger.
 *
 * - Creates a base logger instance used across the application.
 * - Exposes `createLogger(module)` which returns a child logger with the
 *   provided `module` field for better log attribution and filtering.
 *
 * Environment configuration:
 * - LOG_LEVEL: (string) log verbosity, defaults to 'info'
 * - NODE_ENV: when != 'production', enables a human-friendly pretty
 *   transport (pino-pretty) for development consoles.
 */

/**
 * Determine the log level from the environment, defaulting to 'info'.
 */
const logLevel = process.env.LOG_LEVEL || 'info';

/**
 * Configure optional pretty transport for non-production environments.
 * In production, we keep the default (fast) pino JSON output for performance
 * and structured logging. During development `pino-pretty` is enabled to
 * provide coloured, readable logs with formatted timestamps.
 */
const transport = process.env.NODE_ENV === 'production'
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
            colorize: true,
            /** Use system timezone and a standard readable time format */
            translateTime: 'SYS:standard',
            /** Hide pid and hostname to reduce noise in console output */
            ignore: 'pid,hostname'
        }
    };

/**
 * Base logger instance used throughout the app. The `transport` option is
 * omitted in production for best performance.
 */
const baseLogger = pino({
    level: logLevel,
    transport
});

/**
 * Create a child logger annotated with a `module` field.
 *
 * @param {string} module - Short identifier for the calling module (e.g.
 *                          'api.routes.devices')
 * @returns {import('pino').Logger} child logger instance
 *
 * @example
 * // const logger = createLogger('api.routes.devices');
 * // logger.info('device created', { id: deviceId });
 */
export function createLogger(module) {
    return baseLogger.child({ module });
}


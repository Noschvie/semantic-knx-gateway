// SPDX-License-Identifier: AGPL-3.0-or-later
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
 * - PRETTY_LOGS: (boolean) when 'true', enables a human-friendly pretty
 *   transport (pino-pretty) for readable console output.
 */

/**
 * Determine the log level from the environment, defaulting to 'info'.
 */
const logLevel = process.env.LOG_LEVEL || 'info';

/**
 * Configure optional pretty transport for readable console output.
 * In production, you can still enable this by setting PRETTY_LOGS=true.
 * By default, (PRETTY_LOGS=true), we provide colored, readable logs with
 * formatted timestamps for better console readability.
 */
const usePrettyLogs = process.env.PRETTY_LOGS !== 'false';

const transport = usePrettyLogs
    ? {
        target: 'pino-pretty',
        options: {
            colorize: true,
            /** Use system timezone and a standard readable time format */
            translateTime: 'SYS:standard',
            /** Hide pid and hostname to reduce noise in console output */
            ignore: 'pid,hostname',
        },
    }
    : undefined;

/**
 * Base logger instance used throughout the app. The `transport` option
 * depends on the PRETTY_LOGS environment variable.
 */
const baseLogger = pino({
    timestamp: pino.stdTimeFunctions.isoTime,
    level: logLevel,
    transport,
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

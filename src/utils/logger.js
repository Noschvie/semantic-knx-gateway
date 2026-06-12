// SPDX-License-Identifier: CC-BY-NC-SA-4.0
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import pino from 'pino';

const logLevel = process.env.LOG_LEVEL || 'info';

const transport = process.env.NODE_ENV === 'production'
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname'
        }
    };

const baseLogger = pino({
    level: logLevel,
    transport
});

export function createLogger(module) {
    return baseLogger.child({ module });
}
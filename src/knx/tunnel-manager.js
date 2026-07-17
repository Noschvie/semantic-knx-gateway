// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

// tunnel-manager.js

import { createRequire } from 'module';
import { createLogger } from '../utils/logger.js';
import { TelegramDecoder } from './telegram-decoder.js';
import { TelegramQueue } from './telegram-queue.js';
import { createTunnelOptions } from './tunnel-options.js';

const require = createRequire(import.meta.url);
const { KNXClient } = require('knxultimate');

// ===== CONSTANTS =====
const HEALTH_CHECK_INTERVAL_MS = 30000; // 30 seconds
const INITIAL_RECONNECT_DELAY_MS = 2000; // 2 seconds
const MAX_RECONNECT_DELAY_MS = 30000; // 30 seconds (= PERSISTENT_RECONNECT_INTERVAL_MS)
const MAX_RECONNECT_ATTEMPTS = 10; // After this, switch to persistent 30s interval
const PERSISTENT_RECONNECT_INTERVAL_MS = 30000; // 30 seconds for persistent reconnection
const MAX_QUEUE_SIZE = 100;

export class TunnelManager {
    constructor(stateEngine) {
        this.logger = createLogger('TunnelManager');
        this.stateEngine = stateEngine;
        this.connection = null;
        this.decoder = new TelegramDecoder();
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = MAX_RECONNECT_ATTEMPTS;
        this.isShuttingDown = false;
        this.reconnectTimer = null;
        this.healthCheckTimer = null;
        this.isConnected = false;
        this.isConnecting = false;

        // Telegram queue for outgoing writes during disconnect (FIFO with drop policy)
        this.telegramQueue = new TelegramQueue(MAX_QUEUE_SIZE, this.logger);
    }

    async connect() {
        if (this.isConnecting) {
            this.logger.debug('Connection already in progress, skipping...');
            return;
        }

        if (this.isConnected && this.connection) {
            this.logger.debug('Already connected, skipping...');
            return;
        }

        this.isConnecting = true;

        // Options are built by tunnel-options.js, which decides between
        // Classic KNXnet/IP and KNX IP Secure based on environment
        // variables (KNX_SECURE, KNX_HOST_PROTOCOL, KNX_KEYRING_FILE,
        // KNX_KEYRING_PASSWORD). See KNX_IP_Secure_Integration_Specification.md.
        let options;
        try {
            options = createTunnelOptions(this.logger);
        } catch (error) {
            this.isConnecting = false;
            this.logger.error({
                msg: '❌ Invalid KNX tunnel configuration',
                error: error.message,
            });
            return Promise.reject(error);
        }

        this.logger.info(
            `Connecting to KNX Gateway at ${options.ipAddr}:${options.ipPort} ` +
            `(${options.hostProtocol}${options.isSecureKNXEnabled ? ', Secure' : ''})`,
        );

        return new Promise((resolve, reject) => {
            try {
                this.connection = new KNXClient(options);

                const timeout = setTimeout(() => {
                    this.isConnecting = false;
                    reject(new Error('Connection timeout'));
                }, 10000);

                // ===== EVENTS =====
                this.connection.on('connected', () => {
                    clearTimeout(timeout);
                    this.isConnecting = false;

                    if (options.isSecureKNXEnabled) {
                        this.logger.info('✅ KNX connected — Secure session established');
                    } else {
                        this.logger.info('KNX connected');
                    }
                    this.logger.info('Registered events:', Object.keys(this.connection._events || {}));

                    this.onConnected();
                    resolve();
                });

                this.connection.on('disconnected', () => {
                    this.logger.warn('KNX disconnected');
                    this.onDisconnected();
                });

                this.connection.on('error', (err) => {
                    clearTimeout(timeout);
                    this.isConnecting = false;

                    this.logger.error({
                        msg: 'KNX connection error',
                        error: err?.message ?? String(err),
                    });

                    reject(err);
                });

                this.connection.on('indication', (telegram) => {
                    this.handleIndication(telegram).catch((err) => {
                        this.logger.error({
                            msg: 'Unhandled error in indication handler',
                            error: err?.message,
                            stack: err?.stack,
                        });
                    });
                });

                this.connection.Connect();
            } catch (error) {
                this.isConnecting = false;
                reject(error);
            }
        });
    }

    onConnected() {
        this.logger.info('✅ KNX Tunnel connected');
        this.isConnected = true;
        this.reconnectAttempts = 0;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        // Start health check
        this.startHealthCheck();

        // Process queued outgoing telegrams (fire-and-forget, logs errors internally)
        this.processQueuedTelegrams().catch((err) => {
            this.logger.error({
                msg: 'Unexpected error in processQueuedTelegrams',
                error: err?.message,
                stack: err?.stack,
            });
        });
    }

    onDisconnected() {
        if (this.isConnecting) {
            this.logger.debug('Disconnect event during connection phase, ignoring...');
            return;
        }

        if (this.isShuttingDown) {
            return;
        }

        if (this.isConnected) {
            this.logger.warn('❌ KNX Tunnel disconnected');
            this.isConnected = false;

            // Stop health check
            this.stopHealthCheck();

            this.scheduleReconnect();
        }
    }

    async onTelegram(evt, src, dest, rawValue) {
        const telegram = {
            timestamp: new Date().toISOString(),
            event: evt,
            source: src,
            destination: dest,
            rawValue: rawValue,
        };

        this.logger.debug({
            msg: '📨 KNX Telegram received',
            event: evt,
            source: src,
            destination: dest,
            rawValue: rawValue,
            rawValueType: typeof rawValue,
        });

        try {
            // Get DPT from StateEngine mapping (if present)
            const mapping = this.stateEngine.datapointMappings?.get(dest);
            const dpt = mapping?.dpt ?? null;

            const decoded = await this.decoder.decode(telegram, dpt);

            this.logger.debug({
                msg: '✅ Telegram decoded',
                ga: decoded.ga,
                value: decoded.value,
                valueType: typeof decoded.value,
                dpt: decoded.dpt,
                decoded: decoded.decoded,
                source: decoded.source,
            });

            await this.stateEngine.processTelegram(decoded);
        } catch (error) {
            this.logger.error({
                msg: 'Error processing telegram',
                errorMessage: error.message,
                errorStack: error.stack,
                evt, src, dest, rawValue,
            });
        }
    }

    /**
     * Handle KNX indication telegrams from the bus
     * Parses cEMI message, extracts addresses and data, then routes to onTelegram
     */
    async handleIndication(telegram) {
        this.logger.debug({ msg: '📨 RAW indication telegram', telegram });

        const cemi = telegram?.cEMIMessage;

        if (!cemi) {
            return;
        }

        // ===== SOURCE ADDRESS =====
        const srcRaw = cemi?.srcAddress?.get();

        const src = srcRaw != null
            ? `${(srcRaw >> 12) & 0x0F}.${(srcRaw >> 8) & 0x0F}.${srcRaw & 0xFF}`
            : '';

        // ===== GROUP ADDRESS =====
        const dstRaw = cemi?.dstAddress?.get();

        const dest = dstRaw != null
            ? `${(dstRaw >> 11) & 0x1F}/${(dstRaw >> 8) & 0x07}/${dstRaw & 0xFF}`
            : '';

        // ===== EVENT TYPE (using public API: isGroupRead, isGroupResponse, isGroupWrite) =====
        let evt = 'Unknown';
        if (cemi?.npdu?.isGroupRead) {
            evt = 'GroupValue_Read';
        } else if (cemi?.npdu?.isGroupResponse) {
            evt = 'GroupValue_Response';
        } else if (cemi?.npdu?.isGroupWrite) {
            evt = 'GroupValue_Write';
        }

        // Read requests have no payload - do not store in state
        if (evt === 'GroupValue_Read') {
            this.logger.debug({ msg: '📖 GroupValue_Read – skipping state update', dest });
            return;
        }

        // ===== VALUE (using public API: dataValue instead of _data) =====
        const dataValue = cemi?.npdu?.dataValue;

        let rawValue;

        if (!dataValue || (Buffer.isBuffer(dataValue) && dataValue.length === 0)) {
            // Short telegram or no data
            rawValue = 0;
        } else if (Buffer.isBuffer(dataValue)) {
            if (dataValue.length === 1) {
                rawValue = dataValue[0];
            } else {
                rawValue = dataValue;
            }
        } else if (Array.isArray(dataValue)) {
            if (dataValue.length === 1) {
                rawValue = dataValue[0];
            } else {
                rawValue = Buffer.from(dataValue);
            }
        } else {
            rawValue = 0;
        }

        this.logger.debug({
            msg: '📨 Parsed KNX telegram',
            event: evt,
            source: src,
            destination: dest,
            rawValue,
            rawValueIsBuffer: Buffer.isBuffer(rawValue),
        });

        await this.onTelegram(evt, src, dest, rawValue);
    }

    scheduleReconnect() {
        if (this.isShuttingDown || this.isConnecting) {
            return;
        }

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }

        this.reconnectAttempts++;

        // Determine delay: exponential backoff for first 10 attempts, then persistent interval
        let delay;
        if (this.reconnectAttempts <= this.maxReconnectAttempts) {
            // Exponential backoff: 2s, 4s, 6s, ..., up to 30s
            delay = Math.min(
                INITIAL_RECONNECT_DELAY_MS * this.reconnectAttempts,
                MAX_RECONNECT_DELAY_MS
            );
            this.logger.info(
                `⏳ Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
            );
        } else {
            // After maxReconnectAttempts, use persistent interval (30s)
            delay = PERSISTENT_RECONNECT_INTERVAL_MS;
            this.logger.warn(
                `⏳ Persistent reconnect: trying again in ${delay}ms (attempt ${this.reconnectAttempts})`,
            );
        }

        this.reconnectTimer = setTimeout(() => {
            if (!this.isShuttingDown && !this.isConnecting) {
                this.connect().catch((err) => {
                    this.logger.error(`Reconnect failed: ${err.message}`);
                    this.isConnected = false;
                    this.isConnecting = false;
                    // Schedule next retry
                    this.scheduleReconnect();
                });
            }
        }, delay);
    }

    async disconnect() {
        this.isShuttingDown = true;
        this.isConnected = false;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        this.stopHealthCheck();

        if (this.connection) {
            this.connection.Disconnect();
            this.connection = null;
            this.logger.info('KNX Tunnel disconnected');
        }
    }

    async write(groupAddress, value, dpt) {
        const telegram = {
            groupAddress,
            value,
            dpt,
            timestamp: new Date().toISOString(),
        };

        if (!this.connection || !this.isConnected) {
            // Queue for later delivery (FIFO Drop policy handled by TelegramQueue)
            this.telegramQueue.push(telegram);
            this.logger.warn(
                `📋 KNX write queued (not connected): ${groupAddress} = ${value} ` +
                `(queue: ${this.telegramQueue.length}/${this.telegramQueue.maxSize})`,
            );
            return;
        }

        return new Promise((resolve, reject) => {
            try {
                this.logger.debug(`📤 KNX write: ${groupAddress} = ${value} (DPT: ${dpt})`);
                this.connection.write(groupAddress, value, dpt);
                resolve();
            } catch (error) {
                this.logger.error({ msg: '❌ KNX write failed', error: error.message });
                reject(error);
            }
        });
    }

    /**
     * Process queued telegrams after reconnection
     */
    async processQueuedTelegrams() {
        if (this.telegramQueue.isEmpty()) {
            return;
        }

        const queueSize = this.telegramQueue.length;
        this.logger.info(`📤 Processing ${queueSize} queued telegrams...`);

        const queue = this.telegramQueue.drain();
        let successCount = 0;
        let failureCount = 0;

        for (const telegram of queue) {
            try {
                await this.write(telegram.groupAddress, telegram.value, telegram.dpt);
                successCount++;
            } catch (err) {
                failureCount++;
                this.logger.error(
                    `Failed to send queued telegram to ${telegram.groupAddress}: ${err.message}`,
                );
            }
        }

        this.logger.info(
            `✅ Queue processing complete: ${successCount} sent, ${failureCount} failed`,
        );
    }

    /**
     * Start periodic health check (ping)
     */
    startHealthCheck() {
        if (this.healthCheckTimer) {
            return;
        }

        this.logger.debug('Starting health check...');

        // Check every HEALTH_CHECK_INTERVAL_MS
        this.healthCheckTimer = setInterval(() => {
            if (!this.isConnected || !this.connection) {
                this.logger.warn('⚠️ Health check: Connection lost detected');
                // Ensure timer is stopped before calling onDisconnected
                this.stopHealthCheck();
                this.onDisconnected();
                return;
            }

            this.logger.debug('💓 Health check OK');
        }, HEALTH_CHECK_INTERVAL_MS);
    }

    /**
     * Stop periodic health check
     */
    stopHealthCheck() {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
            this.logger.debug('Health check stopped');
        }
    }
}

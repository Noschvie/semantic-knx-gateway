// SPDX-License-Identifier: CC-BY-NC-SA-4.0
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

// tunnel-manager.js

import { createRequire } from 'module';
import { createLogger } from '../utils/logger.js';
import { TelegramDecoder } from './telegram-decoder.js';

const require = createRequire(import.meta.url);
const { KNXClient, dptlib, KNXClientEvents } = require('knxultimate');

export class TunnelManager {
    constructor(stateEngine) {
        this.logger = createLogger('TunnelManager');
        this.stateEngine = stateEngine;
        this.connection = null;
        this.decoder = new TelegramDecoder();
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.isShuttingDown = false;
        this.reconnectTimer = null;
        this.isConnected = false;
        this.isConnecting = false;
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

        const options = {
            ipAddr: process.env.KNX_GATEWAY_IP,
            ipPort: parseInt(process.env.KNX_GATEWAY_PORT, 10),
            physAddr: process.env.KNX_GATEWAY_PHYS_ADDR,
            hostProtocol: 'TunnelUDP',
            // Suppress ACKs for LDataReq (reduces telegram traffic during many read requests)
            suppress_ack_ldatareq: true,
            loglevel: 'error',
        };

        this.logger.info(`Connecting to KNX Gateway at ${options.ipAddr}:${options.ipPort}`);

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

                    this.logger.info('KNX connected');
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
                        error: err?.message ?? String(err)
                    });

                    reject(err);
                });

                this.connection.on('indication', async (telegram) => {
                    this.logger.debug({ msg: '📨 RAW indication telegram', telegram });

                    try {
                        const cemi = telegram?.cEMIMessage;

                        if (!cemi) {
                            return;
                        }

                        // ===== SOURCE ADDRESS =====
                        const srcRaw = cemi?.srcAddress?._address;

                        const src = srcRaw != null
                            ? `${(srcRaw >> 12) & 0x0F}.${(srcRaw >> 8) & 0x0F}.${srcRaw & 0xFF}`
                            : '';

                        // ===== GROUP ADDRESS =====
                        const dstRaw = cemi?.dstAddress?._address;

                        const dest = dstRaw != null
                            ? `${(dstRaw >> 11) & 0x1F}/${(dstRaw >> 8) & 0x07}/${dstRaw & 0xFF}`
                            : '';

                        // ===== APCI + VALUE =====
                        const apciRaw = cemi?.npdu?._apci ?? 0;
                        const apciCmd = apciRaw & 0xC0; // Bits 7:6 -> command type
                        const apciData = apciRaw & 0x3F; // Bits 5:0 -> short data (<= 6 bit)

                        let evt = 'Unknown';
                        switch (apciCmd) {
                            case 0x00: evt = 'GroupValue_Read';     break;
                            case 0x40: evt = 'GroupValue_Response'; break;
                            case 0x80: evt = 'GroupValue_Write';    break;
                        }

                        // Read requests have no payload - do not store in state
                        if (evt === 'GroupValue_Read') {
                            this.logger.debug({ msg: '📖 GroupValue_Read – skipping state update', dest });
                            return;
                        }

                        // ===== VALUE =====
                        const npduData = cemi?.npdu?._data;

                        // Cover all possible knxultimate data paths
                        const dataBytes =
                            npduData?._data?.data ??   // { _data: { type: 'Buffer', data: [...] } }
                            npduData?._data ??         // direct Buffer
                            npduData?.data ??          // { data: [...] }
                            null;

                        let rawValue;

                        if (!dataBytes || (Array.isArray(dataBytes) && dataBytes.length === 0)) {
                            // Short telegram (1-bit / 4-bit): value in APCI low bits
                            rawValue = apciData;
                        } else if (Array.isArray(dataBytes) || Buffer.isBuffer(dataBytes)) {
                            const arr = Array.isArray(dataBytes) ? dataBytes : Array.from(dataBytes);
                            if (arr.length === 1) {
                                rawValue = arr[0];
                            } else {
                                rawValue = Buffer.from(arr);
                            }
                        } else {
                            rawValue = apciData;
                        }

                        this.logger.debug({
                            msg: '📨 Parsed KNX telegram',
                            event: evt,
                            source: src,
                            destination: dest,
                            rawValue,
                            rawValueIsBuffer: Buffer.isBuffer(rawValue),
                            dataBytes,
                        });

                        await this.onTelegram(evt, src, dest, rawValue);

                    } catch (err) {
                        this.logger.error({
                            msg: 'Error handling indication telegram',
                            error: err?.message,
                            stack: err?.stack
                        });
                    }
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
            this.scheduleReconnect();
        }
    }

    async onTelegram(evt, src, dest, rawValue) {
        const telegram = {
            timestamp: new Date().toISOString(),
            event: evt,
            source: src,
            destination: dest,
            rawValue: rawValue
        };

        this.logger.debug({
            msg: '📨 KNX Telegram received',
            event: evt,
            source: src,
            destination: dest,
            rawValue: rawValue,
            rawValueType: typeof rawValue
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
                source: decoded.source
            });

            await this.stateEngine.processTelegram(decoded);
        } catch (error) {
            this.logger.error({
                msg: 'Error processing telegram',
                errorMessage: error.message,
                errorStack: error.stack,
                evt, src, dest, rawValue
            });
        }
    }

    onError(error) {
        this.logger.error('KNX Tunnel error:', error);
    }

    scheduleReconnect() {
        if (this.isShuttingDown || this.isConnecting) {
            return;
        }

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.logger.error('Max reconnect attempts reached. Giving up.');
            return;
        }

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }

        this.reconnectAttempts++;
        const delay = Math.min(2000 * this.reconnectAttempts, 30000);
        this.logger.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

        this.reconnectTimer = setTimeout(() => {
            if (!this.isShuttingDown && !this.isConnecting) {
                this.connect().catch((err) => {
                    this.logger.error('Reconnect failed:', err);
                    this.isConnected = false;
                    this.isConnecting = false;
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

        if (this.connection) {
            this.connection.Disconnect();
            this.connection = null;
            this.logger.info('KNX Tunnel disconnected');
        }
    }

    async write(groupAddress, value, dpt) {
        if (!this.connection || !this.isConnected) {
            throw new Error('Not connected to KNX');
        }

        return new Promise((resolve, reject) => {
            try {
                this.connection.write(groupAddress, value, dpt);
                resolve();
            } catch (error) {
                this.logger.error({ msg: '❌ KNX write failed', error: error.message });
                reject(error);
            }
        });
    }
}

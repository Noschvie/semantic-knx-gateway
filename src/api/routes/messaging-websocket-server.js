// SPDX-License-Identifier: CC-BY-NC-SA-4.0
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import { WebSocketServer } from 'ws';

import { createLogger } from '../../utils/logger.js';
import { tokenStore } from './oauth-router.js';
import { stableUuid } from './helpers/knx-iot-uuid.js';
import { decodeValueForKnx, toSpecValue } from './helpers/knx-iot-dpt.js';

export class MessagingWebSocketServer {
    constructor(stateEngine, tunnelManager) {
        this.logger = createLogger('MessagingWebSocket');
        this.stateEngine = stateEngine;
        this.tunnelManager = tunnelManager;
        this.wsServer = null;
        this.wsClients = new Set();
        this.httpServer = null;
        this.boundUpgradeHandler = null;
    }

    resolveDatapointId(identifier, allStates) {
        const state = allStates.find((entry) =>
            entry.datapointId === identifier || stableUuid(entry.datapointId) === identifier
        );
        return state?.datapointId ?? null;
    }

    normalizeIncomingValue(value) {
        if (typeof value === 'string') return value;
        if (Array.isArray(value) || (value && typeof value === 'object')) return JSON.stringify(value);
        return String(value);
    }

    sendWsMessage(ws, payload) {
        if (ws.readyState === 1) {
            ws.send(JSON.stringify(payload));
        }
    }

    authenticateWebSocketUpgrade(req) {
        if (process.env.OAUTH_DISABLED === 'true') {
            return { ok: true, oauth: { clientId: 'oauth-disabled', scope: 'manage' } };
        }

        const authHeader = req.headers.authorization ?? '';
        if (!authHeader.startsWith('Bearer ')) {
            return { ok: false, status: 401, detail: 'Bearer token required' };
        }

        const token = authHeader.slice(7).trim();
        const entry = tokenStore.validateAccessToken(token);
        if (!entry) {
            return { ok: false, status: 401, detail: 'Token is invalid or has expired' };
        }

        const granted = new Set((entry.scope ?? '').split(/\s+/).filter(Boolean));
        if (!granted.has('manage')) {
            return { ok: false, status: 403, detail: 'Required scope missing: manage' };
        }

        return { ok: true, oauth: { clientId: entry.clientId, scope: entry.scope } };
    }

    rejectUpgrade(socket, statusCode, detail) {
        const reason = {
            400: 'Bad Request',
            401: 'Unauthorized',
            403: 'Forbidden',
            404: 'Not Found',
            500: 'Internal Server Error'
        }[statusCode] ?? 'Bad Request';

        const body = detail ? `${detail}\n` : '';
        const response = [
            `HTTP/1.1 ${statusCode} ${reason}`,
            'Connection: close',
            'Content-Type: text/plain; charset=utf-8',
            `Content-Length: ${Buffer.byteLength(body)}`,
            '',
            body
        ].join('\r\n');

        socket.write(response);
        socket.destroy();
    }

    onUpgrade(req, socket, head) {
        let url;
        try {
            url = new URL(req.url, 'http://localhost');
        } catch (_err) {
            this.rejectUpgrade(socket, 400, 'Invalid request URL.');
            return;
        }

        if (url.pathname !== '/messaging/ws') {
            this.rejectUpgrade(socket, 404, 'WebSocket endpoint not found.');
            return;
        }

        const upgrade = (req.headers.upgrade ?? '').toLowerCase();
        const connection = (req.headers.connection ?? '').toLowerCase();
        const wsVersion = String(req.headers['sec-websocket-version'] ?? '');
        const wsKey = req.headers['sec-websocket-key'];
        const wsProtocol = req.headers['sec-websocket-protocol'];

        if (upgrade !== 'websocket') {
            this.rejectUpgrade(socket, 400, 'Header Upgrade must be websocket.');
            return;
        }

        if (!connection.includes('upgrade')) {
            this.rejectUpgrade(socket, 400, 'Header Connection must include Upgrade.');
            return;
        }

        if (!wsKey) {
            this.rejectUpgrade(socket, 400, 'Missing header Sec-WebSocket-Key.');
            return;
        }

        if (wsVersion !== '13') {
            this.rejectUpgrade(socket, 400, 'Header Sec-WebSocket-Version must be 13.');
            return;
        }

        if (wsProtocol !== 'gw.knx.org') {
            this.rejectUpgrade(socket, 400, 'Header Sec-WebSocket-Protocol must be gw.knx.org.');
            return;
        }

        const auth = this.authenticateWebSocketUpgrade(req);
        if (!auth.ok) {
            this.rejectUpgrade(socket, auth.status, auth.detail);
            return;
        }

        this.wsServer.handleUpgrade(req, socket, head, (ws) => {
            this.wsServer.emit('connection', ws, req, { oauth: auth.oauth });
        });
    }

    async onMessage(ws, msg, subscriptions, context) {
        const action = msg?.action;

        if (action === 'subscribe') {
            const items = Array.isArray(msg.items) ? msg.items : [];
            if (items.length === 0) {
                this.sendWsMessage(ws, {
                    type: 'error',
                    errors: [{ status: '422', detail: 'items[] is required for subscribe.' }]
                });
                return;
            }

            const allStates = await this.stateEngine.getAllStates();
            const subscribed = [];

            for (const item of items) {
                const requestedId = item?.id;
                if (!requestedId || item?.type !== 'datapoint') continue;

                const datapointId = this.resolveDatapointId(requestedId, allStates);
                if (!datapointId || subscriptions.has(datapointId)) continue;

                const eventName = `datapoint:${datapointId}`;
                const listener = (event) => {
                    this.sendWsMessage(ws, {
                        type: 'update',
                        data: [{
                            id: stableUuid(event.datapointId),
                            type: 'datapoint',
                            attributes: {
                                ...toSpecValue(event.value),
                                timestamp: event.timestamp
                            },
                            meta: {
                                datapointId: event.datapointId,
                                ga: event.ga,
                                dpt: event.dpt
                            }
                        }]
                    });
                };

                this.stateEngine.subscribe(eventName, listener);
                subscriptions.set(datapointId, listener);
                subscribed.push({ id: stableUuid(datapointId), type: 'datapoint' });
            }

            this.sendWsMessage(ws, {
                type: 'subscribed',
                data: subscribed
            });

            if (subscribed.length > 0) {
                this.logger.info({
                    msg: '✅ WebSocket subscribed',
                    clientId: context?.oauth?.clientId ?? 'unknown',
                    count: subscribed.length,
                    datapoints: subscribed.map(s => s.id),
                });
            } else {
                this.logger.warn({
                    msg: '⚠️  WebSocket subscribe — no matching datapoints',
                    clientId: context?.oauth?.clientId ?? 'unknown',
                    requestedItems: items.map(i => i.id),
                });
            }
            return;
        }

        if (action === 'read') {
            const requestedId = msg?.id;
            if (!requestedId) {
                this.sendWsMessage(ws, {
                    type: 'error',
                    errors: [{ status: '422', detail: 'id is required for read.' }]
                });
                return;
            }

            const allStates = await this.stateEngine.getAllStates();
            const datapointId = this.resolveDatapointId(requestedId, allStates);
            if (!datapointId) {
                this.sendWsMessage(ws, {
                    type: 'error',
                    errors: [{ status: '404', detail: `Datapoint with id "${requestedId}" not found.` }]
                });
                return;
            }

            const state = await this.stateEngine.getCurrentState(datapointId);
            if (!state) {
                this.sendWsMessage(ws, {
                    type: 'error',
                    errors: [{ status: '404', detail: `No state available for datapoint "${requestedId}".` }]
                });
                return;
            }

            this.sendWsMessage(ws, {
                type: 'readResult',
                data: {
                    id: stableUuid(datapointId),
                    type: 'datapoint',
                    attributes: {
                        ...toSpecValue(state.value),
                        timestamp: state.timestamp
                    },
                    meta: {
                        datapointId,
                        ga: state.ga,
                        dpt: state.dpt
                    }
                }
            });
            return;
        }

        if (action === 'write') {
            const requestedId = msg?.id;
            if (!requestedId || msg.value === undefined) {
                this.sendWsMessage(ws, {
                    type: 'error',
                    errors: [{ status: '422', detail: 'id and value are required for write.' }]
                });
                return;
            }

            const allStates = await this.stateEngine.getAllStates();
            const state = allStates.find((entry) =>
                entry.datapointId === requestedId || stableUuid(entry.datapointId) === requestedId
            );

            if (!state) {
                this.sendWsMessage(ws, {
                    type: 'error',
                    errors: [{ status: '404', detail: `Datapoint with id "${requestedId}" not found.` }]
                });
                return;
            }

            if (state.writable === false) {
                this.sendWsMessage(ws, {
                    type: 'error',
                    errors: [{ status: '403', detail: `Datapoint "${state.name ?? state.ga}" is not writable.` }]
                });
                return;
            }

            if (!this.tunnelManager) {
                this.sendWsMessage(ws, {
                    type: 'error',
                    errors: [{ status: '503', detail: 'KNX runtime not available.' }]
                });
                return;
            }

            let nativeValue;
            try {
                nativeValue = decodeValueForKnx(this.normalizeIncomingValue(msg.value), state.dpt);
            } catch (err) {
                this.sendWsMessage(ws, {
                    type: 'error',
                    errors: [{ status: '422', detail: err.message }]
                });
                return;
            }

            try {
                await this.tunnelManager.write(state.ga, nativeValue, state.dpt);
                const now = new Date();
                await this.stateEngine.updateState(state.datapointId, {
                    ga: state.ga,
                    value: nativeValue,
                    dpt: state.dpt,
                    source: 'websocket',
                    timestamp: now
                });

                this.sendWsMessage(ws, {
                    type: 'writeResult',
                    data: {
                        id: stableUuid(state.datapointId),
                        type: 'datapoint',
                        attributes: {
                            value: String(msg.value),
                            timestamp: now.toISOString()
                        },
                        meta: {
                            datapointId: state.datapointId,
                            ga: state.ga,
                            dpt: state.dpt
                        }
                    }
                });
            } catch (err) {
                this.sendWsMessage(ws, {
                    type: 'error',
                    errors: [{ status: '502', detail: `KNX write failed: ${err.message}` }]
                });
            }
            return;
        }

        this.sendWsMessage(ws, {
            type: 'error',
            errors: [{ status: '400', detail: `Unsupported action "${action}".` }]
        });
    }

    onConnection(ws, _req, context) {
        const subscriptions = new Map();
        this.wsClients.add(ws);

        this.logger.info({
            msg: '🔌 WebSocket client connected',
            clientId: context?.oauth?.clientId ?? 'unknown',
            scope: context?.oauth?.scope ?? '',
            totalClients: this.wsClients.size,
        });

        this.sendWsMessage(ws, {
            type: 'welcome',
            data: {
                protocol: 'gw.knx.org',
                path: '/messaging/ws',
                clientId: context?.oauth?.clientId ?? 'unknown',
                scope: context?.oauth?.scope ?? ''
            }
        });

        // Heartbeat: send a ping every 30s
        const heartbeatInterval = setInterval(() => {
            this.sendWsMessage(ws, {
                type: 'ping',
                data: {
                    serverTime: new Date().toLocaleString('sv-SE', {
                        timeZone: 'Europe/Vienna',
                        hour12: false
                    }).replace('T', ' ')
                }
            });
        }, 30_000);

        ws.on('message', async (raw) => {
            let msg;
            try {
                msg = JSON.parse(raw.toString('utf8'));
            } catch (_err) {
                this.sendWsMessage(ws, {
                    type: 'error',
                    errors: [{ status: '400', detail: 'Message must be valid JSON.' }]
                });
                return;
            }

            try {
                await this.onMessage(ws, msg, subscriptions, context);
            } catch (err) {
                this.logger.error({ msg: 'WebSocket message handling failed', error: err.message });
                this.sendWsMessage(ws, {
                    type: 'error',
                    errors: [{ status: '500', detail: 'Internal server error while processing message.' }]
                });
            }
        });

        ws.on('close', () => {
            clearInterval(heartbeatInterval);
            for (const [datapointId, listener] of subscriptions.entries()) {
                this.stateEngine.unsubscribe(`datapoint:${datapointId}`, listener);
            }
            this.logger.info({
                msg: '🔌 WebSocket client disconnected',
                clientId: context?.oauth?.clientId ?? 'unknown',
                subscriptionsRemoved: subscriptions.size,
                totalClients: this.wsClients.size - 1,
            });
            subscriptions.clear();
            this.wsClients.delete(ws);
        });
    }

    start(httpServer) {
        if (this.wsServer) {
            return;
        }

        this.httpServer = httpServer;
        this.wsServer = new WebSocketServer({ noServer: true });
        this.wsServer.on('connection', (ws, req, context) => this.onConnection(ws, req, context));

        this.boundUpgradeHandler = (req, socket, head) => this.onUpgrade(req, socket, head);
        this.httpServer.on('upgrade', this.boundUpgradeHandler);
    }

    async stop() {
        if (!this.wsServer) {
            return;
        }

        if (this.httpServer && this.boundUpgradeHandler) {
            this.httpServer.off('upgrade', this.boundUpgradeHandler);
        }

        for (const client of this.wsClients) {
            try {
                client.close();
            } catch (_err) {
                // Ignore socket shutdown errors.
            }
        }

        await new Promise((resolve) => {
            this.wsServer.close(resolve);
        });

        this.wsServer = null;
        this.wsClients.clear();
        this.httpServer = null;
        this.boundUpgradeHandler = null;
        this.logger.info('WebSocket API stopped');
    }
}

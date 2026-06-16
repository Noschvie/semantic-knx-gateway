// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import express from 'express';

import { createLogger } from '../utils/logger.js';
import { formatTimestamp } from '../utils/timezone.js';

import { datapointsRouter } from './routes/datapoints.js';
import { eventsRouter } from './routes/events.js';
import { devicesRouter } from './routes/devices.js';
import { functionsRouter } from './routes/functions.js';
import { semanticRouter } from './routes/semantic.js';
import { locationsRouter } from './routes/locations.js';
import { installationsRouter } from './routes/installations.js';
import { nodeRouter } from './routes/node.js';
import { sitesRouter } from './routes/sites.js';
import { statsRouter } from './routes/stats.js';
import { subscriptionsRouter } from './routes/subscriptions.js';
import { CallbackDispatcher } from './routes/subscription-dispatcher.js';
import { oauthRouter } from './routes/oauth-router.js';
import { SubscriptionStore } from '../storage/subscription-store.js';
import { MessagingWebSocketServer } from './routes/messaging-websocket-server.js';

// ── KNX IoT Spec §Errors – JSON:API error shape (./schemas/Errors.json) ──────
const KNX_SCHEMA_LINK = 'https://schema.knx.org/2020/api';

/**
 * Build a spec-compliant JSON:API error body.
 * Spec example:
 *   { errors: [{ title, links, status, detail }] }
 */
function knxError(status, title, detail) {
    return { errors: [{ title, links: KNX_SCHEMA_LINK, status: String(status), detail }] };
}

// HTTP status → title mapping as defined in the KNX IoT OpenAPI spec responses
const HTTP_TITLES = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    406: 'Not Acceptable',
    409: 'Conflict',
    414: 'URI Too Long',
    415: 'Unsupported Media Type',
    422: 'Unprocessable Entity',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    501: 'Not Implemented',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
    505: 'HTTP Version Not Supported',
};

// ── GET /.well-known/knx Handler ──────────────────────────────────────────────
//
// Spec §/.well-known/knx:
//   - NO JSON:API format - own schema: api / supportedversions / links / context
//   - Content-Type: application/json (not application/vnd.api+json)
//   - security: [] - no bearer token required
//   - URL must NOT include an API base path (so /.well-known/knx, not /api/v2/...)
//
function wellKnownKnxHandler() {
    return async (req, res) => {
        // Spec requires application/json (not vnd.api+json)
        res.setHeader('Content-Type', 'application/json');

        res.json({
            api: {
                version: '2.1.0',
                base:    '/api/v1',
            },
            supportedversions: [],
            links: [
                { href: '/node', contenttype: 'application/vnd.api+json', rel: 'node',
                    typedescription: `${KNX_SCHEMA_LINK}/work_in_progress?visualisation=swagger#/information/getNode` },
                { href: '/installations', contenttype: 'application/vnd.api+json', rel: 'installations' },
                { href: '/datapoints', contenttype: 'application/vnd.api+json', rel: 'datapoints' },
                { href: '/devices', contenttype: 'application/vnd.api+json', rel: 'devices' },
                { href: '/functions', contenttype: 'application/vnd.api+json', rel: 'functions' },
                { href: '/locations', contenttype: 'application/vnd.api+json', rel: 'locations' },
                { href: '/sites', contenttype: 'application/vnd.api+json', rel: 'sites' },
                { href: '/subscriptions', contenttype: 'application/vnd.api+json', rel: 'subscriptions' },
            ],
            context: [
                { prefix: 'knx', iri: 'http://schema.knx.org/2020/ontology/knx#' },
                { prefix: 'loc', iri: 'http://schema.knx.org/2020/ontology/loc#' },
                { prefix: 'dpa', iri: 'http://schema.knx.org/2020/ontology/dpa#' },
                { prefix: 'tag', iri: 'http://schema.knx.org/2020/ontology/tag#' },
            ],
        });
    };
}

export class RestAPI {
    constructor(stateEngine, db, semanticEngine = null, tunnelManager) {
        this.logger = createLogger('RestAPI');
        this.stateEngine = stateEngine;
        this.db = db;
        this.semanticEngine = semanticEngine;
        this.tunnelManager = tunnelManager;
        this.app = express();
        this.server = null;
        this.websocketApi = new MessagingWebSocketServer(this.stateEngine, this.tunnelManager);

        // Store before setupRoutes() - used in router and dispatcher
        this.subscriptionStore = new SubscriptionStore(this.db);
        this.dispatcher = new CallbackDispatcher(this.stateEngine, this.subscriptionStore);

        // 503 Guard when semantic engine is missing
        if (!this.semanticEngine) {
            this.app.use((req, res) => {
                res.status(503)
                    .set('Content-Type', 'application/vnd.api+json')
                    .json(knxError(503, 'Service Unavailable', 'No TTL file was provided at startup'));
            });
            return;
        }

        this.setupMiddleware();
        this.setupRoutes();
    }

    // ── GLOBAL JSON:API MIDDLEWARE ────────────────────────────────────────────
    setupMiddleware() {
        // ── JSON Parser ───────────────────────────────────────────────────────
        this.app.use(express.json({
            type: [
                'application/json',
                'application/vnd.api+json'
            ]
        }));

        this.app.use((req, res, next) => {
            // OAuth endpoints use application/json (RFC 6749) - not JSON:API
            if (req.path.startsWith('/oauth')) return next();

            // .well-known endpoints return specific MIME types (e.g. PKCS#7 for iDevID)
            if (req.path.includes('/.well-known')) return next();

            // JSON:API Response Content-Type
            res.setHeader('Content-Type', 'application/vnd.api+json');

            // ── ACCEPT HEADER VALIDATION ──────────────────────────────────────
            const accept = req.headers.accept;

            if (
                accept &&
                accept !== '*/*' &&
                !accept.includes('application/vnd.api+json')
            ) {
                return res.status(406).json(
                    knxError(406, 'Not Acceptable', 'Only application/vnd.api+json is supported in Accept header.')
                );
            }

            // ── CONTENT-TYPE VALIDATION ───────────────────────────────────────
            const methodsWithBody = ['POST', 'PATCH', 'PUT'];

            if (methodsWithBody.includes(req.method)) {
                const contentType = req.headers['content-type'];

                const allowJsonFallbackForDatapointValues =
                    req.method === 'PUT' &&
                    req.path === '/api/v1/datapoints/values';
                const allowJsonFallbackForSubscriptions =
                    req.path.startsWith('/api/v1/subscriptions') &&
                    (req.method === 'POST' || req.method === 'PATCH');

                const allowJsonFallback =
                    allowJsonFallbackForDatapointValues ||
                    allowJsonFallbackForSubscriptions;

                const isJsonApi = contentType?.startsWith('application/vnd.api+json');
                const isJsonFallback =
                    allowJsonFallback &&
                    contentType?.startsWith('application/json');

                if (!contentType || (!isJsonApi && !isJsonFallback)) {
                    return res.status(415).json(
                        knxError(
                            415,
                            'Unsupported Media Type',
                            'Content-Type must be application/vnd.api+json ' +
                            '(fallback application/json allowed for PUT /api/v1/datapoints/values ' +
                            'and POST/PATCH /api/v1/subscriptions*).'
                        )
                    );
                }

                // JSON:API allows no extra parameters except profile/ext
                const hasInvalidParameter =
                    isJsonApi &&
                    contentType.includes(';') &&
                    !contentType.includes('profile=') &&
                    !contentType.includes('ext=');

                if (hasInvalidParameter) {
                    return res.status(415).json(
                        knxError(
                            415,
                            'Unsupported Media Type',
                            'JSON:API Content-Type must not contain unsupported media type parameters.'
                        )
                    );
                }
            }

            next();
        });

        // ── CORS ──────────────────────────────────────────────────────────────
        this.app.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
            res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');

            if (req.method === 'OPTIONS') {
                return res.sendStatus(200);
            }
            next();
        });

        // ── Request / Response logging ────────────────────────────────────────
        this.app.use((req, res, next) => {
            const start = Date.now();

            res.on('finish', () => {
                const ms = Date.now() - start;
                const status = res.statusCode;
                const level = status >= 500 ? 'error'
                    : status >= 400 ? 'warn'
                        : 'debug';
                this.logger[level]({
                    msg: `${req.method} ${req.path} → ${status} (${ms}ms)`,
                    method: req.method,
                    path: req.path,
                    status,
                    ms,
                });
            });
            next();
        });
    }

    setupRoutes() {
        const certificateNotConfigured = (kind) => (req, res) => {
            res.status(501)
                .set('Content-Type', 'application/vnd.api+json')
                .json(
                    knxError(
                        501,
                        'Not Implemented',
                        `${kind} certificate endpoint is currently disabled (runtime operates without certificates).`
                    )
                );
        };

        // OAuth2 token endpoint (KNX IoT spec §/oauth/access)
        this.app.use('/oauth', oauthRouter());

        // /.well-known/knx - KNX IoT discovery endpoint (required by spec)
        this.app.get('/.well-known/knx', wellKnownKnxHandler());

        this.app.get('/api/v1/.well-known/knx/idevid', async (req, res) => {
            const certPath = process.env.IDEVID_CERT_PATH;
            if (!certPath) {
                return res.status(501)
                    .set('Content-Type', 'application/vnd.api+json')
                    .json(knxError(501, 'Not Implemented',
                        'iDevID certificate endpoint is currently disabled.'));
            }
            const cert = await fs.readFile(certPath);
            res.status(200)
                .set('Content-Type', 'application/pkcs7-mime')
                .send(cert);
        });

        this.app.get('/api/v1/.well-known/knx/ldevid', certificateNotConfigured('lDevID'));

        // ── Health check ──────────────────────────────────────────────────────
        this.app.get('/health', (req, res) => {
            const now = new Date();
            res.json({
                status: 'ok',
                timestamp: formatTimestamp(now),
                timestampISO: now.toISOString(),
                semantic: this.semanticEngine !== null
            });
        });

        // ── Info endpoint ─────────────────────────────────────────────────────
        this.app.get('/info', (req, res) => {
            res.json({
                name: 'Semantic KNX Runtime Engine',
                version: '0.1.0',
                features: {
                    knxRuntime: true,
                    stateEngine: true,
                    semanticLayer: this.semanticEngine !== null,
                    timescaleDB: true,
                    restAPI: true,
                    websocket: true
                },
                endpoints: {
                    stats: '/api/v1/stats',
                    datapoints: '/api/v1/datapoints',
                    events: '/api/v1/events',
                    devices: '/api/v1/devices',
                    semantic: '/api/v1/semantic',
                    messagingWebSocket: '/messaging/ws'
                }
            });
        });

        this.app.use('/api/v1/stats', statsRouter(this.stateEngine, this.db));
        this.app.use('/api/v1/events', eventsRouter(this.stateEngine, this.db));
        this.app.use('/api/v1/semantic', semanticRouter(this.semanticEngine));
        // API v1 KNX IoT routes
        this.app.use('/api/v1/datapoints', datapointsRouter(this.stateEngine, this.tunnelManager));
        this.app.use('/api/v1/functions', functionsRouter(this.semanticEngine));
        this.app.use('/api/v1/devices', devicesRouter(this.semanticEngine));
        this.app.use('/api/v1/locations', locationsRouter(this.semanticEngine));
        this.app.use('/api/v1/installations', installationsRouter());
        this.app.use('/api/v1/node', nodeRouter(this.stateEngine));
        this.app.use('/api/v1/sites', sitesRouter(this.semanticEngine));
        this.app.use('/api/v1/subscriptions', subscriptionsRouter(this.subscriptionStore, this.stateEngine));

        // ── 404 handler ───────────────────────────────────────────────────────
        this.app.use((req, res) => {
            this.logger.warn({
                msg: `${req.method} ${req.path} → 404 Not Found`,
                method: req.method,
                path: req.path,
            });
            res.status(404).json(
                knxError(404, 'Not Found', `Endpoint ${req.path} does not exist.`)
            );
        });

        // ── Global error handler ──────────────────────────────────────────────
        this.app.use((err, req, res, _next) => {
            const status = err.status || err.statusCode || 500;
            const title = HTTP_TITLES[status] || 'Internal Server Error';
            const detail = process.env.NODE_ENV !== 'production'
                ? (err.message || 'Unexpected error.')
                : 'Unexpected error.';

            this.logger.error({
                msg: `${req.method} ${req.path} → ${status} – ${err.message || 'unknown error'}`,
                method: req.method,
                path: req.path,
                status,
                error: err.message,
                stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
            });

            res.status(status).json(knxError(status, title, detail));
        });
    }

    async start() {
        const port = parseInt(process.env.API_PORT || '3000');

        return new Promise((resolve) => {
            this.server = this.app.listen(port, '0.0.0.0', () => {
                this.logger.info(`✅ REST API listening on http://0.0.0.0:${port}`);
                this.websocketApi.start(this.server);
                this.logger.info(`✅ WebSocket listening on ws://0.0.0.0:${port}/messaging/ws (subprotocol gw.knx.org)`);
                this.dispatcher.start();
                resolve();
            });
        });
    }

    async stop() {
        this.dispatcher.stop();
        await this.websocketApi.stop();

        if (this.server) {
            return new Promise((resolve) => {
                this.server.close(() => {
                    this.logger.info('REST API stopped');
                    resolve();
                });
            });
        }
    }
}

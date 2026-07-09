// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

/**
 * oauth-router.js
 *
 * Implements POST /oauth/access as defined in KNX IoT 3rd Party API v2.1.0
 * (OpenAPI spec path: /oauth/access, operationId: getOauthToken)
 *
 * Supported grant_type values:
 *   - authorization_code (RFC 6749 §4.1.3)
 *   - client_credentials (RFC 6749 §4.4.2)
 *   - refresh_token (RFC 6749 §6)
 *
 * Tokens are opaque strings (NOT UUIDs, per spec note).
 * Storage is in-memory by default; swap OAuthTokenStore for a DB-backed
 * implementation in production.
 *
 * Transport security (TLS) must be enforced at the reverse-proxy / load-balancer
 * level – this router does not enforce HTTPS itself.
 */

import express, { Router } from 'express';
import crypto              from 'crypto';
import { createLogger }    from '../../utils/logger.js';

const logger = createLogger('OAuthRouter');

// ── Token lifetime defaults (seconds) ────────────────────────────────────────
const DEFAULT_ACCESS_TTL  = parseInt(process.env.OAUTH_ACCESS_TTL  ?? '1440');   // 24 min
const DEFAULT_REFRESH_TTL = parseInt(process.env.OAUTH_REFRESH_TTL ?? '86400');  // 24 h

// ── In-memory token store ─────────────────────────────────────────────────────
// Replace with a persistent store (e.g. Redis / Postgres) for production use.
class OAuthTokenStore {
    constructor() {
        /** @type {Map<string, {scope:string, clientId:string, expiresAt:number}>} */
        this._access  = new Map();
        /** @type {Map<string, {scope:string, clientId:string, expiresAt:number}>} */
        this._refresh = new Map();
        /** @type {Map<string, {redirectUri:string, scope:string, clientId:string, expiresAt:number}>} */
        this._codes   = new Map();
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    _generate(prefix = '') {
        // Opaque, high-entropy token string (not UUID – per spec recommendation)
        return prefix + crypto.randomBytes(32).toString('base64url');
    }

    _nowSec() { return Math.floor(Date.now() / 1000); }

    // ── Authorization codes (issued externally, validated here) ──────────────
    /**
     * Register a one-time authorization code.
     * Call this from your authorization endpoint (out-of-scope per spec).
     */
    registerCode(code, { redirectUri, scope, clientId, ttl = 60 }) {
        this._codes.set(code, {
            redirectUri,
            scope,
            clientId,
            expiresAt: this._nowSec() + ttl,
        });
    }

    consumeCode(code) {
        const entry = this._codes.get(code);
        if (!entry) return null;
        this._codes.delete(code);
        if (entry.expiresAt < this._nowSec()) return null;
        return entry;
    }

    // ── Access tokens ─────────────────────────────────────────────────────────
    createAccessToken(scope, clientId, ttl = DEFAULT_ACCESS_TTL) {
        const token = this._generate('at-');
        this._access.set(token, { scope, clientId, expiresAt: this._nowSec() + ttl });
        return { token, expiresIn: ttl };
    }

    validateAccessToken(token) {
        const entry = this._access.get(token);
        if (!entry) return null;
        if (entry.expiresAt < this._nowSec()) { this._access.delete(token); return null; }
        return entry;
    }

    // ── Refresh tokens ────────────────────────────────────────────────────────
    createRefreshToken(scope, clientId, ttl = DEFAULT_REFRESH_TTL) {
        const token = this._generate('rt-');
        this._refresh.set(token, { scope, clientId, expiresAt: this._nowSec() + ttl });
        return token;
    }

    consumeRefreshToken(token) {
        const entry = this._refresh.get(token);
        if (!entry) return null;
        this._refresh.delete(token); // single-use (rotation)
        if (entry.expiresAt < Math.floor(Date.now() / 1000)) return null;
        return entry;
    }
}

// Singleton store – shared with auth middleware (see exports below)
export const tokenStore = new OAuthTokenStore();

// ── Client registry ───────────────────────────────────────────────────────────
// In production load from a DB / config file.
// Format: { clientId: { secret, allowedGrantTypes: [], allowedScopes: [] } }
function getClientConfig(clientId) {
    const clients = JSON.parse(process.env.OAUTH_CLIENTS ?? '{}');
    // Fall-back: a single built-in client for quick dev/test
    const defaults = {
        'knx-default-client': {
            secret: process.env.OAUTH_CLIENT_SECRET ?? 'change-me-in-production',
            allowedGrantTypes: ['authorization_code', 'client_credentials', 'refresh_token'],
            allowedScopes: ['read', 'write', 'manage', 'delete:database'],
        },
    };
    return clients[clientId] ?? defaults[clientId] ?? null;
}

// ── Scope validation ──────────────────────────────────────────────────────
const KNOWN_SCOPES = new Set(['read', 'write', 'manage', 'delete:database']);

function validateScope(requestedScope, clientConfig) {
    if (!requestedScope) return { valid: true, scope: '' };
    const parts = requestedScope.trim().split(/\s+/);
    // Strip vendor-prefixed scopes for standard validation, keep them if present
    const standard = parts.filter(s => KNOWN_SCOPES.has(s));
    const vendor   = parts.filter(s => !KNOWN_SCOPES.has(s));
    const allowed  = clientConfig?.allowedScopes ?? [];
    for (const s of standard) {
        if (!allowed.includes(s)) return { valid: false, scope: null };
    }
    return { valid: true, scope: [...standard, ...vendor].join(' ') };
}

// ── Client authentication (Basic Auth or body params) ────────────────────────
function authenticateClient(req) {
    // 1. HTTP Basic Authentication header
    const authHeader = req.headers.authorization ?? '';
    if (authHeader.startsWith('Basic ')) {
        const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
        const [id, secret] = decoded.split(':');
        const cfg = getClientConfig(id);
        if (!cfg) return null;
        const valid = crypto.timingSafeEqual(
            Buffer.from(cfg.secret),
            Buffer.from(secret ?? ''),
        );
        return valid ? { clientId: id, config: cfg } : null;
    }

    // 2. client_id / client_secret in the request body (public client fallback)
    const { client_id, client_secret } = req.body ?? {};
    if (client_id) {
        const cfg = getClientConfig(client_id);
        if (!cfg) return null;
        if (client_secret) {
            const valid = crypto.timingSafeEqual(
                Buffer.from(cfg.secret),
                Buffer.from(client_secret),
            );
            if (!valid) return null;
        }
        return { clientId: client_id, config: cfg };
    }

    return null;
}

// ── Router factory ────────────────────────────────────────────────────────────
export function oauthRouter() {
    const router = Router();

    // The spec says this endpoint uses application/x-www-form-urlencoded
    router.use(express.urlencoded({ extended: false }));

    /**
     * POST /oauth/access
     *
     * Handles three scenarios:
     *   1. grant_type=authorization_code → exchange code for access+refresh token
     *   2. grant_type=client_credentials → issue access token directly
     *   3. grant_type=refresh_token → rotate tokens
     */
    router.post('/access', (req, res) => {
        const { grant_type } = req.body ?? {};

        if (!grant_type) {
            return res.status(400).json({
                error: 'invalid_request',
                error_description: 'grant_type is required',
            });
        }

        // ── Client authentication ─────────────────────────────────────────
        const client = authenticateClient(req);

        // ── 1. authorization_code ─────────────────────────────────────────
        if (grant_type === 'authorization_code') {
            if (!client) return unauthorizedResponse(res);

            const { code, redirect_uri } = req.body;

            if (!code) {
                return res.status(400).json({
                    error: 'invalid_request',
                    error_description: 'code is required for authorization_code grant',
                });
            }

            if (!client.config.allowedGrantTypes.includes('authorization_code')) {
                return res.status(400).json({ error: 'unauthorized_client' });
            }

            const codeEntry = tokenStore.consumeCode(code);
            if (!codeEntry) {
                return res.status(400).json({
                    error: 'invalid_grant',
                    error_description: 'Authorization code is invalid or has expired',
                });
            }

            // redirect_uri must match if it was present in the original request
            if (codeEntry.redirectUri && codeEntry.redirectUri !== redirect_uri) {
                return res.status(400).json({
                    error: 'invalid_grant',
                    error_description: 'redirect_uri mismatch',
                });
            }

            return issueTokens(res, codeEntry.scope, client.clientId);
        }

        // ── 2. client_credentials ─────────────────────────────────────────
        if (grant_type === 'client_credentials') {
            if (!client) return unauthorizedResponse(res);

            if (!client.config.allowedGrantTypes.includes('client_credentials')) {
                return res.status(400).json({ error: 'unauthorized_client' });
            }

            const { scope } = req.body;
            const { valid, scope: resolvedScope } = validateScope(scope, client.config);

            if (!valid) {
                return res.status(400).json({
                    error: 'invalid_scope',
                    error_description: `Requested scope "${scope}" is not allowed for this client`,
                });
            }

            return issueTokens(res, resolvedScope, client.clientId, /* no refresh token */ false);
        }

        // ── 3. refresh_token ──────────────────────────────────────────────
        if (grant_type === 'refresh_token') {
            if (!client) return unauthorizedResponse(res);

            const { refresh_token } = req.body;
            if (!refresh_token) {
                return res.status(400).json({
                    error: 'invalid_request',
                    error_description: 'refresh_token is required',
                });
            }

            const rtEntry = tokenStore.consumeRefreshToken(refresh_token);
            if (!rtEntry) {
                return res.status(400).json({
                    error: 'invalid_grant',
                    error_description: 'Refresh token is invalid or has expired',
                });
            }

            return issueTokens(res, rtEntry.scope, rtEntry.clientId);
        }

        // ── Unknown grant_type ────────────────────────────────────────────
        return res.status(400).json({
            error: 'unsupported_grant_type',
            error_description: `grant_type "${grant_type}" is not supported`,
        });
    });

    return router;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function issueTokens(res, scope, clientId, includeRefresh = true) {
    const { token: accessToken, expiresIn } = tokenStore.createAccessToken(scope, clientId);
    const response = {
        access_token:  accessToken,
        token_type:    'Bearer',
        expires_in:    expiresIn,
        scope:         scope || undefined,
    };

    if (includeRefresh) {
        response.refresh_token = tokenStore.createRefreshToken(scope, clientId);
    }

    logger.info(`Token issued – client: ${clientId}, scope: "${scope}", refresh: ${includeRefresh}`);

    return res
        .status(200)
        .set('Cache-Control', 'no-store')
        .set('Pragma', 'no-cache')
        .json(response);
}

function unauthorizedResponse(res) {
    return res
        .status(401)
        .set('WWW-Authenticate', 'Basic realm="KNX IoT Authorization Server"')
        .json({
            error: 'invalid_client',
            error_description: 'Client authentication failed',
        });
}

// ── Bearer token middleware (use on protected routes) ─────────────────────────
/**
 * Express middleware that validates a Bearer token from the Authorization header.
 * Attaches `req.oauth` = { clientId, scope } on success.
 *
 * Usage:
 *   import { bearerAuthMiddleware } from './routes/oauth-router.js';
 *   router.get('/protected', bearerAuthMiddleware(['read']), handler);
 */
export function bearerAuthMiddleware(requiredScopes = []) {
    return (req, res, next) => {
        const authHeader = req.headers.authorization ?? '';
        if (!authHeader.startsWith('Bearer ')) {
            return res.status(401)
                .set('WWW-Authenticate', 'Bearer realm="KNX IoT"')
                .json({ errors: [{ status: '401', title: 'Unauthorized', detail: 'Bearer token required' }] });
        }

        const token = authHeader.slice(7).trim();
        const entry = tokenStore.validateAccessToken(token);
        if (!entry) {
            return res.status(401)
                .set('WWW-Authenticate', 'Bearer realm="KNX IoT", error="invalid_token"')
                .json({ errors: [{ status: '401', title: 'Unauthorized', detail: 'Token is invalid or has expired' }] });
        }

        if (requiredScopes.length > 0) {
            const grantedScopes = new Set((entry.scope ?? '').split(/\s+/));
            const missing = requiredScopes.filter(s => !grantedScopes.has(s));
            if (missing.length > 0) {
                return res.status(403)
                    .json({ errors: [{ status: '403', title: 'Forbidden', detail: `Required scope(s) missing: ${missing.join(', ')}` }] });
            }
        }

        req.oauth = { clientId: entry.clientId, scope: entry.scope };
        next();
    };
}

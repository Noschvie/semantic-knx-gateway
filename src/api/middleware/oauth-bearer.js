// SPDX-License-Identifier: CC-BY-NC-SA-4.0
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

/**
 * oauth-bearer.js
 *
 * Reusable Express middleware for Bearer token validation.
 * Uses the shared tokenStore from oauth-router.js.
 *
 * Usage:
 *   import { bearer } from '../middleware/oauth-bearer.js';
 *
 *   router.get('/protected', bearer('read'), handler);
 *   router.post('/protected', bearer('write'), handler);
 *
 * Set env var OAUTH_DISABLED=true to bypass auth (dev/test only).
 */

import { tokenStore } from '../routes/oauth-router.js';

/**
 * Returns Express middleware that enforces a Bearer token
 * with the given required scope(s).
 *
 * @param {...string} requiredScopes - One or more required OAuth2 scopes.
 */
export function bearer(...requiredScopes) {
    // Allow disabling OAuth for local development via env flag
    if (process.env.OAUTH_DISABLED === 'true') {
        return (_req, _res, next) => next();
    }

    return (req, res, next) => {
        const authHeader = req.headers.authorization ?? '';

        if (!authHeader.startsWith('Bearer ')) {
            return res
                .status(401)
                .set('WWW-Authenticate', 'Bearer realm="KNX IoT"')
                .json({
                    errors: [{
                        status: '401',
                        title: 'Unauthorized',
                        detail: 'A Bearer token is required. Use POST /oauth/access to obtain one.'
                    }]
                });
        }

        const token = authHeader.slice(7).trim();
        const entry = tokenStore.validateAccessToken(token);

        if (!entry) {
            return res
                .status(401)
                .set('WWW-Authenticate', 'Bearer realm="KNX IoT", error="invalid_token"')
                .json({
                    errors: [{
                        status: '401',
                        title: 'Unauthorized',
                        detail: 'The provided Bearer token is invalid or has expired.'
                    }]
                });
        }

        if (requiredScopes.length > 0) {
            const granted = new Set((entry.scope ?? '').split(/\s+/).filter(Boolean));
            const missing = requiredScopes.filter(s => !granted.has(s));

            if (missing.length > 0) {
                return res
                    .status(403)
                    .set('WWW-Authenticate',
                        `Bearer realm="KNX IoT", error="insufficient_scope", scope="${requiredScopes.join(' ')}"`)
                    .json({
                        errors: [{
                            status: '403',
                            title: 'Forbidden',
                            detail: `Insufficient scope. Required: "${requiredScopes.join(' ')}". Granted: "${entry.scope ?? ''}".`
                        }]
                    });
            }
        }

        // Attach OAuth context to request for downstream use
        req.oauth = { clientId: entry.clientId, scope: entry.scope };
        next();
    };
}
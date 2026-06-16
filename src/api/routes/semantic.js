// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import { Router } from 'express';
import { bearer } from '../middleware/oauth-bearer.js';

// ── Vendor-Extension: Semantic Engine Endpoints ───────────────────────────────
// These endpoints are NOT defined in the KNX IoT spec.
// They return proprietary response formats for internal/debug purposes.
// Registered under /api/v2/semantic/...

export function semanticRouter(semanticEngine) {
    const router = Router();

    if (!semanticEngine) {
        router.use((req, res) => {
            res.status(503).json({
                error: 'Semantic engine not available',
                message: 'No TTL file was provided at startup',
            });
        });
        return router;
    }

    // GET /api/v2/semantic/locations - location hierarchy (proprietary)
    router.get('/locations', bearer('read'), async(req, res) => {
        try {
            const hierarchy = await semanticEngine.getLocationHierarchy();
            res.json({ locations: hierarchy });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // GET /api/v2/semantic/locations/hierarchy - alias
    router.get('/locations/hierarchy', bearer('read'), async(req, res) => {
        try {
            const hierarchy = await semanticEngine.getLocationHierarchy();
            res.json({ locations: hierarchy });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // GET /api/v2/semantic/locations/:id - single location (proprietary)
    router.get('/locations/:id', bearer('read'), async(req, res) => {
        try {
            const location = await semanticEngine.getLocation(req.params.id);
            if (!location) return res.status(404).json({ error: 'Location not found' });
            res.json(location);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // GET /api/v2/semantic/devices - all devices (proprietary)
    router.get('/devices', bearer('read'), async(req, res) => {
        try {
            const devices = await semanticEngine.getAllDevices();
            res.json({ devices, count: devices.length });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // GET /api/v2/semantic/devices/:id - device details (proprietary)
    router.get('/devices/:id', bearer('read'), async(req, res) => {
        try {
            const device = await semanticEngine.getDeviceDetails(req.params.id);
            if (!device) return res.status(404).json({ error: 'Device not found' });
            res.json(device);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // GET /api/v2/semantic/functions - all functions (proprietary)
    router.get('/functions', bearer('read'), async(req, res) => {
        try {
            const functions = await semanticEngine.getAllApplicationFunctions();
            res.json({ functions, count: functions.length });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // GET /api/v2/semantic/datapoints/:id - datapoint semantic info (proprietary)
    router.get('/datapoints/:id', bearer('read'), async(req, res) => {
        try {
            const info = await semanticEngine.getDatapointInfo(req.params.id);
            if (!info) return res.status(404).json({ error: 'Datapoint not found' });
            res.json(info);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // GET /api/v2/semantic/search?q=... - free-text search (proprietary)
    router.get('/search', bearer('read'), async(req, res) => {
        try {
            const { q } = req.query;
            if (!q) return res.status(400).json({ error: 'Query parameter "q" required' });
            const results = await semanticEngine.search(q);
            res.json({ query: q, results, count: results.length });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    return router;
}

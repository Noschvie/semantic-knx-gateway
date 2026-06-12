// SPDX-License-Identifier: CC-BY-NC-SA-4.0
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import { Router } from 'express';
import { bearer } from '../middleware/oauth-bearer.js';

export function eventsRouter(stateEngine, db) {
    const router = Router();

    // GET /api/v1/events - Get recent events
    router.get('/', bearer('read'), async (req, res) => {
        try {
            const { limit = 100, ga, startTime, endTime } = req.query;

            const options = {
                startTime: startTime ? new Date(startTime) : undefined,
                endTime: endTime ? new Date(endTime) : undefined,
                limit: parseInt(limit)
            };

            let rows;
            if (ga) {
                rows = await stateEngine.eventStore.getEventsByGA(ga, options);
            } else {
                const params = [parseInt(limit)];
                const result = await db.query(
                    `SELECT ts AS timestamp, datapoint_id, ga, source, event_type, dpt,
                     COALESCE(value_text, value_bool::text, value_float::text, value_int::text) AS value
                     FROM knx_events ORDER BY ts DESC LIMIT $1`,
                    params
                );
                rows = result.rows;
            }

            res.json({ events: rows, count: rows.length });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    return router;
}
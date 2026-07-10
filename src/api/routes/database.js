// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import express from 'express';
import { createLogger } from '../../utils/logger.js';
import { bearer } from '../middleware/oauth-bearer.js';
import { DatabaseManager } from '../../storage/database-manager.js';

const logger = createLogger('routes.database');

/**
 * Create a database management router
 *
 * Endpoints:
 * - GET  /info           → Database statistics (Tier 1: Information)
 * - POST /purge          → Delete old events (Tier 2: Maintenance)
 * - POST /optimize       → Reclaim disk space (Tier 2: Maintenance)
 * - GET  /cleanup-jobs   → Audit log (Tier 3: Audit)
 *
 * @param {object} pool - PostgreSQL connection pool
 * @returns {express.Router} Express router
 */
export function createDatabaseRouter(pool) {
    const router = express.Router();
    const dbManager = new DatabaseManager(pool);

    /**
     * GET /info
     *
     * Get comprehensive database statistics and health metrics
     *
     * Authentication: Bearer token with 'read' scope
     *
     * Returns:
     * - Database name, size, version
     * - Per-table statistics (rows, sizes, indexes)
     * - Event timeline (the earliest/latest event, coverage, avg events/day)
     * - Hypertable compression info (chunk count, compression status)
     * - Subscription counts
     * - Backend capabilities
     */
    router.get(
        '/info',
        bearer('read'),
        async (req, res, next) => {
            try {
                logger.debug('GET /info requested');

                // Execute sequentially to avoid concurrent connection conflicts
                const stats = await dbManager.getStatistics();
                const capabilities = await dbManager.getCapabilities();

                res.status(200).json({
                    data: {
                        id: 'database-info',
                        type: 'database-info',
                        attributes: {
                            ...stats,
                            ...capabilities,
                        },
                    },
                });
            } catch (err) {
                logger.error('Failed to get database info', { error: err.message });
                next(err);
            }
        }
    );

    /**
     * POST /purge
     *
     * Delete old events using configurable retention strategies
     *
     * Supports presets: 30_days, 90_days, 365_days, custom, purge_all
     *
     * First call with dry_run=true to preview,
     * Then call with dry_run=false and confirm=true to execute
     *
     * Authentication: Bearer token with 'delete:database' scope
     */
    router.post(
        '/purge',
        bearer('delete:database'),
        async (req, res, next) => {
            try {
                const { preset, older_than, purge_all, dry_run, confirm } = req.body?.data?.attributes || {};

                logger.debug('POST /purge requested', { preset, dry_run, confirm, purge_all });

                // Determine actual preset
                let actualPreset = preset;
                if (purge_all) {
                    actualPreset = 'purge_all';
                }

                // Validation
                const validPresets = Object.keys(DatabaseManager.PURGE_PRESETS);
                if (!validPresets.includes(actualPreset)) {
                    return res.status(400).json({
                        errors: [{
                            status: '400',
                            title: 'Bad Request',
                            detail: `Invalid preset. Valid options: ${validPresets.join(', ')}`,
                        }],
                    });
                }

                if (actualPreset === 'custom' && !older_than) {
                    return res.status(400).json({
                        errors: [{
                            status: '400',
                            title: 'Bad Request',
                            detail: 'When preset=custom, older_than is required',
                        }],
                    });
                }

                // Destructive operation safety check
                if (!dry_run && !confirm) {
                    return res.status(409).json({
                        errors: [{
                            status: '409',
                            title: 'Confirmation Required',
                            detail: 'This is a destructive operation. Call with dry_run=true first to preview, then with dry_run=false and confirm=true to execute.',
                        }],
                    });
                }

                // Preview mode
                if (dry_run || !confirm) {
                    const preview = await dbManager.getPurgePreview(actualPreset, older_than);
                    const jobId = `purge-preview-${Date.now()}-${Math.random().toString(36).substring(7)}`;
                    return res.status(200).json({
                        data: {
                            id: jobId,
                            type: 'purge-result',
                            attributes: preview,
                        },
                    });
                }

                // Execute purge
                const userId = req.oauth?.clientId || 'api-client';
                const result = await dbManager.executePurge(actualPreset, older_than, userId);

                res.status(202).json({
                    data: {
                        id: result.id,
                        type: result.type,
                        attributes: {
                            status: result.status,
                            dry_run: result.dry_run,
                            preset: result.preset,
                            execution: result.execution,
                            results: result.results,
                            totals: result.totals,
                        },
                    },
                });
            } catch (err) {
                logger.error('Failed to execute purge', { error: err.message });
                next(err);
            }
        }
    );

    /**
     * POST /optimize
     *
     * Optimize a database using PostgreSQL VACUUM
     *
     * Parameters:
     * - full: false (default, VACUUM ANALYZE - online)
     *         true (VACUUM FULL - requires a maintenance window, the system goes offline)
     * - analyze: true (default, update query planner stats)
     *
     * Authentication: Bearer token with 'delete:database' scope
     */
    router.post(
        '/optimize',
        bearer('delete:database'),
        async (req, res, next) => {
            try {
                const { full = false, analyze = true } = req.body?.data?.attributes || {};

                logger.debug('POST /optimize requested', { full, analyze });

                if (full) {
                    logger.warn('⚠️ VACUUM FULL requested - System will go offline during operation');
                }

                const userId = req.oauth?.clientId || 'api-client';
                const result = await dbManager.optimizeDatabase({ full, analyze }, userId);

                res.status(202).json({
                    data: {
                        id: result.id,
                        type: result.type,
                        attributes: {
                            status: result.status,
                            execution: result.execution,
                            results: result.results,
                        },
                    },
                });
            } catch (err) {
                logger.error('Failed to optimize database', { error: err.message });
                next(err);
            }
        }
    );

    /**
     * GET /cleanup-jobs
     *
     * Query audit log of cleanup operations
     *
     * Query Parameters:
     * - offset: Pagination offset (default: 0)
     * - limit: Results per page (default: 20, max: 100)
     * - status: Filter by status (completed, failed, simulated)
     * - days: Show jobs from last N days (default: 30)
     *
     * Authentication: Bearer token with 'read' scope
     */
    router.get(
        '/cleanup-jobs',
        bearer('read'),
        async (req, res, next) => {
            try {
                logger.debug('GET /cleanup-jobs requested', { query: req.query });

                const offset = Math.max(0, parseInt(req.query.offset || '0'));
                const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20')));
                const status = req.query.status?.toLowerCase();
                const days = Math.max(1, parseInt(req.query.days || '30'));

                const { jobs, total } = await dbManager.getCleanupJobs(offset, limit, status, days);

                res.status(200).json({
                    data: jobs,
                    meta: {
                        pagination: {
                            offset,
                            limit,
                            total,
                        },
                    },
                });
            } catch (err) {
                logger.error('Failed to get cleanup jobs', { error: err.message });
                next(err);
            }
        }
    );

    /**
     * GET /health
     *
     * Simple endpoint to check if the database is responsive
     * (Used for monitoring, doesn't require Bearer token)
     */
    router.get('/health', async (req, res) => {
        const isHealthy = await dbManager.checkHealth();
        if (isHealthy) {
            res.status(200).json({ status: 'ok', database: 'connected' });
        } else {
            res.status(503).json({ status: 'error', database: 'disconnected' });
        }
    });

    return router;
}

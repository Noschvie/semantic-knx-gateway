// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import { Router } from 'express';
import { createLogger } from '../../utils/logger.js';
import { bearer } from '../middleware/oauth-bearer.js';
import { KnxLensImporter } from '../../import/knx-lens-importer.js';
import { importJobStore } from '../../import/import-job-store.js';
import { formatTimestamp } from '../../utils/timezone.js';

const logger = createLogger('routes.import');

/**
 * Import router (addon).
 *
 * Endpoints:
 * - POST /api/v2/import/knx-lens          → starts a background import, returns job info immediately
 * - GET  /api/v2/import/knx-lens/:jobId   → query job status/progress
 *
 * Runs asynchronously in the same process (no separate worker/queue system
 * exists in the project). Job status is kept in-memory (import-job-store.js)
 * and will be lost on server restart — acceptable for a one-off historical
 * bulk import.
 *
 * @param {import('../../state/state-engine.js').StateEngine} stateEngine
 * @returns {import('express').Router}
 */
export function createImportRouter(stateEngine) {
    const router = Router();
    const importer = new KnxLensImporter(stateEngine);

    /**
     * POST /knx-lens
     *
     * Body:
     *   { data: { attributes: { path: "/path/to/logs", dryRun?: boolean } } }
     *
     * Authentication: Bearer token with 'write' scope
     * Response: 202 Accepted with job ID; query progress via GET .../:jobId
     */
    router.post(
        '/knx-lens',
        bearer('write'),
        async(req, res, next) => {
            try {
                const { path: logDir, dryRun = false, deleteExistingForDay = false } = req.body?.data?.attributes || {};

                if (!logDir) {
                    return res.status(400).json({
                        errors: [{
                            status: '400',
                            title: 'Bad Request',
                            detail: 'data.attributes.path (directory containing knx_bus.log files) is required.',
                        }],
                    });
                }

                const jobId = `knx-lens-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                const job = importJobStore.create(jobId, { logDir, dryRun, deleteExistingForDay });

                logger.info('POST /import/knx-lens - job started', { jobId, logDir, dryRun, deleteExistingForDay });

                // Intentionally NOT awaited - runs in the background, response is returned immediately.
                runImportJob(importer, jobId, logDir, dryRun, deleteExistingForDay);

                res.status(202).json({
                    data: {
                        id: jobId,
                        type: 'import-job',
                        attributes: {
                            status: 'running',
                            logDir,
                            dryRun,
                            deleteExistingForDay,
                            statusUrl: `${req.baseUrl}/knx-lens/${jobId}`,
                            // Vendor-extension: provide both local human-readable and ISO UTC
                            created_at: formatTimestamp(job.createdAt),
                            created_at_iso: job.createdAt,
                        },
                    },
                });
            } catch (err) {
                logger.error('Could not start knx-lens import job', { error: err.message });
                next(err);
            }
        },
    );

    /**
     * GET /knx-lens/:jobId
     *
     * Authentication: Bearer token with 'read' scope
     */
    router.get(
        '/knx-lens/:jobId',
        bearer('read'),
        (req, res) => {
            const job = importJobStore.get(req.params.jobId);

            if (!job) {
                return res.status(404).json({
                    errors: [{ status: '404', title: 'Not Found', detail: `Job '${req.params.jobId}' unknown.` }],
                });
            }

            res.status(200).json({
                data: {
                    id: job.id,
                    type: 'import-job',
                    attributes: {
                        status: job.status,
                        logDir: job.logDir,
                        dryRun: job.dryRun,
                        deleteExistingForDay: job.deleteExistingForDay,
                        // Vendor-extension: provide both local human-readable and ISO UTC
                        created_at: formatTimestamp(job.createdAt),
                        created_at_iso: job.createdAt,
                        completed_at: job.completedAt ? formatTimestamp(job.completedAt) : null,
                        completed_at_iso: job.completedAt || null,
                        progress: job.progress,
                        result: job.result,
                        error: job.error,
                    },
                },
            });
        },
    );

    return router;
}

/**
 * Executes the import in the background and continuously updates the job store.
 * Errors are recorded in the job instead of throwing an unhandled rejection.
 */
async function runImportJob(importer, jobId, logDir, dryRun, deleteExistingForDay) {
    try {
        const result = await importer.importFromDirectory(logDir, {
            dryRun,
            deleteExistingForDay,
            onProgress: (progress) => importJobStore.updateProgress(jobId, progress),
        });
        importJobStore.complete(jobId, result);
        logger.info('knx-lens import job completed', { jobId, totalImported: result.totalImported });
    } catch (err) {
        importJobStore.fail(jobId, err);
        logger.error('knx-lens import job failed', { jobId, error: err.message });
    }
}

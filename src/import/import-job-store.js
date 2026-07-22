// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

/**
 * Simple in-memory job store for asynchronous import runs.
 *
 * Intentionally, no DB schema change: the import is a one-time bulk operation
 * and not a recurring operational workflow. Job status is lost on server
 * restart — acceptable for a one-off historical import. If import jobs are
 * intended to run routinely in the future, switch to a DB-backed pattern
 * such as `database_maintenance_log` (see database-manager.js).
 */
export class ImportJobStore {
    constructor() {
        this.jobs = new Map();
    }

    create(jobId, initial = {}) {
        const job = {
            id: jobId,
            status: 'running',
            createdAt: new Date().toISOString(),
            completedAt: null,
            progress: {
                filesTotal: 0,
                filesDone: 0,
                currentFile: null,
                totalParsed: 0,
                totalImported: 0,
                totalSkipped: 0,
            },
            result: null,
            error: null,
            ...initial,
        };
        this.jobs.set(jobId, job);
        return job;
    }

    update(jobId, patch) {
        const job = this.jobs.get(jobId);
        if (!job) return null;
        Object.assign(job, patch);
        return job;
    }

    updateProgress(jobId, progressPatch) {
        const job = this.jobs.get(jobId);
        if (!job) return null;
        Object.assign(job.progress, progressPatch);
        return job;
    }

    complete(jobId, result) {
        return this.update(jobId, {
            status: 'completed',
            completedAt: new Date().toISOString(),
            result,
        });
    }

    fail(jobId, error) {
        return this.update(jobId, {
            status: 'failed',
            completedAt: new Date().toISOString(),
            error: error?.message || String(error),
        });
    }

    get(jobId) {
        return this.jobs.get(jobId) || null;
    }
}

// A single, process-wide store is enough for this addon.
export const importJobStore = new ImportJobStore();

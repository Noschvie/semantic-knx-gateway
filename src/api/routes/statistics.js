// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import { Router } from 'express';
import { formatTimestamp } from '../../utils/timezone.js';
import { formatDPTValue } from '../../utils/dpt-formatter.js';
import { bearer } from '../middleware/oauth-bearer.js';
import { StatisticsStore } from '../../storage/statistics-store.js';

// ── Vendor-Extension: Statistics Endpoints ────────────────────────────────────────
// These endpoints are NOT defined in the KNX IoT spec.
// Registered under /api/v2/stats/...

function parseHours(raw, defaultVal = 24, max = 8760) {
    const n = parseInt(raw);
    return isNaN(n) ? defaultVal : Math.min(max, Math.max(1, n));
}

function parseLimit(raw, defaultVal = 20, max = 1000) {
    const n = parseInt(raw);
    return isNaN(n) ? defaultVal : Math.min(max, Math.max(1, n));
}

export function statisticsRouter(stateEngine, db) {
    const router = Router();

    // GET /api/v2/stats - Database statistics
    router.get('/', bearer('read'), async(req, res) => {
        try {
            const store = new StatisticsStore(db);
            const stats = await store.getAllStats();

            res.json({
                timestamp:    formatTimestamp(new Date()),
                timestampISO: new Date().toISOString(),
                counts: stats.counts,
                eventRange: {
                    firstEvent:    formatTimestamp(stats.eventRange.firstEvent),
                    lastEvent:     formatTimestamp(stats.eventRange.lastEvent),
                    firstEventISO: stats.eventRange.firstEvent,
                    lastEventISO:  stats.eventRange.lastEvent,
                },
                topGroupAddresses: stats.topGroupAddresses.map(ga => ({
                    ga:         ga.ga,
                    eventCount: ga.eventCount,
                    lastSeen:   formatTimestamp(ga.lastSeen),
                    lastSeenISO: ga.lastSeen,
                })),
                database: {
                    size: stats.dbSize,
                },
            });
        } catch (error) {
            res.status(500).json({ errors: [{ status: '500', title: 'Internal Server Error', detail: error.message }] });
        }
    });

    // GET /api/v2/stats/events - Event statistics
    router.get('/events', bearer('read'), async(req, res) => {
        try {
            const hours = parseHours(req.query.hours);
            const since = new Date(Date.now() - hours * 60 * 60 * 1000);
            const store = new StatisticsStore(db);
            const stats = await store.getEventStatistics(hours);

            res.json({
                period: {
                    hours,
                    since:    formatTimestamp(since),
                    sinceISO: since.toISOString(),
                },
                summary: stats.summary,
                hourly: stats.hourly.map(row => ({
                    hour:    formatTimestamp(row.hour),
                    hourISO: row.hour,
                    count:   row.count,
                })),
                byType: stats.byType,
            });
        } catch (error) {
            res.status(500).json({ errors: [{ status: '500', title: 'Internal Server Error', detail: error.message }] });
        }
    });

    // GET /api/v2/stats/states - Current state statistics
    router.get('/states', bearer('read'), async(req, res) => {
        try {
            const store = new StatisticsStore(db);
            const stats = await store.getStateStatistics();

            res.json({
                summary: {
                    total_states: stats.summary.total_states,
                    unique_gas: stats.summary.unique_gas,
                    unique_sources: stats.summary.unique_sources,
                    states_with_dpt: stats.summary.states_with_dpt,
                    oldest_update:     formatTimestamp(stats.summary.oldest_update),
                    newest_update:     formatTimestamp(stats.summary.newest_update),
                    oldest_update_iso: stats.summary.oldest_update,
                    newest_update_iso: stats.summary.newest_update,
                },
                byDpt: stats.byDpt,
            });
        } catch (error) {
            res.status(500).json({ errors: [{ status: '500', title: 'Internal Server Error', detail: error.message }] });
        }
    });

    // GET /api/v2/stats/top-active - Most active datapoints
    router.get('/top-active', bearer('read'), async(req, res) => {
        try {
            const hours = parseHours(req.query.hours);
            const limit = parseLimit(req.query.limit);
            const since = new Date(Date.now() - hours * 60 * 60 * 1000);

            const store = new StatisticsStore(db);
            const datapoints = await store.getTopActiveDatapoints(since, limit);

            res.json({
                period: {
                    hours,
                    since:    formatTimestamp(since),
                    sinceISO: since.toISOString(),
                },
                datapoints: datapoints.map(dp => ({
                    ga:            dp.ga,
                    datapointId:   dp.datapointId,
                    eventCount:    dp.eventCount,
                    lastEvent:     formatTimestamp(dp.lastEvent),
                    lastEventISO:  dp.lastEvent,
                    currentValue:  formatDPTValue(dp.currentValue),
                    datapointName: dp.datapointName,
                    dpt:           dp.dpt,
                })),
            });
        } catch (error) {
            res.status(500).json({ errors: [{ status: '500', title: 'Internal Server Error', detail: error.message }] });
        }
    });

    // GET /api/v2/stats/health/db-checks - Complete database integrity checks
    router.get('/health/db-checks', bearer('read'), async(req, res) => {
        try {
            const store = new StatisticsStore(db);
            const now = new Date();

            const health = await store.getHealthCheckDetails();

            const orphanedCount = health.orphanedCount;
            const orphanedGAs = health.orphanedGAs;
            const duplicateCount = health.duplicateCount;
            const staleCount = health.staleCount;
            const totalMappings = health.totalMappings;
            const uniqueGASMappingsCount = health.uniqueGASMappings;
            const totalStates = health.totalStates;
            const uniqueGASStates = health.uniqueGASStates;
            const dataIntegrityScore = health.dataIntegrityScore;

            // Determine overall health status
            const hasIssues = orphanedCount > 0 || duplicateCount > 0 || staleCount > 0;
            const healthStatus = hasIssues ? 'WARNING' : 'HEALTHY';

            res.json({
                timestamp: formatTimestamp(now),
                timestampISO: now.toISOString(),
                status: healthStatus,
                checks: {
                    orphaned_states: {
                        check: 'ORPHANED STATES CHECK',
                        description: 'States without corresponding datapoint mapping',
                        status: orphanedCount === 0 ? '✓' : '⚠️',
                        orphaned_count: orphanedCount,
                        affected_gas: orphanedGAs,
                        severity: orphanedCount === 0 ? 'none' : (orphanedCount > 100 ? 'high' : 'medium'),
                        recommendation: orphanedCount > 0 ? 'Run cleanup-orphaned-datapoints.sql to remove orphaned states' : 'No action needed',
                    },
                    duplicate_gas: {
                        check: 'DUPLICATE GROUP ADDRESSES CHECK',
                        description: 'Group addresses with multiple datapoint mappings (data corruption risk)',
                        status: duplicateCount === 0 ? '✓' : '⚠️',
                        duplicate_ga_count: duplicateCount,
                        severity: duplicateCount === 0 ? 'none' : 'high',
                        recommendation: duplicateCount > 0 ? 'Investigate and fix conflicting mappings manually' : 'No action needed',
                    },
                    stale_mappings: {
                        check: 'STALE MAPPINGS CHECK',
                        description: 'Datapoint mappings without current state (unused)',
                        status: staleCount === 0 ? '✓' : '⚠️',
                        stale_count: staleCount,
                        severity: staleCount === 0 ? 'none' : (staleCount > 50 ? 'high' : 'medium'),
                        recommendation: staleCount > 0 ? 'Consider removing stale mappings or check if devices are still active' : 'No action needed',
                    },
                },
                summary: {
                    total_mappings: totalMappings,
                    unique_gas_mappings: uniqueGASMappingsCount,
                    unique_gas: uniqueGASMappingsCount,  // Backward compatibility
                    total_states: totalStates,
                    unique_gas_states: uniqueGASStates,
                    orphaned_states: orphanedCount,
                    duplicate_gas: duplicateCount,
                    stale_mappings: staleCount,
                    data_integrity_score: dataIntegrityScore,
                },
                notes: 'Run periodic database maintenance to ensure optimal performance and data integrity',
            });
        } catch (error) {
            res.status(500).json({ errors: [{ status: '500', title: 'Internal Server Error', detail: error.message }] });
        }
    });

    // GET /api/v2/stats/health/orphaned-states - Detailed orphaned states
    router.get('/health/orphaned-states', bearer('read'), async(req, res) => {
        try {
            const limit = parseLimit(req.query.limit);
            const store = new StatisticsStore(db);
            const data = await store.getDetailedOrphanedStates(limit);

            res.json({
                timestamp: formatTimestamp(new Date()),
                total_orphaned: data.totalOrphaned,
                limit,
                states: data.states.map(row => ({
                    datapointId: row.datapointId,
                    ga: row.ga,
                    dpt: row.dpt,
                    lastUpdate: formatTimestamp(row.lastUpdate),
                    lastUpdateISO: row.lastUpdate,
                    source: row.source,
                    value: row.value,
                })),
            });
        } catch (error) {
            res.status(500).json({ errors: [{ status: '500', title: 'Internal Server Error', detail: error.message }] });
        }
    });

    // GET /api/v2/stats/health/duplicate-gas - Detailed duplicate GA check
    router.get('/health/duplicate-gas', bearer('read'), async(req, res) => {
        try {
            const store = new StatisticsStore(db);
            const data = await store.getDetailedDuplicateGAs();

            res.json({
                timestamp: formatTimestamp(new Date()),
                total_duplicate_gas: data.totalDuplicateGAs,
                duplicates: data.duplicates.map(row => ({
                    ga: row.ga,
                    mappingCount: row.mappingCount,
                    dptCount: row.dptCount,
                    dpts: row.dpts,
                    names: row.names,
                    deviceIds: row.deviceIds,
                })),
                severity: data.duplicates.length > 0 ? 'HIGH - Data corruption risk!' : 'OK',
            });
        } catch (error) {
            res.status(500).json({ errors: [{ status: '500', title: 'Internal Server Error', detail: error.message }] });
        }
    });

    // GET /api/v2/stats/health/stale-mappings - Detailed stale mappings
    router.get('/health/stale-mappings', bearer('read'), async(req, res) => {
        try {
            const limit = parseLimit(req.query.limit);
            const store = new StatisticsStore(db);
            const data = await store.getDetailedStaleMappings(limit);

            res.json({
                timestamp: formatTimestamp(new Date()),
                total_stale: data.totalStale,
                limit,
                mappings: data.mappings.map(row => ({
                    datapointId: row.datapointId,
                    ga: row.ga,
                    dpt: row.dpt,
                    name: row.name,
                    deviceId: row.deviceId,
                    hasState: row.hasState,
                })),
            });
        } catch (error) {
            res.status(500).json({ errors: [{ status: '500', title: 'Internal Server Error', detail: error.message }] });
        }
    });

    return router;
}

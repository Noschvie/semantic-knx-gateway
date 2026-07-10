// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import { createLogger } from '../utils/logger.js';

/**
 * DatabaseManager - High-level database maintenance operations
 *
 * Provides abstraction layer for:
 * - Database statistics and monitoring
 * - Purge/cleanup operations
 * - Database optimization (VACUUM)
 * - Audit logging
 */
export class DatabaseManager {
    constructor(pool) {
        this.pool = pool;
        this.logger = createLogger('DatabaseManager');
    }

    /**
     * Format bytes to human-readable size
     * @param {number} bytes - Size in bytes
     * @returns {string} Formatted size (e.g. "2.7 GB")
     */
    static formatBytes(bytes) {
        if (!bytes || bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    /**
     * Get comprehensive database statistics
     *
     * Returns:
     * - Database name, size, version
     * - Per-table sizes and row counts
     * - Event timeline (earliest/latest/coverage)
     * - Hypertable compression info
     * - Subscription counts
     *
     * @returns {Promise<object>} Database statistics
     */
    async getStatistics() {
        if (!this.pool) {
            throw new Error('Database pool not initialized');
        }
        let client;
        try {
            client = await this.pool.connect();
            // Get PostgreSQL version
            const versionResult = await client.query(`
                SELECT version();
            `);
            const version = versionResult.rows[0]?.version || 'unknown';

            // Get database size
            const dbSizeResult = await client.query(`
                SELECT 
                    current_database() as database_name,
                    pg_database_size(current_database()) as size_bytes;
            `);
            const dbSize = dbSizeResult.rows[0];

            // Get table information
            const tablesResult = await client.query(`
                SELECT 
                    schemaname,
                    tablename,
                    pg_total_relation_size(schemaname || '.' || tablename) as total_size,
                    pg_relation_size(schemaname || '.' || tablename) as table_size,
                    pg_indexes_size(schemaname || '.' || tablename) as index_size
                FROM pg_tables
                WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
                ORDER BY total_size DESC;
            `);

            // Get row counts
            const rowCountsResult = await client.query(`
                SELECT relname, n_live_tup
                FROM pg_stat_user_tables
                ORDER BY n_live_tup DESC;
            `);
            const rowCountMap = new Map(rowCountsResult.rows.map(r => [r.relname, r.n_live_tup]));

            // Get hypertable information
            let hypertableInfo = {};
            try {
                const hypertablesResult = await client.query(`
                    SELECT 
                        ht.table_name,
                        count(*) as chunk_count,
                        count(*) FILTER (WHERE is_compressed) as compressed_chunks,
                        count(*) FILTER (WHERE NOT is_compressed) as uncompressed_chunks,
                        min(range_start) as earliest_chunk,
                        max(range_end) as latest_chunk
                    FROM timescaledb_information.hypertables ht
                    LEFT JOIN timescaledb_information.chunks c ON ht.hypertable_id = c.hypertable_id
                    GROUP BY ht.table_name
                    ORDER BY ht.table_name;
                `);
                for (const row of hypertablesResult.rows) {
                    const compressionRatio = await this._getCompressionRatio(client, row.table_name);
                    hypertableInfo[row.table_name] = {
                        chunk_count: row.chunk_count,
                        earliest_chunk: row.earliest_chunk ? row.earliest_chunk.toISOString().split('T')[0] : null,
                        latest_chunk: row.latest_chunk ? row.latest_chunk.toISOString().split('T')[0] : null,
                        compressed_chunks: row.compressed_chunks,
                        uncompressed_chunks: row.uncompressed_chunks,
                        compression_ratio: compressionRatio,
                    };
                }
            } catch (err) {
                this.logger.debug('TimescaleDB extension not available or no hypertables found', { error: err.message });
            }

            // Get event timeline (from knx_events table)
            let eventTimeline = {
                total_events: 0,
                earliest_event: null,
                latest_event: null,
                coverage_days: 0,
                events_per_day_avg: 0,
            };
            try {
                const eventsResult = await client.query(`
                    SELECT 
                        COUNT(*) as total_count,
                        MIN(ts) as earliest,
                        MAX(ts) as latest
                    FROM knx_events;
                `);
                if (eventsResult.rows[0]) {
                    const row = eventsResult.rows[0];
                    const earliest = row.earliest;
                    const latest = row.latest;
                    if (earliest && latest) {
                        const coverageDays = Math.ceil(
                            (latest - earliest) / (1000 * 60 * 60 * 24)
                        );
                        eventTimeline = {
                            total_events: parseInt(row.total_count),
                            earliest_event: earliest.toISOString(),
                            latest_event: latest.toISOString(),
                            coverage_days: Math.max(1, coverageDays),
                            events_per_day_avg: Math.ceil(row.total_count / Math.max(1, coverageDays)),
                        };
                    }
                }
            } catch (err) {
                this.logger.debug('Could not get event timeline', { error: err.message });
            }

            // Get subscription counts
            let subscriptionCounts = {
                total_subscriptions: 0,
                active: 0,
                expired: 0,
            };
            try {
                const subsResult = await client.query(`
                    SELECT 
                        COUNT(*) as total,
                        COUNT(*) FILTER (WHERE expires_at > NOW()) as active,
                        COUNT(*) FILTER (WHERE expires_at <= NOW()) as expired
                    FROM subscriptions;
                `);
                if (subsResult.rows[0]) {
                    const row = subsResult.rows[0];
                    subscriptionCounts = {
                        total_subscriptions: parseInt(row.total),
                        active: parseInt(row.active),
                        expired: parseInt(row.expired),
                    };
                }
            } catch (err) {
                this.logger.debug('Could not get subscription counts', { error: err.message });
            }

            // Build tables info
            const tables = {};
            for (const row of tablesResult.rows) {
                const rowCount = rowCountMap.get(row.tablename) || 0;
                tables[row.tablename] = {
                    type: hypertableInfo[row.tablename] ? 'hypertable' : 'regular',
                    row_count: rowCount,
                    size_bytes: row.table_size,
                    size_pretty: DatabaseManager.formatBytes(row.table_size),
                    index_size_bytes: row.index_size || 0,
                    index_size_pretty: DatabaseManager.formatBytes(row.index_size || 0),
                };
            }

            return {
                timestamp: new Date().toISOString(),
                database: {
                    name: dbSize.database_name,
                    size_bytes: dbSize.size_bytes,
                    size_pretty: DatabaseManager.formatBytes(dbSize.size_bytes),
                    version: version,
                },
                tables,
                events_timeline: eventTimeline,
                hypertables: hypertableInfo,
                subscriptions: subscriptionCounts,
            };
        } catch (err) {
            this.logger.error('Failed to get database statistics', { error: err.message });
            throw err;
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    /**
     * Get database capabilities
     *
     * Returns feature support flags for API clients
     *
     * @returns {Promise<object>} Capabilities
     */
    async getCapabilities() {
        let client;
        try {
            client = await this.pool.connect();
            // Check for TimescaleDB
            const tsdbResult = await client.query(`
                SELECT EXISTS (
                    SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'
                ) as timescaledb_installed;
            `);
            const hasTimescaleDB = tsdbResult.rows[0]?.timescaledb_installed || false;

            return {
                backend: 'postgresql',
                capabilities: {
                    supports_size_stats: true,       // Always available
                    supports_optimize: true,         // VACUUM available in all PG versions
                    supports_vacuum_full: true,      // VACUUM FULL available
                    supports_compression: hasTimescaleDB,  // Only with TimescaleDB
                    supports_dry_run: true,          // Implemented in logic
                    supports_presets: true,          // Implemented in logic
                },
            };
        } catch (err) {
            this.logger.error('Failed to get capabilities', { error: err.message });
            return {
                backend: 'postgresql',
                capabilities: {
                    supports_size_stats: true,
                    supports_optimize: true,
                    supports_vacuum_full: true,
                    supports_compression: false,
                    supports_dry_run: true,
                    supports_presets: true,
                },
            };
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    /**
     * Purge presets configuration
     */
    static PURGE_PRESETS = {
        '30_days': { label: 'Last 30 days', days: 30 },
        '90_days': { label: 'Last 90 days (Recommended)', days: 90 },
        '365_days': { label: 'Last 365 days (1 year)', days: 365 },
        'custom': { label: 'Custom date', days: null },
        'purge_all': { label: '⚠️ Delete All', days: null },
    };

    /**
     * Calculate the date threshold for a purge preset
     * @param {string} preset - Preset name
     * @param {Date} customDate - Optional custom date for 'custom' preset
     * @returns {Date} The threshold date
     */
    static _calculateThresholdDate(preset, customDate = null) {
        if (preset === 'custom' && customDate) {
            return customDate;
        }
        const presetConfig = DatabaseManager.PURGE_PRESETS[preset];
        if (presetConfig?.days) {
            const now = new Date();
            now.setDate(now.getDate() - presetConfig.days);
            return now;
        }
        return null;
    }

    /**
     * Get a preview of what would be purged without actually deleting
     *
     * @param {string} preset - Purge preset ('30_days', '90_days', etc.)
     * @param {string|Date} olderThan - ISO 8601 date for 'custom' preset
     * @returns {Promise<object>} Preview data
     */
    async getPurgePreview(preset, olderThan = null) {
        // Validate preset before connecting
        const validPresets = Object.keys(DatabaseManager.PURGE_PRESETS);
        if (!validPresets.includes(preset)) {
            throw new Error(`Invalid preset: ${preset}. Valid options: ${validPresets.join(', ')}`);
        }

        let client;
        try {
            client = await this.pool.connect();
            let thresholdDate;

            if (preset === 'custom' && olderThan) {
                thresholdDate = new Date(olderThan);
            } else if (preset === 'purge_all') {
                thresholdDate = new Date('2099-12-31');  // Far future
            } else {
                thresholdDate = DatabaseManager._calculateThresholdDate(preset);
            }

            // This should never happen due to validation above
            if (!thresholdDate) {
                // noinspection JSUnusedLocalSymbols
                const validPresets = Object.keys(DatabaseManager.PURGE_PRESETS);
                // noinspection ExceptionCaughtLocallyJS
                throw new Error(`Failed to calculate threshold for preset: ${preset}. Valid: ${validPresets.join(', ')}`);
            }

            const thresholdISO = thresholdDate.toISOString();

            // Get preview for knx_events
            const knxEventsResult = await client.query(`
                SELECT 
                    COUNT(*) as rows_to_delete,
                    COALESCE(pg_total_relation_size('knx_events'), 0) as table_size
                FROM knx_events
                WHERE ts < $1;
            `, [thresholdDate]);

            const knxData = knxEventsResult.rows[0];
            const rowsToDeleteKnx = parseInt(knxData.rows_to_delete);
            const tableSizeKnx = parseInt(knxData.table_size);
            const deletionRatioKnx = rowsToDeleteKnx > 0 ? rowsToDeleteKnx / (await this._getTotalRowCount(client, 'knx_events')) : 0;
            const estimatedFreedKnx = Math.floor(tableSizeKnx * deletionRatioKnx);

            // Get preview for subscription_events
            const subEventsResult = await client.query(`
                SELECT 
                    COUNT(*) as rows_to_delete,
                    COALESCE(pg_total_relation_size('subscription_events'), 0) as table_size
                FROM subscription_events
                WHERE ts < $1;
            `, [thresholdDate]);

            const subData = subEventsResult.rows[0];
            const rowsToDeleteSub = parseInt(subData.rows_to_delete);
            const tableSizeSub = parseInt(subData.table_size);
            const deletionRatioSub = rowsToDeleteSub > 0 ? rowsToDeleteSub / (await this._getTotalRowCount(client, 'subscription_events')) : 0;
            const estimatedFreedSub = Math.floor(tableSizeSub * deletionRatioSub);

            const totalRowsToDelete = rowsToDeleteKnx + rowsToDeleteSub;
            const totalSizeToFree = estimatedFreedKnx + estimatedFreedSub;

            return {
                dry_run: true,
                preset,
                older_than: thresholdISO,
                preview: {
                    tables: {
                        knx_events: {
                            rows_to_delete: rowsToDeleteKnx,
                            rows_remaining: (await this._getTotalRowCount(client, 'knx_events')) - rowsToDeleteKnx,
                            size_to_free_bytes: estimatedFreedKnx,
                            size_to_free_pretty: DatabaseManager.formatBytes(estimatedFreedKnx),
                            percentage: rowsToDeleteKnx > 0 ? parseFloat(((rowsToDeleteKnx / (await this._getTotalRowCount(client, 'knx_events'))) * 100).toFixed(1)) : 0,
                        },
                        subscription_events: {
                            rows_to_delete: rowsToDeleteSub,
                            rows_remaining: (await this._getTotalRowCount(client, 'subscription_events')) - rowsToDeleteSub,
                            size_to_free_bytes: estimatedFreedSub,
                            size_to_free_pretty: DatabaseManager.formatBytes(estimatedFreedSub),
                            percentage: rowsToDeleteSub > 0 ? parseFloat(((rowsToDeleteSub / (await this._getTotalRowCount(client, 'subscription_events'))) * 100).toFixed(1)) : 0,
                        },
                    },
                    totals: {
                        total_rows_to_delete: totalRowsToDelete,
                        total_rows_remaining: (await this._getTotalRowCount(client, 'knx_events')) + (await this._getTotalRowCount(client, 'subscription_events')) - totalRowsToDelete,
                        total_size_to_free_bytes: totalSizeToFree,
                        total_size_to_free_pretty: DatabaseManager.formatBytes(totalSizeToFree),
                    },
                    warning: `This will permanently delete ${totalRowsToDelete.toLocaleString()} telegrams recorded before ${thresholdISO}`,
                },
                next_step: 'Call again with dry_run=false and confirm=true to execute',
            };
        } catch (err) {
            this.logger.error('Failed to get purge preview', { error: err.message, preset, olderThan });
            throw err;
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    /**
     * Execute purge operation
     *
     * @param {string} preset - Purge preset
     * @param {string|Date} olderThan - Custom date
     * @param {string} executedBy - User email/ID
     * @returns {Promise<object>} Execution results
     */
    async executePurge(preset, olderThan = null, executedBy = 'system') {
        // Validate preset before connecting
        const validPresets = Object.keys(DatabaseManager.PURGE_PRESETS);
        if (!validPresets.includes(preset)) {
            throw new Error(`Invalid preset: ${preset}. Valid options: ${validPresets.join(', ')}`);
        }

        let client;
        const jobId = `purge-job-${Date.now()}-${Math.random().toString(36).substring(7)}`;

        try {
            client = await this.pool.connect();
            // Calculate threshold date
            let thresholdDate;
            if (preset === 'custom' && olderThan) {
                thresholdDate = new Date(olderThan);
            } else if (preset === 'purge_all') {
                thresholdDate = new Date('2099-12-31');
            } else {
                thresholdDate = DatabaseManager._calculateThresholdDate(preset);
            }

            if (!thresholdDate) {
                // noinspection ExceptionCaughtLocallyJS
                throw new Error(`Failed to calculate threshold for preset: ${preset}`);
            }

            // Log the job as started
            const startedAt = new Date();
            await client.query(
                `INSERT INTO database_maintenance_log (
                    id, operation, preset, older_than, purge_all, dry_run, 
                    executed_by, created_at, started_at, status, tables_affected
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                [
                    jobId, 'purge', preset, thresholdDate, preset === 'purge_all',
                    false, executedBy, startedAt, startedAt, 'running',
                    ['knx_events', 'subscription_events']
                ]
            );

            // Get row counts before deletion
            const beforeKnx = await client.query('SELECT COUNT(*) as count FROM knx_events');
            const beforeSub = await client.query('SELECT COUNT(*) as count FROM subscription_events');

            const rowsBeforeKnx = parseInt(beforeKnx.rows[0].count);
            const rowsBeforeSub = parseInt(beforeSub.rows[0].count);

            this.logger.info('📊 Row counts before purge', {
                jobId,
                preset,
                knx_events: rowsBeforeKnx,
                subscription_events: rowsBeforeSub,
                total: rowsBeforeKnx + rowsBeforeSub,
            });

            const deleteKnxResult = await client.query(
                'DELETE FROM knx_events WHERE ts < $1',
                [thresholdDate]
            );
            const knxRowsDeleted = deleteKnxResult.rowCount;

            // Delete from subscription_events
            const deleteSubResult = await client.query(
                'DELETE FROM subscription_events WHERE ts < $1',
                [thresholdDate]
            );
            const subRowsDeleted = deleteSubResult.rowCount;

            // Get row counts after deletion
            const afterKnx = await client.query('SELECT COUNT(*) as count FROM knx_events');
            const afterSub = await client.query('SELECT COUNT(*) as count FROM subscription_events');

            // Get sizes after deletion
            const sizeKnxAfter = await client.query(
                'SELECT pg_total_relation_size(\'knx_events\') as size'
            );
            const sizeSubAfter = await client.query(
                'SELECT pg_total_relation_size(\'subscription_events\') as size'
            );

            const rowsAfterKnx = parseInt(afterKnx.rows[0].count);
            const rowsAfterSub = parseInt(afterSub.rows[0].count);
            const sizeAfterKnx = parseInt(sizeKnxAfter.rows[0].size);
            const sizeAfterSub = parseInt(sizeSubAfter.rows[0].size);

            this.logger.info('📊 Row counts and sizes after deletion', {
                jobId,
                knx_events: {
                    rows: rowsAfterKnx,
                    rows_deleted: knxRowsDeleted,
                    size_bytes: sizeAfterKnx,
                    size_pretty: DatabaseManager.formatBytes(sizeAfterKnx),
                },
                subscription_events: {
                    rows: rowsAfterSub,
                    rows_deleted: subRowsDeleted,
                    size_bytes: sizeAfterSub,
                    size_pretty: DatabaseManager.formatBytes(sizeAfterSub),
                },
                totals: {
                    rows_remaining: rowsAfterKnx + rowsAfterSub,
                    rows_deleted: knxRowsDeleted + subRowsDeleted,
                    total_size_bytes: sizeAfterKnx + sizeAfterSub,
                    total_size_pretty: DatabaseManager.formatBytes(sizeAfterKnx + sizeAfterSub),
                },
            });

            const completedAt = new Date();
            const results = {
                knx_events: {
                    rows_deleted: knxRowsDeleted,
                    rows_remaining: parseInt(afterKnx.rows[0].count),
                    size_freed_bytes: 0,  // Estimation
                    size_freed_pretty: '~' + DatabaseManager.formatBytes(0),
                },
                subscription_events: {
                    rows_deleted: subRowsDeleted,
                    rows_remaining: parseInt(afterSub.rows[0].count),
                    size_freed_bytes: 0,
                    size_freed_pretty: '~' + DatabaseManager.formatBytes(0),
                },
                totals: {
                    total_rows_deleted: knxRowsDeleted + subRowsDeleted,
                    total_rows_remaining: parseInt(afterKnx.rows[0].count) + parseInt(afterSub.rows[0].count),
                    total_freed_bytes: 0,
                    total_freed_pretty: '~0 MB',
                },
            };

            // Update job as completed
            await client.query(
                `UPDATE database_maintenance_log 
                 SET status = $1, completed_at = $2, results = $3
                 WHERE id = $4`,
                ['completed', completedAt, JSON.stringify(results), jobId]
            );

            this.logger.info('✅ Purge operation completed', {
                jobId,
                preset,
                rowsDeleted: results.totals.total_rows_deleted,
                status: 'completed',
            });

            return {
                id: jobId,
                type: 'purge-result',
                status: 'completed',
                dry_run: false,
                preset,
                execution: {
                    started_at: startedAt.toISOString(),
                    completed_at: completedAt.toISOString(),
                    duration_seconds: Math.round((completedAt - startedAt) / 1000),
                },
                results: results.knx_events,
                totals: results.totals,
            };
        } catch (err) {
            this.logger.error('Failed to execute purge', { error: err.message, jobId });
            // Log failure
            try {
                await client.query(
                    `UPDATE database_maintenance_log 
                     SET status = $1, completed_at = $2, error_message = $3
                     WHERE id = $4`,
                    ['failed', new Date(), err.message, jobId]
                );
            } catch (logErr) {
                this.logger.error('Failed to log purge failure', { error: logErr.message });
             }
             throw err;
         } finally {
             if (client) {
                 client.release();
             }
         }
     }

    /**
     * Optimize a database using VACUUM
     *
     * @param {object} options - { full: boolean, analyze: boolean }
     * @param {string} executedBy - User email/ID
     * @returns {Promise<object>} Optimization results
     */
    async optimizeDatabase(options = {}, executedBy = 'system') {
        const { full = false, analyze = true } = options;
        let client;
        const jobId = `optimize-job-${Date.now()}-${Math.random().toString(36).substring(7)}`;

        try {
            client = await this.pool.connect();
            const vacuumMethod = full ? 'VACUUM FULL' : 'VACUUM';
            const vacuumCommand = analyze
                ? (full ? `${vacuumMethod} ANALYZE` : `${vacuumMethod} ANALYZE`)
                : vacuumMethod;

            // Get size before
            const sizeBefore = await client.query(
                'SELECT pg_database_size(current_database()) as size'
            );
            const sizeBeforeBytes = parseInt(sizeBefore.rows[0].size);

            // Log the job
            const startedAt = new Date();
            await client.query(
                `INSERT INTO database_maintenance_log (
                    id, operation, dry_run, executed_by, created_at, started_at, 
                    status, tables_affected
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [
                    jobId, 'optimize', false, executedBy, startedAt, startedAt,
                    'running', ['knx_events', 'current_state', 'subscription_events']
                ]
            );

            // Execute VACUUM
            this.logger.info(`Executing ${vacuumCommand}...`);
            await client.query(vacuumCommand);

            // Get size after
            const sizeAfter = await client.query(
                'SELECT pg_database_size(current_database()) as size'
            );
            const sizeAfterBytes = parseInt(sizeAfter.rows[0].size);

            const completedAt = new Date();
            const spaceFreedbytes = sizeBeforeBytes - sizeAfterBytes;
            const spaceFreePercent = (spaceFreedbytes / sizeBeforeBytes * 100).toFixed(1);

            const results = {
                status: 'completed',
                execution: {
                    started_at: startedAt.toISOString(),
                    completed_at: completedAt.toISOString(),
                    duration_seconds: Math.round((completedAt - startedAt) / 1000),
                },
                results: {
                    size_before_bytes: sizeBeforeBytes,
                    size_before_pretty: DatabaseManager.formatBytes(sizeBeforeBytes),
                    size_after_bytes: sizeAfterBytes,
                    size_after_pretty: DatabaseManager.formatBytes(sizeAfterBytes),
                    space_freed_bytes: spaceFreedbytes,
                    space_freed_pretty: DatabaseManager.formatBytes(spaceFreedbytes),
                    space_freed_percent: parseFloat(spaceFreePercent),
                    method: vacuumCommand,
                    tables_optimized: ['knx_events', 'current_state', 'subscription_events'],
                    downtime_warning: full ? `⚠️ VACUUM FULL: System was offline for ${Math.round((completedAt - startedAt) / 1000)} seconds` : null,
                },
            };

            // Update job as completed
            await client.query(
                `UPDATE database_maintenance_log 
                 SET status = $1, completed_at = $2, results = $3
                 WHERE id = $4`,
                ['completed', completedAt, JSON.stringify(results.results), jobId]
            );

            this.logger.info('✅ Optimize operation completed', {
                jobId,
                method: vacuumCommand,
                spaceFreed: DatabaseManager.formatBytes(spaceFreedbytes),
                status: 'completed',
            });

            return {
                id: jobId,
                type: 'optimize-result',
                ...results,
            };
        } catch (err) {
            this.logger.error('Failed to optimize database', { error: err.message, jobId });
            // Log failure
            try {
                await client.query(
                    `UPDATE database_maintenance_log 
                     SET status = $1, completed_at = $2, error_message = $3
                     WHERE id = $4`,
                    ['failed', new Date(), err.message, jobId]
                );
            } catch (logErr) {
                this.logger.error('Failed to log optimize failure', { error: logErr.message });
            }
            throw err;
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    /**
     * Helper: Get the total row count for a table
     * @private
     */
    async _getTotalRowCount(client, tableName) {
        try {
            const result = await client.query(`SELECT COUNT(*) as count FROM ${tableName}`);
            return parseInt(result.rows[0].count);
        } catch (err) {
            return 0;
        }
    }

    /**
     * Helper: Get a compression ratio for a hypertable
     * @private
     */
    async _getCompressionRatio(client, tableName) {
        try {
            const result = await client.query(`
                SELECT 
                    COALESCE(
                        ROUND(
                            (SELECT pg_total_relation_size(tablename)
                             FROM pg_tables WHERE tablename = $1) /
                            NULLIF(
                                (SELECT total_compressed_bytes FROM _timescaledb_internal.compressed_hypertable_stats
                                 WHERE hypertable_id = (SELECT id FROM _timescaledb_catalog.hypertable WHERE table_name = $1)),
                                0
                            ),
                            1
                        )::text || ':1',
                        'N/A'
                    ) as ratio;
            `, [tableName]);
            return result.rows[0]?.ratio || 'N/A';
        } catch (err) {
            return 'N/A';
        }
    }

    /**
     * Get cleanup jobs from the audit log with pagination and filtering
     *
     * @param {number} offset - Pagination offset
     * @param {number} limit - Results per page
     * @param {string} status - Filter by status (optional)
     * @param {number} days - Show jobs from last N days
     * @returns {Promise<object>} { jobs: [], total: number }
     */
    async getCleanupJobs(offset = 0, limit = 20, status = null, days = 30) {
        let client;
        try {
            client = await this.pool.connect();
            // Build query
            let whereClause = 'WHERE created_at > NOW() - INTERVAL \'1 day\' * $1';
            const params = [days];

            if (status && ['completed', 'failed', 'simulated'].includes(status)) {
                whereClause += ` AND status = $${params.length + 1}`;
                params.push(status);
            }

            // Get total count
            const countResult = await client.query(
                `SELECT COUNT(*) as total FROM database_maintenance_log ${whereClause}`,
                params
            );
            const total = parseInt(countResult.rows[0].total);

            // Get paginated results
            const result = await client.query(
                `SELECT * FROM database_maintenance_log 
                 ${whereClause}
                 ORDER BY created_at DESC
                 LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
                [...params, limit, offset]
            );

            const cleanupJobs = result.rows.map(row => ({
                id: row.id,
                type: 'cleanup-job',
                attributes: {
                    status: row.status,
                    strategy: row.operation,  // 'purge' or 'optimize'
                    preset: row.preset,
                    params: row.params || {},
                    dry_run: row.dry_run || false,
                    executed_by: row.executed_by,
                    created_at: row.created_at?.toISOString(),
                    completed_at: row.completed_at?.toISOString(),
                    duration_seconds: row.completed_at && row.started_at
                        ? Math.round((row.completed_at - row.started_at) / 1000)
                        : null,
                    tables_affected: row.tables_affected || [],
                    statistics: row.results || {},
                },
            }));

            return {
                jobs: cleanupJobs,
                total,
            };
        } catch (err) {
            this.logger.error('Failed to get cleanup jobs', { error: err.message, offset, limit, status, days });
            throw err;
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    /**
     * Check if the database is responsive (health check)
     *
     * @returns {Promise<boolean>} true if a database is connected, false otherwise
     */
    async checkHealth() {
         let client;
         try {
             client = await this.pool.connect();
            await client.query('SELECT NOW()');
            return true;
        } catch (err) {
            this.logger.error('Database health check failed', { error: err.message });
            return false;
        } finally {
            if (client) {
                client.release();
            }
        }
    }
}

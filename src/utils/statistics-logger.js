// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import { createLogger } from './logger.js';
import { formatTimestamp } from './timezone.js';
import { formatDPTValue } from './dpt-formatter.js';

export class StatisticsLogger {
    constructor(db) {
        this.logger = createLogger('StatisticsLogger');
        this.db = db;
        this.interval = null;
        this.intervalMinutes = 15;
        this.lastEventCount = 0;
    }

    /**
     * Start periodic stats logging
     */
    start() {
        this.logger.info(`Starting periodic stats logging (every ${this.intervalMinutes} minutes)`);

        // Log immediately on start
        this.logStats();

        // Then every 15 minutes
        this.interval = setInterval(() => {
            this.logStats();
        }, this.intervalMinutes * 60 * 1000);
    }

    /**
     * Stop periodic logging
     */
    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
            this.logger.info('Stopped periodic stats logging');
        }
    }

    /**
     * Log current statistics using process.stdout for Docker compatibility
     */
    async logStats() {
        try {
            const stats = await this.getStats();

            const eventsSinceLastCheck = stats.totalEvents - this.lastEventCount;
            const eventsPerMinute = this.lastEventCount > 0
                ? (eventsSinceLastCheck / this.intervalMinutes).toFixed(1)
                : 0;

            // Build output as single string for atomic write
            const output = [
                '',
                '════════════════════════════════════════════════════',
                '📊 PERIODIC DATABASE STATISTICS',
                '════════════════════════════════════════════════════',
                '📦 Total Records:',
                `   • Events:              ${stats.totalEvents.toLocaleString()}`,
                `   • Current States:      ${stats.totalStates.toLocaleString()}`,
                `   • Datapoint Mappings:  ${stats.totalMappings.toLocaleString()}`,
                `   • Semantic Resources:  ${stats.totalResources.toLocaleString()}`,
                `   • Unique GAs:          ${stats.uniqueGAs.toLocaleString()}`,
                '',
                `📈 Activity (last ${this.intervalMinutes} min):`,
                `   • New Events:          ${eventsSinceLastCheck.toLocaleString()}`,
                `   • Events/minute:       ${eventsPerMinute}`,
                `   • Last Event:          ${formatTimestamp(stats.lastEventTime) || 'N/A'}`,
                '',
                '💾 Database:',
                `   • Size:                ${stats.dbSize}`,
                `   • First Event:         ${formatTimestamp(stats.oldestEventTime) || 'N/A'}`,
                `   • Last Event:          ${formatTimestamp(stats.lastEventTime) || 'N/A'}`,
                '',
                `🔝 Top 5 Active Group Addresses (last ${this.intervalMinutes}min):`,
            ];

            for (const ga of stats.topGAs) {
                output.push(
                    `   • ${ga.ga.padEnd(12)} → ${String(ga.count).padStart(4)} events` +
                    `   | ${formatTimestamp(ga.lastSeen) || 'N/A'}` +
                    `   | Value: ${formatDPTValue(ga.currentValue)}`,
                );
            }

            output.push('');
            output.push('🔍 DATA INTEGRITY CHECKS:');
            output.push('─────────────────────────────────────────────────────');
            output.push(`✓ Orphaned States:        ${stats.orphanedStatesCount} orphaned (${stats.orphanedStatesGAs} GAs affected)`);
            output.push(`✓ Duplicate GAs:          ${stats.duplicateGAsCount} duplicate GAs`);
            output.push(`✓ Stale Mappings:         ${stats.staleMappingsCount} stale mappings`);
            output.push(`✓ Data Integrity Score:   ${stats.dataIntegrityScore}%`);
            output.push('════════════════════════════════════════════════════');
            output.push('');

            // Write as single block to stdout (Docker compatible)
            process.stdout.write(output.join('\n') + '\n');

            // Update for next comparison
            this.lastEventCount = stats.totalEvents;

        } catch (error) {
            this.logger.error('Failed to log statistics:', {
                errorMessage: error.message,
                errorStack: error.stack,
            });
        }
    }

    /**
     * Gather all statistics
     */
    async getStats() {
        const fifteenMinutesAgo = new Date(Date.now() - this.intervalMinutes * 60 * 1000);

        // Run all queries in parallel
        const [
            totalEvents,
            totalStates,
            totalMappings,
            totalResources,
            uniqueGAs,
            eventTimes,
            dbSize,
            topGAs,
            orphanedStates,
            duplicateGAs,
            staleMappings,
        ] = await Promise.all([
            this.db.query('SELECT COUNT(*) as count FROM knx_events'),
            this.db.query('SELECT COUNT(*) as count FROM current_state'),
            this.db.query('SELECT COUNT(*) as count FROM datapoint_mappings'),
            this.db.query('SELECT COUNT(*) as count FROM semantic_resources'),
            this.db.query('SELECT COUNT(DISTINCT ga) as count FROM current_state'),
            this.db.query(`
                SELECT
                    MIN(ts) as oldest,
                    MAX(ts) as latest
                FROM knx_events
            `),
            this.db.query('SELECT pg_size_pretty(pg_database_size(current_database())) as size'),
            this.db.query(`
                SELECT
                    e.ga,
                    COUNT(*) as count,
                    MAX(e.ts) as last_seen,
                    (
                        SELECT cs.value_decoded
                        FROM current_state cs
                        WHERE cs.ga = e.ga
                        ORDER BY cs.updated_at DESC
                        LIMIT 1
                    ) as current_value
                FROM knx_events e
                WHERE e.ts >= $1
                GROUP BY e.ga
                ORDER BY count DESC
                LIMIT 5
            `, [fifteenMinutesAgo]),
            this.db.query(`
                SELECT COUNT(*) as count, COUNT(DISTINCT cs.ga) as affected_gas
                FROM current_state cs
                LEFT JOIN datapoint_mappings m ON cs.datapoint_id = m.datapoint_id
                WHERE m.datapoint_id IS NULL
            `),
            this.db.query(`
                SELECT COUNT(*) as duplicate_count
                FROM (
                    SELECT ga, COUNT(*) as mapping_count
                    FROM datapoint_mappings
                    GROUP BY ga
                    HAVING COUNT(*) > 1
                ) duplicates
            `),
            this.db.query(`
                SELECT COUNT(*) as count
                FROM datapoint_mappings m
                LEFT JOIN current_state cs ON m.datapoint_id = cs.datapoint_id
                WHERE cs.datapoint_id IS NULL
            `),
        ]);

        const orphanedStatesCount = parseInt(orphanedStates.rows[0].count || 0);
        const orphanedStatesGAs = parseInt(orphanedStates.rows[0].affected_gas || 0);
        const duplicateGAsCount = parseInt(duplicateGAs.rows[0].duplicate_count || 0);
        const staleMappingsCount = parseInt(staleMappings.rows[0].count || 0);
        const totalMappingsCount = parseInt(totalMappings.rows[0].count || 0);

        return {
            totalEvents: parseInt(totalEvents.rows[0].count),
            totalStates: parseInt(totalStates.rows[0].count),
            totalMappings: parseInt(totalMappings.rows[0].count),
            totalResources: parseInt(totalResources.rows[0].count),
            uniqueGAs: parseInt(uniqueGAs.rows[0].count),
            oldestEventTime: eventTimes.rows[0]?.oldest,
            lastEventTime: eventTimes.rows[0]?.latest,
            dbSize: dbSize.rows[0].size,
            topGAs: topGAs.rows.map(row => ({
                ga: row.ga,
                count: parseInt(row.count),
                lastSeen: row.last_seen,
                currentValue: row.current_value,
            })),
            orphanedStatesCount,
            orphanedStatesGAs,
            duplicateGAsCount,
            staleMappingsCount,
            dataIntegrityScore: Math.round(((totalMappingsCount - staleMappingsCount) / Math.max(1, totalMappingsCount)) * 100),
        };
    }
}

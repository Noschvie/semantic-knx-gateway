// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import { createLogger } from './logger.js';
import { formatTimestamp } from './timezone.js';
import { formatDPTValue } from './dpt-formatter.js';
import { StatisticsStore } from '../storage/statistics-store.js';

export class StatisticsLogger {
    constructor(db) {
        this.logger = createLogger('StatisticsLogger');
        this.db = db;
        this.store = new StatisticsStore(db);
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
     * Gather all statistics using StatisticsStore abstraction
     */
    async getStats() {
        const fifteenMinutesAgo = new Date(Date.now() - this.intervalMinutes * 60 * 1000);

        // Run all queries in parallel through StatisticsStore
        const [
            totalEvents,
            totalStates,
            totalMappings,
            totalResources,
            uniqueGAs,
            eventTimeline,
            dbSize,
            topGAs,
            orphanedStates,
            duplicateGAs,
            staleMappings,
            integrityScore,
        ] = await Promise.all([
            this.store.getTotalEventCount(),
            this.store.getTotalStateCount(),
            this.store.getTotalMappingCount(),
            this.store.getTotalResourceCount(),
            this.store.getUniqueGroupAddressCount(),
            this.store.getEventTimeline(),
            this.store.getDatabaseSize(),
            this.store.getTopActiveGroupAddresses(fifteenMinutesAgo, 5),
            this.store.getOrphanedStatesInfo(),
            this.store.getDuplicateGroupAddressCount(),
            this.store.getStaleMappingCount(),
            this.store.getDataIntegrityScore(),
        ]);

        return {
            totalEvents,
            totalStates,
            totalMappings,
            totalResources,
            uniqueGAs,
            oldestEventTime: eventTimeline.oldest,
            lastEventTime: eventTimeline.latest,
            dbSize,
            topGAs,
            orphanedStatesCount: orphanedStates.count,
            orphanedStatesGAs: orphanedStates.affectedGAs,
            duplicateGAsCount: duplicateGAs,
            staleMappingsCount: staleMappings,
            dataIntegrityScore: integrityScore,
        };
    }
}

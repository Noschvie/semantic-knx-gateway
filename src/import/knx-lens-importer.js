// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import { createLogger } from '../utils/logger.js';
import { findLogFiles, parseLogFile, splitValueUnit } from './knx-lens-parser.js';
import { EventStore } from '../storage/event-store.js';

/**
 * Batch importer for knx-lens log files.
 *
 * Feeds historical telegrams through the existing StateEngine path
 * (StateEngine.processTelegram) so they end up in the TimescaleDB table
 * `knx_events` exactly like live-received telegrams and automatically reuse
 * the existing GA -> DPT mapping (datapointMappings loaded from the ETS
 * project).
 */
export class KnxLensImporter {
    /**
     * @param {import('../state/state-engine.js').StateEngine} stateEngine
     */
    constructor(stateEngine) {
        this.logger = createLogger('KnxLensImporter');
        this.stateEngine = stateEngine;
        this.eventStore = new EventStore(stateEngine.db);
    }

    /**
     * Imports all knx-lens log files from a directory.
     *
     * @param {string} logDir - Directory containing knx_bus.log / knx_bus.log.*.zip
     * @param {object} [options]
     * @param {boolean} [options.dryRun=false] - only parse/count, do not write
     * @param {boolean} [options.deleteExistingForDay=false] - before importing a file,
     *   delete all existing knx_events for the corresponding calendar day (makes
     *   the import idempotent for repeated runs). In dry-run mode the code will
     *   only count how many rows would be affected.
     * @param {(progress: object) => void} [options.onProgress] - called after each file
     * @returns {Promise<{files: Array, totalParsed: number, totalImported: number,
     *                     totalSkipped: number, totalDeleted: number, dryRun: boolean}>}
     */
    async importFromDirectory(logDir, options = {}) {
        const { dryRun = false, deleteExistingForDay = false, onProgress } = options;

        const files = findLogFiles(logDir);
        if (files.length === 0) {
            throw new Error(`No knx-lens log files found in '${logDir}'.`);
        }

        this.logger.info(
            `Starting ${dryRun ? 'dry-run ' : ''}import from ${files.length} file(s) in ${logDir}` +
            `${deleteExistingForDay ? ' (existing daily events will be deleted beforehand)' : ''}`,
        );
        onProgress?.({
            filesTotal: files.length, filesDone: 0, currentFile: null,
            totalParsed: 0, totalImported: 0, totalSkipped: 0, totalDeleted: 0,
        });

        const fileSummaries = [];
        let totalParsed = 0;
        let totalImported = 0;
        let totalSkipped = 0;
        let totalDeleted = 0;

        for (const file of files) {
            onProgress?.({ currentFile: file });

            let parsed;
            try {
                parsed = parseLogFile(file);
            } catch (err) {
                this.logger.error(`Error parsing ${file}: ${err.message}`);
                fileSummaries.push({ file, error: err.message, parsed: 0, imported: 0, skipped: 0, deleted: 0 });
                onProgress?.({ filesDone: fileSummaries.length, totalParsed, totalImported, totalSkipped, totalDeleted });
                continue;
            }

            let deleted = 0;
            if (deleteExistingForDay && parsed.length > 0) {
                const dayRange = this.getDayRange(parsed[0].timestamp);
                try {
                    deleted = await this.eventStore.deleteEventsByTimeRange(
                        dayRange.start,
                        dayRange.end,
                        dryRun,
                    );
                    if (deleted > 0) {
                        this.logger.info(
                            `${file}: ${deleted} existing event(s) from ${dayRange.start.toISOString().slice(0, 10)} ` +
                            `${dryRun ? 'would be deleted (dry-run)' : 'deleted'}`,
                        );
                    }
                } catch (err) {
                    this.logger.error(`Deleting day events for ${file} failed: ${err.message}`);
                }
            }
            totalDeleted += deleted;

            let imported = 0;
            let skipped = 0;

            for (const telegram of parsed) {
                if (!telegram.groupAddress) {
                    skipped++;
                    continue;
                }

                if (!dryRun) {
                    try {
                        await this.stateEngine.processTelegram(this.toStateEngineTelegram(telegram, file));
                        imported++;
                    } catch (err) {
                        this.logger.warn(`Failed to import telegram (GA ${telegram.groupAddress}): ${err.message}`);
                        skipped++;
                    }
                } else {
                    imported++; // in dry-run mode we count what would be imported
                }
            }

            totalParsed += parsed.length;
            totalImported += imported;
            totalSkipped += skipped;

            fileSummaries.push({ file, parsed: parsed.length, imported, skipped, deleted });
            this.logger.info(`${file}: ${parsed.length} parsed, ${imported} imported, ${skipped} skipped`);
            onProgress?.({ filesDone: fileSummaries.length, totalParsed, totalImported, totalSkipped, totalDeleted });
        }

        this.logger.info(
            `Import completed: ${totalImported}/${totalParsed} telegrams imported ` +
            `(${totalSkipped} skipped, ${totalDeleted} existing events deleted)` +
            `${dryRun ? ' [DRY RUN - nothing written]' : ''}`,
        );

        return { files: fileSummaries, totalParsed, totalImported, totalSkipped, totalDeleted, dryRun };
    }

    /**
     * Returns [start of day, start of next day) for the calendar day of a timestamp
     * (local time, as used by the knx-lens logger).
     *
     * IMPORTANT: Timestamps from knx-lens-parser are in local time (JavaScript Date objects
     * created with new Date(year, month, day, hour, minute, second, ms)). This function
     * converts them to UTC boundaries for correct database queries.
     *
     * Example:
     *   Input (local Berlin time): 2026-07-13 15:30:00
     *   Timestamp object interprets this as local time
     *   getDayRange() calculates UTC boundaries: 2026-07-12 22:00:00Z to 2026-07-13 22:00:00Z
     *   Database query uses UTC times for correct event matching
     *
     */
    getDayRange(timestamp) {
        // Extract calendar day components (these are interpreted as local time by JS)
        const start = new Date(timestamp.getFullYear(), timestamp.getMonth(), timestamp.getDate());

        // Get timezone offset in milliseconds for the given date
        // This accounts for DST transitions (Winter: UTC+1, Summer: UTC+2 for Europe/Berlin)
        const offsetMs = timestamp.getTimezoneOffset() * 60 * 1000;

        // Adjust start to UTC equivalent of midnight local time
        const startUTC = new Date(start.getTime() - offsetMs);

        // Calculate next day UTC boundary
        const end = new Date(start);
        end.setDate(end.getDate() + 1);
        const endUTC = new Date(end.getTime() - offsetMs);

        return { start: startUTC, end: endUTC };
    }


    /**
     * Converts a parsed knx-lens telegram into the format expected by
     * StateEngine.processTelegram().
     * The DPT is intentionally NOT set - processTelegram resolves it itself
     * using the already loaded GA -> DPT mapping (mapping?.dpt).
     */
    toStateEngineTelegram(telegram, sourceFile) {
        const { numeric, text } = splitValueUnit(telegram.rawValue);

        return {
            timestamp: telegram.timestamp.toISOString(),
            event: 'GroupValue_Write',
            source: telegram.sourceAddress,
            ga: telegram.groupAddress,
            value: numeric !== undefined ? numeric : text,
            dpt: undefined,
            // origin for traceability in the payload field of knx_events
            importMeta: {
                importedFrom: 'knx-lens',
                sourceFile,
                sourceName: telegram.sourceName || undefined,
                groupName: telegram.groupName || undefined,
                rawValue: telegram.rawValue,
            },
        };
    }
}

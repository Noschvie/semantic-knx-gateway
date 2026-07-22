// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';

/**
 * Parser for log files produced by the knx-lens logger
 * (https://github.com/henfri/knx-lens/blob/main/knx-lens-logger.py).
 *
 * Line format (see telegram_to_log_message() in the original):
 *   <timestamp:22> | <ia:9> | <ia_name:25> | <ga:8> | <ga_name:30> | <data:50>
 *
 * Values in the log are already formatted as human-readable strings (not the
 * raw DPT bytes) — lossless for simple numeric DPTs (temperature, percent,
 * etc.), but may lose information for more complex DPTs (e.g. ControlDimming)
 * compared to the original telegram.
 */

const LINE_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}/;
const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/;

/**
 * Parses a single log line.
 * @param {string} line
 * @returns {{timestamp: Date, sourceAddress: string, sourceName: string,
 *            groupAddress: string, groupName: string, rawValue: string} | null}
 */
export function parseLogLine(line) {
    const trimmed = line.replace(/\r?\n$/, '');
    if (!trimmed.trim()) return null;
    if (trimmed.startsWith('========')) return null; // separator lines / startup banner
    if (!LINE_TIMESTAMP_RE.test(trimmed)) return null; // e.g. "Logger started at ..."

    const parts = trimmed.split(' | ').map((p) => p.trim());
    if (parts.length < 6) return null;

    const [tsStr, ia, iaName, ga, gaName, ...dataParts] = parts;
    const rawValue = dataParts.join(' | '); // in case the value itself contains " | "

    const timestamp = parseTimestamp(tsStr);
    if (!timestamp) return null;

    return {
        timestamp,
        sourceAddress: ia,
        sourceName: iaName,
        groupAddress: ga,
        groupName: gaName,
        rawValue,
    };
}

function parseTimestamp(s) {
    // "YYYY-MM-DD HH:MM:SS.mmm" - local time (datetime.now() in the original logger)
    const m = s.match(TIMESTAMP_RE);
    if (!m) return null;
    const [, y, mo, d, h, mi, se, ms] = m.map(Number);
    return new Date(y, mo - 1, d, h, mi, se, ms);
}

/**
 * Attempts to extract a numeric value and unit from the logged string
 * (e.g. "21.5 °C" -> 21.5 / "°C"). If extraction fails (enum values or
 * fallback/raw data), the original text is returned unchanged.
 */
export function splitValueUnit(raw) {
    const m = raw.trim().match(/^(-?\d+(?:\.\d+)?)\s*(.*)$/);
    if (m) {
        return { numeric: parseFloat(m[1]), unit: m[2] || undefined, text: raw.trim() };
    }
    return { numeric: undefined, unit: undefined, text: raw.trim() };
}

function readLogFileContent(filePath) {
    if (filePath.toLowerCase().endsWith('.zip')) {
        const zip = new AdmZip(filePath);
        const entries = zip.getEntries().filter((e) => !e.isDirectory);
        // ZipTimedRotatingFileHandler bundles exactly one text file per ZIP
        return entries.map((e) => e.getData().toString('utf-8')).join('\n');
    }
    return fs.readFileSync(filePath, 'utf-8');
}
/** Reads a single log file (plain text or .zip) and returns all contained telegrams. */
export function parseLogFile(filePath) {
    const content = readLogFileContent(filePath);
    return content
        .split('\n')
        .map(parseLogLine)
        .filter((t) => t !== null);
}

/** Finds all relevant log files (active .log + rotated .log.*.zip) in a directory. */
export function findLogFiles(dir) {
    return fs
        .readdirSync(dir)
        .filter((f) => f === 'knx_bus.log' || /^knx_bus\.log\..*\.zip$/.test(f))
        .sort() // rotation files include a date stamp in their name -> sortable chronologically
        .map((f) => path.join(dir, f));
}

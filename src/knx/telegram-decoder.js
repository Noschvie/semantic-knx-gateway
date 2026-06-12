// SPDX-License-Identifier: CC-BY-NC-SA-4.0
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import { createLogger } from '../utils/logger.js';
import { DPTDecoder } from './dpt-decoder.js';
import { DPT_NAME_MAP } from '../utils/dpt-map.js';

export class TelegramDecoder {
    constructor() {
        this.logger = createLogger('TelegramDecoder');
        this.dptDecoder = new DPTDecoder();
        // einmalig loggen pro unbekanntem DPT-String, um Spam zu vermeiden
        this._unknownDpts = new Set();
    }

    /**
     * Normalisiert einen DPT-String auf das Format "X.YYY"
     * Akzeptiert: "1.001", "9", "timeOfDay", "date", ...
     */
    normalizeDpt(dpt) {
        if (!dpt) return null;
        if (/^\d+\.\d+$/.test(dpt)) return dpt;
        if (/^\d+$/.test(dpt)) return `${dpt}.001`;

        // ETS/KNX-IoT Format: "DPST-9-4" → "9.004" oder "DPT-9" → "9.001"
        const dpstMatch = dpt.match(/^DPST-(\d+)-(\d+)$/i);
        if (dpstMatch) {
            return `${dpstMatch[1]}.${String(dpstMatch[2]).padStart(3, '0')}`;
        }
        const dptMatch = dpt.match(/^DPT-(\d+)$/i);
        if (dptMatch) {
            return `${dptMatch[1]}.001`;
        }

        // Exakter Map-Lookup
        const mapped = DPT_NAME_MAP[dpt];
        if (mapped) return mapped;

        // Fallback: case-insensitive Suche in der Map
        const lowerDpt = dpt.toLowerCase();
        const caseInsensitiveMatch = Object.entries(DPT_NAME_MAP)
            .find(([key]) => key.toLowerCase() === lowerDpt);
        if (caseInsensitiveMatch) return caseInsensitiveMatch[1];

        if (!this._unknownDpts.has(dpt)) {
            this._unknownDpts.add(dpt);
            this.logger.warn(`Unknown DPT string: "${dpt}", treating as raw value. Add to DPT_NAME_MAP.`);
        }
        return null;
    }

    async decode(telegram, dpt) {
        const { timestamp, event, source, destination, rawValue } = telegram;

        const normalizedDpt = this.normalizeDpt(dpt);
        let value = rawValue;
        let decoded = false;

        if (normalizedDpt) {
            try {
                value = this.dptDecoder.decode(rawValue, normalizedDpt);
                decoded = true;
            } catch (err) {
                this.logger.warn({
                    msg: 'DPT decode failed, using raw value',
                    dpt: normalizedDpt,
                    error: err.message,
                });
            }
        }

        return {
            timestamp,
            event,
            source,
            ga: destination,
            rawValue,
            value,
            dpt: normalizedDpt,
            decoded,
        };
    }

    async decodeWithDPT(telegram, dpt) {
        return this.decode(telegram, dpt);
    }
}
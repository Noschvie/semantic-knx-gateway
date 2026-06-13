// SPDX-License-Identifier: CC-BY-NC-SA-4.0
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import { createLogger } from '../utils/logger.js';

export class DPTDecoder {
    constructor() {
        this.logger = createLogger('DPTDecoder');
    }

    /**
     * Decode KNX raw value based on DPT type
     * @param {Buffer|number|boolean} rawValue - Raw KNX value
     * @param {string} dpt - DPT type (e.g., "1.001", "5.001", "9.001")
     * @returns {*} Decoded value
     */
    decode(rawValue, dpt) {
        if (!dpt) {
            return rawValue;
        }

        try {
            const [main, sub] = dpt.split('.').map(Number);

            switch (main) {
                case 1: // DPT 1.xxx - Boolean
                    return this.decodeDPT1(rawValue);

                case 5: // DPT 5.xxx - 8-bit unsigned
                    return this.decodeDPT5(rawValue, sub);

                case 6: // DPT 6.xxx - 8-bit signed
                    return this.decodeDPT6(rawValue);

                case 7: // DPT 7.xxx - 16-bit unsigned
                    return this.decodeDPT7(rawValue);

                case 8: // DPT 8.xxx - 16-bit signed
                    return this.decodeDPT8(rawValue);

                case 9: // DPT 9.xxx - 2-byte float
                    return this.decodeDPT9(rawValue);

                case 10: // DPT 10.xxx - Time of Day
                    return this.decodeDPT10(rawValue);

                case 11: // DPT 11.xxx - Date
                    return this.decodeDPT11(rawValue);

                case 12: // DPT 12.xxx - 32-bit unsigned
                    return this.decodeDPT12(rawValue);

                case 13: // DPT 13.xxx - 32-bit signed
                    return this.decodeDPT13(rawValue);

                case 14: // DPT 14.xxx - 4-byte float
                    return this.decodeDPT14(rawValue);

                case 16: // DPT 16.xxx - String
                    return this.decodeDPT16(rawValue);

                case 17: // DPT 17.xxx - Scene number
                    return this.decodeDPT17(rawValue);

                case 18: // DPT 18.xxx - Scene control
                    return this.decodeDPT18(rawValue);

                case 19: // DPT 19.xxx - Date/Time
                    return this.decodeDPT19(rawValue);

                default:
                    this.logger.warn(`Unsupported DPT: ${dpt}`);
                    return rawValue;
            }
        } catch (error) {
            this.logger.error(`Error decoding DPT ${dpt}:`, error);
            return rawValue;
        }
    }

    /**
     * Encode value to KNX raw format
     */
    encode(value, dpt) {
        if (!dpt) {
            return value;
        }

        try {
            const [main] = dpt.split('.').map(Number);

            switch (main) {
                case 1:
                    return this.encodeDPT1(value);
                case 5:
                    return this.encodeDPT5(value);

                case 7: // DPT 7.xxx - 16-bit unsigned
                    return this.encodeDPT7(value);

                case 8: // DPT 8.xxx - 16-bit signed
                    return this.encodeDPT8(value);

                case 9: // DPT 9.xxx - 2-byte float
                    return this.encodeDPT9(value);
                default:
                    this.logger.warn(`Encoding not implemented for DPT: ${dpt}`);
                    return value;
            }
        } catch (error) {
            this.logger.error(`Error encoding DPT ${dpt}:`, error);
            return value;
        }
    }

    // ==================== DPT Decoders ====================

    decodeDPT1(value) {
        // Boolean: 0 = false, 1 = true
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value !== 0;
        if (Buffer.isBuffer(value)) {
            if (value.length === 0) return false;
            return (value[0] & 0x01) !== 0;
        }
        if (Array.isArray(value)) {
            if (value.length === 0) return false;
            return (value[0] & 0x01) !== 0;
        }
        return Boolean(value);
    }

    decodeDPT5(value, sub) {
        // 8-bit unsigned (0-255)
        const raw = this.toNumber(value);

        switch (sub) {
            case 1: // Scaling (0-100%)
                return Math.round((raw / 255) * 100);
            case 3: // Angle (0-360°)
                return Math.round((raw / 255) * 360);
            case 4: // Percent_U8 (0-255%)
                return raw;
            default:
                return raw;
        }
    }

    decodeDPT6(value) {
        // 8-bit signed (-128 to 127)
        const raw = this.toNumber(value);
        return raw > 127 ? raw - 256 : raw;
    }

    decodeDPT7(value) {
        // 16-bit unsigned (0-65535)
        const raw = this.toBuffer(value);
        const buf = raw.length < 2 ? Buffer.concat([Buffer.alloc(2 - raw.length), raw]) : raw;
        return buf.readUInt16BE(0);
    }

    decodeDPT8(value) {
        // 16-bit signed (-32768 to 32767)
        const raw = this.toBuffer(value);
        const buf = raw.length < 2 ? Buffer.concat([Buffer.alloc(2 - raw.length), raw]) : raw;
        return buf.readInt16BE(0);
    }

    decodeDPT9(value) {
        // 2-byte float (KNX DPT 9.x)
        // Format: SEEEEMMM MMMMMMMM
        // S = Sign, E = Exponent (4 bit), M = Mantissa (11 bit, two's complement)
        const buf = this.toBuffer(value);
        if (buf.length < 2) return 0;

        const byte1 = buf[0];
        const byte2 = buf[1];

        const sign     = (byte1 & 0x80) >> 7;
        const exponent = (byte1 & 0x78) >> 3;
        const mantissa = ((byte1 & 0x07) << 8) | byte2;

        // Mantissa as 11-bit two's complement
        const mantissaSigned = sign ? mantissa - 2048 : mantissa;

        const result = 0.01 * mantissaSigned * Math.pow(2, exponent);

        return Math.round(result * 100) / 100;
    }

    decodeDPT10(value) {
        // Time of Day: 3 Bytes
        // Byte 0: Bits 7-5 = day of week (0=none, 1=Mon ... 7=Sun), Bits 4-0 = hours
        // Byte 1: minutes (0-59)
        // Byte 2: seconds (0-59)
        const buf = this.toBuffer(value);
        if (buf.length < 2) return null;

        const dayOfWeek = (buf[0] & 0xE0) >> 5; // 0=no day, 1=Mon...7=Sun
        const hour    = buf[0] & 0x1F;
        const minute  = buf.length > 1 ? buf[1] & 0x3F : 0;
        const second  = buf.length > 2 ? buf[2] & 0x3F : 0;

        const days = [null, 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        return {
            dayOfWeek: dayOfWeek,
            dayName: days[dayOfWeek] ?? null,
            hour,
            minute,
            second,
            formatted: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`
        };
    }

    decodeDPT11(value) {
        // Date: 3 Bytes
        // Byte 0: day (1-31)
        // Byte 1: month (1-12)
        // Byte 2: year (0-99, where 90-99 = 1990-1999, 0-89 = 2000-2089)
        const buf = this.toBuffer(value);
        if (buf.length < 3) return null;

        const day   = buf[0] & 0x1F;
        const month = buf[1] & 0x0F;
        const yearRaw = buf[2] & 0x7F;
        const year  = yearRaw >= 90 ? 1900 + yearRaw : 2000 + yearRaw;

        return {
            day,
            month,
            year,
            formatted: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
        };
    }

    decodeDPT12(value) {
        // 32-bit unsigned
        const buf = this.toBuffer(value);
        return buf.readUInt32BE(0);
    }

    decodeDPT13(value) {
        // 32-bit signed
        const buf = this.toBuffer(value);
        return buf.readInt32BE(0);
    }

    decodeDPT14(value) {
        // 4-byte float
        const buf = this.toBuffer(value);
        return buf.readFloatBE(0);
    }

    decodeDPT16(value) {
        // String (ASCII)
        const buf = this.toBuffer(value);
        return buf.toString('ascii').replace(/\0/g, '');
    }

    decodeDPT17(value) {
        // Scene number (0-63)
        return this.toNumber(value) & 0x3F;
    }

    decodeDPT18(value) {
        // Scene control
        const raw = this.toNumber(value);
        return {
            learn: (raw & 0x80) !== 0,
            sceneNumber: raw & 0x3F
        };
    }

    decodeDPT19(value) {
        // Date/Time
        const buf = this.toBuffer(value);

        const year = buf[0] + 1900;
        const month = buf[1] & 0x0F;
        const day = buf[2] & 0x1F;
        const dayOfWeek = (buf[3] & 0xE0) >> 5;
        const hour = buf[3] & 0x1F;
        const minute = buf[4] & 0x3F;
        const second = buf[5] & 0x3F;

        return new Date(year, month - 1, day, hour, minute, second);
    }

    // ==================== DPT Encoders ====================

    encodeDPT1(value) {
        return value ? 1 : 0;
    }

    encodeDPT5(value) {
        return Math.max(0, Math.min(255, Math.round(value)));
    }

    encodeDPT7(value) {
        // 16-bit unsigned
        const buf = Buffer.alloc(2);
        buf.writeUInt16BE(Math.max(0, Math.min(65535, Math.round(value))), 0);
        return buf;
    }

    encodeDPT8(value) {
        // 16-bit signed
        const buf = Buffer.alloc(2);
        buf.writeInt16BE(Math.max(-32768, Math.min(32767, Math.round(value))), 0);
        return buf;
    }

    encodeDPT9(value) {
        // Encode 2-byte float
        const sign = value < 0 ? 1 : 0;
        const absValue = Math.abs(value);

        let exponent = 0;
        let mantissa = Math.round(absValue * 100);

        while (mantissa > 2047) {
            mantissa = mantissa >> 1;
            exponent++;
        }

        const byte1 = (sign << 7) | (exponent << 3) | ((mantissa >> 8) & 0x07);
        const byte2 = mantissa & 0xFF;

        return Buffer.from([byte1, byte2]);
    }

    // ==================== Helper Methods ====================

    toBuffer(value) {
        if (Buffer.isBuffer(value)) return value;
        if (typeof value === 'number') return Buffer.from([value]);
        if (Array.isArray(value)) return Buffer.from(value);
        return Buffer.from([0]);
    }

    toNumber(value) {
        if (typeof value === 'number') return value;
        if (Buffer.isBuffer(value)) return value[0];
        if (typeof value === 'boolean') return value ? 1 : 0;
        return 0;
    }

    /**
     * Get a human-readable value type for DPT
     */
    getValueType(dpt) {
        if (!dpt) return 'unknown';

        const [main] = dpt.split('.').map(Number);

        const typeMap = {
            1: 'boolean',
            5: 'number',
            6: 'number',
            7: 'number',
            9: 'number',
            12: 'number',
            13: 'number',
            14: 'number',
            16: 'string',
            17: 'number',
            18: 'object',
            19: 'datetime'
        };

        return typeMap[main] || 'unknown';
    }
}
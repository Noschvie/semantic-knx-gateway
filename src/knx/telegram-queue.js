// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

/**
 * TelegramQueue
 *
 * FIFO queue for outgoing KNX telegrams.
 * Implements FIFO Drop policy: when the queue is full, the oldest telegram is dropped.
 *
 * Usage:
 *   const queue = new TelegramQueue(100, logger);
 *   queue.push({ groupAddress: '1/2/3', value: 1, dpt: '1.001' });
 *   const telegram = queue.shift();
 */

export class TelegramQueue {
    /**
     * @param {number} maxSize - Maximum queue size
     * @param {Object} logger - Logger instance
     */
    constructor(maxSize = 100, logger = null) {
        this.maxSize = maxSize;
        this.logger = logger;
        this.items = [];
    }

    /**
     * Add a telegram to queue
     * If queue is full, drop oldest (FIFO Drop policy)
     * @param {Object} telegram - Telegram object {groupAddress, value, dpt, timestamp}
     * @returns {Object|null} - Dropped telegram if one was dropped, null otherwise
     */
    push(telegram) {
        let dropped = null;

        if (this.items.length >= this.maxSize) {
            dropped = this.items.shift();
            this.logger?.warn(
                `📋 Queue full (${this.maxSize}), dropping oldest: ` +
                `${dropped.groupAddress} = ${dropped.value}`,
            );
        }

        this.items.push(telegram);
        return dropped;
    }

    /**
     * Remove and return the first telegram (FIFO)
     * @returns {Object|undefined}
     */
    shift() {
        return this.items.shift();
    }

    /**
     * Remove multiple telegrams from front
     * @param {number} count - Number of items to remove
     * @returns {Array}
     */
    splice(count) {
        return this.items.splice(0, count);
    }

    /**
     * Get all telegrams and clear the queue
     * @returns {Array}
     */
    drain() {
        const items = [...this.items];
        this.items = [];
        return items;
    }

    /**
     * Get the current queue size
     * @returns {number}
     */
    get length() {
        return this.items.length;
    }

    /**
     * Get all telegrams (without removing)
     * @returns {Array}
     */
    getAll() {
        return [...this.items];
    }

    /**
     * Clear all telegrams
     */
    clear() {
        this.items = [];
    }

    /**
     * Check if the queue is empty
     * @returns {boolean}
     */
    isEmpty() {
        return this.items.length === 0;
    }

    /**
     * Check if the queue is full
     * @returns {boolean}
     */
    isFull() {
        return this.items.length >= this.maxSize;
    }

    /**
     * Get queue statistics
     * @returns {Object}
     */
    getStats() {
        return {
            size: this.items.length,
            maxSize: this.maxSize,
            isFull: this.isFull(),
            isEmpty: this.isEmpty(),
            utilizationPercent: Math.round((this.items.length / this.maxSize) * 100),
        };
    }
}

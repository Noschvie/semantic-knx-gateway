// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger.js';

export class EventBus extends EventEmitter {
    constructor() {
        super();
        this.logger = createLogger('EventBus');
        this.setMaxListeners(100); // Support many subscribers
    }

    emit(event, ...args) {
        this.logger.debug(`Event emitted: ${event}`);
        return super.emit(event, ...args);
    }

    on(event, listener) {
        this.logger.debug(`Listener registered: ${event}`);
        return super.on(event, listener);
    }

    off(event, listener) {
        this.logger.debug(`Listener removed: ${event}`);
        return super.off(event, listener);
    }
}

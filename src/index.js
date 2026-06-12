// SPDX-License-Identifier: CC-BY-NC-SA-4.0
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import dotenv from 'dotenv';
import { createLogger } from './utils/logger.js';
import { TunnelManager } from './knx/tunnel-manager.js';
import { StateEngine } from './state/state-engine.js';
import { PostgresClient } from './storage/postgres.js';
import { SemanticEngine } from './semantic/semantic-engine.js';
import { RestAPI } from './api/rest-api.js';
import { StatsLogger } from './utils/stats-logger.js';

dotenv.config();

const logger = createLogger('Main');

class SemanticKNXRuntime {
    constructor() {
        this.logger = logger;
        this.db = null;
        this.stateEngine = null;
        this.semanticEngine = null;
        this.tunnelManager = null;
        this.api = null;
        this.statsLogger = null;
    }

    async start() {
        try {
            this.logger.info('🚀 Starting Semantic KNX Runtime Engine...');
            this.logger.info('=====================================');

            // Phase 1: Database Connection
            this.logger.info('Phase 1: Initializing Database...');
            this.db = new PostgresClient();
            await this.db.connect();

            // Phase 2: State Engine
            this.logger.info('Phase 2: Initializing State Engine...');
            this.stateEngine = new StateEngine(this.db);
            await this.stateEngine.initialize();

            // Phase 3: Semantic Engine (optional)
            const ttlPath = process.env.KNX_TTL_PATH;
            if (ttlPath) {
                this.logger.info('Phase 3: Initializing Semantic Engine...');
                this.semanticEngine = new SemanticEngine(this.db, this.stateEngine);
                await this.semanticEngine.initialize(ttlPath);
            } else {
                this.logger.info('Phase 3: Skipping Semantic Engine (no TTL file)');
            }

            // Phase 4: KNX Tunnel Manager
            this.logger.info('Phase 4: Connecting to KNX...');
            this.tunnelManager = new TunnelManager(this.stateEngine);
            await this.tunnelManager.connect();

            // Phase 5: Stats Logger (periodic)
            this.logger.info('Phase 5: Starting Stats Logger...');
            this.statsLogger = new StatsLogger(this.db);
            this.statsLogger.start();

            // Phase 6: REST API
            this.logger.info('Phase 6: Starting REST API...');
            this.api = new RestAPI(this.stateEngine, this.db, this.semanticEngine, this.tunnelManager);
            await this.api.start();

            this.logger.info('=====================================');
            this.logger.info('✅ Semantic KNX Runtime Engine started successfully');
            this.logger.info(`📡 KNX Gateway: ${process.env.KNX_GATEWAY_IP}:${process.env.KNX_GATEWAY_PORT}`);
            this.logger.info(`🌐 REST API: http://0.0.0.0:${process.env.API_PORT}`);
            this.logger.info(`💾 Database: ${process.env.POSTGRES_HOST}:${process.env.POSTGRES_PORT}`);

            if (ttlPath) {
                this.logger.info(`🧠 Semantic Layer: Enabled (${ttlPath})`);
            }

            this.logger.info('=====================================');
        } catch (error) {
            this.logger.error({ msg: '❌ Failed to start runtime', error: error?.message ?? String(error), stack: error?.stack });
            await this.shutdown();
            process.exit(1);
        }
    }

    async shutdown() {
        this.logger.info('Shutting down gracefully...');

        if (this.statsLogger) this.statsLogger.stop();
        if (this.api) await this.api.stop();
        if (this.tunnelManager) await this.tunnelManager.disconnect();
        if (this.db) await this.db.disconnect();

        this.logger.info('✅ Shutdown complete');
    }
}

// Graceful Shutdown
const runtime = new SemanticKNXRuntime();

process.on('SIGTERM', () => runtime.shutdown());
process.on('SIGINT', () => runtime.shutdown());

// Start
runtime.start().catch((error) => {
    logger.error('Unhandled error:', error);
    process.exit(1);
});
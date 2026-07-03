// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { createLogger } from './utils/logger.js';
import { TunnelManager } from './knx/tunnel-manager.js';
import { StateEngine } from './state/state-engine.js';
import { PostgresClient } from './storage/postgres.js';
import { SemanticEngine } from './semantic/semantic-engine.js';
import { RestAPI } from './api/rest-api.js';
import { StatsLogger } from './utils/stats-logger.js';

dotenv.config();

const configDirectory = '/app/config';
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
        // Pre-startup validation (before opening connections)
        let ttlFileName = process.env.KNX_TTL_FILE;
        let ttlFilePath = null;

        if (ttlFileName) {
            ttlFilePath = path.join(configDirectory, ttlFileName);
            const validationError = await this.#validateTTLFile(ttlFilePath, ttlFileName);
            if (validationError) {
                this.logger.error('❌ TTL configuration validation failed: ' + validationError.message);
                this.logger.warn('Proceeding without semantic layer (treating as if KNX_TTL_FILE was not set)');
                ttlFileName = null;
                ttlFilePath = null;
            }
        }

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
            if (!ttlFileName) {
                this.logger.warn('⚠️  KNX_TTL_FILE not configured – Semantic Engine disabled');
                this.logger.warn('To enable the semantic layer, set KNX_TTL_FILE=YourProject.ttl in .env');
                this.logger.info('Phase 3: Skipping Semantic Engine');
            } else {
                this.logger.info('Phase 3: Initializing Semantic Engine...');
                this.semanticEngine = new SemanticEngine(this.db, this.stateEngine);
                await this.semanticEngine.initialize(ttlFilePath);
            }

            // Phase 4: KNX Tunnel Manager
            this.logger.info('Phase 4: Connecting to KNX...');
            this.tunnelManager = new TunnelManager(this.stateEngine);
            await this.tunnelManager.connect();

            // Phase 5: Statistics Logger (periodic)
            this.logger.info('Phase 5: Starting Statistics Logger...');
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

            if (ttlFilePath) {
                this.logger.info(`🧠 Semantic Layer: Enabled (${ttlFileName})`);
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

    /**
     * Validates that the TTL file exists and is a regular file.
     * Returns an Error object if validation fails, null if successful.
     * @param {string} ttlFilePath - Full path to TTL file
     * @param {string} ttlFileName - Filename only (for error messages)
     * @returns {Promise<Error|null>} Error object or null
     */
    async #validateTTLFile(ttlFilePath, ttlFileName) {
        // Check file exists
        try {
            await fs.promises.access(ttlFilePath, fs.constants.F_OK);
        } catch {
            this.logger.error('❌ TTL file not found: ' + ttlFilePath);
            this.logger.error(`Please place the file in the config directory and set KNX_TTL_FILE=${ttlFileName} in .env`);
            return new Error(`TTL file not found: ${ttlFilePath}`);
        }

        // Check is a regular file (not directory)
        try {
            const stat = await fs.promises.stat(ttlFilePath);
            if (!stat.isFile()) {
                this.logger.error('❌ TTL path is not a regular file: ' + ttlFilePath);
                this.logger.error('Expected a .ttl file, but found a directory or other file type');
                return new Error(`TTL path is not a regular file: ${ttlFilePath}`);
            }
        } catch (error) {
            this.logger.error('❌ Failed to validate TTL file: ' + error.message);
            return error;
        }

        return null;
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

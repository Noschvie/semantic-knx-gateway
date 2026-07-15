// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

import pg from 'pg';
import { createLogger } from '../utils/logger.js';

const { Pool } = pg;

/**
 * @typedef {Object} TransactionContext
 * @property {Function} query - Execute a query within the transaction
 * @property {Function} commit - Commit the transaction
 * @property {Function} rollback - Rollback the transaction
 */

export class PostgresClient {
    constructor() {
        this.logger = createLogger('PostgreSQL');
        this.pool = null;
    }

    async connect() {
        const config = {
            host: process.env.POSTGRES_HOST || 'localhost',
            port: parseInt(process.env.POSTGRES_PORT || '5432'),
            database: process.env.POSTGRES_DB || 'knx',
            user: process.env.POSTGRES_USERNAME || 'knx',
            password: process.env.POSTGRES_PASSWORD || 'knx',
            max: 20,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000,
        };

        this.logger.info(`Connecting to PostgreSQL at ${config.host}:${config.port}/${config.database}`);

        this.pool = new Pool(config);

        // Test connection
        try {
            const client = await this.pool.connect();
            const result = await client.query('SELECT NOW()');
            this.logger.info(`✅ PostgreSQL connected at ${result.rows[0].now}`);
            client.release();

            // Initialize schema
            await this.initializeSchema();
        } catch (error) {
            this.logger.error('Failed to connect to PostgreSQL:', error);
            throw error;
        }
    }

    async initializeSchema() {
        this.logger.info('Initializing database schema...');

        const client = await this.pool.connect();

        try {
            await client.query('BEGIN');

            // Enable pg_trgm extension for ILIKE index support
            await client.query(`
                CREATE EXTENSION IF NOT EXISTS pg_trgm;
            `);

            // Enable TimescaleDB extension
            await client.query(`
            CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;
          `);

            // Table: knx_events (TimescaleDB Hypertable)
            await client.query(`
            CREATE TABLE IF NOT EXISTS knx_events (
              ts TIMESTAMPTZ NOT NULL,
              datapoint_id TEXT,
              ga TEXT NOT NULL,
              source TEXT,
              event_type TEXT,
              value_bool BOOLEAN,
              value_float DOUBLE PRECISION,
              value_int BIGINT,
              value_text TEXT,
              dpt TEXT,
              payload JSONB,
              PRIMARY KEY (ts, ga)
            );
          `);

            // Convert to hypertable if not already
            await client.query(`
            SELECT create_hypertable('knx_events', 'ts', 
              if_not_exists => TRUE,
              chunk_time_interval => INTERVAL '1 day'
            );
          `);

            // Table: current_state
            await client.query(`
            CREATE TABLE IF NOT EXISTS current_state (
              datapoint_id TEXT PRIMARY KEY,
              ga TEXT,
              value JSONB,
              value_decoded TEXT,
              dpt TEXT,
              updated_at TIMESTAMPTZ NOT NULL,
              source TEXT
            );
          `);

            // Table: semantic_resources
            await client.query(`
            CREATE TABLE IF NOT EXISTS semantic_resources (
              id TEXT PRIMARY KEY,
              type TEXT NOT NULL,
              resource JSONB NOT NULL,
              created_at TIMESTAMPTZ DEFAULT NOW(),
              updated_at TIMESTAMPTZ DEFAULT NOW()
            );
          `);

            // Table: semantic_relationships
            await client.query(`
                CREATE TABLE IF NOT EXISTS semantic_relationships (
                    subject   TEXT NOT NULL,
                    predicate TEXT NOT NULL,
                    object    TEXT NOT NULL,
                    PRIMARY KEY (subject, predicate, object)
                );
            `);

            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_relationships_subject
                  ON semantic_relationships (subject, predicate);
                CREATE INDEX IF NOT EXISTS idx_relationships_object
                  ON semantic_relationships (object, predicate);
            `);

            // Table: datapoint_mappings
            await client.query(`
            CREATE TABLE IF NOT EXISTS datapoint_mappings (
              datapoint_id TEXT PRIMARY KEY,
              ga TEXT NOT NULL,
              dpt TEXT,
              name TEXT,
              location_id TEXT,
              device_id TEXT,
              function_id TEXT,
              metadata JSONB
            );
          `);

            // Table: dpt_change_log
            // Tracks DPT changes for audit trail and historical value interpretation
            await client.query(`
            CREATE TABLE IF NOT EXISTS dpt_change_log (
              id SERIAL PRIMARY KEY,
              datapoint_id TEXT NOT NULL,
              ga TEXT NOT NULL,
              old_dpt TEXT,
              new_dpt TEXT NOT NULL,
              changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              changed_by TEXT DEFAULT 'system',
              reason TEXT,
              metadata JSONB,
              CONSTRAINT fk_dpt_log_mapping FOREIGN KEY (datapoint_id)
                REFERENCES datapoint_mappings(datapoint_id) ON DELETE CASCADE
            );
          `);

            // Table: subscriptions
            await client.query(`
            CREATE TABLE IF NOT EXISTS subscriptions (
              id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid(),
              type        TEXT        NOT NULL DEFAULT 'callback'
                                      CHECK (type IN ('callback', 'websocket')),
              url         TEXT,
              secret      TEXT,
              ca_cert     TEXT,
              lifetime    INTERVAL,
              created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              expires_at  TIMESTAMPTZ,
              updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              active      BOOLEAN     NOT NULL DEFAULT TRUE,
              CONSTRAINT callback_requires_url CHECK (
                type != 'callback' OR url IS NOT NULL
              )
            );
          `);

            await client.query(`
            CREATE TABLE IF NOT EXISTS subscription_datapoints (
              subscription_id TEXT    NOT NULL REFERENCES subscriptions (id) ON DELETE CASCADE,
              datapoint_id    TEXT    NOT NULL,
              expand          BOOLEAN NOT NULL DEFAULT FALSE,
              PRIMARY KEY (subscription_id, datapoint_id)
            );
          `);

            await client.query(`
            CREATE TABLE IF NOT EXISTS subscription_installations (
              subscription_id  TEXT    NOT NULL REFERENCES subscriptions (id) ON DELETE CASCADE,
              installation_id  TEXT    NOT NULL,
              expand           BOOLEAN NOT NULL DEFAULT FALSE,
              PRIMARY KEY (subscription_id, installation_id)
            );
          `);

            await client.query(`
            CREATE TABLE IF NOT EXISTS subscription_node (
              subscription_id TEXT    NOT NULL REFERENCES subscriptions (id) ON DELETE CASCADE,
              node_id         TEXT    NOT NULL,
              expand          BOOLEAN NOT NULL DEFAULT FALSE,
              PRIMARY KEY (subscription_id, node_id),
              UNIQUE (subscription_id)
            );
          `);

            await client.query(`
            CREATE TABLE IF NOT EXISTS subscription_events (
              ts              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              subscription_id TEXT        NOT NULL REFERENCES subscriptions (id) ON DELETE CASCADE,
              datapoint_id    TEXT,
              trigger_type    TEXT        NOT NULL,
              payload         JSONB,
              http_status     SMALLINT,
              delivery_error  TEXT,
              delivered_at    TIMESTAMPTZ
            );
          `);

            await client.query(`
            SELECT create_hypertable('subscription_events', 'ts',
              if_not_exists => TRUE,
              chunk_time_interval => INTERVAL '1 day'
            );
          `);

            // updated_at trigger for subscriptions
            await client.query(`
            CREATE OR REPLACE FUNCTION update_updated_at_column()
            RETURNS TRIGGER AS $$
            BEGIN
              NEW.updated_at = NOW();
              RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
          `);
            await client.query(`
            DO $$ BEGIN
              IF NOT EXISTS (
                SELECT 1 FROM pg_trigger
                WHERE tgname = 'trg_subscriptions_updated_at'
              ) THEN
                CREATE TRIGGER trg_subscriptions_updated_at
                  BEFORE UPDATE ON subscriptions
                  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
              END IF;
            END $$;
          `);

            // Indexes
            await client.query(`
            CREATE INDEX IF NOT EXISTS idx_events_ga ON knx_events(ga, ts DESC);
            CREATE INDEX IF NOT EXISTS idx_events_datapoint ON knx_events(datapoint_id, ts DESC);
            CREATE INDEX IF NOT EXISTS idx_resources_type ON semantic_resources(type);
            CREATE INDEX IF NOT EXISTS idx_resources_trgm
                ON semantic_resources USING GIN ((resource::text) gin_trgm_ops);
            CREATE INDEX IF NOT EXISTS idx_mappings_ga ON datapoint_mappings(ga);
            CREATE INDEX IF NOT EXISTS idx_subscriptions_expires_at
              ON subscriptions (expires_at) WHERE expires_at IS NOT NULL AND active = TRUE;
            CREATE INDEX IF NOT EXISTS idx_sub_dp_datapoint_id
              ON subscription_datapoints (datapoint_id);
            CREATE INDEX IF NOT EXISTS idx_sub_inst_installation_id
              ON subscription_installations (installation_id);
            CREATE INDEX IF NOT EXISTS idx_sub_events_subscription_id
              ON subscription_events (subscription_id, ts DESC);
            CREATE INDEX IF NOT EXISTS idx_dpt_log_ga 
              ON dpt_change_log(ga, changed_at DESC);
            CREATE INDEX IF NOT EXISTS idx_dpt_log_datapoint_id 
              ON dpt_change_log(datapoint_id, changed_at DESC);
          `);

            // Views for DPT history tracking
            // View: Get current DPT for each GA
            await client.query(`
            CREATE OR REPLACE VIEW v_dpt_current AS
            SELECT
              ga,
              datapoint_id,
              new_dpt as dpt,
              changed_at,
              changed_by
            FROM dpt_change_log
            WHERE (ga, changed_at) IN (
              SELECT ga, MAX(changed_at)
              FROM dpt_change_log
              GROUP BY ga
            );
          `);

            // View: Get DPT at specific timestamp
            await client.query(`
            CREATE OR REPLACE VIEW v_dpt_history AS
            SELECT
              ga,
              datapoint_id,
              old_dpt,
              new_dpt,
              changed_at,
              LEAD(changed_at) OVER (PARTITION BY ga ORDER BY changed_at) as valid_until
            FROM dpt_change_log
            ORDER BY ga, changed_at;
          `);

            // Table: database_maintenance_log (Audit log for purge/optimize operations)
            await client.query(`
            CREATE TABLE IF NOT EXISTS database_maintenance_log (
              id              TEXT PRIMARY KEY,
              operation       TEXT NOT NULL CHECK (operation IN ('purge', 'optimize')),
              preset          TEXT,
              older_than      TIMESTAMPTZ,
              purge_all       BOOLEAN,
              dry_run         BOOLEAN NOT NULL DEFAULT FALSE,
              executed_by     TEXT,
              created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              started_at      TIMESTAMPTZ,
              completed_at    TIMESTAMPTZ,
              status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
              results         JSONB,
              error_message   TEXT,
              tables_affected TEXT[] DEFAULT ARRAY[]::TEXT[]
            );
          `);

            await client.query(`
            CREATE INDEX IF NOT EXISTS idx_maintenance_status 
              ON database_maintenance_log (status, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_maintenance_created 
              ON database_maintenance_log (created_at DESC);
          `);

            await client.query('COMMIT');
            this.logger.info('✅ Database schema initialized');

            // Log statistics
            await this.logStatistics();
        } catch (error) {
            await client.query('ROLLBACK');
            this.logger.error('Failed to initialize schema:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Get and log database statistics
     */
    async logStatistics() {
        try {
            const stats = await this.getStatistics();

            this.logger.info('📊 Database Statistics:');
            this.logger.info(`   • Events (knx_events): ${stats.events.toLocaleString()}`);
            this.logger.info(`   • Current States: ${stats.states.toLocaleString()}`);
            this.logger.info(`   • Datapoint Mappings: ${stats.mappings.toLocaleString()}`);
            this.logger.info(`   • Semantic Resources: ${stats.resources.toLocaleString()}`);
            this.logger.info(`   • Unique Group Addresses: ${stats.uniqueGAs.toLocaleString()}`);
            this.logger.info(`   • Active Subscriptions: ${stats.subscriptions.toLocaleString()}`);
            this.logger.info(`   • Database Size: ${stats.dbSize}`);
        } catch (error) {
            this.logger.warn('Failed to retrieve statistics:', error.message);
        }
    }

    /**
     * Get database statistics
     */
    async getStatistics() {
        const results = await Promise.all([
            this.query('SELECT COUNT(*) as count FROM knx_events'),
            this.query('SELECT COUNT(*) as count FROM current_state'),
            this.query('SELECT COUNT(*) as count FROM datapoint_mappings'),
            this.query('SELECT COUNT(*) as count FROM semantic_resources'),
            this.query('SELECT COUNT(DISTINCT ga) as count FROM current_state'),
            this.query('SELECT pg_size_pretty(pg_database_size(current_database())) as size'),
            this.query('SELECT COUNT(*) as count FROM subscriptions WHERE active = TRUE'),
        ]);

        return {
            events: parseInt(results[0].rows[0].count),
            states: parseInt(results[1].rows[0].count),
            mappings: parseInt(results[2].rows[0].count),
            resources: parseInt(results[3].rows[0].count),
            uniqueGAs: parseInt(results[4].rows[0].count),
            dbSize: results[5].rows[0].size,
            subscriptions: parseInt(results[6].rows[0].count),
        };
    }

    async query(text, params) {
        const start = Date.now();
        try {
            const result = await this.pool.query(text, params);
            const duration = Date.now() - start;
            this.logger.debug(`Query executed in ${duration}ms`);
            return result;
        } catch (error) {
            this.logger.error({
                msg: 'Query error',
                query: text,
                params: params,
                errorMessage: error.message,
                errorDetail: error.detail,
                errorHint: error.hint,
                errorCode: error.code,
                errorWhere: error.where,
                errorPosition: error.position,
            });
            throw error;
        }
    }

    async disconnect() {
        if (this.pool) {
            await this.pool.end();
            this.logger.info('PostgreSQL disconnected');
        }
    }

    // Helper: Get client for transactions
    async getClient() {
        return await this.pool.connect();
    }

    /**
     * Begin a transaction and return a transaction context
     * Usage:
     *   const txn = await this.db.beginTransaction();
     *   try {
     *       await txn.query('UPDATE ...');
     *       await txn.query('INSERT ...');
     *       await txn.commit();
     *   } catch (err) {
     *       await txn.rollback();
     *       throw err;
     *   }
     * @returns {Promise<TransactionContext>} Transaction context with query/commit/rollback methods
     */
    async beginTransaction() {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            return {
                query: (text, params) => client.query(text, params),
                commit: async () => {
                    await client.query('COMMIT');
                    client.release();
                },
                rollback: async () => {
                    await client.query('ROLLBACK');
                    client.release();
                },
            };
        } catch (err) {
            client.release();
            throw err;
        }
    }
}

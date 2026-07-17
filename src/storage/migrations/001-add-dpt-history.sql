-- Migration: Add DPT History Tracking
-- File: src/storage/migrations/001-add-dpt-history.sql
-- Purpose: Track when and how DPT changes for Group Addresses
-- This allows correct interpretation of historical values even after DPT changes

-- Table: dpt_change_log
-- Logs every DPT change for audit trail and value re-interpretation
CREATE TABLE IF NOT EXISTS dpt_change_log (
  id SERIAL PRIMARY KEY,
  datapoint_id TEXT NOT NULL,
  ga TEXT NOT NULL,
  old_dpt TEXT,
  new_dpt TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by TEXT DEFAULT 'system',  -- 'system', 'admin', 'import', etc.
  reason TEXT,
  metadata JSONB,

  CONSTRAINT fk_dpt_log_mapping FOREIGN KEY (datapoint_id)
    REFERENCES datapoint_mappings(datapoint_id) ON DELETE CASCADE
);

-- Index for fast lookup of DPT changes by GA
CREATE INDEX IF NOT EXISTS idx_dpt_log_ga
  ON dpt_change_log(ga, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_dpt_log_datapoint_id
  ON dpt_change_log(datapoint_id, changed_at DESC);

-- View: Get current DPT for each GA (for quick reference)
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

-- View: Get DPT at specific timestamp (for historical interpretation)
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

-- Example queries:

-- 1. What DPT was in effect when state was captured?
-- SELECT dpt_change_log.new_dpt
-- FROM dpt_change_log
-- WHERE ga = '10/4/2' AND changed_at <= '2026-06-20 15:06:01.902'
-- ORDER BY changed_at DESC
-- LIMIT 1;

-- 2. History of all DPT changes for GA 10/4/2
-- SELECT * FROM v_dpt_history WHERE ga = '10/4/2';

-- 3. Current DPT for all GAs
-- SELECT * FROM v_dpt_current;

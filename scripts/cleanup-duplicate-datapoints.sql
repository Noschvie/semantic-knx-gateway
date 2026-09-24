-- ============================================================================
-- One-time cleanup: remove synthetic fallback rows from current_state
-- ============================================================================
--
-- Context
--   Telegrams processed before their mapping was loaded persist a synthetic
--   fallback state under datapoint_id = 'ga-<a>-<b>-<c>' (e.g. "ga-2-4-0"),
--   while the projected datapoint uses the canonical id (e.g. "GA-471").
--   The API already collapses both onto the canonical datapoint at read time;
--   this script additionally removes the dead synthetic row from the database.
--
-- Safety
--   * Value-preserving: the newest value (by updated_at) is always kept under
--     the canonical datapoint_id.
--   * Only synthetic rows that HAVE a matching mapping are touched. Genuine
--     unprojected datapoints (synthetic id without a mapping) are left intact.
--   * Runs in a single transaction. Review the preview first, then execute.
--
-- Root-cause analysis
--   To understand HOW these rows were created, run the read-only diagnostics
--   FIRST (before this cleanup): scripts/diagnose-duplicate-datapoints.sql
--
-- Usage (local psql)
--   psql "$DATABASE_URL" -f scripts/cleanup-duplicate-datapoints.sql
--   (or run the PREVIEW block alone first to inspect the affected rows)
--
-- Usage (Docker Compose — service "timescaledb")
--   Reference stack:
--     docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
--       semantic-knx-runtime   ghcr.io/noschvie/semantic-knx-gateway:development
--       timescaledb            timescale/timescaledb:latest-pg18
--
--   Pipe this file into psql inside the timescaledb container. Adjust the
--   user/db to your env (POSTGRES_USERNAME=knxuser, POSTGRES_DB=knx by default):
--
--     docker compose -f docker-compose.yml -f docker-compose.prod.yml \
--       exec -T timescaledb psql -U knxuser -d knx \
--       < scripts/cleanup-duplicate-datapoints.sql
--
--   Preview only (dry run, no changes) — run just the first SELECT:
--     docker compose -f docker-compose.yml -f docker-compose.prod.yml \
--       exec timescaledb psql -U knxuser -d knx \
--       -c "SELECT cs.ga, cs.datapoint_id AS synthetic_id, dm.datapoint_id AS canonical_id \
--            FROM current_state cs JOIN datapoint_mappings dm ON dm.ga = cs.ga \
--            WHERE cs.datapoint_id = 'ga-' || replace(cs.ga, '/', '-') \
--              AND cs.datapoint_id <> dm.datapoint_id ORDER BY cs.ga;"
-- ============================================================================


-- ── PREVIEW (read-only): which synthetic rows would be affected? ────────────
SELECT
    cs.ga,
    cs.datapoint_id                       AS synthetic_id,
    dm.datapoint_id                       AS canonical_id,
    cs.updated_at                         AS synthetic_updated_at,
    canon.updated_at                      AS canonical_updated_at,
    CASE
        WHEN canon.datapoint_id IS NULL                 THEN 'rename synthetic -> canonical (canonical missing)'
        WHEN cs.updated_at > canon.updated_at           THEN 'overwrite canonical with newer synthetic, drop synthetic'
        ELSE                                                 'drop synthetic (canonical is newer/equal)'
    END                                   AS planned_action
FROM current_state cs
JOIN datapoint_mappings dm
    ON dm.ga = cs.ga
LEFT JOIN current_state canon
    ON canon.datapoint_id = dm.datapoint_id
WHERE cs.datapoint_id = 'ga-' || replace(cs.ga, '/', '-')
  AND cs.datapoint_id <> dm.datapoint_id
ORDER BY cs.ga;


-- ── CLEANUP (transactional) ─────────────────────────────────────────────────
BEGIN;

-- 1) Canonical row missing → rename synthetic to canonical (keeps last value).
UPDATE current_state cs
SET datapoint_id = dm.datapoint_id
FROM datapoint_mappings dm
WHERE dm.ga = cs.ga
  AND cs.datapoint_id = 'ga-' || replace(cs.ga, '/', '-')
  AND cs.datapoint_id <> dm.datapoint_id
  AND NOT EXISTS (
      SELECT 1 FROM current_state c2 WHERE c2.datapoint_id = dm.datapoint_id
  );

-- 2) Both rows exist, and the synthetic one is NEWER → copy its value onto the
--    canonical row (the synthetic row is deleted in step 3).
UPDATE current_state canon
SET value         = syn.value,
    value_decoded = syn.value_decoded,
    dpt           = syn.dpt,
    updated_at    = syn.updated_at,
    source        = syn.source
FROM current_state syn
JOIN datapoint_mappings dm ON dm.ga = syn.ga
WHERE syn.datapoint_id = 'ga-' || replace(syn.ga, '/', '-')
  AND canon.datapoint_id = dm.datapoint_id
  AND canon.datapoint_id <> syn.datapoint_id
  AND syn.updated_at > canon.updated_at;

-- 3) Drop any remaining synthetic rows that have a canonical mapping
--    (older duplicates and the ones already copied in step 2).
DELETE FROM current_state cs
USING datapoint_mappings dm
WHERE dm.ga = cs.ga
  AND cs.datapoint_id = 'ga-' || replace(cs.ga, '/', '-')
  AND cs.datapoint_id <> dm.datapoint_id;

COMMIT;


-- ── VERIFY (read-only): expect zero rows after cleanup ──────────────────────
SELECT cs.ga, cs.datapoint_id AS remaining_synthetic_id
FROM current_state cs
JOIN datapoint_mappings dm ON dm.ga = cs.ga
WHERE cs.datapoint_id = 'ga-' || replace(cs.ga, '/', '-')
  AND cs.datapoint_id <> dm.datapoint_id;


-- ── Root-cause analysis ─────────────────────────────────────────────────────
-- To understand HOW these synthetic rows came to exist, run the read-only
-- diagnostics BEFORE this cleanup (afterwards the rows are gone):
--     scripts/diagnose-duplicate-datapoints.sql

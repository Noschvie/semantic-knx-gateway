-- ============================================================================
-- Diagnostics (read-only): how did synthetic fallback rows come to exist?
-- ============================================================================
--
-- Purpose
--   Investigate duplicate datapoints per group address without changing any
--   data. Run this BEFORE scripts/cleanup-duplicate-datapoints.sql — once the
--   cleanup has run, the synthetic rows are gone and Q1–Q3 return nothing.
--
-- Root cause
--   Synthetic ids ('ga-<a>-<b>-<c>') are created in exactly one place —
--   StateEngine.processTelegram() — when a telegram arrives for a GA that has
--   NO mapping in the in-memory map yet:
--
--       const mapping = this.datapointMappings.get(ga);
--       datapointId = mapping?.datapointId || `ga-${ga.replace(/\//g, '-')}`;
--
--   In the current startup order (index.js) mappings are loaded (Phase 2) and
--   the TTL is imported (Phase 3) BEFORE the KNX tunnel connects (Phase 4), so
--   telegrams normally cannot create synthetic states anymore. Existing rows are
--   therefore historical: at the time the telegrams arrived, the GA was not yet
--   mapped. Two realistic scenarios:
--     A) The GA block was projected/imported LATER (e.g. blinds/"Raffstores"
--        added to the ETS/TTL after they were already live and chatty on the
--        bus). Most likely when a whole contiguous functional block is affected.
--        Typical operational timeline:
--          1. New GAs are created, parametrized and commissioned in ETS → the
--             devices start sending telegrams on the bus immediately.
--          2. The RUNNING gateway container still has the OLD TTL (no mapping
--             for these GAs) but is already connected to the bus, so every
--             telegram creates a synthetic 'ga-...' state.
--          3. The project/TTL file in the container is replaced — but this only
--             takes effect on RESTART (the TTL is imported once at startup).
--          4. After the restart the new TTL is imported → canonical GA-xxx
--             mappings appear → the duplicates become visible.
--        Note: the trigger is the window in step 2 (bus active with new GAs
--        while the running gateway has the old TTL), not the file swap itself.
--     B) The gateway ran without a semantic layer for a while (missing/invalid
--        KNX_TTL_FILE → "Proceeding without semantic layer") while the bus was
--        connected, so active GAs accumulated synthetic states.
--
--   There is no created_at on datapoint_mappings, but dpt_change_log records the
--   first-ever DPT assignment per GA (reason = 'Initial DPT assignment'), which
--   acts as a reliable "mapping created" timestamp.
--
-- Usage (local psql)
--   psql "$DATABASE_URL" -f scripts/diagnose-duplicate-datapoints.sql
--
-- Usage (Docker Compose — service "timescaledb")
--   docker compose -f docker-compose.yml -f docker-compose.prod.yml \
--     exec -T timescaledb psql -U knxuser -d knx \
--     < scripts/diagnose-duplicate-datapoints.sql
--
-- Follow-up
--   To remove the synthetic rows afterward (value-preserving), run:
--     scripts/cleanup-duplicate-datapoints.sql
-- ============================================================================


-- Q1) When were the canonical mappings first created (initial DPT assignment)?
SELECT dcl.ga, dcl.datapoint_id, dcl.changed_at AS mapping_created, dcl.reason
FROM dpt_change_log dcl
JOIN current_state cs
    ON cs.ga = dcl.ga
   AND cs.datapoint_id = 'ga-' || replace(cs.ga, '/', '-')
WHERE dcl.reason = 'Initial DPT assignment'
ORDER BY dcl.changed_at, dcl.ga;

-- Q2) Did the synthetic state get its value BEFORE the mapping existed?
--     telegram_before_mapping = TRUE confirms scenario A/B (telegram arrived
--     while the GA was still unmapped).
SELECT cs.ga,
       cs.updated_at                    AS synthetic_last_seen,
       dcl.changed_at                   AS mapping_created,
       (cs.updated_at < dcl.changed_at) AS telegram_before_mapping
FROM current_state cs
JOIN dpt_change_log dcl
    ON dcl.ga = cs.ga
   AND dcl.reason = 'Initial DPT assignment'
WHERE cs.datapoint_id = 'ga-' || replace(cs.ga, '/', '-')
ORDER BY cs.ga;

-- Q3) Does a canonical state already exist (are these GAs still sending)?
--     has_canonical_state = FALSE means the synthetic row holds the ONLY (last
--     known) value — which is why the cleanup script is value-preserving.
SELECT dm.ga,
       dm.datapoint_id,
       (canon.datapoint_id IS NOT NULL) AS has_canonical_state,
       canon.updated_at                 AS canonical_last_seen
FROM datapoint_mappings dm
JOIN current_state syn
    ON syn.ga = dm.ga
   AND syn.datapoint_id = 'ga-' || replace(dm.ga, '/', '-')
LEFT JOIN current_state canon
    ON canon.datapoint_id = dm.datapoint_id
ORDER BY dm.ga;


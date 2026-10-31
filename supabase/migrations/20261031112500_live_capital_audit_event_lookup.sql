-- CoinOps / OnPlay Platform otdfpmsegjxpqrzisfmi / schema coinops.
-- readCapitalRefreshEvents must not scan every RECONCILED event in a long run.
-- Keep the full index: PostgREST may use a generic plan with event_type=ANY($n),
-- which cannot reliably imply a partial-index predicate. All existing scope
-- filters, row validation, RLS, timeouts and recovery proofs remain unchanged.
-- LIVE: prebuild this exact index CONCURRENTLY as one top-level statement,
-- verify pg_index.indisvalid/indisready and the definition, then record this
-- migration. Transactional/local replay can use the ordinary statement below.
create index if not exists robot_v1_live_events_run_type_time_idx
  on coinops.robot_v1_live_events (run_id, event_type, observed_at, id);

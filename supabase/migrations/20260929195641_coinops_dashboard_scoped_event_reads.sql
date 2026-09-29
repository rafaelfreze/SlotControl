-- Evidence: authenticated latest-40 events read = 4092.838 ms / 6320 rows.
-- Version aligned with the official Supabase migration history after application.
-- Equality scope precedes ordering so LIMIT stops before evaluating the whole
-- run under RLS. No policy, grants or financial records are changed.
-- Bound lock acquisition and index-build time; failure rolls back atomically.
set local lock_timeout = '1s';
set local statement_timeout = '3s';

create index if not exists robot_v1_live_events_scope_recent_idx
  on coinops.robot_v1_live_events
  (operator_id, exchange_account_id, trading_engine_id, run_id, observed_at desc);

create index if not exists robot_v1_testnet_events_scope_recent_idx
  on coinops.robot_v1_testnet_events
  (operator_id, exchange_account_id, trading_engine_id, run_id, observed_at desc);

-- Legacy readers also supply product/tenant/user rather than operator.
create index if not exists robot_v1_testnet_events_owner_recent_idx
  on coinops.robot_v1_testnet_events
  (tenant_id, user_id, exchange_account_id, run_id, observed_at desc);

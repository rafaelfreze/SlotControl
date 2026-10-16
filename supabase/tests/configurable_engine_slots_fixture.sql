-- Synthetic isolated PostgreSQL fixture: column shapes from read-only metadata,
-- not a bootstrap schema and never applicable to Supabase. No production rows.
create role anon; create role authenticated; create role service_role bypassrls;
create schema coinops; create schema private; create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$ select jsonb_build_object('role',current_setting('request.jwt.claim.role',true)) $$;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
grant usage on schema coinops,private,auth to service_role,authenticated;
create table coinops.account_engine_append_previews (
  "exchange_account_id" uuid,
  "operator_id" uuid,
  "request_id" uuid,
  "input" jsonb,
  "preview_hash" text,
  "observed_at" timestamp with time zone,
  "expected_account_cap" numeric,
  "engine_inventory" jsonb,
  "available_capital" numeric
);
create table coinops.account_execution_policies (
  "exchange_account_id" uuid,
  "operator_id" uuid,
  "contract" text,
  "status" text,
  "request_id" uuid,
  "executor_version" text,
  "required_shards" text[],
  "proofs" jsonb default '{}'::jsonb,
  "updated_at" timestamp with time zone default clock_timestamp()
);
create table coinops.account_executor_connections (
  "exchange_account_id" uuid,
  "operator_id" uuid,
  "executor_shard_id" text,
  "environment" text,
  "credential_ref" text,
  "status" text default 'VALIDATION_REQUIRED'::text,
  "checked_at" timestamp with time zone,
  "validation_evidence" jsonb default '{}'::jsonb
);
create table coinops.account_onboarding_checks (
  "id" uuid default gen_random_uuid(),
  "operator_id" uuid,
  "exchange_account_id" uuid,
  "trading_engine_id" uuid,
  "check_key" text,
  "status" text default 'PENDING'::text,
  "evidence" jsonb default '{}'::jsonb,
  "checked_at" timestamp with time zone default now(),
  "created_by" uuid,
  "idempotency_key" text
);
alter table coinops.account_onboarding_checks add primary key(id);
create table coinops.account_order_budget_reservations (
  "client_order_id" text,
  "exchange_account_id" uuid,
  "operator_id" uuid,
  "trading_engine_id" uuid,
  "executor_shard_id" text,
  "reserved_at" timestamp with time zone default clock_timestamp(),
  "acknowledged_at" timestamp with time zone,
  "protection_orders" integer default 0
);
create table coinops.account_order_budget_samples (
  "exchange_account_id" uuid,
  "operator_id" uuid,
  "observed_at" timestamp with time zone,
  "server_time_ms" bigint,
  "intervals" jsonb,
  "symbol_limits" jsonb,
  "restrictions" jsonb default '[]'::jsonb,
  "exchange_limits" jsonb,
  "source_shard_id" text
);
create table coinops.account_quote_caps (
  "operator_id" uuid,
  "exchange_account_id" uuid,
  "quote_asset" text,
  "hard_cap_quote" numeric(28,12) default 0,
  "created_at" timestamp with time zone default now(),
  "updated_at" timestamp with time zone default now()
);
create table coinops.binance_account_identity_bindings (
  "exchange_account_id" uuid,
  "operator_id" uuid,
  "environment" text,
  "identity_hash" text,
  "created_at" timestamp with time zone default now()
);
create table coinops.exchange_accounts (
  "id" uuid default gen_random_uuid(),
  "operator_id" uuid,
  "display_name" text,
  "status" text default 'INACTIVE'::text,
  "credential_ref" text,
  "executor_profile" text,
  "is_legacy_default" boolean default false,
  "kill_switch" boolean default true,
  "created_at" timestamp with time zone default now(),
  "updated_at" timestamp with time zone default now(),
  "executor_shard_id" text default 'executor-01'::text,
  "onboarding_environment" text
);
alter table coinops.exchange_accounts add primary key(id);
create table coinops.executor_shards (
  "id" text,
  "egress_ipv4" inet,
  "enabled" boolean default true,
  "binance_limit_per_min" integer default 6000,
  "admission_ratio" numeric(5,4) default 0.65,
  "incremental_engine_weight" integer default 900,
  "created_at" timestamp with time zone default now()
);
alter table coinops.executor_shards add primary key(id);
create table coinops.operators (
  "id" uuid default gen_random_uuid(),
  "product_id" uuid,
  "tenant_id" uuid,
  "user_id" uuid,
  "status" text default 'INACTIVE'::text,
  "kill_switch" boolean default true,
  "created_at" timestamp with time zone default now(),
  "updated_at" timestamp with time zone default now()
);
alter table coinops.operators add primary key(id);
create table coinops.robot_v1_live_adjustment_batches (
  "id" uuid default gen_random_uuid(),
  "product_id" uuid,
  "tenant_id" uuid,
  "user_id" uuid,
  "operator_id" uuid,
  "exchange_account_id" uuid,
  "request_id" uuid,
  "request_fingerprint" text,
  "kind" text,
  "quote_asset" text,
  "origin_currency" text,
  "origin_amount" numeric(20,8) default 0,
  "amount_quote" numeric(20,8) default 0,
  "fx_rate" numeric(20,8),
  "fx_observed_at" timestamp with time zone,
  "evidence" text,
  "reason" text,
  "reversal_of" uuid,
  "created_at" timestamp with time zone default now()
);
alter table coinops.robot_v1_live_adjustment_batches add primary key(id);
create table coinops.robot_v1_live_adjustment_items (
  "id" uuid default gen_random_uuid(),
  "batch_id" uuid,
  "product_id" uuid,
  "tenant_id" uuid,
  "user_id" uuid,
  "operator_id" uuid,
  "exchange_account_id" uuid,
  "trading_engine_id" uuid,
  "symbol" text,
  "quote_asset" text,
  "slot_number" integer,
  "physical_slot_id" text,
  "amount_quote" numeric(20,8) default 0,
  "gain_units" integer default 0,
  "balance_before" numeric(20,8),
  "balance_after" numeric(20,8),
  "monthly_before" integer,
  "monthly_after" integer,
  "lifetime_before" integer,
  "lifetime_after" integer,
  "open_at_time" boolean,
  "position_committed_quote" numeric(20,8) default 0,
  "operation_sequence" integer,
  "period_key" text,
  "created_at" timestamp with time zone default now()
);
alter table coinops.robot_v1_live_adjustment_items add primary key(id);
create table coinops.robot_v1_live_events (
  "id" uuid default gen_random_uuid(),
  "run_id" uuid,
  "product_id" uuid,
  "tenant_id" uuid,
  "user_id" uuid,
  "event_key" text,
  "event_type" text,
  "slot_number" integer,
  "details" jsonb default '{}'::jsonb,
  "observed_at" timestamp with time zone default now(),
  "operator_id" uuid,
  "exchange_account_id" uuid,
  "trading_engine_id" uuid,
  "quote_asset" text
);
alter table coinops.robot_v1_live_events add primary key(id);
create table coinops.robot_v1_live_orders (
  "id" uuid default gen_random_uuid(),
  "run_id" uuid,
  "slot_id" uuid,
  "product_id" uuid,
  "tenant_id" uuid,
  "user_id" uuid,
  "slot_number" integer,
  "operation_sequence" integer,
  "side" text,
  "purpose" text,
  "revision" integer,
  "client_order_id" text,
  "exchange_order_id" text,
  "status" text default 'PREPARED'::text,
  "requested_quantity" numeric(28,12),
  "requested_quote" numeric(20,8),
  "price" numeric(24,8),
  "reserved_notional_brl" numeric(20,8),
  "executed_quantity" numeric(28,12) default 0,
  "cumulative_quote" numeric(20,8) default 0,
  "fee_base" numeric(28,12) default 0,
  "fee_quote" numeric(20,8) default 0,
  "fee_other" jsonb default '[]'::jsonb,
  "trades_reconciled" boolean default false,
  "submission_guarded_at" timestamp with time zone,
  "strategy_decision_id" text,
  "config_version" integer,
  "config_snapshot" jsonb,
  "created_at" timestamp with time zone default now(),
  "updated_at" timestamp with time zone default now(),
  "operator_id" uuid,
  "exchange_account_id" uuid,
  "trading_engine_id" uuid,
  "quote_asset" text,
  "reserved_notional_quote" numeric,
  "account_order_unsent_receipt" jsonb
);
alter table coinops.robot_v1_live_orders add primary key(id);
create table coinops.robot_v1_live_preparations (
  "id" uuid default gen_random_uuid(),
  "product_id" uuid,
  "tenant_id" uuid,
  "user_id" uuid,
  "asset" text,
  "symbol" text,
  "quote_asset" text default 'BRL'::text,
  "slot_count" integer default 25,
  "monthly_target" integer,
  "configured_live_capital_brl" numeric(20,8),
  "max_order_notional_brl" numeric(20,8),
  "max_total_exposure_brl" numeric(20,8),
  "compounding_enabled" boolean default true,
  "single_active_entry" boolean default true,
  "initial_market_enabled" boolean default true,
  "local_reentry_enabled" boolean default true,
  "kill_switch" boolean default true,
  "live_enabled" boolean default false,
  "config_version" integer default 1,
  "created_at" timestamp with time zone default now(),
  "updated_at" timestamp with time zone default now(),
  "operator_id" uuid,
  "exchange_account_id" uuid,
  "trading_engine_id" uuid,
  "max_total_exposure_quote" numeric,
  "max_order_notional_quote" numeric,
  "configured_live_capital_quote" numeric
);
alter table coinops.robot_v1_live_preparations add primary key(id);
create table coinops.robot_v1_live_runs (
  "id" uuid default gen_random_uuid(),
  "product_id" uuid,
  "tenant_id" uuid,
  "user_id" uuid,
  "asset" text,
  "symbol" text,
  "status" text default 'PREPARING'::text,
  "anchor_price" numeric(24,8),
  "slot_notional_brl" numeric(20,8),
  "gain_rate" numeric(12,8),
  "entry_spacing" numeric(12,8),
  "entry_regime" text,
  "config_version" integer,
  "config_snapshot" jsonb,
  "strategy_version" text,
  "ath_transition_key" text,
  "ath_period_key" text,
  "previous_run_id" uuid,
  "reset_idempotency_key" text,
  "completed_at" timestamp with time zone,
  "last_reconciled_at" timestamp with time zone,
  "last_error" text,
  "lease_owner" uuid,
  "lease_until" timestamp with time zone,
  "created_at" timestamp with time zone default now(),
  "updated_at" timestamp with time zone default now(),
  "operator_id" uuid,
  "exchange_account_id" uuid,
  "trading_engine_id" uuid,
  "quote_asset" text,
  "slot_notional_quote" numeric
);
alter table coinops.robot_v1_live_runs add primary key(id);
create table coinops.robot_v1_live_selective_contribution_allocations (
  "id" uuid default gen_random_uuid(),
  "batch_id" uuid,
  "product_id" uuid,
  "tenant_id" uuid,
  "user_id" uuid,
  "operator_id" uuid,
  "exchange_account_id" uuid,
  "trading_engine_id" uuid,
  "symbol" text,
  "quote_asset" text,
  "slot_number" integer,
  "amount_quote" numeric(20,8),
  "status" text,
  "source" text default 'ADMIN_SELECTED_SLOTS'::text,
  "slot_state_at_creation" text,
  "operation_sequence_at_creation" integer,
  "balance_before" numeric(20,8),
  "created_at" timestamp with time zone default now(),
  "applied_at" timestamp with time zone,
  "applied_operation_sequence" integer,
  "cancelled_at" timestamp with time zone
);
alter table coinops.robot_v1_live_selective_contribution_allocations add primary key(id);
create table coinops.robot_v1_live_selective_contribution_batches (
  "id" uuid default gen_random_uuid(),
  "product_id" uuid,
  "tenant_id" uuid,
  "user_id" uuid,
  "operator_id" uuid,
  "exchange_account_id" uuid,
  "trading_engine_id" uuid,
  "request_id" uuid,
  "request_fingerprint" text,
  "quote_asset" text,
  "origin_currency" text,
  "origin_amount" numeric(20,8),
  "amount_quote" numeric(20,8),
  "evidence" text,
  "reason" text,
  "source" text default 'ADMIN_SELECTED_SLOTS'::text,
  "created_at" timestamp with time zone default now()
);
alter table coinops.robot_v1_live_selective_contribution_batches add primary key(id);
create table coinops.robot_v1_live_selective_contribution_preset_usages (
  "id" uuid default gen_random_uuid(),
  "product_id" uuid,
  "tenant_id" uuid,
  "user_id" uuid,
  "operator_id" uuid,
  "preset_id" uuid,
  "trading_engine_id" uuid,
  "request_id" uuid,
  "anchor_slot_number" integer,
  "resolved_slot_numbers" integer[],
  "created_at" timestamp with time zone default now()
);
alter table coinops.robot_v1_live_selective_contribution_preset_usages add primary key(id);
create table coinops.robot_v1_live_selective_contribution_presets (
  "id" uuid default gen_random_uuid(),
  "product_id" uuid,
  "tenant_id" uuid,
  "user_id" uuid,
  "operator_id" uuid,
  "name" text,
  "total_slots" integer,
  "open_slots" integer,
  "following_slots" integer,
  "status" text default 'ACTIVE'::text,
  "built_in" boolean default false,
  "default_key" text,
  "usage_count" integer default 0,
  "created_by" uuid,
  "created_at" timestamp with time zone default now(),
  "updated_at" timestamp with time zone default now()
);
alter table coinops.robot_v1_live_selective_contribution_presets add primary key(id);
create table coinops.robot_v1_live_slot_accounts (
  "product_id" uuid,
  "tenant_id" uuid,
  "user_id" uuid,
  "asset" text,
  "slot_number" integer,
  "quote_asset" text default 'BRL'::text,
  "balance_brl" numeric(20,8) default 0,
  "market_pnl_brl" numeric(20,8) default 0,
  "manual_gain_brl" numeric(20,8) default 0,
  "contribution_brl" numeric(20,8) default 0,
  "fees_brl" numeric(20,8) default 0,
  "gain_count" integer default 0,
  "created_at" timestamp with time zone default now(),
  "updated_at" timestamp with time zone default now(),
  "dust_quantity" numeric(28,12) default 0,
  "dust_cost_brl" numeric(20,8) default 0,
  "operator_id" uuid,
  "exchange_account_id" uuid,
  "trading_engine_id" uuid,
  "dust_cost_quote" numeric,
  "fees_quote" numeric,
  "contribution_quote" numeric,
  "manual_gain_quote" numeric,
  "market_pnl_quote" numeric,
  "balance_quote" numeric
);
create table coinops.robot_v1_live_slots (
  "id" uuid default gen_random_uuid(),
  "run_id" uuid,
  "product_id" uuid,
  "tenant_id" uuid,
  "user_id" uuid,
  "slot_number" integer,
  "entry_state" text default 'PLANNED'::text,
  "target_buy_price" numeric(24,8),
  "entry_reference_price" numeric(24,8),
  "operation_sequence" integer default 1,
  "entry_origin" text default 'GRID'::text,
  "operational_rank" integer,
  "post_ath_group" text,
  "post_ath_group_rank" integer,
  "position_quantity" numeric(28,12) default 0,
  "position_committed_brl" numeric(20,8) default 0,
  "missed_at" timestamp with time zone,
  "last_take_profit_price" numeric(24,8),
  "last_credited_sell_client_order_id" text,
  "created_at" timestamp with time zone default now(),
  "updated_at" timestamp with time zone default now(),
  "operator_id" uuid,
  "exchange_account_id" uuid,
  "trading_engine_id" uuid,
  "quote_asset" text,
  "position_committed_quote" numeric
);
alter table coinops.robot_v1_live_slots add primary key(id);
create table coinops.robot_v1_monthly_slot_gains (
  "environment" text,
  "source_id" uuid,
  "product_id" uuid,
  "tenant_id" uuid,
  "user_id" uuid,
  "asset" text,
  "slot_number" integer,
  "physical_slot_id" text,
  "credited_at" timestamp with time zone,
  "effective_gain_at" timestamp with time zone,
  "evidence_basis" text,
  "period_key" text,
  "timezone" text default 'America/Campo_Grande'::text,
  "created_at" timestamp with time zone default now(),
  "gain_units" integer default 1,
  "operator_id" uuid,
  "exchange_account_id" uuid,
  "trading_engine_id" uuid,
  "quote_asset" text
);
create table coinops.robot_v1_strategy_decisions (
  "id" uuid default gen_random_uuid(),
  "product_id" uuid,
  "tenant_id" uuid,
  "user_id" uuid,
  "environment" text,
  "asset" text,
  "decision_id" text,
  "strategy_version" text,
  "cycle_id" uuid,
  "slot_id" uuid,
  "operation_id" text,
  "operation_sequence" integer,
  "action_type" text,
  "target_price" numeric(28,12),
  "target_notional" numeric(28,12),
  "priority" integer,
  "reason" text,
  "expected_next_state" jsonb,
  "observed_next_state" jsonb default '{}'::jsonb,
  "created_at" timestamp with time zone default now(),
  "dispatched_at" timestamp with time zone,
  "exchange_ack_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "result" text default 'PENDING'::text,
  "error" text,
  "latency_ms" numeric,
  "root_cause" text,
  "resolved_by_version" text,
  "operator_id" uuid,
  "exchange_account_id" uuid,
  "trading_engine_id" uuid,
  "quote_asset" text
);
alter table coinops.robot_v1_strategy_decisions add primary key(id);
create table coinops.robot_v1_testnet_runs (
  "id" uuid default gen_random_uuid(),
  "product_id" uuid,
  "tenant_id" uuid,
  "user_id" uuid,
  "asset" text,
  "symbol" text,
  "status" text default 'ACTIVE'::text,
  "anchor_price" numeric(24,8),
  "slot_notional_usdc" numeric(20,8),
  "gain_rate" numeric(12,8),
  "entry_spacing" numeric(12,8),
  "last_reconciled_at" timestamp with time zone,
  "last_error" text,
  "lease_owner" uuid,
  "lease_until" timestamp with time zone,
  "created_at" timestamp with time zone default timezone('utc'::text, now()),
  "updated_at" timestamp with time zone default timezone('utc'::text, now()),
  "previous_run_id" uuid,
  "completed_at" timestamp with time zone,
  "completion_reason" text,
  "terminal_fill_client_order_id" text,
  "reset_idempotency_key" text,
  "reset_started_at" timestamp with time zone,
  "reset_completed_at" timestamp with time zone,
  "recovery_source" text,
  "next_capital_usdc" numeric(20,8),
  "next_gain_rate" numeric(12,8),
  "next_entry_spacing" numeric(12,8),
  "strategy_version" text,
  "config_version" integer,
  "config_snapshot" jsonb,
  "entry_regime" text,
  "ath_transition_key" text,
  "ath_period_key" text,
  "operator_id" uuid,
  "exchange_account_id" uuid,
  "trading_engine_id" uuid,
  "quote_asset" text,
  "next_capital_quote" numeric,
  "slot_notional_quote" numeric
);
alter table coinops.robot_v1_testnet_runs add primary key(id);
create table coinops.trading_engines (
  "id" uuid default gen_random_uuid(),
  "operator_id" uuid,
  "exchange_account_id" uuid,
  "environment" text,
  "symbol" text,
  "base_asset" text,
  "quote_asset" text,
  "ath_reference_symbol" text,
  "status" text default 'INACTIVE'::text,
  "kill_switch" boolean default true,
  "legacy_compatible" boolean default false,
  "hard_cap_quote" numeric(28,12) default 0,
  "config" jsonb default '{}'::jsonb,
  "created_at" timestamp with time zone default now(),
  "updated_at" timestamp with time zone default now(),
  "strategy_config_pending" boolean default false,
  "executor_shard_id" text,
  "order_owner_prefix" text
);
alter table coinops.trading_engines add primary key(id);
alter table coinops.robot_v1_live_preparations add constraint robot_v1_live_preparations_slot_count_check check(true);
alter table coinops.robot_v1_live_slot_accounts add constraint robot_v1_live_slot_accounts_slot_number_check check(true);
alter table coinops.robot_v1_live_slots add constraint robot_v1_live_slots_slot_number_check check(true);
alter table coinops.robot_v1_live_slots add constraint robot_v1_live_slots_operational_rank_check check(true);
alter table coinops.robot_v1_live_slots add constraint robot_v1_live_slots_post_ath_group_rank_check check(true);
alter table coinops.robot_v1_live_orders add constraint robot_v1_live_orders_slot_number_check check(true);
alter table coinops.robot_v1_live_events add constraint robot_v1_live_events_slot_number_check check(true);
alter table coinops.robot_v1_monthly_slot_gains add constraint robot_v1_monthly_slot_gains_slot_number_check check(true);
alter table coinops.robot_v1_live_adjustment_items add constraint robot_v1_live_adjustment_items_slot_number_check check(true);
alter table coinops.robot_v1_live_selective_contribution_allocations add constraint robot_v1_live_selective_contribution_allocati_slot_number_check check(true);
alter table coinops.robot_v1_live_selective_contribution_presets add constraint robot_v1_live_selective_contribution_presets_total_slots_check check(true);
alter table coinops.robot_v1_live_selective_contribution_presets add constraint robot_v1_live_selective_contribution_presets_open_slots_check check(true);
alter table coinops.robot_v1_live_selective_contribution_presets add constraint robot_v1_live_selective_contribution_pres_following_slots_check check(true);
alter table coinops.robot_v1_live_selective_contribution_preset_usages add constraint robot_v1_live_selective_contribution_p_anchor_slot_number_check check(true);
alter table coinops.robot_v1_live_selective_contribution_preset_usages add constraint robot_v1_live_selective_contributio_resolved_slot_numbers_check check(true);
create unique index account_quote_caps_natural on coinops.account_quote_caps(exchange_account_id,quote_asset);
create unique index slot_accounts_natural on coinops.robot_v1_live_slot_accounts(trading_engine_id,slot_number);
create unique index live_slots_natural on coinops.robot_v1_live_slots(run_id,slot_number);
create unique index live_preparation_engine on coinops.robot_v1_live_preparations(trading_engine_id);
create table coinops.executor_capacity_admissions(engine_id uuid primary key,shard_id text,environment text,reserved_weight numeric,expires_at timestamptz,reserved_at timestamptz default now());
create table coinops.robot_v1_ath_profiles(product_id uuid,tenant_id uuid,user_id uuid,operator_id uuid,exchange_account_id uuid,trading_engine_id uuid,environment text,asset text,quote_asset text,config_version int,gain_rate numeric,normal_spacing_rate numeric,post_ath_spacing_rate numeric,regime text);
-- Deterministic control-plane stub records the requested conservative units.
-- It cannot contact an executor or certify actual fleet capacity.
create function coinops.preview_executor_admission(text,text,integer,uuid default null) returns jsonb language sql stable as $$
 select jsonb_build_object('code',case when current_setting('coinops.test.capacity',true)='deny' then 'CAPACITY_REQUIRED' else 'CAPACITY_OK' end,'requested_units',$3) $$;
create function coinops.executor_capacity_policy() returns jsonb language sql stable as $$select '{"version":"capacity-v3-20260930","incremental_weight":900}'::jsonb$$;
create table coinops.executor_admission_release(singleton boolean primary key default true,target_sha text,runtime_sha256 text,node_version text,policy_version text,verified_at timestamptz);
create table coinops.executor_admission_attestations(shard_id text primary key,egress_ipv4 inet,target_sha text,runtime_sha256 text,node_version text,policy_version text,verified_at timestamptz,evidence jsonb);
-- Scope binder fixture mirrors production's established context trigger only;
-- production implementation is untouched by the variable-slot migration.
create function private.test_bind_context() returns trigger language plpgsql set search_path='' as $$
declare j jsonb:=to_jsonb(new); e coinops.trading_engines%rowtype; r coinops.robot_v1_live_runs%rowtype;
begin
 if j->>'trading_engine_id' is null and j->>'run_id' is not null then
  select * into strict r from coinops.robot_v1_live_runs where id=(j->>'run_id')::uuid;
  new:=jsonb_populate_record(new,jsonb_build_object('trading_engine_id',r.trading_engine_id));
 end if;
 j:=to_jsonb(new);
 select * into strict e from coinops.trading_engines where id=(j->>'trading_engine_id')::uuid;
 if (j->>'operator_id' is not null and (j->>'operator_id')::uuid<>e.operator_id)
   or (j->>'exchange_account_id' is not null and (j->>'exchange_account_id')::uuid<>e.exchange_account_id) then
  raise exception 'COINOPS_ENGINE_IDENTITY_MISMATCH'; end if;
 new:=jsonb_populate_record(new,jsonb_build_object('operator_id',e.operator_id,'exchange_account_id',e.exchange_account_id,'quote_asset',e.quote_asset));
 return new;
end$$;
create trigger aa_coinops_engine_context before insert or update on coinops.robot_v1_live_preparations for each row execute function private.test_bind_context();
create trigger aa_coinops_engine_context before insert or update on coinops.robot_v1_live_runs for each row execute function private.test_bind_context();
create trigger aa_coinops_engine_context before insert or update on coinops.robot_v1_live_slots for each row execute function private.test_bind_context();
create trigger aa_coinops_engine_context before insert or update on coinops.robot_v1_live_orders for each row execute function private.test_bind_context();
create trigger aa_coinops_engine_context before insert or update on coinops.robot_v1_live_events for each row execute function private.test_bind_context();
create trigger aa_coinops_engine_context before insert or update on coinops.robot_v1_live_slot_accounts for each row execute function private.test_bind_context();
alter table coinops.trading_engines enable row level security; alter table coinops.trading_engines force row level security;
create policy test_scope on coinops.trading_engines for select to authenticated using(operator_id in(select id from coinops.operators where user_id=auth.uid()));
alter table coinops.robot_v1_live_runs enable row level security; alter table coinops.robot_v1_live_runs force row level security;
create policy test_scope on coinops.robot_v1_live_runs for select to authenticated using(operator_id in(select id from coinops.operators where user_id=auth.uid()));
alter table coinops.robot_v1_live_preparations enable row level security; alter table coinops.robot_v1_live_preparations force row level security;
create policy test_scope on coinops.robot_v1_live_preparations for select to authenticated using(operator_id in(select id from coinops.operators where user_id=auth.uid()));
alter table coinops.robot_v1_live_slots enable row level security; alter table coinops.robot_v1_live_slots force row level security;
create policy test_scope on coinops.robot_v1_live_slots for select to authenticated using(operator_id in(select id from coinops.operators where user_id=auth.uid()));
alter table coinops.robot_v1_live_orders enable row level security; alter table coinops.robot_v1_live_orders force row level security;
create policy test_scope on coinops.robot_v1_live_orders for select to authenticated using(operator_id in(select id from coinops.operators where user_id=auth.uid()));
alter table coinops.robot_v1_live_slot_accounts enable row level security; alter table coinops.robot_v1_live_slot_accounts force row level security;
create policy test_scope on coinops.robot_v1_live_slot_accounts for select to authenticated using(operator_id in(select id from coinops.operators where user_id=auth.uid()));
grant select,insert,update,delete on all tables in schema coinops to service_role;
grant select on all tables in schema coinops to authenticated;
revoke all on coinops.executor_admission_release,coinops.executor_admission_attestations from public,anon,authenticated;
create unique index live_order_client_id on coinops.robot_v1_live_orders(client_order_id);
create unique index live_slots_composite_identity on coinops.robot_v1_live_slots(id,run_id,product_id,tenant_id,user_id);
alter table coinops.robot_v1_live_orders add foreign key(slot_id,run_id,product_id,tenant_id,user_id)
  references coinops.robot_v1_live_slots(id,run_id,product_id,tenant_id,user_id);

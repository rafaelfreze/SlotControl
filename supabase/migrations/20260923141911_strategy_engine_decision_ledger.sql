-- Phase 4.1: additive, fictitious execution audit. No financial history rewrite.
alter table coinops.robot_v1_configs add column if not exists strategy_version text,
  add column if not exists strategy_lease_owner uuid,
  add column if not exists strategy_lease_until timestamptz;
alter table coinops.robot_v1_cycles add column if not exists strategy_version text;
alter table coinops.robot_v1_testnet_runs add column if not exists strategy_version text;
alter table coinops.robot_v1_testnet_orders add column if not exists strategy_decision_id text;

create table coinops.robot_v1_strategy_decisions (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  environment text not null check (environment in ('SHADOW','TESTNET')),
  asset text not null check (asset in ('BTC','SOL')),
  decision_id text not null check (decision_id ~ '^[a-f0-9]{64}$'),
  strategy_version text not null,
  cycle_id uuid not null,
  slot_id uuid,
  operation_id text,
  operation_sequence integer,
  action_type text not null check (action_type in ('OPEN_INITIAL_MARKET','CREATE_TP','PLAN_LOCAL_REENTRY','ARM_NEXT_BUY','CANCEL_REPLACE_NEXT_BUY','COMPLETE_CYCLE','REANCHOR','WAIT')),
  target_price numeric(28,12),
  target_notional numeric(28,12),
  priority integer not null,
  reason text not null,
  expected_next_state jsonb not null,
  observed_next_state jsonb not null default '{}',
  created_at timestamptz not null default now(),
  dispatched_at timestamptz,
  exchange_ack_at timestamptz,
  completed_at timestamptz,
  result text not null default 'PENDING' check (result in ('PENDING','DISPATCHED','ACKNOWLEDGED','COMPLETED','FAILED')),
  error text,
  latency_ms numeric,
  root_cause text,
  resolved_by_version text,
  unique (product_id,tenant_id,user_id,environment,decision_id),
  foreign key (product_id,tenant_id) references public.product_tenants(product_id,tenant_id) on delete restrict
);
create index robot_v1_strategy_decisions_cycle on coinops.robot_v1_strategy_decisions (tenant_id,environment,cycle_id,created_at);
create index robot_v1_strategy_decisions_pending on coinops.robot_v1_strategy_decisions (tenant_id,result,created_at) where result <> 'COMPLETED';
alter table coinops.robot_v1_strategy_decisions enable row level security;
alter table coinops.robot_v1_strategy_decisions force row level security;
create policy robot_v1_strategy_decisions_owner_select on coinops.robot_v1_strategy_decisions for select to authenticated
  using (private.coinops_can_access_row(product_id,tenant_id,user_id));
revoke all on coinops.robot_v1_strategy_decisions from public,anon,authenticated;
grant select on coinops.robot_v1_strategy_decisions to authenticated,service_role;
grant insert,update on coinops.robot_v1_strategy_decisions to service_role;

-- A polymorphic cycle must still match the full environment and tenant scope.
create function private.coinops_guard_strategy_decision() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if (new.product_id,new.tenant_id,new.user_id,new.environment,new.asset,new.decision_id,new.strategy_version,new.cycle_id,new.slot_id,new.operation_id,new.operation_sequence,new.action_type,new.target_price,new.target_notional,new.priority,new.reason,new.expected_next_state,new.created_at)
       is distinct from
       (old.product_id,old.tenant_id,old.user_id,old.environment,old.asset,old.decision_id,old.strategy_version,old.cycle_id,old.slot_id,old.operation_id,old.operation_sequence,old.action_type,old.target_price,old.target_notional,old.priority,old.reason,old.expected_next_state,old.created_at) then
      raise exception 'COINOPS_STRATEGY_DECISION_IMMUTABLE';
    end if;
    return new;
  end if;
  if new.environment = 'TESTNET' then
    if not exists (select 1 from coinops.robot_v1_testnet_runs r where r.id=new.cycle_id and r.product_id=new.product_id and r.tenant_id=new.tenant_id and r.user_id=new.user_id and r.asset=new.asset)
      or (new.slot_id is not null and not exists (select 1 from coinops.robot_v1_testnet_slots s where s.id=new.slot_id and s.run_id=new.cycle_id)) then
      raise exception 'COINOPS_STRATEGY_DECISION_SCOPE_INVALID';
    end if;
  else
    if not exists (select 1 from coinops.robot_v1_cycles c where c.id=new.cycle_id and c.product_id=new.product_id and c.tenant_id=new.tenant_id and c.user_id=new.user_id and c.asset=new.asset and c.execution_mode='SHADOW')
      or (new.slot_id is not null and not exists (select 1 from coinops.robot_v1_slots s where s.id=new.slot_id and s.cycle_id=new.cycle_id)) then
      raise exception 'COINOPS_STRATEGY_DECISION_SCOPE_INVALID';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.coinops_guard_strategy_decision() from public,anon,authenticated;
create trigger robot_v1_strategy_decision_guard before insert or update on coinops.robot_v1_strategy_decisions
  for each row execute function private.coinops_guard_strategy_decision();

-- Historical versions deliberately stay NULL. Runtime stamps a cycle only when
-- the shared engine has actually adopted it; old decisions/fills remain intact.

-- Preserve the observed SOL incident as an additional audit record, never a
-- retroactive BUY or a rewrite of credited gains. Exact crossing time is unknown.
insert into coinops.robot_v1_testnet_events
  (run_id,product_id,tenant_id,user_id,event_key,event_type,slot_number,details)
select r.id,r.product_id,r.tenant_id,r.user_id,
  'PHASE_4_1_SOL_TP_LATENCY_DIAGNOSIS','MISSED_LEVEL_DIAGNOSED',s.slot_number,
  jsonb_build_object('root_cause','STALE_CACHED_RUN_DISCOVERY',
    'filled_at',f.details->>'filledAt','collected_at',f.details->>'collectedAt',
    'latency_ms',extract(epoch from ((f.details->>'collectedAt')::timestamptz-(f.details->>'filledAt')::timestamptz))*1000,
    'first_cross_at',null,'targetPrice',s.target_buy_price,'detected_at',s.missed_at,
    'order_resident_at',null,'resolved_by_version','4.1.0',
    'correction','EXPLICIT_NO_STORE_AND_ONE_MINUTE_REACTOR',
    'historical_missed_preserved',true,'retroactive_fill_created',false,
    'root_cause_evidence','NEXT_14_2_35_PATCH_FETCH_REGRESSION_REPRODUCED')
from coinops.robot_v1_testnet_runs r
join coinops.robot_v1_testnet_slots s on s.run_id=r.id and s.slot_number=1
join coinops.robot_v1_testnet_events f on f.run_id=r.id and f.slot_number=s.slot_number
where r.asset='SOL' and r.symbol='SOLUSDC' and s.operation_sequence=2
  and s.missed_at is not null and s.target_buy_price=118.97
  and f.event_type='TESTNET_FILL_OBSERVED' and f.details->>'side'='SELL'
  and f.details->>'filledAt'='2026-09-23T04:23:36.439Z'
  and f.details->>'collectedAt'='2026-09-23T12:30:04.982Z'
on conflict (run_id,event_key) do nothing;

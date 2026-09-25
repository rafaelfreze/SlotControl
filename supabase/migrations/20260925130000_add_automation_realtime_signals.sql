-- A payload-free, account-scoped invalidation channel for the read-only UI.
-- Exchange execution, ledgers, and existing rows are not changed by this migration.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create table coinops.automation_refresh_signals (
  trading_engine_id uuid primary key,
  operator_id uuid not null references coinops.operators(id) on delete restrict,
  exchange_account_id uuid not null,
  environment text not null check (environment in ('REAL','TESTNET','SHADOW')),
  symbol text not null,
  revision bigint not null default 1 check (revision > 0),
  last_txid bigint not null,
  changed_at timestamptz not null default now(),
  foreign key (trading_engine_id,operator_id,exchange_account_id)
    references coinops.trading_engines(id,operator_id,exchange_account_id) on delete cascade
);
create index automation_refresh_signals_account_idx
  on coinops.automation_refresh_signals(exchange_account_id,environment,symbol);
alter table coinops.automation_refresh_signals enable row level security;
alter table coinops.automation_refresh_signals force row level security;
revoke all on coinops.automation_refresh_signals from public,anon,authenticated;
grant select on coinops.automation_refresh_signals to authenticated;
grant all on coinops.automation_refresh_signals to service_role;

create function private.coinops_can_read_automation_signal(p_operator uuid,p_account uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null and (
    exists (select 1 from coinops.viewer_access v
      where v.user_id=(select auth.uid()) and v.operator_id=p_operator
        and v.exchange_account_id=p_account and v.status='ACTIVE')
    or private.coinops_operator_owned(p_operator)
  );
$$;
revoke all on function private.coinops_can_read_automation_signal(uuid,uuid) from public,anon;
grant execute on function private.coinops_can_read_automation_signal(uuid,uuid) to authenticated,service_role;
create policy automation_refresh_scope on coinops.automation_refresh_signals
  for select to authenticated
  using (private.coinops_can_read_automation_signal(operator_id,exchange_account_id));

create function private.coinops_emit_automation_refresh() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  row_data jsonb;
  account_id uuid;
  engine_id uuid;
  owner_id uuid;
  engine coinops.trading_engines%rowtype;
  current_tx bigint := txid_current();
begin
  if tg_op='UPDATE' and new is not distinct from old then return new; end if;
  row_data := to_jsonb(case when tg_op='DELETE' then old else new end);
  account_id := nullif(row_data->>'exchange_account_id','')::uuid;
  if tg_table_name='operators' then
    owner_id := (row_data->>'id')::uuid;
  elsif tg_table_name='exchange_accounts' then
    account_id := (row_data->>'id')::uuid;
  elsif tg_table_name='trading_engines' then
    engine_id := (row_data->>'id')::uuid;
  else
    engine_id := nullif(row_data->>'trading_engine_id','')::uuid;
  end if;
  for engine in select e.* from coinops.trading_engines e
    where (engine_id is not null and e.id=engine_id)
       or (owner_id is not null and e.operator_id=owner_id)
       or (engine_id is null and account_id is not null and e.exchange_account_id=account_id)
  loop
    insert into coinops.automation_refresh_signals
      (trading_engine_id,operator_id,exchange_account_id,environment,symbol,last_txid)
    values (engine.id,engine.operator_id,engine.exchange_account_id,engine.environment,engine.symbol,current_tx)
    on conflict (trading_engine_id) do update
      set revision=coinops.automation_refresh_signals.revision+1,
          last_txid=excluded.last_txid,changed_at=now()
      where coinops.automation_refresh_signals.last_txid is distinct from excluded.last_txid;
  end loop;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
revoke all on function private.coinops_emit_automation_refresh() from public,anon,authenticated;
grant execute on function private.coinops_emit_automation_refresh() to service_role;

do $$ declare table_name text; begin
  foreach table_name in array array[
    'operators','exchange_accounts','trading_engines','account_quote_caps',
    'robot_v1_live_runs','robot_v1_live_slots','robot_v1_live_orders',
    'robot_v1_live_fills','robot_v1_live_events','robot_v1_live_alerts',
    'robot_v1_live_slot_accounts','robot_v1_live_preparations',
    'robot_v1_testnet_runs','robot_v1_testnet_slots','robot_v1_testnet_orders',
    'robot_v1_testnet_events','robot_v1_configs','robot_v1_cycles',
    'robot_v1_slots','robot_v1_slot_accounts','robot_v1_slot_operations',
    'robot_v1_manual_adjustments','robot_v1_monthly_slot_gains',
    'robot_v1_ath_profiles','robot_v1_ath_events'
  ] loop
    execute format('create trigger zz_automation_refresh after insert or update or delete on coinops.%I
      for each row execute function private.coinops_emit_automation_refresh()',table_name);
  end loop;
end $$;

alter publication supabase_realtime add table coinops.automation_refresh_signals;
comment on table coinops.automation_refresh_signals is
  'Read-only invalidation keys only; never credentials, order contents, or financial values.';
commit;

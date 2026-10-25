-- Owner-authorized maintenance only. No exchange I/O, order/slot/fill mutation,
-- fake reconciliation or generic shard reassignment API.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

alter table coinops.robot_v1_live_runs drop constraint robot_v1_live_runs_status_check;
alter table coinops.robot_v1_live_runs add constraint robot_v1_live_runs_status_check
  check(status in('PREPARING','ACTIVE','PAUSED','COMPLETED','OFFBOARDED'));

create table coinops.engine_handoffs (
  id uuid primary key,
  product_id uuid not null, tenant_id uuid not null, user_id uuid not null,
  operator_id uuid not null, exchange_account_id uuid not null, trading_engine_id uuid not null,
  quote_asset text not null, environment text not null check(environment='REAL'),
  run_id uuid not null references coinops.robot_v1_live_runs(id),
  kind text not null check(kind in('CLIENT_MANAGED','SHARD_MIGRATION')),
  source_shard_id text not null references coinops.executor_shards(id),
  target_shard_id text references coinops.executor_shards(id),
  phase text not null check(phase in('PREPARED','COMMITTING','COMMITTED')),
  before_snapshot jsonb not null, before_sha256 text not null check(before_sha256~'^[a-f0-9]{64}$'),
  proof jsonb, commit_txid bigint, created_at timestamptz not null default now(),
  committed_at timestamptz,
  foreign key(trading_engine_id,operator_id,exchange_account_id)
    references coinops.trading_engines(id,operator_id,exchange_account_id),
  check((kind='CLIENT_MANAGED' and target_shard_id is null)
    or(kind='SHARD_MIGRATION' and target_shard_id is not null and target_shard_id<>source_shard_id))
);
create unique index engine_handoff_one_pending on coinops.engine_handoffs(trading_engine_id)
  where phase<>'COMMITTED';
alter table coinops.engine_handoffs enable row level security;
alter table coinops.engine_handoffs force row level security;
revoke all on coinops.engine_handoffs from public,anon,authenticated,service_role;
grant select on coinops.engine_handoffs to service_role,authenticated;
create policy engine_handoff_owner_read on coinops.engine_handoffs for select to authenticated
  using(user_id=(select auth.uid()));

create function private.coinops_handoff_snapshot(p_engine uuid) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('engine',to_jsonb(e)-'updated_at',
    'run',to_jsonb(r)-array['lease_owner','lease_until','updated_at'],
    'preparation',(select to_jsonb(p) from coinops.robot_v1_live_preparations p where p.trading_engine_id=e.id),
    'slots',coalesce((select jsonb_agg(to_jsonb(s) order by s.slot_number) from coinops.robot_v1_live_slots s where s.run_id=r.id),'[]'),
    'accounts',coalesce((select jsonb_agg(to_jsonb(a) order by a.slot_number) from coinops.robot_v1_live_slot_accounts a where a.trading_engine_id=e.id),'[]'),
    'orders',coalesce((select jsonb_agg(to_jsonb(o) order by o.id) from coinops.robot_v1_live_orders o where o.run_id=r.id),'[]'),
    'fills',coalesce((select jsonb_agg(to_jsonb(f) order by f.id) from coinops.robot_v1_live_fills f
      join coinops.robot_v1_live_orders o on o.id=f.order_id where o.run_id=r.id),'[]'))
  from coinops.trading_engines e join lateral(select * from coinops.robot_v1_live_runs x
    where x.trading_engine_id=e.id order by x.created_at desc,x.id desc limit 1)r on true where e.id=p_engine
$$;
revoke all on function private.coinops_handoff_snapshot(uuid) from public,anon,authenticated,service_role;

create function coinops.prepare_engine_handoff(p_request uuid,p_engine uuid,p_kind text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e coinops.trading_engines%rowtype; r coinops.robot_v1_live_runs%rowtype;
  h coinops.engine_handoffs%rowtype; snap jsonb; target text;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','')<>'service_role'
    or p_request is null then raise exception 'COINOPS_HANDOFF_SCOPE_DENIED'; end if;
  select * into h from coinops.engine_handoffs where id=p_request for update;
  if found then
    if h.trading_engine_id<>p_engine or h.kind<>p_kind then raise exception 'COINOPS_HANDOFF_REQUEST_COLLISION'; end if;
    return to_jsonb(h);
  end if;
  select * into strict e from coinops.trading_engines where id=p_engine for update;
  -- Explicitly approved identities; not automatic fleet rebalancing/offboarding.
  if e.operator_id<>'d508bb3e-5a1d-4579-bd7a-de171c118d25' or e.environment<>'REAL'
    or e.status<>'ACTIVE' or e.strategy_config_pending or e.slot_count<>25 or e.legacy_compatible then
    raise exception 'COINOPS_HANDOFF_SCOPE_DENIED'; end if;
  if p_kind='CLIENT_MANAGED' and e.executor_shard_id='executor-02'
    and (e.id='b08b6f73-6fc2-485d-a949-5f77ce651c17' and e.exchange_account_id='c1a0e4d2-8c8f-421d-8fb4-5ddd26e606c3'
      or e.id='755cf77f-a517-4c84-ac4b-6ee041ed1123' and e.exchange_account_id='ffd5dceb-5cce-4504-921b-6ec0f9a37df1') then target:=null;
  elsif p_kind='SHARD_MIGRATION' and e.executor_shard_id='executor-03'
    and e.exchange_account_id='95c95966-b92e-4e22-ac03-32a3f1d0bc1b'
    and e.id in('8464c3b3-62ac-4a52-b2f1-c4bf4bd6ed36','b4d30a96-71a3-4e44-a633-13bc419be7e1') then target:='executor-02';
  else raise exception 'COINOPS_HANDOFF_SCOPE_DENIED'; end if;
  select * into strict r from coinops.robot_v1_live_runs where trading_engine_id=e.id and status in('ACTIVE','PAUSED') for update;
  if r.operator_id<>e.operator_id or r.exchange_account_id<>e.exchange_account_id
    or r.last_error is not null or r.last_reconciled_at is null or r.last_reconciled_at<now()-interval '150 seconds'
    or r.lease_until>=now() or (p_kind='CLIENT_MANAGED' and (r.status<>'PAUSED' or not e.kill_switch)) then
    raise exception 'COINOPS_HANDOFF_BUSY_OR_UNSAFE'; end if;
  if exists(select 1 from coinops.robot_v1_live_orders o where o.run_id=r.id
      and (o.status not in('NEW','FILLED','CANCELED','EXPIRED','REJECTED','EXPIRED_IN_MATCH')
        or o.executed_quantity>0 and not coalesce(o.trades_reconciled,false)
        or p_kind='CLIENT_MANAGED' and o.side='BUY' and o.status='NEW'))
    or exists(select 1 from coinops.robot_v1_live_alerts a where a.trading_engine_id=e.id
      and a.resolved_at is null and a.severity='CRITICAL')
    or exists(select 1 from coinops.strategy_bulk_engine_updates u where u.trading_engine_id=e.id
      and u.status in('PENDING','APPLYING','BLOCKED_SAFE'))
    or exists(select 1 from coinops.account_order_budget_reservations b where b.trading_engine_id=e.id and b.acknowledged_at is null)
    or exists(select 1 from coinops.robot_v1_strategy_decisions d where d.trading_engine_id=e.id and d.environment='REAL'
      and d.action_type in('OPEN_INITIAL_MARKET','CREATE_TP','ARM_NEXT_BUY','CANCEL_REPLACE_NEXT_BUY')
      and d.result is distinct from 'COMPLETED') then raise exception 'COINOPS_HANDOFF_UNSETTLED'; end if;
  snap:=private.coinops_handoff_snapshot(e.id);
  if jsonb_array_length(snap->'slots')<>e.slot_count or jsonb_array_length(snap->'accounts')<>e.slot_count
    or (select count(distinct (s->>'slot_number')::integer) from jsonb_array_elements(snap->'slots')s
      where (s->>'slot_number')::integer between 1 and e.slot_count)<>e.slot_count then raise exception 'COINOPS_HANDOFF_LEDGER_INCOMPLETE'; end if;
  update coinops.robot_v1_live_runs set lease_owner=p_request,lease_until=now()+interval '3 minutes' where id=r.id;
  insert into coinops.engine_handoffs(id,product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,
    quote_asset,environment,run_id,kind,source_shard_id,target_shard_id,phase,before_snapshot,before_sha256)
  values(p_request,r.product_id,r.tenant_id,r.user_id,e.operator_id,e.exchange_account_id,e.id,e.quote_asset,'REAL',r.id,
    p_kind,e.executor_shard_id,target,'PREPARED',snap,encode(sha256(convert_to(snap::text,'UTF8')),'hex')) returning * into h;
  return to_jsonb(h);
end $$;

create function coinops.renew_engine_handoff(p_request uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare changed integer;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','')<>'service_role' then
    raise exception 'COINOPS_HANDOFF_SCOPE_DENIED'; end if;
  update coinops.robot_v1_live_runs r set lease_until=now()+interval '3 minutes'
    from coinops.engine_handoffs h where h.id=p_request and h.phase='PREPARED' and r.id=h.run_id
      and r.lease_owner=p_request and r.lease_until>now();
  get diagnostics changed=row_count; return changed=1;
end $$;

-- Preserve the namespace guard. Only this exact transaction's checked handoff
-- can change a shard; no trigger disabling or caller-set bypass flag.
create or replace function private.coinops_engine_shard_immutable() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='UPDATE' and (new.id is distinct from old.id or new.operator_id is distinct from old.operator_id
    or new.exchange_account_id is distinct from old.exchange_account_id or new.environment is distinct from old.environment
    or new.symbol is distinct from old.symbol or new.quote_asset is distinct from old.quote_asset
    or new.base_asset is distinct from old.base_asset or new.legacy_compatible is distinct from old.legacy_compatible) then
    raise exception 'COINOPS_ORDER_NAMESPACE_IMMUTABLE'; end if;
  if tg_op='UPDATE' and new.executor_shard_id is distinct from old.executor_shard_id
    and not exists(select 1 from coinops.engine_handoffs h where h.trading_engine_id=old.id
      and h.operator_id=old.operator_id and h.exchange_account_id=old.exchange_account_id
      and h.kind='SHARD_MIGRATION' and h.phase='COMMITTING' and h.commit_txid=txid_current()
      and h.source_shard_id=old.executor_shard_id and h.target_shard_id=new.executor_shard_id) then
    raise exception 'COINOPS_ENGINE_SHARD_IMMUTABLE'; end if;
  if tg_op='INSERT' and new.executor_shard_id is null then
    select a.executor_shard_id into new.executor_shard_id from coinops.exchange_accounts a
      where a.id=new.exchange_account_id and a.operator_id=new.operator_id; end if;
  return new;
end $$;
revoke all on function private.coinops_engine_shard_immutable() from public,anon,authenticated,service_role;

-- Keep the pre-existing never-traded staged capability. The only additional
-- exception is the fully checked Samya handoff, in this transaction, after all
-- operational engines already point to the same destination.
create or replace function private.coinops_primary_shard_immutable() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.executor_shard_id is distinct from old.executor_shard_id and not (
    (old.status='INACTIVE' and old.kill_switch and not old.is_legacy_default
      and new.status=old.status and new.kill_switch=old.kill_switch
      and new.operator_id=old.operator_id and new.credential_ref is not distinct from old.credential_ref
      and exists(select 1 from private.coinops_staged_shard_move_capabilities c
        where c.account_id=old.id and c.from_shard=old.executor_shard_id
          and c.to_shard=new.executor_shard_id and c.transaction_id=txid_current()))
    or (old.id='95c95966-b92e-4e22-ac03-32a3f1d0bc1b'
      and to_jsonb(new)-array['executor_shard_id','updated_at'] = to_jsonb(old)-array['executor_shard_id','updated_at']
      and exists(select 1 from coinops.engine_handoffs h where h.exchange_account_id=old.id
        and h.operator_id=old.operator_id and h.kind='SHARD_MIGRATION' and h.phase='COMMITTING'
        and h.commit_txid=txid_current() and h.source_shard_id=old.executor_shard_id and h.target_shard_id=new.executor_shard_id)
      and not exists(select 1 from coinops.trading_engines e where e.exchange_account_id=old.id
        and e.environment='REAL' and e.status='ACTIVE' and e.executor_shard_id<>new.executor_shard_id))
  ) then raise exception 'COINOPS_SHARD_REASSIGNMENT_FORBIDDEN'; end if;
  if old.onboarding_environment is not null and new.onboarding_environment is distinct from old.onboarding_environment then
    raise exception 'COINOPS_ADMIN_ENVIRONMENT_MISMATCH'; end if;
  return new;
end $$;
revoke all on function private.coinops_primary_shard_immutable() from public,anon,authenticated,service_role;

create function coinops.commit_engine_handoff(p_request uuid,p_proof jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare h coinops.engine_handoffs%rowtype; r coinops.robot_v1_live_runs%rowtype;
  snap jsonb; admission jsonb;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','')<>'service_role' then
    raise exception 'COINOPS_HANDOFF_SCOPE_DENIED'; end if;
  select * into strict h from coinops.engine_handoffs where id=p_request for update;
  if h.phase='COMMITTED' then
    if h.proof is distinct from p_proof then raise exception 'COINOPS_HANDOFF_REPLAY_MISMATCH'; end if;
    return jsonb_build_object('status','COMMITTED','replayed',true); end if;
  perform 1 from coinops.trading_engines where id=h.trading_engine_id for update;
  select * into strict r from coinops.robot_v1_live_runs where id=h.run_id for update;
  if r.lease_owner is distinct from h.id or r.lease_until is null or r.lease_until<now() then raise exception 'COINOPS_HANDOFF_LEASE_LOST'; end if;
  snap:=private.coinops_handoff_snapshot(h.trading_engine_id);
  if snap is distinct from h.before_snapshot then raise exception 'COINOPS_HANDOFF_SNAPSHOT_CHANGED'; end if;
  if p_proof->>'contract' is distinct from 'CONTROLLED_HANDOFF_V1'
    or p_proof->>'engine_id' is distinct from h.trading_engine_id::text
    or p_proof->>'run_id' is distinct from h.run_id::text
    or p_proof->>'snapshot_sha256' is distinct from h.before_sha256
    or p_proof->>'source_shard' is distinct from h.source_shard_id
    or p_proof->>'source_write_fenced' is distinct from 'true'
    or p_proof->>'binance_ledger_match' is distinct from 'true'
    or p_proof->>'pending_claims' is distinct from '0'
    or (p_proof->>'observed_at')::timestamptz<now()-interval '90 seconds'
    or (p_proof->>'observed_at')::timestamptz>now()+interval '5 seconds'
    or p_proof->>'observed_at' is null then raise exception 'COINOPS_HANDOFF_PROOF_UNPROVEN'; end if;
  if h.kind='CLIENT_MANAGED' then
    if p_proof->>'client_assumes_management' is distinct from 'true' then raise exception 'COINOPS_HANDOFF_CLIENT_ACK_REQUIRED'; end if;
    update coinops.trading_engines set status='DISABLED',kill_switch=true where id=h.trading_engine_id;
    update coinops.robot_v1_live_preparations set live_enabled=false,kill_switch=true where trading_engine_id=h.trading_engine_id;
    update coinops.robot_v1_live_runs set status='OFFBOARDED',lease_owner=null,lease_until=null where id=h.run_id;
    update coinops.exchange_accounts set status='DISABLED',kill_switch=true where id=h.exchange_account_id
      and not exists(select 1 from coinops.trading_engines where exchange_account_id=h.exchange_account_id and status='ACTIVE');
  else
    if p_proof->>'source_process_stopped' is distinct from 'true'
      or p_proof->>'target_read_proven' is distinct from 'true'
      or p_proof->>'target_shard' is distinct from h.target_shard_id then raise exception 'COINOPS_HANDOFF_DESTINATION_UNPROVEN'; end if;
    perform 1 from coinops.exchange_accounts where id=h.exchange_account_id for update;
    perform 1 from coinops.executor_shards where id=h.target_shard_id and enabled for update;
    if not found then raise exception 'COINOPS_HANDOFF_DESTINATION_UNPROVEN'; end if;
    if not exists(select 1 from coinops.account_executor_connections c join coinops.executor_shards s on s.id=c.executor_shard_id
      join coinops.binance_account_identity_bindings b on b.exchange_account_id=c.exchange_account_id and b.operator_id=c.operator_id and b.environment=c.environment
      where c.exchange_account_id=h.exchange_account_id and c.operator_id=h.operator_id and c.executor_shard_id=h.target_shard_id
      and c.environment='REAL' and c.status='VALIDATED' and c.validation_evidence->>'status'='PASS'
      and c.validation_evidence->>'executor_ip'=host(s.egress_ipv4)
      and c.checked_at>now()-interval '30 minutes') then raise exception 'COINOPS_HANDOFF_CREDENTIAL_UNPROVEN'; end if;
    admission:=coinops.preview_engine_slot_admission(h.target_shard_id,'REAL',array[25],h.trading_engine_id);
    if admission->>'code' is distinct from 'CAPACITY_OK' then raise exception 'COINOPS_HANDOFF_CAPACITY_REQUIRED'; end if;
    update coinops.engine_handoffs set phase='COMMITTING',commit_txid=txid_current() where id=h.id;
    update coinops.trading_engines set executor_shard_id=h.target_shard_id where id=h.trading_engine_id;
    insert into coinops.executor_capacity_admissions(engine_id,shard_id,environment,reserved_weight,expires_at)
      values(h.trading_engine_id,h.target_shard_id,'REAL',(coinops.executor_capacity_policy()->>'incremental_weight')::numeric,now()+interval '20 minutes')
      on conflict(engine_id) do update set shard_id=excluded.shard_id,reserved_weight=excluded.reserved_weight,reserved_at=now(),expires_at=excluded.expires_at;
    -- Bootstrap is compatibility only, but must not route account diagnostics
    -- to a retired server once every engine has migrated to the same target.
    update coinops.exchange_accounts set executor_shard_id=h.target_shard_id where id=h.exchange_account_id
      and not exists(select 1 from coinops.trading_engines where exchange_account_id=h.exchange_account_id
        and environment='REAL' and status='ACTIVE' and executor_shard_id<>h.target_shard_id);
  end if;
  insert into coinops.robot_v1_live_events(product_id,tenant_id,user_id,operator_id,exchange_account_id,trading_engine_id,quote_asset,
    run_id,event_key,event_type,details)
    values(h.product_id,h.tenant_id,h.user_id,h.operator_id,h.exchange_account_id,h.trading_engine_id,h.quote_asset,
      h.run_id,'HANDOFF:'||h.id,h.kind,jsonb_build_object('handoff_id',h.id,'source_shard',h.source_shard_id,
        'target_shard',h.target_shard_id,'snapshot_sha256',h.before_sha256,'proof',p_proof));
  update coinops.engine_handoffs set phase='COMMITTED',proof=p_proof,committed_at=now() where id=h.id;
  return jsonb_build_object('status','COMMITTED','replayed',false);
end $$;

revoke all on function coinops.prepare_engine_handoff(uuid,uuid,text),coinops.renew_engine_handoff(uuid),
  coinops.commit_engine_handoff(uuid,jsonb) from public,anon,authenticated;
grant execute on function coinops.prepare_engine_handoff(uuid,uuid,text),coinops.renew_engine_handoff(uuid),
  coinops.commit_engine_handoff(uuid,jsonb) to service_role;
commit;

-- max_order_notional_quote is GENERATED ALWAYS AS (max_order_notional_brl).
-- Preserve that schema contract; update only the canonical stored column.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
-- Risk metadata only: no cash, position, gain, strategy or total cap changes.
create or replace function coinops.align_live_recovery_order_cap(p_run_id uuid,p_slot_id uuid,
 p_expected_cap numeric,p_target_cap numeric,p_engine_cap numeric,p_account_cap numeric,p_lease_owner uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare r coinops.robot_v1_live_runs%rowtype;e coinops.trading_engines%rowtype;
 p coinops.robot_v1_live_preparations%rowtype;s coinops.robot_v1_live_slots%rowtype;
 a coinops.robot_v1_live_slot_accounts%rowtype;c coinops.account_quote_caps%rowtype;
 auth jsonb;period text;key text;v_details jsonb;
begin
 select *into strict r from coinops.robot_v1_live_runs where id=p_run_id for update;
 select *into strict e from coinops.trading_engines where id=r.trading_engine_id for update;
 select *into strict c from coinops.account_quote_caps where exchange_account_id=r.exchange_account_id and quote_asset=r.quote_asset for share;
 select *into strict p from coinops.robot_v1_live_preparations where trading_engine_id=e.id and asset=r.asset for update;
 select *into strict s from coinops.robot_v1_live_slots where id=p_slot_id and run_id=r.id for update;
 select *into strict a from coinops.robot_v1_live_slot_accounts where trading_engine_id=e.id and asset=r.asset and slot_number=s.slot_number for share;
 auth:=r.config_snapshot->'market_entry_authorization';period:=to_char(now()at time zone'America/Campo_Grande','YYYY-MM');
 if p_lease_owner is null or r.lease_owner is distinct from p_lease_owner or r.lease_until is null or r.lease_until<=now()
  or r.status<>'ACTIVE' or r.last_error is not null or e.status<>'ACTIVE' or e.environment<>'REAL'
  or e.kill_switch is distinct from false or e.strategy_config_pending
  or p.live_enabled is distinct from true or p.kill_switch is distinct from false or p.compounding_enabled is distinct from true
  or e.symbol<>r.symbol or p.symbol<>r.symbol or p.slot_count is distinct from e.slot_count or r.slot_count is distinct from e.slot_count
  or e.operator_id<>r.operator_id or e.exchange_account_id<>r.exchange_account_id
  or p.product_id<>r.product_id or p.tenant_id<>r.tenant_id or p.user_id<>r.user_id
  or p.operator_id<>r.operator_id or p.exchange_account_id<>r.exchange_account_id
  or s.trading_engine_id<>e.id or s.operator_id<>r.operator_id or s.exchange_account_id<>r.exchange_account_id
  or s.product_id<>r.product_id or s.tenant_id<>r.tenant_id or s.user_id<>r.user_id
  or a.product_id<>r.product_id or a.tenant_id<>r.tenant_id or a.user_id<>r.user_id
  or a.operator_id<>r.operator_id or a.exchange_account_id<>r.exchange_account_id
  or c.operator_id<>r.operator_id or c.hard_cap_quote is distinct from p_account_cap
  or e.hard_cap_quote is distinct from p_engine_cap or p.max_total_exposure_brl>e.hard_cap_quote
  or p_target_cap is null or p_expected_cap is null or p_expected_cap<=0 or p_target_cap<=p_expected_cap
  or p_target_cap::text in('NaN','Infinity','-Infinity') or p_expected_cap::text in('NaN','Infinity','-Infinity')
  or p_target_cap>e.hard_cap_quote or p_target_cap>p.max_total_exposure_brl
  or s.entry_state<>'MISSED' or s.position_quantity<>0 or s.position_committed_brl<>0 or s.missed_at is null
  or a.balance_brl is distinct from p_target_cap or a.contribution_brl<=0 or a.market_pnl_brl<=0
  or a.manual_gain_brl<>0 or a.dust_quantity<>0 or a.gain_count<=0
  or a.balance_brl<>round(a.contribution_brl+a.market_pnl_brl-a.fees_brl,8)
  or coalesce(auth->>'policy','')<>'PRIORITY_MISSED_MARKET_V1'
  or coalesce(auth->>'recovery_priority','')<>'EXPLICIT_OPERATION_V1'
  or auth->>'run_id' is distinct from r.id::text or auth->>'engine_id' is distinct from e.id::text
  or auth->>'slot_id' is distinct from s.id::text or (auth->>'operation_sequence')::int is distinct from s.operation_sequence
  or (auth->>'slot_number')::int is distinct from s.slot_number or auth->>'period' is distinct from period
  or (auth->>'source_missed_at')::timestamptz is distinct from s.missed_at
  or (auth->>'quote_cap')::numeric is distinct from p_target_cap
  or not exists(select 1 from coinops.robot_v1_live_events ev where ev.run_id=r.id and ev.trading_engine_id=e.id
    and ev.slot_number=s.slot_number and ev.event_key=auth->>'authorization_event_key'
    and ev.event_type='MISSED_MARKET_ENTRY_REQUESTED' and ev.details=auth)
  or exists(select 1 from coinops.robot_v1_live_orders o where o.run_id=r.id and o.slot_id=s.id
    and o.operation_sequence=s.operation_sequence and(o.status in('PREPARED','NEW','PARTIALLY_FILLED')or o.executed_quantity>0 or not o.trades_reconciled))
  or exists(select 1 from coinops.robot_v1_live_alerts al where al.trading_engine_id=e.id and al.severity='CRITICAL'and al.resolved_at is null)
  or exists(select 1 from coinops.operators op where op.id=r.operator_id and(op.kill_switch or op.status<>'ACTIVE'))
  or exists(select 1 from coinops.exchange_accounts ac where ac.id=r.exchange_account_id and(ac.kill_switch or ac.status<>'ACTIVE'))
 then raise exception 'COINOPS_RECOVERY_ORDER_CAP_UNPROVEN';end if;
 key:='RECOVERY_ORDER_CAP_ALIGNED:'||s.id||':'||s.operation_sequence||':'||period;
 v_details:=jsonb_build_object('slot_id',s.id,'operation_sequence',s.operation_sequence,'old_order_cap',p_expected_cap,
  'new_order_cap',p_target_cap,'engine_cap_unchanged',p_engine_cap,'account_cap_unchanged',p_account_cap,
  'authorization_event_key',auth->>'authorization_event_key');
 if exists(select 1 from coinops.robot_v1_live_events ev where ev.run_id=r.id and ev.event_key=key)then
  if p.max_order_notional_brl=p_target_cap and (e.config->>'max_order_quote')::numeric=p_target_cap
   and exists(select 1 from coinops.robot_v1_live_events ev where ev.run_id=r.id and ev.event_key=key and ev.details=v_details)
  then return v_details;end if;
  raise exception 'COINOPS_RECOVERY_ORDER_CAP_READBACK_MISMATCH';
 end if;
 if p.max_order_notional_brl is distinct from p_expected_cap or (e.config->>'max_order_quote')::numeric is not null
   and(e.config->>'max_order_quote')::numeric<>p_expected_cap then raise exception 'COINOPS_RECOVERY_ORDER_CAP_STALE';end if;
 update coinops.robot_v1_live_preparations set max_order_notional_brl=p_target_cap,
  config_version=config_version+1,updated_at=now()where id=p.id;
 update coinops.trading_engines set config=coalesce(config,'{}'::jsonb)||jsonb_build_object('max_order_quote',p_target_cap),updated_at=now()where id=e.id;
 insert into coinops.robot_v1_live_events(run_id,product_id,tenant_id,user_id,operator_id,exchange_account_id,
  trading_engine_id,quote_asset,event_key,event_type,slot_number,details)
 values(r.id,r.product_id,r.tenant_id,r.user_id,r.operator_id,r.exchange_account_id,e.id,r.quote_asset,key,
  'RECOVERY_ORDER_CAP_ALIGNED',s.slot_number,v_details);
 return v_details;
end $$;
revoke all on function coinops.align_live_recovery_order_cap(uuid,uuid,numeric,numeric,numeric,numeric,uuid)from public,anon,authenticated;
grant execute on function coinops.align_live_recovery_order_cap(uuid,uuid,numeric,numeric,numeric,numeric,uuid)to service_role;
commit;

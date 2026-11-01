-- Explicit, single-operation rescue of a terminal tiny partial BUY. No trading
-- occurs in this migration. Existing positions, caps and strategies are kept.
begin;
set local lock_timeout='3s';set local statement_timeout='30s';
alter table coinops.robot_v1_live_orders drop constraint robot_v1_live_order_request;
alter table coinops.robot_v1_live_orders add constraint robot_v1_live_order_request check
 ((purpose='INITIAL'and requested_quote>0 and requested_quantity is null and price is null)
 or(purpose in('ENTRY','TP')and requested_quote is null and requested_quantity>0 and price>0)
 or(side='BUY'and purpose='ENTRY'and requested_quote>0 and requested_quantity is null and price is null
  and(config_snapshot@>'{"market_entry_intent":{"policy":"PRIORITY_MISSED_MARKET_V1"}}'::jsonb
   or config_snapshot@>'{"partial_entry_recovery_intent":{"policy":"ORPHANED_PARTIAL_RECOVERY_V1"}}'::jsonb)));

create function coinops.authorized_partial_entry_recovery(p_order_id uuid,p_lease_owner uuid)
returns boolean language sql security invoker set search_path='' as $$
 select coalesce((select
  r.status='ACTIVE'and r.lease_owner=p_lease_owner and r.lease_until>clock_timestamp()
  and(r.last_error is null or r.last_error='COINOPS_LIVE_TP_FILTER_UNPROTECTABLE')
  and e.environment='REAL'and e.status='ACTIVE'and e.kill_switch and not e.strategy_config_pending
  and p.live_enabled and p.kill_switch and p.slot_count=e.slot_count and r.slot_count=e.slot_count
  and ac.status='ACTIVE'and not ac.kill_switch and op.status='ACTIVE'and not op.kill_switch
  and o.side='BUY'and o.purpose='ENTRY'and o.status='PREPARED'and o.executed_quantity=0
  and o.requested_quantity is null and o.price is null and o.requested_quote>0
  and o.requested_quote::text not in('NaN','Infinity','-Infinity')
  and o.config_snapshot->'partial_entry_recovery_intent'=r.config_snapshot->'partial_entry_recovery_authorization'
  and a.j->>'policy'='ORPHANED_PARTIAL_RECOVERY_V1'
  and a.j->>'run_id'=r.id::text and a.j->>'engine_id'=e.id::text and a.j->>'slot_id'=s.id::text
  and(a.j->>'slot_number')::integer=s.slot_number and(a.j->>'operation_sequence')::integer=s.operation_sequence
  and(a.j->>'quote')::numeric=o.requested_quote and(a.j->>'slot_balance')::numeric=sa.balance_brl
  and(a.j->>'gain_rate')::numeric=r.gain_rate and(a.j->>'spacing')::numeric=r.entry_spacing
  and(a.j->>'authorized_at')::timestamptz<=clock_timestamp()+interval '2 seconds'
  and(a.j->>'authorized_at')::timestamptz>=clock_timestamp()-interval '30 minutes'
  and s.entry_state='OPEN'and s.operation_sequence=o.operation_sequence
  and s.position_quantity=src.executed_quantity-src.fee_base
  and s.position_committed_brl=(a.j->>'source_committed')::numeric
  and src.run_id=r.id and src.slot_id=s.id and src.operation_sequence=s.operation_sequence
  and src.side='BUY'and src.status in('CANCELED','EXPIRED','EXPIRED_IN_MATCH')and src.trades_reconciled
  and src.requested_quantity>src.executed_quantity and src.executed_quantity>0
  and src.client_order_id=a.j->>'source_client_order_id'and src.exchange_order_id=a.j->>'source_exchange_order_id'
  and src.executed_quantity=(a.j->>'source_quantity')::numeric and src.fee_base=(a.j->>'source_fee_base')::numeric
  and src.cumulative_quote=(a.j->>'source_quote')::numeric
  and src.cumulative_quote=(select coalesce(sum(f.quote_quantity),0)from coinops.robot_v1_live_fills f where f.order_id=src.id)
  and src.executed_quantity=(select coalesce(sum(f.quantity),0)from coinops.robot_v1_live_fills f where f.order_id=src.id)
  and s.position_committed_brl=src.cumulative_quote+(select coalesce(sum(f.commission_brl),0)
    from coinops.robot_v1_live_fills f where f.order_id=src.id and f.commission_asset in(r.quote_asset,'BNB'))
  and s.position_committed_brl+o.requested_quote<=sa.balance_brl
  and o.requested_quote<=p.max_order_notional_brl and p.max_total_exposure_brl<=e.hard_cap_quote
  and e.hard_cap_quote<=cap.hard_cap_quote
  and al.alert_key=a.j->>'incident_key'and al.first_seen_at=(a.j->>'incident_first_seen_at')::timestamptz
  and al.code='COINOPS_LIVE_TP_FILTER_UNPROTECTABLE'and al.resolved_at is null and al.severity='CRITICAL'
  and al.details->>'root_code'=al.code and al.details->>'stage'='PROTECT_TP'
  and exists(select 1 from coinops.robot_v1_live_events ev where ev.run_id=r.id and ev.trading_engine_id=e.id
    and ev.slot_number=s.slot_number and ev.event_key=a.j->>'authorization_event_key'
    and ev.event_type='PARTIAL_ENTRY_RECOVERY_REQUESTED'and ev.details=a.j)
  and not exists(select 1 from coinops.robot_v1_live_orders other where other.run_id=r.id and other.slot_id=s.id
    and other.operation_sequence=s.operation_sequence and other.id not in(src.id,o.id)
    and(other.side<>'BUY'or other.executed_quantity>0 or other.status in('PREPARED','NEW','PARTIALLY_FILLED')or not other.trades_reconciled))
  and not exists(select 1 from coinops.robot_v1_live_orders other where other.run_id=r.id
    and other.side='BUY'and other.status in('PREPARED','NEW','PARTIALLY_FILLED')and other.id<>o.id)
  and not exists(select 1 from coinops.robot_v1_live_alerts other where other.trading_engine_id=e.id
    and other.severity='CRITICAL'and other.resolved_at is null and other.id<>al.id)
 from coinops.robot_v1_live_orders o
 join coinops.robot_v1_live_runs r on r.id=o.run_id and r.trading_engine_id=o.trading_engine_id
 join coinops.trading_engines e on e.id=r.trading_engine_id and e.exchange_account_id=r.exchange_account_id and e.operator_id=r.operator_id
 join coinops.robot_v1_live_preparations p on p.trading_engine_id=e.id and p.asset=r.asset
 join coinops.robot_v1_live_slots s on s.id=o.slot_id and s.run_id=r.id and s.trading_engine_id=e.id
 join coinops.robot_v1_live_slot_accounts sa on sa.trading_engine_id=e.id and sa.asset=r.asset and sa.slot_number=s.slot_number
 join coinops.exchange_accounts ac on ac.id=e.exchange_account_id and ac.operator_id=e.operator_id
 join coinops.operators op on op.id=e.operator_id
 join coinops.account_quote_caps cap on cap.exchange_account_id=ac.id and cap.quote_asset=r.quote_asset
 cross join lateral(select r.config_snapshot->'partial_entry_recovery_authorization'j)a
 join coinops.robot_v1_live_orders src on src.id=(a.j->>'source_order_id')::uuid
 join coinops.robot_v1_live_alerts al on al.trading_engine_id=e.id and al.exchange_account_id=ac.id
   and al.alert_key=a.j->>'incident_key'
 where o.id=p_order_id),false)
$$;
revoke all on function coinops.authorized_partial_entry_recovery(uuid,uuid)from public,anon,authenticated;
grant execute on function coinops.authorized_partial_entry_recovery(uuid,uuid)to service_role;

create function coinops.prepare_live_partial_entry_recovery(p_run_id uuid,p_slot_id uuid,p_revision integer,
 p_client_order_id text,p_decision_id text,p_lease_owner uuid)
returns coinops.robot_v1_live_orders language plpgsql security invoker set search_path='' as $$
declare r coinops.robot_v1_live_runs%rowtype;e coinops.trading_engines%rowtype;s coinops.robot_v1_live_slots%rowtype;
 o coinops.robot_v1_live_orders%rowtype;p coinops.robot_v1_live_preparations%rowtype;
 cap coinops.account_quote_caps%rowtype;a jsonb;engine_exposure numeric;account_exposure numeric;
begin
 select *into strict r from coinops.robot_v1_live_runs where id=p_run_id for update;
 select *into strict e from coinops.trading_engines where id=r.trading_engine_id for share;
 select *into strict cap from coinops.account_quote_caps where exchange_account_id=r.exchange_account_id and quote_asset=r.quote_asset for update;
 select *into strict p from coinops.robot_v1_live_preparations where trading_engine_id=e.id and asset=r.asset for share;
 select *into strict s from coinops.robot_v1_live_slots where id=p_slot_id and run_id=r.id for update;
 a:=r.config_snapshot->'partial_entry_recovery_authorization';
 if p_lease_owner is null or r.lease_owner is distinct from p_lease_owner or r.lease_until is null or r.lease_until<=clock_timestamp()
   or r.status<>'ACTIVE'then raise exception 'COINOPS_PARTIAL_RECOVERY_LEASE_UNPROVEN';end if;
 select *into o from coinops.robot_v1_live_orders where client_order_id=p_client_order_id;
 if found then
  if(o.run_id,o.slot_id,o.operation_sequence,o.side,o.purpose,o.revision,o.strategy_decision_id,o.requested_quote)
   is distinct from(r.id,s.id,s.operation_sequence,'BUY','ENTRY',p_revision,p_decision_id,(a->>'quote')::numeric)
   or o.config_snapshot->'partial_entry_recovery_intent'is distinct from a
   then raise exception 'COINOPS_PARTIAL_RECOVERY_IDENTITY_CONFLICT';end if;
  return o;
 end if;
 if p_revision<>1+(select coalesce(max(revision),0)from coinops.robot_v1_live_orders where slot_id=s.id and side='BUY')
  or p_decision_id !~ '^[a-f0-9]{64}$'
  or(case when e.legacy_compatible then p_client_order_id!~('^COR1-'||r.asset||'-'||s.slot_number||'-'||p_revision||'-BUY-[a-f0-9]{14}$')
    else p_client_order_id!~('^C2-'||substr(encode(sha256(convert_to(r.exchange_account_id::text||'|'||e.id::text,'UTF8')),'hex'),1,10)||'-'||s.slot_number||'-B-[a-f0-9]{14}$')end)
  or not exists(select 1 from coinops.robot_v1_strategy_decisions d where d.environment='REAL'and d.trading_engine_id=e.id
    and d.cycle_id=r.id and d.slot_id=s.id and d.operation_sequence=s.operation_sequence and d.decision_id=p_decision_id
    and d.action_type='OPEN_ENTRY_MARKET'and d.reason='ORPHANED_PARTIAL_RECOVERY_V1'and d.result='PENDING'
    and d.dispatched_at is null and d.exchange_ack_at is null)
 then raise exception 'COINOPS_PARTIAL_RECOVERY_DECISION_UNPROVEN';end if;
 insert into coinops.robot_v1_live_orders(run_id,slot_id,product_id,tenant_id,user_id,operator_id,exchange_account_id,
  trading_engine_id,quote_asset,slot_number,operation_sequence,side,purpose,revision,client_order_id,
  requested_quantity,requested_quote,price,reserved_notional_brl,strategy_decision_id,config_version,config_snapshot)
 values(r.id,s.id,r.product_id,r.tenant_id,r.user_id,r.operator_id,r.exchange_account_id,e.id,r.quote_asset,
  s.slot_number,s.operation_sequence,'BUY','ENTRY',p_revision,p_client_order_id,null,(a->>'quote')::numeric,null,
  (a->>'quote')::numeric,p_decision_id,r.config_version,
  (r.config_snapshot-'market_entry_intent')||jsonb_build_object('partial_entry_recovery_intent',a))returning *into o;
 if not coinops.authorized_partial_entry_recovery(o.id,p_lease_owner)then raise exception 'COINOPS_PARTIAL_RECOVERY_PREPARE_UNPROVEN';end if;
 select coalesce(sum(s2.position_committed_brl),0)into engine_exposure from coinops.robot_v1_live_slots s2
  join coinops.robot_v1_live_runs r2 on r2.id=s2.run_id where r2.trading_engine_id=e.id and r2.status in('ACTIVE','PAUSED');
 select coalesce(sum(s2.position_committed_brl),0)into account_exposure from coinops.robot_v1_live_slots s2
  join coinops.robot_v1_live_runs r2 on r2.id=s2.run_id where r2.exchange_account_id=r.exchange_account_id
  and r2.quote_asset=r.quote_asset and r2.status in('ACTIVE','PAUSED');
 select account_exposure+coalesce(sum(greatest(o2.reserved_notional_brl-o2.cumulative_quote,0)),0)into account_exposure
  from coinops.robot_v1_live_orders o2 join coinops.robot_v1_live_runs r2 on r2.id=o2.run_id
  where r2.exchange_account_id=r.exchange_account_id and r2.quote_asset=r.quote_asset and r2.status in('ACTIVE','PAUSED')
  and o2.side='BUY'and o2.status in('PREPARED','NEW','PARTIALLY_FILLED');
 if engine_exposure+o.requested_quote>p.max_total_exposure_brl or account_exposure>cap.hard_cap_quote
  then raise exception 'COINOPS_PARTIAL_RECOVERY_EXPOSURE_CAP_DENIED';end if;
 return o;
end $$;
revoke all on function coinops.prepare_live_partial_entry_recovery(uuid,uuid,integer,text,text,uuid)from public,anon,authenticated;
grant execute on function coinops.prepare_live_partial_entry_recovery(uuid,uuid,integer,text,text,uuid)to service_role;

-- Extend only the existing typed recovery exception; all parent/venue budget
-- gates remain in the canonical reservation function. Do not duplicate it.
do $patch$
declare definition text;needle text:='o.side=''BUY'' and (e.kill_switch or r.last_error is not null';
 replacement text:='o.side=''BUY'' and (((e.kill_switch or r.last_error is not null) and not coinops.authorized_partial_entry_recovery(o.id,p_lease_owner))';
begin
 select pg_get_functiondef('coinops.reserve_account_order_budget(uuid,uuid,uuid,text,uuid)'::regprocedure)into definition;
 if position(needle in definition)=0 then raise exception 'COINOPS_PARTIAL_RECOVERY_BUDGET_CONTRACT_CHANGED';end if;
 definition:=replace(definition,needle,replacement);
 -- Reuse the original BUY's still-unconsumed protective credit if it exists.
 needle:='protected:=case when o.side=''BUY'' then 1 else 0 end;';
 replacement:='protected:=case when o.side=''BUY''and not(o.config_snapshot @> ''{"partial_entry_recovery_intent":{"policy":"ORPHANED_PARTIAL_RECOVERY_V1"}}''::jsonb
  and coinops.authorized_partial_entry_recovery(o.id,p_lease_owner)
  and exists(select 1 from coinops.account_order_budget_reservations b where b.trading_engine_id=o.trading_engine_id
   and b.executor_shard_id=e.executor_shard_id and b.protection_orders>0
   and b.client_order_id=o.config_snapshot->''partial_entry_recovery_intent''->>''source_client_order_id''))then 1 else 0 end;';
 if position(needle in definition)=0 then raise exception 'COINOPS_PARTIAL_RECOVERY_CREDIT_CONTRACT_CHANGED';end if;
 execute replace(definition,needle,replacement);
end $patch$;
commit;

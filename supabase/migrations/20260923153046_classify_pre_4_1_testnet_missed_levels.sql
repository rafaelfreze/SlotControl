-- CoinOps / OnPlay Platform otdfpmsegjxpqrzisfmi / schema coinops.
-- Audit-only, additive and replay-safe. Never changes a slot, order, fill,
-- balance, gain, strategy version, permission, or manual Production operation.
do $audit$
declare
  incident record;
  tp coinops.robot_v1_testnet_events%rowtype;
  lower_buy coinops.robot_v1_testnet_events%rowtype;
  reconciled coinops.robot_v1_testnet_events%rowtype;
  first_processed coinops.robot_v1_testnet_events%rowtype;
  recovery_operation text;
  diagnosis jsonb;
  deployment_ready_at constant timestamptz := '2026-09-23T14:31:34.826Z';
  effective_at constant timestamptz := '2026-09-23T14:32:20.558Z';
begin
  perform pg_advisory_xact_lock(hashtextextended('coinops:phase_4_1_1:temporal_audit', 0));
  -- No matching historical incidents on a clean/other-scope database means no
  -- synthetic history is created. Every existing match must prove all evidence.
  for incident in
    select e.*, r.asset, proof.tp_filled_at, proof.lower_filled_at, proof.target_price
    from (values
      ('SOL', '2026-09-23T04:23:36.439Z', '2026-09-23T07:44:48.036Z', 118.97::numeric),
      ('BTC', '2026-09-23T14:01:50.234Z', '2026-09-23T14:13:24.677Z', 85480.48::numeric)
    ) as proof(asset, tp_filled_at, lower_filled_at, target_price)
    join coinops.robot_v1_testnet_runs r on r.asset=proof.asset
    join coinops.robot_v1_testnet_events e on e.run_id=r.id
      and e.event_key='SLOT_1_MISSED_2' and e.event_type='MISSED_LEVEL_DURING_REARM'
      and (e.details->>'targetPrice')::numeric=proof.target_price
      and e.observed_at between proof.lower_filled_at::timestamptz and '2026-09-23T14:33:00Z'::timestamptz
    where r.product_id='162a3e3f-d994-4e74-90db-ae666924c77f'
      and r.tenant_id='371dbf6e-2ce4-4bfe-9e15-3a25f2905607'
      and r.user_id='6ecc0b31-97f1-4cbd-890e-17863cbcd7c6'
      and (e.product_id,e.tenant_id,e.user_id)=(r.product_id,r.tenant_id,r.user_id)
      and r.asset in ('BTC','SOL') and r.symbol=r.asset || 'USDC'
  loop
    if incident.event_type <> 'MISSED_LEVEL_DURING_REARM' or incident.slot_number <> 1
      or incident.event_key <> 'SLOT_1_MISSED_2'
      or (incident.details->>'targetPrice')::numeric is distinct from incident.target_price then
      raise exception 'COINOPS_TEMPORAL_INCIDENT_IDENTITY_MISMATCH';
    end if;

    select * into strict tp from coinops.robot_v1_testnet_events
      where run_id=incident.run_id and slot_number=1 and details->>'filledAt'=incident.tp_filled_at
        and (product_id,tenant_id,user_id)=(incident.product_id,incident.tenant_id,incident.user_id)
        and event_type='TESTNET_FILL_OBSERVED' and details->>'side'='SELL'
        and details->>'timestampBasis'='EXCHANGE_TRADE_TIME';
    select * into strict lower_buy from coinops.robot_v1_testnet_events
      where run_id=incident.run_id and slot_number=2 and details->>'filledAt'=incident.lower_filled_at
        and (product_id,tenant_id,user_id)=(incident.product_id,incident.tenant_id,incident.user_id)
        and event_type='TESTNET_FILL_OBSERVED' and details->>'side'='BUY'
        and details->>'timestampBasis'='EXCHANGE_TRADE_TIME';
    select * into strict reconciled from coinops.robot_v1_testnet_events
      where run_id=incident.run_id and observed_at >= effective_at
        and (product_id,tenant_id,user_id)=(incident.product_id,incident.tenant_id,incident.user_id)
        and event_type='RECONCILED' and details->>'strategy_version'='4.1.0'
      order by observed_at limit 1;
    select * into strict first_processed from coinops.robot_v1_testnet_events
      where (product_id,tenant_id,user_id)=(incident.product_id,incident.tenant_id,incident.user_id)
        and event_type='RECONCILIATION_STARTED' and observed_at=effective_at
        and details->>'app_commit_sha'='7530824fa194fe2faf9bc87d87fa5b7c02647bf0';

    if not coalesce((tp.details->>'filledAt')::timestamptz < (lower_buy.details->>'filledAt')::timestamptz
      and (lower_buy.details->>'filledAt')::timestamptz < deployment_ready_at
      and (lower_buy.details->>'price')::numeric < incident.target_price
      and (tp.details->>'price')::numeric > incident.target_price
      and (tp.details->>'collectedAt')::timestamptz >= (tp.details->>'filledAt')::timestamptz
      and reconciled.observed_at >= effective_at, false) then
      raise exception 'COINOPS_TEMPORAL_CAUSAL_WINDOW_NOT_PROVEN';
    end if;
    if not exists (select 1 from coinops.robot_v1_testnet_orders o where o.run_id=incident.run_id
      and (o.product_id,o.tenant_id,o.user_id)=(incident.product_id,incident.tenant_id,incident.user_id)
      and o.client_order_id=tp.details->>'clientOrderId' and o.side='SELL'
      and o.exchange_order_id=tp.details->>'exchangeOrderId' and o.status='FILLED')
      or not exists (select 1 from coinops.robot_v1_testnet_orders o where o.run_id=incident.run_id
        and (o.product_id,o.tenant_id,o.user_id)=(incident.product_id,incident.tenant_id,incident.user_id)
        and o.client_order_id=lower_buy.details->>'clientOrderId' and o.side='BUY'
        and o.exchange_order_id=lower_buy.details->>'exchangeOrderId' and o.status='FILLED') then
      raise exception 'COINOPS_TEMPORAL_FILL_OWNERSHIP_NOT_PROVEN';
    end if;

    recovery_operation := null;
    select d.operation_id into recovery_operation from coinops.robot_v1_strategy_decisions d
      join coinops.robot_v1_testnet_slots s on s.id=d.slot_id and s.run_id=d.cycle_id and s.slot_number=1
      where d.environment='TESTNET' and d.cycle_id=incident.run_id and d.operation_sequence=2
        and (d.product_id,d.tenant_id,d.user_id)=(incident.product_id,incident.tenant_id,incident.user_id)
        and d.action_type='PLAN_LOCAL_REENTRY' and d.target_price=incident.target_price
        and d.created_at between (tp.details->>'collectedAt')::timestamptz and incident.observed_at
      order by d.created_at desc limit 1;
    diagnosis := jsonb_build_object(
      'original_event_id',incident.id,'original_event_type',incident.event_type,
      'original_observed_at',incident.observed_at,'original_created_at',null,
      'asset',incident.asset,'operation_sequence',2,'operation_id',recovery_operation,
      'operation_id_basis','RECOVERY_DECISION_WHEN_AVAILABLE_NOT_LEGACY_FILL_ID',
      'target_price',incident.target_price,'market_price',incident.details->'marketPrice',
      'occurred_at',tp.details->>'filledAt','occurred_at_basis','TP_FILL_UNRECONCILED_WINDOW_START',
      'occurred_by_at',lower_buy.details->>'filledAt','first_cross_at',null,
      'detected_at',coalesce(incident.details->>'detected_at',incident.observed_at::text),
      'strategy_effective_at',effective_at,'deployment_ready_at',deployment_ready_at,
      'strategy_version_at_occurrence',null,'strategy_version_at_occurrence_basis','LEGACY_PRE_4_1_NOT_PERSISTED',
      'detected_by_strategy_version',incident.details->>'strategy_version',
      'temporal_classification','HISTORICAL_PRE_4_1','is_active_issue',false,
      'root_cause','STALE_CACHED_RUN_DISCOVERY','resolved_by_version','4.1.0',
      'resolved_at',reconciled.observed_at,'resolved_at_basis','FIRST_SUCCESSFUL_4_1_RECONCILIATION_CAUSE_REMEDIATION',
      'filled_at',tp.details->>'filledAt','collected_at',tp.details->>'collectedAt',
      'latency_ms',extract(epoch from ((tp.details->>'collectedAt')::timestamptz-(tp.details->>'filledAt')::timestamptz))*1000,
      'evidence_source',jsonb_build_object('tp_fill_event_id',tp.id,'lower_buy_fill_event_id',lower_buy.id,
        'lower_buy_price',lower_buy.details->'price','lower_buy_trade_id',lower_buy.details->'tradeId',
        'first_processed_event_id',first_processed.id,'remediation_checkpoint_event_id',reconciled.id,
        'deployment_id','dpl_B8qB5GnqYkjtT4iFRTomUNkm5mau','commit','7530824fa194fe2faf9bc87d87fa5b7c02647bf0'),
      'historical_missed_preserved',true,'retroactive_fill_created',false,
      'current_slot_state_modified',false,'classification_version','4.1.1');
    insert into coinops.robot_v1_testnet_events
      (run_id,product_id,tenant_id,user_id,event_key,event_type,slot_number,details)
    values (incident.run_id,incident.product_id,incident.tenant_id,incident.user_id,
      'PHASE_4_1_1_TEMPORAL_' || incident.id::text,'MISSED_LEVEL_DIAGNOSED',1,diagnosis)
    on conflict (run_id,event_key) do nothing;
  end loop;
end
$audit$;

-- First no-cache discovery recovered the pre-4.1 BTC backlog. Audit only:
-- no order, gain, balance or slot state is modified.
insert into coinops.robot_v1_testnet_events
  (run_id,product_id,tenant_id,user_id,event_key,event_type,slot_number,details)
select r.id,r.product_id,r.tenant_id,r.user_id,
  'PHASE_4_1_BTC_TP_LATENCY_DIAGNOSIS','MISSED_LEVEL_DIAGNOSED',s.slot_number,
  jsonb_build_object('root_cause','STALE_CACHED_RUN_DISCOVERY',
    'filled_at',f.details->>'filledAt','collected_at',f.details->>'collectedAt',
    'latency_ms',extract(epoch from ((f.details->>'collectedAt')::timestamptz-(f.details->>'filledAt')::timestamptz))*1000,
    'first_cross_at',null,'targetPrice',s.target_buy_price,'detected_at',s.missed_at,
    'operation_sequence',s.operation_sequence,'order_resident_at',null,
    'resolved_by_version','4.1.0','correction','EXPLICIT_NO_STORE_AND_ONE_MINUTE_REACTOR',
    'historical_missed_preserved',true,'retroactive_fill_created',false,
    'root_cause_evidence','FIRST_REACTOR_RECOVERED_CHECKPOINT_STALE_SINCE_12_50_UTC')
from coinops.robot_v1_testnet_runs r
join coinops.robot_v1_testnet_slots s on s.run_id=r.id and s.slot_number=1
join coinops.robot_v1_testnet_events f on f.run_id=r.id and f.slot_number=s.slot_number
where r.asset='BTC' and r.symbol='BTCUSDC' and s.operation_sequence=2
  and s.missed_at is not null and s.target_buy_price=85480.48
  and f.event_type='TESTNET_FILL_OBSERVED' and f.details->>'side'='SELL'
  and f.details->>'filledAt'='2026-09-23T14:01:50.234Z'
  and f.details->>'collectedAt'='2026-09-23T14:32:22.202Z'
on conflict (run_id,event_key) do nothing;

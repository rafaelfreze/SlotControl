-- Record the real pre-baseline capital confirmed by the owner for SOL slots
-- #11-#25. This is append-only economic evidence: slots, positions, gains,
-- contributions and operational values are intentionally left untouched.

create temporary table coinops_confirmed_sol_opening_targets on commit drop as
select s.id slot_id, s.product_id, s.tenant_id, s.user_id, s.slot_number
from coinops.slots s
join coinops.strategies st
  on st.id=s.strategy_id and st.product_id=s.product_id
 and st.tenant_id=s.tenant_id and st.user_id=s.user_id
where upper(st.asset)='SOL'
  and s.slot_number between 11 and 25
  and s.created_at='2026-08-26 12:19:02.028685+00'::timestamptz;

create unique index coinops_confirmed_sol_opening_targets_pk
  on coinops_confirmed_sol_opening_targets(slot_id);

do $confirmed_sol_opening$
declare
  target_count integer;
  scope_count integer;
  distinct_slots integer;
  unexpected_count integer;
  opening_count integer;
  target_total numeric(20,8);
  opening_total numeric(20,8);
  target_scope record;
  slot_state_before text;
  slot_state_after text;
begin
  select count(*)::integer,count(distinct target.slot_number)::integer,
    round(coalesce(sum(s.operational_slot_value),0),8)
  into target_count,distinct_slots,target_total
  from coinops_confirmed_sol_opening_targets target
  join coinops.slots s on s.id=target.slot_id;

  -- A clean/new environment has no production data to reconcile.
  if target_count=0 then
    raise notice 'No confirmed SOL opening balances are present in this environment.';
    return;
  end if;

  select count(*)::integer into scope_count from (
    select distinct product_id,tenant_id,user_id
    from coinops_confirmed_sol_opening_targets
  ) scopes;

  if target_count<>15 or distinct_slots<>15 or target_total<>375.00000000
    or scope_count<>1
    or (select min(slot_number) from coinops_confirmed_sol_opening_targets)<>11
    or (select max(slot_number) from coinops_confirmed_sol_opening_targets)<>25 then
    raise exception 'COINOPS_CONFIRMED_SOL_OPENING_TARGET_MISMATCH';
  end if;

  select product_id,tenant_id,user_id into strict target_scope
  from coinops_confirmed_sol_opening_targets limit 1;

  perform pg_advisory_xact_lock(hashtextextended(
    target_scope.product_id::text||target_scope.tenant_id::text
      ||target_scope.user_id::text||':official-baseline',0));

  perform s.id from coinops.slots s
  join coinops_confirmed_sol_opening_targets target on target.slot_id=s.id
  order by s.id for update of s;

  if exists(
    select 1 from coinops.monitoring_baselines b
    where b.product_id=target_scope.product_id
      and b.tenant_id=target_scope.tenant_id and b.user_id=target_scope.user_id
  ) then
    raise exception 'COINOPS_CONFIRMED_SOL_OPENING_BASELINE_ALREADY_EXISTS';
  end if;

  select count(*)::integer into unexpected_count
  from coinops_confirmed_sol_opening_targets target
  join coinops.slots s on s.id=target.slot_id
  join coinops.strategies st on st.id=s.strategy_id
  where upper(st.asset)<>'SOL' or s.slot_number not between 11 and 25
    or s.created_at<>'2026-08-26 12:19:02.028685+00'::timestamptz
    or s.updated_at<>s.created_at or s.status<>'zerado'
    or coalesce(s.started_once,false)
    or s.operational_slot_value<>25 or s.base_value<>25
    or s.gain_rate<>0.055 or s.operational_gains<>0
    or s.real_gains<>0 or s.added_gains<>0 or s.realized_profit<>0
    or s.growth_contribution<>0 or s.redistribution_received_usdt<>0
    or s.redistribution_sent_usdt<>0 or s.position_notional_usdt is not null
    or s.position_quantity is not null or s.position_opened_at is not null
    or s.preco_entrada is not null or s.preco_atual is not null
    or s.preco_alvo is not null;
  if unexpected_count<>0 then
    raise exception 'COINOPS_CONFIRMED_SOL_OPENING_STATE_CHANGED';
  end if;

  if exists(
    select 1 from coinops.btc_external_contributions c
    join coinops_confirmed_sol_opening_targets t
      on t.slot_id=c.slot_id and t.product_id=c.product_id
     and t.tenant_id=c.tenant_id and t.user_id=c.user_id
  ) then
    raise exception 'COINOPS_CONFIRMED_SOL_OPENING_CONTRIBUTION_PRESENT';
  end if;

  if exists(
    select 1 from coinops.history_events h
    join coinops_confirmed_sol_opening_targets t
      on t.slot_id=h.slot_id and t.product_id=h.product_id
     and t.tenant_id=h.tenant_id and t.user_id=h.user_id
    union all
    select 1 from coinops.slot_compounding_adjustments a
    join coinops_confirmed_sol_opening_targets t
      on t.slot_id=a.slot_id and t.product_id=a.product_id
     and t.tenant_id=a.tenant_id and t.user_id=a.user_id
    union all
    select 1 from coinops.slot_operational_reconciliations r
    join coinops_confirmed_sol_opening_targets t
      on t.slot_id=r.slot_id and t.product_id=r.product_id
     and t.tenant_id=r.tenant_id and t.user_id=r.user_id
    union all
    select 1 from coinops.btc_redistribution_transfers tr
    join coinops_confirmed_sol_opening_targets t
      on t.product_id=tr.product_id and t.tenant_id=tr.tenant_id
     and t.user_id=tr.user_id
     and t.slot_id in(tr.donor_slot_id,tr.receiver_slot_id)
  ) then
    raise exception 'COINOPS_CONFIRMED_SOL_OPENING_ACTIVITY_PRESENT';
  end if;

  if exists(
    select 1 from coinops.slot_capital_ledger l
    join coinops_confirmed_sol_opening_targets t
      on t.slot_id=l.slot_id and t.product_id=l.product_id
     and t.tenant_id=l.tenant_id and t.user_id=l.user_id
    where l.entry_type<>'OPENING_BALANCE'
  ) then
    raise exception 'COINOPS_CONFIRMED_SOL_OPENING_OTHER_LEDGER_PRESENT';
  end if;

  if exists(
    select 1 from coinops.slot_capital_ledger l
    join coinops_confirmed_sol_opening_targets t
      on t.slot_id=l.slot_id and t.product_id=l.product_id
     and t.tenant_id=l.tenant_id and t.user_id=l.user_id
    where l.entry_type='OPENING_BALANCE' and (
      l.amount_usdt<>25 or l.operational_gain_delta<>0
      or l.operational_before<>0 or l.operational_after<>0
      or l.value_before<>0 or l.value_after<>25
      or l.real_gains_snapshot<>0 or l.added_gains_snapshot<>0)
  ) then
    raise exception 'COINOPS_CONFIRMED_SOL_OPENING_EXISTING_BALANCE_MISMATCH';
  end if;

  select encode(extensions.digest(pg_catalog.convert_to(
    coalesce(jsonb_agg(to_jsonb(s) order by s.id),'[]'::jsonb)::text,'UTF8'
  ),'sha256'),'hex') into slot_state_before
  from coinops.slots s join coinops_confirmed_sol_opening_targets t on t.slot_id=s.id;

  insert into coinops.slot_capital_ledger(
    product_code,product_id,tenant_id,user_id,slot_id,entry_type,
    amount_usdt,operational_gain_delta,operational_before,operational_after,
    value_before,value_after,gain_unit_before_usdt,gain_unit_after_usdt,
    redistribution_received_before,redistribution_received_after,
    redistribution_sent_before,redistribution_sent_after,
    real_gains_snapshot,added_gains_snapshot,metadata,created_by,created_at
  )
  select 'coinops',s.product_id,s.tenant_id,s.user_id,s.id,'OPENING_BALANCE',
    s.operational_slot_value,s.operational_gains,0,s.operational_gains,
    0,s.operational_slot_value,
    private.coinops_gain_unit_usdt(s.base_value,s.growth_contribution,s.gain_rate),
    private.coinops_gain_unit_usdt(s.base_value,s.growth_contribution,s.gain_rate),
    0,s.redistribution_received_usdt,0,s.redistribution_sent_usdt,
    s.real_gains,s.added_gains,
    jsonb_build_object(
      'schemaVersion',1,
      'source','USER_CONFIRMED_SOL_FUNDING_2026_08_29',
      'classification','REAL_PRE_BASELINE_CAPITAL',
      'confirmedOn','2026-08-29',
      'legacyPreBaseline',true,
      'asset','SOL',
      'slotNumber',s.slot_number,
      'backfilledAt',clock_timestamp()
    ),
    s.user_id,s.created_at
  from coinops.slots s
  join coinops_confirmed_sol_opening_targets t on t.slot_id=s.id
  where not exists(
    select 1 from coinops.slot_capital_ledger existing
    where existing.product_id=s.product_id and existing.tenant_id=s.tenant_id
      and existing.user_id=s.user_id and existing.slot_id=s.id
      and existing.entry_type='OPENING_BALANCE'
  )
  on conflict do nothing;

  select count(*)::integer,round(coalesce(sum(l.amount_usdt),0),8)
  into opening_count,opening_total
  from coinops.slot_capital_ledger l
  join coinops_confirmed_sol_opening_targets t
    on t.slot_id=l.slot_id and t.product_id=l.product_id
   and t.tenant_id=l.tenant_id and t.user_id=l.user_id
  where l.entry_type='OPENING_BALANCE';

  if opening_count<>15 or opening_total<>375.00000000 or exists(
    select 1 from coinops.slot_capital_ledger l
    join coinops_confirmed_sol_opening_targets t
      on t.slot_id=l.slot_id and t.product_id=l.product_id
     and t.tenant_id=l.tenant_id and t.user_id=l.user_id
    join coinops.slots s on s.id=t.slot_id
    where l.entry_type='OPENING_BALANCE'
      and l.value_after<>s.operational_slot_value
  ) then
    raise exception 'COINOPS_CONFIRMED_SOL_OPENING_POSTCONDITION_FAILED';
  end if;

  select encode(extensions.digest(pg_catalog.convert_to(
    coalesce(jsonb_agg(to_jsonb(s) order by s.id),'[]'::jsonb)::text,'UTF8'
  ),'sha256'),'hex') into slot_state_after
  from coinops.slots s join coinops_confirmed_sol_opening_targets t on t.slot_id=s.id;

  if slot_state_after<>slot_state_before then
    raise exception 'COINOPS_CONFIRMED_SOL_OPENING_SLOT_STATE_CHANGED';
  end if;
end
$confirmed_sol_opening$;

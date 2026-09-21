-- Explicit owner-approved reporting cutover. No generated entity IDs or PII
-- are embedded: the reviewed full-state fingerprint selects exactly one scope.
-- The existing administrative function performs locks and all postconditions.
do $confirmed_opening$
declare
  reviewed_hash constant text := 'fcd661d07ebab0ce42f34bba3720eb9d083192c641592b98eac701c1eadfb987';
  confirmation_key constant uuid := '55397b36-0f91-4c1c-8c7c-4a41d2b3207f';
  confirmation_reason constant text := 'Owner approved incorporation of prior contributions into operational opening; preserve balances, positions, realized profit and history.';
  candidate record;
  target_scope record;
  matched_count integer := 0;
  existing coinops.capital_accounting_openings%rowtype;
begin
  select * into existing from coinops.capital_accounting_openings
  where idempotency_key = confirmation_key;
  if found then
    if existing.state_hash <> reviewed_hash or existing.reason <> confirmation_reason then
      raise exception 'COINOPS_CONFIRMED_OPENING_IDEMPOTENCY_MISMATCH';
    end if;
    return;
  end if;
  if not exists (select 1 from coinops.slots) then
    raise notice 'No operational data in this environment; no owner cutover to apply.';
    return;
  end if;
  for candidate in
    select product_id, tenant_id, user_id from coinops.slots
    group by product_id, tenant_id, user_id
  loop
    if encode(sha256(convert_to(private.coinops_capital_opening_snapshot(
      candidate.product_id, candidate.tenant_id, candidate.user_id
    )::text, 'UTF8')), 'hex') = reviewed_hash then
      target_scope := candidate;
      matched_count := matched_count + 1;
    end if;
  end loop;
  if matched_count <> 1 then
    raise exception 'COINOPS_CONFIRMED_OPENING_REVIEWED_STATE_NOT_FOUND';
  end if;
  perform private.coinops_activate_capital_opening(
    target_scope.product_id, target_scope.tenant_id, target_scope.user_id,
    reviewed_hash, confirmation_key, confirmation_reason
  );
end
$confirmed_opening$;

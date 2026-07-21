-- Automacao de slots v2: candles de 1 minuto, cursor persistente, auditoria e
-- execucao atomica. Nenhuma ordem externa e enviada por esta migracao.

create table if not exists public.automation_worker_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'RUNNING' check (status in ('RUNNING', 'COMPLETED', 'DEGRADED', 'FAILED')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  source text,
  window_start timestamptz,
  window_end timestamptz,
  stats jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now()
);

create table if not exists public.automation_market_cursors (
  asset text primary key check (asset in ('BTC', 'SOL')),
  last_window_end timestamptz,
  locked_by uuid references public.automation_worker_runs(id) on delete set null,
  locked_until timestamptz,
  last_source text,
  last_success_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);

create table if not exists public.automation_price_windows (
  asset text not null check (asset in ('BTC', 'SOL')),
  window_start timestamptz not null,
  window_end timestamptz not null,
  open_price numeric(20,8) not null check (open_price > 0),
  high_price numeric(20,8) not null check (high_price > 0),
  low_price numeric(20,8) not null check (low_price > 0),
  close_price numeric(20,8) not null check (close_price > 0),
  source text not null,
  worker_run_id uuid references public.automation_worker_runs(id) on delete set null,
  fetched_at timestamptz not null default now(),
  primary key (asset, window_start),
  check (window_end > window_start),
  check (low_price <= high_price),
  check (low_price <= open_price and low_price <= close_price),
  check (high_price >= open_price and high_price >= close_price)
);

create table if not exists public.automation_decisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  asset text not null check (asset in ('BTC', 'SOL')),
  slot_id uuid not null references public.slots(id) on delete restrict,
  event_type text not null check (event_type in ('ENTRY', 'EXIT')),
  decision text not null check (decision in ('EXECUTED', 'SKIPPED', 'RETRY', 'FAILED', 'BLOCKED')),
  reason text not null,
  trigger_price numeric(20,8),
  previous_price numeric(20,8),
  current_price numeric(20,8),
  interval_low numeric(20,8),
  interval_high numeric(20,8),
  window_start timestamptz not null,
  window_end timestamptz not null,
  source text not null,
  worker_run_id uuid references public.automation_worker_runs(id) on delete set null,
  idempotency_key text not null unique,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists automation_worker_runs_started_idx
  on public.automation_worker_runs (started_at desc);
create index if not exists automation_price_windows_asset_end_idx
  on public.automation_price_windows (asset, window_end desc);
create index if not exists automation_decisions_user_created_idx
  on public.automation_decisions (user_id, created_at desc);
create index if not exists automation_decisions_slot_created_idx
  on public.automation_decisions (slot_id, created_at desc);

alter table public.automation_worker_runs enable row level security;
alter table public.automation_market_cursors enable row level security;
alter table public.automation_price_windows enable row level security;
alter table public.automation_decisions enable row level security;

drop policy if exists "Users can view own automation decisions" on public.automation_decisions;
create policy "Users can view own automation decisions"
  on public.automation_decisions for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table public.automation_worker_runs from public, anon, authenticated;
revoke all on table public.automation_market_cursors from public, anon, authenticated;
revoke all on table public.automation_price_windows from public, anon, authenticated;
revoke all on table public.automation_decisions from public, anon, authenticated;
grant select on table public.automation_decisions to authenticated;
grant select, insert, update, delete on table public.automation_worker_runs to service_role;
grant select, insert, update, delete on table public.automation_market_cursors to service_role;
grant select, insert, update, delete on table public.automation_price_windows to service_role;
grant select, insert, update, delete on table public.automation_decisions to service_role;

create or replace function public.claim_automation_asset_cursor(
  p_asset text,
  p_worker_run_id uuid,
  p_lock_seconds integer default 120,
  p_initial_backfill_minutes integer default 360
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $claim_cursor$
declare
  v_asset text := upper(trim(p_asset));
  v_cursor public.automation_market_cursors%rowtype;
  v_start timestamptz;
  v_end timestamptz := date_trunc('minute', now());
begin
  if v_asset not in ('BTC', 'SOL') or p_worker_run_id is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_REQUEST');
  end if;

  insert into public.automation_market_cursors (asset)
  values (v_asset)
  on conflict (asset) do nothing;

  select * into v_cursor
  from public.automation_market_cursors
  where asset = v_asset
  for update skip locked;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'LOCKED');
  end if;

  if v_cursor.locked_until is not null and v_cursor.locked_until > now() and v_cursor.locked_by is distinct from p_worker_run_id then
    return jsonb_build_object('ok', false, 'code', 'LOCKED');
  end if;

  v_start := coalesce(v_cursor.last_window_end, v_end - make_interval(mins => greatest(1, least(coalesce(p_initial_backfill_minutes, 360), 1440))));
  if v_start >= v_end then
    return jsonb_build_object('ok', false, 'code', 'UP_TO_DATE', 'start', v_start, 'end', v_end);
  end if;

  update public.automation_market_cursors
  set locked_by = p_worker_run_id,
      locked_until = now() + make_interval(secs => greatest(30, least(coalesce(p_lock_seconds, 120), 600))),
      updated_at = now()
  where asset = v_asset;

  return jsonb_build_object('ok', true, 'asset', v_asset, 'start', v_start, 'end', v_end);
end;
$claim_cursor$;

create or replace function public.complete_automation_asset_cursor(
  p_asset text,
  p_worker_run_id uuid,
  p_last_window_end timestamptz,
  p_source text,
  p_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $complete_cursor$
declare
  v_asset text := upper(trim(p_asset));
begin
  update public.automation_market_cursors
  set last_window_end = case when p_error is null and p_last_window_end is not null then greatest(coalesce(last_window_end, p_last_window_end), p_last_window_end) else last_window_end end,
      locked_by = null,
      locked_until = null,
      last_source = coalesce(nullif(trim(p_source), ''), last_source),
      last_success_at = case when p_error is null and p_last_window_end is not null then now() else last_success_at end,
      last_error = p_error,
      updated_at = now()
  where asset = v_asset and locked_by = p_worker_run_id;
  return found;
end;
$complete_cursor$;

create or replace function public.execute_slot_automation_decision(
  p_slot_id uuid,
  p_event_type text,
  p_asset text,
  p_trigger_price numeric,
  p_previous_price numeric,
  p_current_price numeric,
  p_interval_low numeric,
  p_interval_high numeric,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_source text,
  p_worker_run_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $automation_decision$
declare
  v_slot public.slots%rowtype;
  v_asset text := upper(trim(p_asset));
  v_event_type text := upper(trim(p_event_type));
  v_mode text;
  v_slot_asset text;
  v_gain_rate numeric(20,8);
  v_target numeric(20,8);
  v_open_exists boolean := false;
  v_operation_id uuid;
  v_result jsonb;
  v_reason text;
  v_decision text := 'BLOCKED';
begin
  if p_slot_id is null or v_asset not in ('BTC', 'SOL') or v_event_type not in ('ENTRY', 'EXIT')
     or p_trigger_price is null or p_trigger_price <= 0 or p_window_start is null or p_window_end is null
     or p_window_end <= p_window_start or coalesce(nullif(trim(p_idempotency_key), ''), '') = '' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_REQUEST', 'message', 'Decisao automatica invalida.');
  end if;

  select result into v_result
  from public.automation_decisions
  where idempotency_key = p_idempotency_key;
  if found then
    return v_result;
  end if;

  if not pg_try_advisory_xact_lock(hashtextextended('slot-automation:slot:' || p_slot_id::text, 0)) then
    return jsonb_build_object('ok', false, 'code', 'LOCKED', 'message', 'Slot em processamento.');
  end if;

  select sl.*
    into v_slot
  from public.slots sl
  join public.strategies st on st.id = sl.strategy_id
  where sl.id = p_slot_id and upper(st.asset) = v_asset
  for update of sl;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'SLOT_NOT_ELIGIBLE', 'message', 'Slot nao encontrado para a decisao automatica.');
  end if;

  select upper(st.asset), st.gain_rate
    into v_slot_asset, v_gain_rate
  from public.strategies st
  where st.id = v_slot.strategy_id;

  if v_slot.updated_at > p_window_start then
    v_reason := 'STALE_TRIGGER';
  else
    select coalesce(settings ->> 'automationMode', case when coalesce((settings ->> 'autoGainEnabled')::boolean, false) then 'exit_only' else 'off' end)
      into v_mode
    from public.user_settings
    where user_id = v_slot.user_id;
    v_mode := coalesce(v_mode, 'off');

    if (v_event_type = 'ENTRY' and v_mode <> 'entry_exit') or (v_event_type = 'EXIT' and v_mode not in ('exit_only', 'entry_exit')) then
      v_reason := 'MODE_DISABLED';
    elsif v_event_type = 'ENTRY' and v_slot.status <> 'hold' then
      v_reason := 'INVALID_STATE';
    elsif v_event_type = 'EXIT' and v_slot.status <> 'aberto' then
      v_reason := 'INVALID_STATE';
    elsif v_event_type = 'ENTRY' and (v_slot.preco_entrada is null or round(v_slot.preco_entrada, 8) <> round(p_trigger_price, 8) or p_interval_low is null or p_interval_low > p_trigger_price) then
      v_reason := 'TRIGGER_NOT_REACHED';
    elsif v_event_type = 'EXIT' and (v_slot.preco_alvo is null or round(v_slot.preco_alvo, 8) <> round(p_trigger_price, 8) or p_interval_high is null or p_interval_high < p_trigger_price) then
      v_reason := 'TRIGGER_NOT_REACHED';
    else
      if v_event_type = 'ENTRY' then
        if not pg_try_advisory_xact_lock(hashtextextended('slot-automation:asset:' || v_slot.user_id::text || ':' || v_asset, 0)) then
          v_reason := 'LOCKED';
        else
          select exists(
            select 1
            from public.slots other_slot
            join public.strategies other_strategy on other_strategy.id = other_slot.strategy_id
            where other_slot.user_id = v_slot.user_id
              and other_slot.id <> v_slot.id
              and other_slot.status = 'aberto'
              and upper(other_strategy.asset) = v_asset
              and round(other_slot.preco_entrada, 8) = round(p_trigger_price, 8)
          ) into v_open_exists;
          if v_open_exists then
            v_reason := 'DUPLICATE';
          else
            v_target := coalesce(v_slot.preco_alvo, p_trigger_price * (1 + coalesce(v_gain_rate, v_slot.gain_rate, 0)));
            update public.slots
            set status = 'aberto',
                started_once = true,
                preco_atual = p_current_price,
                preco_alvo = v_target
            where id = v_slot.id and status = 'hold';
            insert into public.history_events (user_id, strategy_id, slot_id, action, detail, strategy_key, slot_number)
            select v_slot.user_id, v_slot.strategy_id, v_slot.id, 'entrada_automatica',
              jsonb_build_object(
                'schemaVersion', 3, 'message', format('Entrada automatica registrada no %s - Slot %s', v_asset, v_slot.slot_number),
                'origin', 'CRON', 'asset', v_asset, 'eventType', 'entrada_automatica',
                'expectedPrice', p_trigger_price, 'executedPrice', p_trigger_price, 'currentPrice', p_current_price,
                'targetPrice', v_target, 'intervalLow', p_interval_low, 'intervalHigh', p_interval_high,
                'windowStart', p_window_start, 'windowEnd', p_window_end, 'source', p_source,
                'statusBefore', 'hold', 'statusAfter', 'aberto', 'gains', v_slot.gains,
                'slotValue', v_slot.operational_slot_value, 'note', 'Entrada confirmada pela minima do candle de 1 minuto. Nenhuma ordem real foi enviada.'
              )::text,
              st.key, v_slot.slot_number
            from public.strategies st where st.id = v_slot.strategy_id
            returning id into v_operation_id;
            v_decision := 'EXECUTED';
            v_reason := 'INTERVAL_LOW_REACHED';
          end if;
        end if;
      else
        update public.slots
        set status = 'gain',
            gains = v_slot.gains + 1,
            started_once = true,
            preco_entrada = null,
            preco_atual = null,
            preco_alvo = null
        where id = v_slot.id and status = 'aberto';
        insert into public.history_events (user_id, strategy_id, slot_id, action, detail, strategy_key, slot_number)
        select v_slot.user_id, v_slot.strategy_id, v_slot.id, 'auto_gain',
          jsonb_build_object(
            'schemaVersion', 3, 'message', format('Gain automatico registrado no %s - Slot %s', v_asset, v_slot.slot_number),
            'origin', 'CRON', 'asset', v_asset, 'eventType', 'saida_automatica',
            'expectedPrice', p_trigger_price, 'executedPrice', p_trigger_price, 'currentPrice', p_current_price,
            'targetPrice', p_trigger_price, 'intervalLow', p_interval_low, 'intervalHigh', p_interval_high,
            'windowStart', p_window_start, 'windowEnd', p_window_end, 'source', p_source,
            'statusBefore', 'aberto', 'statusAfter', 'gain', 'gains', v_slot.gains + 1,
            'slotValue', v_slot.operational_slot_value * (1 + coalesce(v_slot.gain_rate, 0)),
            'realizedProfit', v_slot.operational_slot_value * coalesce(v_slot.gain_rate, 0),
            'note', 'Saida confirmada pela maxima do candle de 1 minuto. Nenhuma ordem real foi enviada.'
          )::text,
          st.key, v_slot.slot_number
        from public.strategies st where st.id = v_slot.strategy_id
        returning id into v_operation_id;
        v_decision := 'EXECUTED';
        v_reason := 'INTERVAL_HIGH_REACHED';
      end if;
    end if;
  end if;

  v_result := jsonb_build_object(
    'ok', v_decision = 'EXECUTED', 'decision', v_decision, 'reason', coalesce(v_reason, 'UNKNOWN'),
    'asset', v_asset, 'slot_id', p_slot_id, 'event_type', v_event_type, 'operation_id', v_operation_id,
    'message', case when v_decision = 'EXECUTED' then 'Operacao automatica registrada com sucesso.' else 'Operacao automatica nao executada.' end
  );

  insert into public.automation_decisions (
    user_id, asset, slot_id, event_type, decision, reason, trigger_price, previous_price, current_price,
    interval_low, interval_high, window_start, window_end, source, worker_run_id, idempotency_key, result
  ) values (
    v_slot.user_id, v_asset, p_slot_id, v_event_type,
    v_decision, coalesce(v_reason, 'UNKNOWN'), p_trigger_price, p_previous_price, p_current_price,
    p_interval_low, p_interval_high, p_window_start, p_window_end, p_source, p_worker_run_id, p_idempotency_key, v_result
  ) on conflict (idempotency_key) do update set idempotency_key = excluded.idempotency_key
  returning result into v_result;

  return v_result;
exception when others then
  raise;
end;
$automation_decision$;

revoke all on function public.claim_automation_asset_cursor(text, uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.complete_automation_asset_cursor(text, uuid, timestamptz, text, text) from public, anon, authenticated;
revoke all on function public.execute_slot_automation_decision(uuid, text, text, numeric, numeric, numeric, numeric, numeric, timestamptz, timestamptz, text, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_automation_asset_cursor(text, uuid, integer, integer) to service_role;
grant execute on function public.complete_automation_asset_cursor(text, uuid, timestamptz, text, text) to service_role;
grant execute on function public.execute_slot_automation_decision(uuid, text, text, numeric, numeric, numeric, numeric, numeric, timestamptz, timestamptz, text, uuid, text) to service_role;

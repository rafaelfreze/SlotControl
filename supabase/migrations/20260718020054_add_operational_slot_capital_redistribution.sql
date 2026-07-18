-- Redistribuicao financeira v3.
-- `slots.gains` e os eventos historicos permanecem imutaveis para esta operacao.
-- `base_value` continua sendo o capital-base do slot; somente o lucro reinvestido
-- passa a ser materializado para que o capital operacional deixe de depender do
-- contador historico de gains.

alter table public.slots
  add column if not exists reinvested_profit numeric(18,8) not null default 0;

update public.slots
set reinvested_profit = round(
  greatest(
    coalesce(base_value, 0)::numeric * power(1 + coalesce(gain_rate, 0)::numeric, coalesce(gains, 0)::integer)
      - coalesce(base_value, 0)::numeric,
    0
  ),
  8
)
where reinvested_profit = 0
  and coalesce(gains, 0) > 0;

alter table public.slots
  add column if not exists operational_slot_value numeric(18,8)
    generated always as (round(base_value + reinvested_profit, 8)) stored;

alter table public.slots
  drop constraint if exists slots_reinvested_profit_nonnegative;
alter table public.slots
  add constraint slots_reinvested_profit_nonnegative check (reinvested_profit >= 0);

create index if not exists slots_user_status_redistribution_idx
  on public.slots (user_id, status, slot_number, sort_order);

alter table public.slot_gain_redistributions
  add column if not exists total_reinvested_before numeric(18,8),
  add column if not exists total_reinvested_after numeric(18,8),
  add column if not exists base_reinvested numeric(18,8),
  add column if not exists remainder_reinvested_units integer,
  add column if not exists algorithm_version text;

create or replace function public.apply_operational_profit_on_real_gain()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $operational_profit$
declare
  v_profit numeric(18,8);
begin
  -- A transicao aberta -> gain e a unica que representa um gain operacional.
  -- Assim, edicoes administrativas no contador historico nao criam capital.
  if old.status = 'aberto'
     and new.status = 'gain'
     and new.gains = old.gains + 1
     and new.reinvested_profit is not distinct from old.reinvested_profit then
    v_profit := round(old.operational_slot_value * coalesce(old.gain_rate, 0)::numeric, 8);
    new.reinvested_profit := old.reinvested_profit + greatest(v_profit, 0);
  end if;

  return new;
end;
$operational_profit$;

drop trigger if exists slots_apply_operational_profit_on_real_gain on public.slots;
create trigger slots_apply_operational_profit_on_real_gain
before update of status, gains, reinvested_profit on public.slots
for each row execute function public.apply_operational_profit_on_real_gain();

create or replace function public.slot_gain_redistribution_preview_for_user(
  p_user_id uuid,
  p_asset text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $redistribution_preview$
declare
  v_asset text := upper(trim(p_asset));
  v_target integer;
  v_closed_slot_count integer := 0;
  v_ignored_open_slot_count integer := 0;
  v_invalid_slot_count integer := 0;
  v_recipient_slot_count integer := 0;
  v_zeroed_slot_count integer := 0;
  v_total_gains bigint := 0;
  v_base_gain bigint := 0;
  v_remainder_gain integer := 0;
  v_total_reinvested numeric(18,8) := 0;
  v_base_reinvested numeric(18,8) := 0;
  v_remainder_reinvested_units integer := 0;
  v_money_unit constant numeric(18,8) := 0.00000001;
  v_snapshot_before jsonb := '[]'::jsonb;
  v_snapshot_after jsonb := '[]'::jsonb;
  v_closed_slots jsonb := '[]'::jsonb;
  v_hash text;
begin
  v_target := case v_asset when 'BTC' then 15 when 'SOL' then 6 else null end;
  if p_user_id is null or v_target is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_ASSET', 'message', 'Ativo invalido para redistribuicao.');
  end if;

  select
    count(*) filter (where public.is_closed_slot_status(sl.status))::integer,
    count(*) filter (where public.is_open_slot_status(sl.status))::integer,
    count(*) filter (
      where (public.is_closed_slot_status(sl.status) and (
        sl.gains_distribuidos is null or sl.gains_distribuidos < 0 or
        sl.reinvested_profit is null or sl.reinvested_profit < 0 or
        sl.operational_slot_value < sl.base_value
      )) or (not public.is_closed_slot_status(sl.status) and not public.is_open_slot_status(sl.status))
    )::integer,
    coalesce(sum(sl.gains_distribuidos) filter (where public.is_closed_slot_status(sl.status)), 0)::bigint,
    coalesce(sum(sl.reinvested_profit) filter (where public.is_closed_slot_status(sl.status)), 0)::numeric(18,8)
  into v_closed_slot_count, v_ignored_open_slot_count, v_invalid_slot_count, v_total_gains, v_total_reinvested
  from public.slots sl
  join public.strategies st on st.id = sl.strategy_id
  where sl.user_id = p_user_id and upper(st.asset) = v_asset;

  if v_invalid_slot_count > 0 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_SLOT', 'message', 'Ha dados invalidos nos slots fechados. Nenhuma redistribuicao foi aplicada.', 'asset', v_asset, 'target_slot_count', v_target);
  end if;
  if v_closed_slot_count = 0 then
    return jsonb_build_object('ok', false, 'code', 'NO_CLOSED_SLOTS', 'message', 'Nao ha slots fechados para redistribuir.', 'asset', v_asset, 'target_slot_count', v_target, 'ignored_open_slot_count', v_ignored_open_slot_count);
  end if;

  v_recipient_slot_count := least(v_target, v_closed_slot_count);
  v_zeroed_slot_count := v_closed_slot_count - v_recipient_slot_count;
  v_base_gain := v_total_gains / v_recipient_slot_count;
  v_remainder_gain := (v_total_gains % v_recipient_slot_count)::integer;
  v_base_reinvested := trunc(v_total_reinvested / v_recipient_slot_count, 8);
  v_remainder_reinvested_units := round((v_total_reinvested - (v_base_reinvested * v_recipient_slot_count)) / v_money_unit)::integer;

  with ranked as (
    select sl.id, sl.slot_number, sl.sort_order, sl.status, sl.gains as gains_real,
      sl.gains_distribuidos as gains_before, sl.base_value, sl.reinvested_profit as reinvested_profit_before,
      sl.operational_slot_value as operational_slot_value_before, sl.updated_at,
      row_number() over (order by sl.gains_distribuidos desc, sl.slot_number asc, sl.sort_order asc, sl.id asc)::integer as recipient_rank
    from public.slots sl join public.strategies st on st.id = sl.strategy_id
    where sl.user_id = p_user_id and upper(st.asset) = v_asset and public.is_closed_slot_status(sl.status)
  ), final_slots as (
    select ranked.*, case when recipient_rank <= v_recipient_slot_count then 'RECIPIENT' else 'ZEROED' end as role,
      case when recipient_rank <= v_recipient_slot_count then 'CLOSED_HIGHEST_GAIN' else 'CLOSED_EXCESS_ZEROED' end as selection_reason,
      case when recipient_rank <= v_recipient_slot_count then (v_base_gain + case when recipient_rank <= v_remainder_gain then 1 else 0 end)::integer else 0 end as gains_after,
      case when recipient_rank <= v_recipient_slot_count then round(v_base_reinvested + case when recipient_rank <= v_remainder_reinvested_units then v_money_unit else 0 end, 8) else 0::numeric end as reinvested_profit_after
    from ranked
  )
  select
    coalesce(jsonb_agg(jsonb_build_object('slot_id', id, 'slot_number', slot_number, 'sort_order', sort_order, 'status', status, 'gains_real', gains_real, 'gains_before', gains_before, 'base_value', base_value, 'reinvested_profit_before', reinvested_profit_before, 'operational_slot_value_before', operational_slot_value_before, 'role', role, 'selection_reason', selection_reason, 'updated_at', updated_at) order by case when role = 'RECIPIENT' then 0 else 1 end, recipient_rank), '[]'::jsonb),
    coalesce(jsonb_agg(jsonb_build_object('slot_id', id, 'slot_number', slot_number, 'sort_order', sort_order, 'status', status, 'gains_real', gains_real, 'gains_after', gains_after, 'base_value', base_value, 'reinvested_profit_after', reinvested_profit_after, 'operational_slot_value_after', round(base_value + reinvested_profit_after, 8), 'role', role, 'selection_reason', selection_reason, 'updated_at', updated_at) order by case when role = 'RECIPIENT' then 0 else 1 end, recipient_rank), '[]'::jsonb),
    coalesce(jsonb_agg(jsonb_build_object('slot_id', id, 'slot_number', slot_number, 'sort_order', sort_order, 'status', status, 'gains_real', gains_real, 'gains_before', gains_before, 'gains_after', gains_after, 'base_value', base_value, 'reinvested_profit_before', reinvested_profit_before, 'reinvested_profit_after', reinvested_profit_after, 'operational_slot_value_before', operational_slot_value_before, 'operational_slot_value_after', round(base_value + reinvested_profit_after, 8), 'role', role, 'selection_reason', selection_reason, 'updated_at', updated_at) order by case when role = 'RECIPIENT' then 0 else 1 end, recipient_rank), '[]'::jsonb)
  into v_snapshot_before, v_snapshot_after, v_closed_slots from final_slots;

  v_hash := encode(digest(jsonb_build_object('algorithm_version', 'CLOSED_POOL_FINANCIAL_V3', 'asset', v_asset, 'target_slot_count', v_target, 'recipient_slot_count', v_recipient_slot_count, 'total_gains_before', v_total_gains, 'total_reinvested_before', v_total_reinvested, 'base_gain', v_base_gain, 'base_reinvested', v_base_reinvested, 'remainder_gain', v_remainder_gain, 'remainder_reinvested_units', v_remainder_reinvested_units, 'closed_slots', v_closed_slots)::text, 'sha256'), 'hex');

  return jsonb_build_object('ok', true, 'algorithm_version', 'CLOSED_POOL_FINANCIAL_V3', 'asset', v_asset, 'target_slot_count', v_target, 'recipient_slot_count', v_recipient_slot_count, 'closed_slot_count', v_closed_slot_count, 'ignored_open_slot_count', v_ignored_open_slot_count, 'zeroed_slot_count', v_zeroed_slot_count, 'total_gains_before', v_total_gains, 'total_gains_after', v_total_gains, 'base_gain', v_base_gain, 'remainder_gain', v_remainder_gain, 'total_reinvested_before', v_total_reinvested, 'total_reinvested_after', v_total_reinvested, 'base_reinvested', v_base_reinvested, 'remainder_reinvested_units', v_remainder_reinvested_units, 'snapshot_hash', v_hash, 'snapshot_before', v_snapshot_before, 'snapshot_after', v_snapshot_after, 'closed_slots', v_closed_slots);
end;
$redistribution_preview$;

create or replace function public.confirm_slot_gain_redistribution(p_asset text, p_snapshot_hash text, p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $redistribution_confirm$
declare
  v_user_id uuid := auth.uid(); v_asset text := upper(trim(p_asset)); v_preview jsonb := '{}'::jsonb; v_result jsonb; v_existing jsonb; v_target integer; v_updated integer; v_after_gains bigint; v_after_reinvested numeric(18,8); v_audit_id uuid; v_error_message text;
begin
  v_target := case v_asset when 'BTC' then 15 when 'SOL' then 6 else null end;
  if v_user_id is null then return jsonb_build_object('ok', false, 'code', 'UNAUTHORIZED', 'message', 'Usuario nao autorizado.'); end if;
  if v_target is null or nullif(trim(p_snapshot_hash), '') is null or p_idempotency_key is null then return jsonb_build_object('ok', false, 'code', 'INVALID_REQUEST', 'message', 'Solicitacao de redistribuicao invalida.'); end if;
  if not pg_try_advisory_xact_lock(hashtextextended('slot_gain_redistribution:' || v_user_id::text || ':' || v_asset, 0)) then return jsonb_build_object('ok', false, 'code', 'CONFLICT_IN_PROGRESS', 'message', 'Ja existe uma redistribuicao em andamento para este ativo.'); end if;
  select result into v_existing from public.slot_gain_redistributions where user_id = v_user_id and idempotency_key = p_idempotency_key;
  if found then return v_existing; end if;
  perform 1 from public.slots sl where sl.user_id = v_user_id and exists (select 1 from public.strategies st where st.id = sl.strategy_id and upper(st.asset) = v_asset) for update;
  v_preview := public.slot_gain_redistribution_preview_for_user(v_user_id, v_asset);
  if coalesce((v_preview ->> 'ok')::boolean, false) is false then
    v_result := v_preview;
    insert into public.slot_gain_redistributions (user_id, asset, action_type, target_slot_count, total_gains_before, total_gains_after, total_reinvested_before, total_reinvested_after, status, idempotency_key, result, error_code, error_message, algorithm_version) values (v_user_id, v_asset, 'REDISTRIBUTION', v_target, 0, 0, 0, 0, 'FAILED', p_idempotency_key, v_result, v_result ->> 'code', v_result ->> 'message', 'CLOSED_POOL_FINANCIAL_V3');
    return v_result;
  end if;
  if (v_preview ->> 'snapshot_hash') <> p_snapshot_hash then
    v_result := jsonb_build_object('ok', false, 'code', 'PREVIEW_STALE', 'message', 'Os slots foram atualizados desde a previa. Gere uma nova previa antes de confirmar.', 'asset', v_asset);
    insert into public.slot_gain_redistributions (user_id, asset, action_type, target_slot_count, total_gains_before, total_gains_after, total_reinvested_before, total_reinvested_after, base_gain, remainder_gain, base_reinvested, remainder_reinvested_units, status, idempotency_key, snapshot_before, snapshot_after, result, error_code, error_message, algorithm_version) values (v_user_id, v_asset, 'REDISTRIBUTION', v_target, coalesce((v_preview ->> 'total_gains_before')::bigint, 0), coalesce((v_preview ->> 'total_gains_after')::bigint, 0), coalesce((v_preview ->> 'total_reinvested_before')::numeric, 0), coalesce((v_preview ->> 'total_reinvested_after')::numeric, 0), (v_preview ->> 'base_gain')::integer, (v_preview ->> 'remainder_gain')::integer, (v_preview ->> 'base_reinvested')::numeric, (v_preview ->> 'remainder_reinvested_units')::integer, 'FAILED', p_idempotency_key, v_preview -> 'snapshot_before', v_preview -> 'snapshot_after', v_result, 'PREVIEW_STALE', v_result ->> 'message', 'CLOSED_POOL_FINANCIAL_V3');
    return v_result;
  end if;
  begin
    update public.slots sl set gains_distribuidos = (item ->> 'gains_after')::integer, reinvested_profit = (item ->> 'reinvested_profit_after')::numeric
    from jsonb_array_elements(v_preview -> 'snapshot_after') item
    where sl.id = (item ->> 'slot_id')::uuid and sl.user_id = v_user_id and public.is_closed_slot_status(sl.status);
    get diagnostics v_updated = row_count;
    if v_updated <> (v_preview ->> 'closed_slot_count')::integer then raise exception 'Quantidade de slots fechados atualizada inesperada: % de %.', v_updated, (v_preview ->> 'closed_slot_count')::integer; end if;
    select coalesce(sum(sl.gains_distribuidos), 0)::bigint, coalesce(sum(sl.reinvested_profit), 0)::numeric(18,8) into v_after_gains, v_after_reinvested from public.slots sl join public.strategies st on st.id = sl.strategy_id where sl.user_id = v_user_id and upper(st.asset) = v_asset and public.is_closed_slot_status(sl.status);
    if v_after_gains <> (v_preview ->> 'total_gains_before')::bigint or v_after_reinvested <> (v_preview ->> 'total_reinvested_before')::numeric then raise exception 'A soma operacional dos slots fechados nao foi preservada.'; end if;
    insert into public.slot_gain_redistributions (user_id, asset, action_type, target_slot_count, total_gains_before, total_gains_after, total_reinvested_before, total_reinvested_after, base_gain, remainder_gain, base_reinvested, remainder_reinvested_units, status, idempotency_key, snapshot_before, snapshot_after, result, completed_at, algorithm_version) values (v_user_id, v_asset, 'REDISTRIBUTION', v_target, (v_preview ->> 'total_gains_before')::bigint, (v_preview ->> 'total_gains_after')::bigint, (v_preview ->> 'total_reinvested_before')::numeric, (v_preview ->> 'total_reinvested_after')::numeric, (v_preview ->> 'base_gain')::integer, (v_preview ->> 'remainder_gain')::integer, (v_preview ->> 'base_reinvested')::numeric, (v_preview ->> 'remainder_reinvested_units')::integer, 'COMPLETED', p_idempotency_key, v_preview -> 'snapshot_before', v_preview -> 'snapshot_after', jsonb_build_object('ok', true, 'algorithm_version', 'CLOSED_POOL_FINANCIAL_V3', 'asset', v_asset, 'target_slot_count', v_target, 'recipient_slot_count', (v_preview ->> 'recipient_slot_count')::integer, 'closed_slot_count', (v_preview ->> 'closed_slot_count')::integer, 'ignored_open_slot_count', (v_preview ->> 'ignored_open_slot_count')::integer, 'zeroed_slot_count', (v_preview ->> 'zeroed_slot_count')::integer, 'total_gains_before', (v_preview ->> 'total_gains_before')::bigint, 'total_gains_after', (v_preview ->> 'total_gains_after')::bigint, 'total_reinvested_before', (v_preview ->> 'total_reinvested_before')::numeric, 'total_reinvested_after', (v_preview ->> 'total_reinvested_after')::numeric), now(), 'CLOSED_POOL_FINANCIAL_V3') returning id, result into v_audit_id, v_result;
    v_result := v_result || jsonb_build_object('audit_id', v_audit_id, 'message', format('Capital operacional e gains redistribuidos com sucesso entre %s slots fechados de %s.', (v_preview ->> 'recipient_slot_count')::integer, v_asset));
    update public.slot_gain_redistributions set result = v_result where id = v_audit_id;
    return v_result;
  exception when others then v_error_message := sqlerrm;
  end;
  v_result := jsonb_build_object('ok', false, 'code', 'REDISTRIBUTION_FAILED', 'message', 'Nao foi possivel concluir a redistribuicao. Nenhum valor operacional foi alterado.', 'asset', v_asset);
  insert into public.slot_gain_redistributions (user_id, asset, action_type, target_slot_count, total_gains_before, total_gains_after, total_reinvested_before, total_reinvested_after, status, idempotency_key, snapshot_before, snapshot_after, result, error_code, error_message, algorithm_version) values (v_user_id, v_asset, 'REDISTRIBUTION', v_target, coalesce((v_preview ->> 'total_gains_before')::bigint, 0), coalesce((v_preview ->> 'total_gains_after')::bigint, 0), coalesce((v_preview ->> 'total_reinvested_before')::numeric, 0), coalesce((v_preview ->> 'total_reinvested_after')::numeric, 0), 'FAILED', p_idempotency_key, coalesce(v_preview -> 'snapshot_before', '[]'::jsonb), coalesce(v_preview -> 'snapshot_after', '[]'::jsonb), v_result, 'REDISTRIBUTION_FAILED', v_error_message, 'CLOSED_POOL_FINANCIAL_V3');
  return v_result;
end;
$redistribution_confirm$;

create or replace function public.undo_last_slot_gain_redistribution(p_asset text, p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $redistribution_undo$
declare
  v_user_id uuid := auth.uid(); v_asset text := upper(trim(p_asset)); v_target integer; v_source public.slot_gain_redistributions%rowtype; v_existing jsonb; v_valid boolean; v_result jsonb; v_audit_id uuid; v_error_message text;
begin
  v_target := case v_asset when 'BTC' then 15 when 'SOL' then 6 else null end;
  if v_user_id is null then return jsonb_build_object('ok', false, 'code', 'UNAUTHORIZED', 'message', 'Usuario nao autorizado.'); end if;
  if v_target is null or p_idempotency_key is null then return jsonb_build_object('ok', false, 'code', 'INVALID_REQUEST', 'message', 'Solicitacao de desfazer invalida.'); end if;
  if not pg_try_advisory_xact_lock(hashtextextended('slot_gain_redistribution:' || v_user_id::text || ':' || v_asset, 0)) then return jsonb_build_object('ok', false, 'code', 'CONFLICT_IN_PROGRESS', 'message', 'Ja existe uma redistribuicao em andamento para este ativo.'); end if;
  select result into v_existing from public.slot_gain_redistributions where user_id = v_user_id and idempotency_key = p_idempotency_key;
  if found then return v_existing; end if;
  perform 1 from public.slots sl where sl.user_id = v_user_id and exists (select 1 from public.strategies st where st.id = sl.strategy_id and upper(st.asset) = v_asset) for update;
  select * into v_source from public.slot_gain_redistributions where user_id = v_user_id and asset = v_asset and action_type = 'REDISTRIBUTION' and status = 'COMPLETED' order by created_at desc limit 1 for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'UNDO_UNAVAILABLE', 'message', 'Nao existe uma redistribuicao segura para desfazer neste ativo.'); end if;
  select coalesce(bool_and(sl.id is not null and sl.gains_distribuidos = (item ->> 'gains_after')::integer and sl.gains = (item ->> 'gains_real')::integer and sl.status is not distinct from item ->> 'status' and public.is_closed_slot_status(sl.status) and (not (item ? 'reinvested_profit_after') or (sl.reinvested_profit = (item ->> 'reinvested_profit_after')::numeric and sl.operational_slot_value = (item ->> 'operational_slot_value_after')::numeric))), false) into v_valid from jsonb_array_elements(v_source.snapshot_after) item left join public.slots sl on sl.id = (item ->> 'slot_id')::uuid and sl.user_id = v_user_id;
  if not v_valid then return jsonb_build_object('ok', false, 'code', 'UNDO_UNSAFE', 'message', 'Os slots foram alterados depois da redistribuicao. O desfazer foi bloqueado para preservar a integridade.'); end if;
  begin
    update public.slots sl set gains_distribuidos = (item ->> 'gains_before')::integer, reinvested_profit = case when item ? 'reinvested_profit_before' then (item ->> 'reinvested_profit_before')::numeric else sl.reinvested_profit end from jsonb_array_elements(v_source.snapshot_before) item where sl.id = (item ->> 'slot_id')::uuid and sl.user_id = v_user_id and public.is_closed_slot_status(sl.status);
    update public.slot_gain_redistributions set status = 'UNDONE' where id = v_source.id;
    v_result := jsonb_build_object('ok', true, 'asset', v_asset, 'target_slot_count', v_source.target_slot_count, 'algorithm_version', coalesce(v_source.algorithm_version, v_source.result ->> 'algorithm_version', 'LEGACY'), 'message', format('Ultima redistribuicao de %s foi desfeita com seguranca.', v_asset));
    insert into public.slot_gain_redistributions (user_id, parent_redistribution_id, asset, action_type, target_slot_count, total_gains_before, total_gains_after, total_reinvested_before, total_reinvested_after, base_gain, remainder_gain, base_reinvested, remainder_reinvested_units, status, idempotency_key, snapshot_before, snapshot_after, result, completed_at, algorithm_version) values (v_user_id, v_source.id, v_asset, 'UNDO', v_source.target_slot_count, v_source.total_gains_after, v_source.total_gains_before, v_source.total_reinvested_after, v_source.total_reinvested_before, v_source.base_gain, v_source.remainder_gain, v_source.base_reinvested, v_source.remainder_reinvested_units, 'COMPLETED', p_idempotency_key, v_source.snapshot_after, v_source.snapshot_before, v_result, now(), coalesce(v_source.algorithm_version, 'LEGACY')) returning id into v_audit_id;
    v_result := v_result || jsonb_build_object('audit_id', v_audit_id); update public.slot_gain_redistributions set result = v_result where id = v_audit_id; return v_result;
  exception when others then v_error_message := sqlerrm;
  end;
  v_result := jsonb_build_object('ok', false, 'code', 'UNDO_FAILED', 'message', 'Nao foi possivel desfazer a redistribuicao. Nenhum valor operacional foi alterado.');
  insert into public.slot_gain_redistributions (user_id, parent_redistribution_id, asset, action_type, target_slot_count, total_gains_before, total_gains_after, total_reinvested_before, total_reinvested_after, status, idempotency_key, snapshot_before, snapshot_after, result, error_code, error_message, algorithm_version) values (v_user_id, v_source.id, v_asset, 'UNDO', v_source.target_slot_count, v_source.total_gains_after, v_source.total_gains_before, v_source.total_reinvested_after, v_source.total_reinvested_before, 'FAILED', p_idempotency_key, v_source.snapshot_after, v_source.snapshot_before, v_result, 'UNDO_FAILED', v_error_message, coalesce(v_source.algorithm_version, 'LEGACY'));
  return v_result;
end;
$redistribution_undo$;

revoke all on function public.apply_operational_profit_on_real_gain() from public, anon, authenticated;
revoke all on function public.slot_gain_redistribution_preview_for_user(uuid, text) from public, anon, authenticated;
grant execute on function public.preview_slot_gain_redistribution(text) to authenticated;
grant execute on function public.confirm_slot_gain_redistribution(text, text, uuid) to authenticated;
grant execute on function public.undo_last_slot_gain_redistribution(text, uuid) to authenticated;

-- Redistribuicao v2: somente slots sem exposicao (gain e zerado) participam.
-- `slots.gains` continua sendo o contador financeiro/historico e nunca e
-- atualizado por estas funcoes.

alter table public.slot_gain_redistributions
  alter column total_gains_before type bigint using total_gains_before::bigint,
  alter column total_gains_after type bigint using total_gains_after::bigint;

create or replace function public.is_closed_slot_status(p_status text)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $closed_status$
  select lower(btrim(p_status)) in ('gain', 'zerado');
$closed_status$;

create or replace function public.is_open_slot_status(p_status text)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $open_status$
  select lower(btrim(p_status)) in ('aberto', 'hold');
$open_status$;

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
  v_total bigint := 0;
  v_base bigint := 0;
  v_remainder integer := 0;
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
      where (public.is_closed_slot_status(sl.status) and (sl.gains_distribuidos is null or sl.gains_distribuidos < 0))
         or (not public.is_closed_slot_status(sl.status) and not public.is_open_slot_status(sl.status))
    )::integer,
    coalesce(sum(sl.gains_distribuidos) filter (where public.is_closed_slot_status(sl.status)), 0)::bigint
  into v_closed_slot_count, v_ignored_open_slot_count, v_invalid_slot_count, v_total
  from public.slots sl
  join public.strategies st on st.id = sl.strategy_id
  where sl.user_id = p_user_id
    and upper(st.asset) = v_asset;

  if v_invalid_slot_count > 0 then
    return jsonb_build_object(
      'ok', false,
      'code', 'INVALID_SLOT',
      'message', 'Ha dados invalidos nos slots fechados. Nenhuma redistribuicao foi aplicada.',
      'asset', v_asset,
      'target_slot_count', v_target
    );
  end if;

  if v_closed_slot_count = 0 then
    return jsonb_build_object(
      'ok', false,
      'code', 'NO_CLOSED_SLOTS',
      'message', 'Nao ha slots fechados para redistribuir.',
      'asset', v_asset,
      'target_slot_count', v_target,
      'ignored_open_slot_count', v_ignored_open_slot_count
    );
  end if;

  v_recipient_slot_count := least(v_target, v_closed_slot_count);
  v_zeroed_slot_count := v_closed_slot_count - v_recipient_slot_count;
  v_base := v_total / v_recipient_slot_count;
  v_remainder := (v_total % v_recipient_slot_count)::integer;

  if v_base + (case when v_remainder > 0 then 1 else 0 end) > 2147483647 then
    return jsonb_build_object(
      'ok', false,
      'code', 'GAIN_OVERFLOW',
      'message', 'O total de gains excede o limite seguro do contador operacional.',
      'asset', v_asset,
      'target_slot_count', v_target
    );
  end if;

  with ranked as (
    select
      sl.id,
      sl.slot_number,
      sl.sort_order,
      sl.status,
      sl.gains as gains_real,
      sl.gains_distribuidos as gains_before,
      sl.updated_at,
      row_number() over (
        order by sl.gains_distribuidos desc, sl.slot_number asc, sl.sort_order asc, sl.id asc
      )::integer as recipient_rank
    from public.slots sl
    join public.strategies st on st.id = sl.strategy_id
    where sl.user_id = p_user_id
      and upper(st.asset) = v_asset
      and public.is_closed_slot_status(sl.status)
  ),
  final_slots as (
    select
      ranked.*,
      case when recipient_rank <= v_recipient_slot_count then 'RECIPIENT' else 'ZEROED' end as role,
      case when recipient_rank <= v_recipient_slot_count then 'CLOSED_HIGHEST_GAIN' else 'CLOSED_EXCESS_ZEROED' end as selection_reason,
      case
        when recipient_rank <= v_recipient_slot_count
          then (v_base + (case when recipient_rank <= v_remainder then 1 else 0 end))::integer
        else 0
      end as gains_after
    from ranked
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'slot_id', id,
          'slot_number', slot_number,
          'sort_order', sort_order,
          'status', status,
          'gains_real', gains_real,
          'gains_before', gains_before,
          'role', role,
          'selection_reason', selection_reason,
          'updated_at', updated_at
        ) order by case when role = 'RECIPIENT' then 0 else 1 end, recipient_rank
      ),
      '[]'::jsonb
    ),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'slot_id', id,
          'slot_number', slot_number,
          'sort_order', sort_order,
          'status', status,
          'gains_real', gains_real,
          'gains_after', gains_after,
          'role', role,
          'selection_reason', selection_reason,
          'updated_at', updated_at
        ) order by case when role = 'RECIPIENT' then 0 else 1 end, recipient_rank
      ),
      '[]'::jsonb
    ),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'slot_id', id,
          'slot_number', slot_number,
          'sort_order', sort_order,
          'status', status,
          'gains_real', gains_real,
          'gains_before', gains_before,
          'gains_after', gains_after,
          'role', role,
          'selection_reason', selection_reason,
          'updated_at', updated_at
        ) order by case when role = 'RECIPIENT' then 0 else 1 end, recipient_rank
      ),
      '[]'::jsonb
    )
  into v_snapshot_before, v_snapshot_after, v_closed_slots
  from final_slots;

  v_hash := encode(
    digest(
      jsonb_build_object(
        'algorithm_version', 'CLOSED_POOL_V2',
        'asset', v_asset,
        'target_slot_count', v_target,
        'recipient_slot_count', v_recipient_slot_count,
        'total_gains_before', v_total,
        'base_gain', v_base,
        'remainder_gain', v_remainder,
        'closed_slots', v_closed_slots
      )::text,
      'sha256'
    ),
    'hex'
  );

  return jsonb_build_object(
    'ok', true,
    'algorithm_version', 'CLOSED_POOL_V2',
    'asset', v_asset,
    'target_slot_count', v_target,
    'recipient_slot_count', v_recipient_slot_count,
    'closed_slot_count', v_closed_slot_count,
    'ignored_open_slot_count', v_ignored_open_slot_count,
    'zeroed_slot_count', v_zeroed_slot_count,
    'total_gains_before', v_total,
    'total_gains_after', v_total,
    'base_gain', v_base,
    'remainder_gain', v_remainder,
    'snapshot_hash', v_hash,
    'snapshot_before', v_snapshot_before,
    'snapshot_after', v_snapshot_after,
    'closed_slots', v_closed_slots
  );
end;
$redistribution_preview$;

create or replace function public.confirm_slot_gain_redistribution(
  p_asset text,
  p_snapshot_hash text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $redistribution_confirm$
declare
  v_user_id uuid := auth.uid();
  v_asset text := upper(trim(p_asset));
  v_preview jsonb := '{}'::jsonb;
  v_result jsonb;
  v_existing jsonb;
  v_target integer;
  v_updated integer;
  v_after_total bigint;
  v_audit_id uuid;
  v_error_message text;
begin
  v_target := case v_asset when 'BTC' then 15 when 'SOL' then 6 else null end;

  if v_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHORIZED', 'message', 'Usuario nao autorizado.');
  end if;

  if v_target is null or nullif(trim(p_snapshot_hash), '') is null or p_idempotency_key is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_REQUEST', 'message', 'Solicitacao de redistribuicao invalida.');
  end if;

  if not pg_try_advisory_xact_lock(hashtextextended('slot_gain_redistribution:' || v_user_id::text || ':' || v_asset, 0)) then
    return jsonb_build_object('ok', false, 'code', 'CONFLICT_IN_PROGRESS', 'message', 'Ja existe uma redistribuicao em andamento para este ativo.');
  end if;

  select result into v_existing
  from public.slot_gain_redistributions
  where user_id = v_user_id and idempotency_key = p_idempotency_key;

  if found then
    return v_existing;
  end if;

  perform 1
  from public.slots sl
  where sl.user_id = v_user_id
    and exists (
      select 1
      from public.strategies st
      where st.id = sl.strategy_id
        and upper(st.asset) = v_asset
    )
  for update;

  v_preview := public.slot_gain_redistribution_preview_for_user(v_user_id, v_asset);

  if coalesce((v_preview ->> 'ok')::boolean, false) is false then
    v_result := v_preview;
    insert into public.slot_gain_redistributions (
      user_id, asset, action_type, target_slot_count, total_gains_before, total_gains_after,
      base_gain, remainder_gain, status, idempotency_key, result, error_code, error_message
    ) values (
      v_user_id, v_asset, 'REDISTRIBUTION', v_target, 0, 0, null, null, 'FAILED', p_idempotency_key,
      v_result, v_result ->> 'code', v_result ->> 'message'
    );
    return v_result;
  end if;

  if (v_preview ->> 'snapshot_hash') <> p_snapshot_hash then
    v_result := jsonb_build_object(
      'ok', false,
      'code', 'PREVIEW_STALE',
      'message', 'Os slots foram atualizados desde a previa. Gere uma nova previa antes de confirmar.',
      'asset', v_asset
    );
    insert into public.slot_gain_redistributions (
      user_id, asset, action_type, target_slot_count, total_gains_before, total_gains_after,
      base_gain, remainder_gain, status, idempotency_key, snapshot_before, snapshot_after,
      result, error_code, error_message
    ) values (
      v_user_id, v_asset, 'REDISTRIBUTION', v_target,
      coalesce((v_preview ->> 'total_gains_before')::bigint, 0),
      coalesce((v_preview ->> 'total_gains_after')::bigint, 0),
      (v_preview ->> 'base_gain')::integer, (v_preview ->> 'remainder_gain')::integer,
      'FAILED', p_idempotency_key, v_preview -> 'snapshot_before', v_preview -> 'snapshot_after',
      v_result, 'PREVIEW_STALE', v_result ->> 'message'
    );
    return v_result;
  end if;

  begin
    update public.slots sl
    set gains_distribuidos = (item ->> 'gains_after')::integer
    from jsonb_array_elements(v_preview -> 'snapshot_after') item
    where sl.id = (item ->> 'slot_id')::uuid
      and sl.user_id = v_user_id
      and public.is_closed_slot_status(sl.status);

    get diagnostics v_updated = row_count;

    if v_updated <> (v_preview ->> 'closed_slot_count')::integer then
      raise exception 'Quantidade de slots fechados atualizada inesperada: % de %.', v_updated, (v_preview ->> 'closed_slot_count')::integer;
    end if;

    select coalesce(sum(sl.gains_distribuidos), 0)::bigint into v_after_total
    from public.slots sl
    join public.strategies st on st.id = sl.strategy_id
    where sl.user_id = v_user_id
      and upper(st.asset) = v_asset
      and public.is_closed_slot_status(sl.status);

    if v_after_total <> (v_preview ->> 'total_gains_before')::bigint then
      raise exception 'A soma de gains distribuidos dos slots fechados nao foi preservada.';
    end if;

    insert into public.slot_gain_redistributions (
      user_id, asset, action_type, target_slot_count, total_gains_before, total_gains_after,
      base_gain, remainder_gain, status, idempotency_key, snapshot_before, snapshot_after,
      result, completed_at
    ) values (
      v_user_id, v_asset, 'REDISTRIBUTION', v_target,
      (v_preview ->> 'total_gains_before')::bigint,
      (v_preview ->> 'total_gains_after')::bigint,
      (v_preview ->> 'base_gain')::integer, (v_preview ->> 'remainder_gain')::integer,
      'COMPLETED', p_idempotency_key, v_preview -> 'snapshot_before', v_preview -> 'snapshot_after',
      jsonb_build_object(
        'ok', true,
        'algorithm_version', 'CLOSED_POOL_V2',
        'asset', v_asset,
        'target_slot_count', v_target,
        'recipient_slot_count', (v_preview ->> 'recipient_slot_count')::integer,
        'closed_slot_count', (v_preview ->> 'closed_slot_count')::integer,
        'ignored_open_slot_count', (v_preview ->> 'ignored_open_slot_count')::integer,
        'zeroed_slot_count', (v_preview ->> 'zeroed_slot_count')::integer,
        'total_gains_before', (v_preview ->> 'total_gains_before')::bigint,
        'total_gains_after', (v_preview ->> 'total_gains_after')::bigint
      ),
      now()
    ) returning id, result into v_audit_id, v_result;

    v_result := v_result || jsonb_build_object(
      'audit_id', v_audit_id,
      'message', format('Gains redistribuidos com sucesso entre %s slots fechados de %s.', (v_preview ->> 'recipient_slot_count')::integer, v_asset)
    );
    update public.slot_gain_redistributions set result = v_result where id = v_audit_id;
    return v_result;
  exception when others then
    v_error_message := sqlerrm;
  end;

  v_result := jsonb_build_object(
    'ok', false,
    'code', 'REDISTRIBUTION_FAILED',
    'message', 'Nao foi possivel concluir a redistribuicao. Nenhum gain foi alterado.',
    'asset', v_asset
  );

  insert into public.slot_gain_redistributions (
    user_id, asset, action_type, target_slot_count, total_gains_before, total_gains_after,
    base_gain, remainder_gain, status, idempotency_key, snapshot_before, snapshot_after,
    result, error_code, error_message
  ) values (
    v_user_id, v_asset, 'REDISTRIBUTION', v_target,
    coalesce((v_preview ->> 'total_gains_before')::bigint, 0),
    coalesce((v_preview ->> 'total_gains_after')::bigint, 0),
    nullif(v_preview ->> 'base_gain', '')::integer, nullif(v_preview ->> 'remainder_gain', '')::integer,
    'FAILED', p_idempotency_key, coalesce(v_preview -> 'snapshot_before', '[]'::jsonb),
    coalesce(v_preview -> 'snapshot_after', '[]'::jsonb), v_result, 'REDISTRIBUTION_FAILED', v_error_message
  );

  return v_result;
end;
$redistribution_confirm$;

create or replace function public.undo_last_slot_gain_redistribution(
  p_asset text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $redistribution_undo$
declare
  v_user_id uuid := auth.uid();
  v_asset text := upper(trim(p_asset));
  v_target integer;
  v_source public.slot_gain_redistributions%rowtype;
  v_existing jsonb;
  v_valid boolean;
  v_result jsonb;
  v_audit_id uuid;
  v_error_message text;
begin
  v_target := case v_asset when 'BTC' then 15 when 'SOL' then 6 else null end;

  if v_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHORIZED', 'message', 'Usuario nao autorizado.');
  end if;

  if v_target is null or p_idempotency_key is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_REQUEST', 'message', 'Solicitacao de desfazer invalida.');
  end if;

  if not pg_try_advisory_xact_lock(hashtextextended('slot_gain_redistribution:' || v_user_id::text || ':' || v_asset, 0)) then
    return jsonb_build_object('ok', false, 'code', 'CONFLICT_IN_PROGRESS', 'message', 'Ja existe uma redistribuicao em andamento para este ativo.');
  end if;

  select result into v_existing
  from public.slot_gain_redistributions
  where user_id = v_user_id and idempotency_key = p_idempotency_key;

  if found then
    return v_existing;
  end if;

  perform 1
  from public.slots sl
  where sl.user_id = v_user_id
    and exists (
      select 1
      from public.strategies st
      where st.id = sl.strategy_id
        and upper(st.asset) = v_asset
    )
  for update;

  select * into v_source
  from public.slot_gain_redistributions
  where user_id = v_user_id
    and asset = v_asset
    and action_type = 'REDISTRIBUTION'
    and status = 'COMPLETED'
  order by created_at desc
  limit 1
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'UNDO_UNAVAILABLE', 'message', 'Nao existe uma redistribuicao segura para desfazer neste ativo.');
  end if;

  select coalesce(bool_and(
    sl.id is not null
    and sl.gains_distribuidos = (item ->> 'gains_after')::integer
    and sl.gains = (item ->> 'gains_real')::integer
    and sl.status is not distinct from item ->> 'status'
    and public.is_closed_slot_status(sl.status)
  ), false)
  into v_valid
  from jsonb_array_elements(v_source.snapshot_after) item
  left join public.slots sl
    on sl.id = (item ->> 'slot_id')::uuid
   and sl.user_id = v_user_id;

  if not v_valid then
    return jsonb_build_object('ok', false, 'code', 'UNDO_UNSAFE', 'message', 'Os slots foram alterados depois da redistribuicao. O desfazer foi bloqueado para preservar a integridade.');
  end if;

  begin
    update public.slots sl
    set gains_distribuidos = (item ->> 'gains_before')::integer
    from jsonb_array_elements(v_source.snapshot_before) item
    where sl.id = (item ->> 'slot_id')::uuid
      and sl.user_id = v_user_id
      and public.is_closed_slot_status(sl.status);

    update public.slot_gain_redistributions
    set status = 'UNDONE'
    where id = v_source.id;

    v_result := jsonb_build_object(
      'ok', true,
      'asset', v_asset,
      'target_slot_count', v_source.target_slot_count,
      'algorithm_version', coalesce(v_source.result ->> 'algorithm_version', 'LEGACY'),
      'message', format('Ultima redistribuicao de %s foi desfeita com seguranca.', v_asset)
    );

    insert into public.slot_gain_redistributions (
      user_id, parent_redistribution_id, asset, action_type, target_slot_count,
      total_gains_before, total_gains_after, base_gain, remainder_gain, status,
      idempotency_key, snapshot_before, snapshot_after, result, completed_at
    ) values (
      v_user_id, v_source.id, v_asset, 'UNDO', v_source.target_slot_count,
      v_source.total_gains_after, v_source.total_gains_before, v_source.base_gain,
      v_source.remainder_gain, 'COMPLETED', p_idempotency_key,
      v_source.snapshot_after, v_source.snapshot_before, v_result, now()
    ) returning id into v_audit_id;

    v_result := v_result || jsonb_build_object('audit_id', v_audit_id);
    update public.slot_gain_redistributions set result = v_result where id = v_audit_id;
    return v_result;
  exception when others then
    v_error_message := sqlerrm;
  end;

  v_result := jsonb_build_object('ok', false, 'code', 'UNDO_FAILED', 'message', 'Nao foi possivel desfazer a redistribuicao. Nenhum gain foi alterado.');
  insert into public.slot_gain_redistributions (
    user_id, parent_redistribution_id, asset, action_type, target_slot_count,
    total_gains_before, total_gains_after, base_gain, remainder_gain, status,
    idempotency_key, snapshot_before, snapshot_after, result, error_code, error_message
  ) values (
    v_user_id, v_source.id, v_asset, 'UNDO', v_source.target_slot_count,
    v_source.total_gains_after, v_source.total_gains_before, v_source.base_gain,
    v_source.remainder_gain, 'FAILED', p_idempotency_key,
    v_source.snapshot_after, v_source.snapshot_before, v_result, 'UNDO_FAILED', v_error_message
  );
  return v_result;
end;
$redistribution_undo$;

revoke all on function public.is_closed_slot_status(text) from public, anon, authenticated;
revoke all on function public.is_open_slot_status(text) from public, anon, authenticated;
revoke all on function public.slot_gain_redistribution_preview_for_user(uuid, text) from public, anon, authenticated;
revoke all on function public.preview_slot_gain_redistribution(text) from public, anon;
revoke all on function public.confirm_slot_gain_redistribution(text, text, uuid) from public, anon;
revoke all on function public.undo_last_slot_gain_redistribution(text, uuid) from public, anon;
grant execute on function public.preview_slot_gain_redistribution(text) to authenticated;
grant execute on function public.confirm_slot_gain_redistribution(text, text, uuid) to authenticated;
grant execute on function public.undo_last_slot_gain_redistribution(text, uuid) to authenticated;

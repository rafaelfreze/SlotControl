-- Redistribuicao operacional de gains.
-- O campo gains continua sendo a base financeira/historica do slot. Esta migracao
-- adiciona um contador separado para nivelamento operacional, sem alterar valores,
-- precos, status ou historico de operacoes.

alter table public.slots
  add column if not exists gains_distribuidos integer;

update public.slots
set gains_distribuidos = gains
where gains_distribuidos is null;

alter table public.slots
  alter column gains_distribuidos set default 0,
  alter column gains_distribuidos set not null;

alter table public.slots
  drop constraint if exists slots_gains_distribuidos_nonnegative;

alter table public.slots
  add constraint slots_gains_distribuidos_nonnegative
  check (gains_distribuidos >= 0);

-- Mantem o contador operacional acompanhando alteracoes reais de gains. A
-- redistribuicao envia gains_distribuidos explicitamente e, portanto, nao entra
-- neste caminho.
create or replace function public.sync_gains_distribuidos_on_real_gain_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.gains is distinct from old.gains
    and new.gains_distribuidos is not distinct from old.gains_distribuidos then
    new.gains_distribuidos := greatest(0, old.gains_distribuidos + (new.gains - old.gains));
  end if;

  return new;
end;
$$;

drop trigger if exists slots_sync_gains_distribuidos on public.slots;
create trigger slots_sync_gains_distribuidos
before update on public.slots
for each row execute function public.sync_gains_distribuidos_on_real_gain_change();

create table if not exists public.slot_gain_redistributions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  parent_redistribution_id uuid references public.slot_gain_redistributions(id),
  asset text not null check (asset in ('BTC', 'SOL')),
  action_type text not null check (action_type in ('REDISTRIBUTION', 'UNDO')),
  target_slot_count integer not null check (target_slot_count > 0),
  total_gains_before integer not null check (total_gains_before >= 0),
  total_gains_after integer not null check (total_gains_after >= 0),
  base_gain integer,
  remainder_gain integer,
  status text not null check (status in ('COMPLETED', 'UNDONE', 'FAILED')),
  idempotency_key uuid not null,
  snapshot_before jsonb not null default '[]'::jsonb,
  snapshot_after jsonb not null default '[]'::jsonb,
  result jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (user_id, idempotency_key)
);

create index if not exists slot_gain_redistributions_user_asset_created_idx
  on public.slot_gain_redistributions (user_id, asset, created_at desc);

create index if not exists slot_gain_redistributions_parent_idx
  on public.slot_gain_redistributions (parent_redistribution_id);

alter table public.slot_gain_redistributions enable row level security;

drop policy if exists "Users can read own gain redistributions" on public.slot_gain_redistributions;
create policy "Users can read own gain redistributions"
on public.slot_gain_redistributions
for select
to authenticated
using ((select auth.uid()) = user_id);

revoke all on table public.slot_gain_redistributions from public, anon, authenticated;
grant select on table public.slot_gain_redistributions to authenticated;
grant all on table public.slot_gain_redistributions to service_role;

create or replace function public.slot_gain_redistribution_preview_for_user(
  p_user_id uuid,
  p_asset text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_asset text := upper(trim(p_asset));
  v_target integer;
  v_count integer;
  v_total integer;
  v_base integer;
  v_remainder integer;
  v_snapshot_before jsonb;
  v_snapshot_after jsonb;
  v_selected_slots jsonb;
  v_hash text;
begin
  v_target := case v_asset when 'BTC' then 15 when 'SOL' then 6 else null end;

  if p_user_id is null or v_target is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_ASSET', 'message', 'Ativo invalido para redistribuicao.');
  end if;

  with ranked as (
    select
      sl.id,
      sl.slot_number,
      sl.sort_order,
      sl.status,
      sl.gains as gains_reais,
      sl.gains_distribuidos as gains_before,
      sl.updated_at,
      count(*) filter (where sl.status = 'aberto') over () as open_count,
      row_number() over (
        partition by (sl.status = 'aberto')
        order by sl.gains_distribuidos asc, sl.slot_number asc, sl.sort_order asc, sl.id asc
      ) as low_gain_rank
    from public.slots sl
    join public.strategies st on st.id = sl.strategy_id
    where sl.user_id = p_user_id
      and upper(st.asset) = v_asset
      and sl.gains_distribuidos >= 0
  ),
  selected as (
    select *,
      case when status = 'aberto' then 'OPEN_SLOT' else 'CLOSED_LOWEST_GAIN' end as selection_reason
    from ranked
    where
      (status = 'aberto' and (open_count <= v_target or low_gain_rank <= v_target))
      or (status <> 'aberto' and open_count < v_target and low_gain_rank <= v_target - open_count)
  ),
  distributed as (
    select
      selected.*,
      sum(gains_before) over ()::integer as total_before,
      row_number() over (order by gains_before asc, slot_number asc, sort_order asc, id asc) as distribution_rank
    from selected
  ),
  calculated as (
    select
      distributed.*,
      (total_before / v_target)::integer as base_gain,
      (total_before % v_target)::integer as remainder_gain
    from distributed
  ),
  final_slots as (
    select
      calculated.*,
      base_gain + case when distribution_rank <= remainder_gain then 1 else 0 end as gains_after
    from calculated
  )
  select
    count(*)::integer,
    coalesce(max(total_before), 0)::integer,
    coalesce(max(base_gain), 0)::integer,
    coalesce(max(remainder_gain), 0)::integer,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'slot_id', id,
          'slot_number', slot_number,
          'sort_order', sort_order,
          'status', status,
          'gains_real', gains_reais,
          'gains_before', gains_before,
          'selection_reason', selection_reason,
          'updated_at', updated_at
        ) order by slot_number asc, sort_order asc, id asc
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
          'gains_real', gains_reais,
          'gains_after', gains_after,
          'selection_reason', selection_reason,
          'updated_at', updated_at
        ) order by slot_number asc, sort_order asc, id asc
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
          'gains_real', gains_reais,
          'gains_before', gains_before,
          'gains_after', gains_after,
          'selection_reason', selection_reason,
          'updated_at', updated_at
        ) order by slot_number asc, sort_order asc, id asc
      ),
      '[]'::jsonb
    )
  into v_count, v_total, v_base, v_remainder, v_snapshot_before, v_snapshot_after, v_selected_slots
  from final_slots;

  if v_count <> v_target then
    return jsonb_build_object(
      'ok', false,
      'code', 'INSUFFICIENT_SLOTS',
      'message', 'Nao ha slots suficientes para completar a redistribuicao.',
      'asset', v_asset,
      'target_slot_count', v_target,
      'available_slot_count', v_count
    );
  end if;

  v_hash := encode(
    digest(
      jsonb_build_object(
        'asset', v_asset,
        'target_slot_count', v_target,
        'total_gains_before', v_total,
        'base_gain', v_base,
        'remainder_gain', v_remainder,
        'selected_slots', v_selected_slots
      )::text,
      'sha256'
    ),
    'hex'
  );

  return jsonb_build_object(
    'ok', true,
    'asset', v_asset,
    'target_slot_count', v_target,
    'open_slot_count', (select count(*) from jsonb_array_elements(v_selected_slots) item where item ->> 'status' = 'aberto'),
    'closed_slot_count', (select count(*) from jsonb_array_elements(v_selected_slots) item where item ->> 'status' <> 'aberto'),
    'total_gains_before', v_total,
    'total_gains_after', v_total,
    'base_gain', v_base,
    'remainder_gain', v_remainder,
    'snapshot_hash', v_hash,
    'snapshot_before', v_snapshot_before,
    'snapshot_after', v_snapshot_after,
    'selected_slots', v_selected_slots
  );
end;
$$;

create or replace function public.preview_slot_gain_redistribution(p_asset text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'UNAUTHORIZED', 'message', 'Usuario nao autorizado.');
  end if;

  return public.slot_gain_redistribution_preview_for_user(v_user_id, p_asset);
end;
$$;

create or replace function public.confirm_slot_gain_redistribution(
  p_asset text,
  p_snapshot_hash text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_asset text := upper(trim(p_asset));
  v_preview jsonb := '{}'::jsonb;
  v_result jsonb;
  v_existing jsonb;
  v_target integer;
  v_updated integer;
  v_after_total integer;
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
      coalesce((v_preview ->> 'total_gains_before')::integer, 0),
      coalesce((v_preview ->> 'total_gains_after')::integer, 0),
      (v_preview ->> 'base_gain')::integer, (v_preview ->> 'remainder_gain')::integer,
      'FAILED', p_idempotency_key, v_preview -> 'snapshot_before', v_preview -> 'snapshot_after',
      v_result, 'PREVIEW_STALE', v_result ->> 'message'
    );
    return v_result;
  end if;

  begin
    update public.slots sl
    set gains_distribuidos = (item ->> 'gains_after')::integer
    from jsonb_array_elements(v_preview -> 'selected_slots') item
    where sl.id = (item ->> 'slot_id')::uuid
      and sl.user_id = v_user_id;

    get diagnostics v_updated = row_count;

    if v_updated <> v_target then
      raise exception 'Quantidade de slots atualizada inesperada: % de %.', v_updated, v_target;
    end if;

    select sum(sl.gains_distribuidos)::integer into v_after_total
    from public.slots sl
    join jsonb_array_elements(v_preview -> 'selected_slots') item
      on sl.id = (item ->> 'slot_id')::uuid
    where sl.user_id = v_user_id;

    if v_after_total <> (v_preview ->> 'total_gains_before')::integer then
      raise exception 'A soma de gains distribuidos nao foi preservada.';
    end if;

    insert into public.slot_gain_redistributions (
      user_id, asset, action_type, target_slot_count, total_gains_before, total_gains_after,
      base_gain, remainder_gain, status, idempotency_key, snapshot_before, snapshot_after,
      completed_at
    ) values (
      v_user_id, v_asset, 'REDISTRIBUTION', v_target,
      (v_preview ->> 'total_gains_before')::integer,
      (v_preview ->> 'total_gains_after')::integer,
      (v_preview ->> 'base_gain')::integer,
      (v_preview ->> 'remainder_gain')::integer,
      'COMPLETED', p_idempotency_key, v_preview -> 'snapshot_before', v_preview -> 'snapshot_after', now()
    ) returning id into v_audit_id;

    v_result := jsonb_build_object(
      'ok', true,
      'asset', v_asset,
      'target_slot_count', v_target,
      'total_gains_before', v_preview -> 'total_gains_before',
      'total_gains_after', v_preview -> 'total_gains_after',
      'audit_id', v_audit_id,
      'message', format('Gains redistribuidos com sucesso entre %s slots de %s.', v_target, v_asset)
    );

    update public.slot_gain_redistributions
    set result = v_result
    where id = v_audit_id;

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
    coalesce((v_preview ->> 'total_gains_before')::integer, 0),
    coalesce((v_preview ->> 'total_gains_after')::integer, 0),
    nullif(v_preview ->> 'base_gain', '')::integer, nullif(v_preview ->> 'remainder_gain', '')::integer,
    'FAILED', p_idempotency_key, coalesce(v_preview -> 'snapshot_before', '[]'::jsonb),
    coalesce(v_preview -> 'snapshot_after', '[]'::jsonb), v_result, 'REDISTRIBUTION_FAILED', v_error_message
  );

  return v_result;
end;
$$;

create or replace function public.undo_last_slot_gain_redistribution(
  p_asset text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
    sl.gains_distribuidos = (item ->> 'gains_after')::integer
    and sl.gains = (item ->> 'gains_real')::integer
  ), false)
  into v_valid
  from jsonb_array_elements(v_source.snapshot_after) item
  left join public.slots sl
    on sl.id = (item ->> 'slot_id')::uuid
   and sl.user_id = v_user_id;

  if not v_valid then
    return jsonb_build_object('ok', false, 'code', 'UNDO_UNSAFE', 'message', 'Os gains dos slots foram alterados depois da redistribuicao. O desfazer foi bloqueado para preservar a integridade.');
  end if;

  begin
    update public.slots sl
    set gains_distribuidos = (item ->> 'gains_before')::integer
    from jsonb_array_elements(v_source.snapshot_before) item
    where sl.id = (item ->> 'slot_id')::uuid
      and sl.user_id = v_user_id;

    update public.slot_gain_redistributions
    set status = 'UNDONE'
    where id = v_source.id;

    v_result := jsonb_build_object(
      'ok', true,
      'asset', v_asset,
      'target_slot_count', v_source.target_slot_count,
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
$$;

revoke all on function public.slot_gain_redistribution_preview_for_user(uuid, text) from public, anon, authenticated;
revoke all on function public.preview_slot_gain_redistribution(text) from public, anon;
revoke all on function public.confirm_slot_gain_redistribution(text, text, uuid) from public, anon;
revoke all on function public.undo_last_slot_gain_redistribution(text, uuid) from public, anon;
grant execute on function public.preview_slot_gain_redistribution(text) to authenticated;
grant execute on function public.confirm_slot_gain_redistribution(text, text, uuid) to authenticated;
grant execute on function public.undo_last_slot_gain_redistribution(text, uuid) to authenticated;

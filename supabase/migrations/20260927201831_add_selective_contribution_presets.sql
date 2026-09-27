-- Configurable selection presets for the existing selective contribution
-- service. Presets select slots only and never mutate capital or orders.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

create table coinops.robot_v1_live_selective_contribution_presets (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  operator_id uuid not null,
  name text not null check(length(btrim(name)) between 3 and 80),
  total_slots integer not null check(total_slots between 1 and 25),
  open_slots integer not null check(open_slots between 1 and 25),
  following_slots integer not null check(following_slots between 0 and 24),
  status text not null default 'ACTIVE' check(status in ('ACTIVE','DISABLED')),
  built_in boolean not null default false,
  default_key text check(default_key in ('OPEN_1_BELOW_4','OPEN_2_BELOW_3')),
  usage_count integer not null default 0 check(usage_count>=0),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(total_slots=open_slots+following_slots),
  foreign key(operator_id,product_id,tenant_id,user_id)
    references coinops.operators(id,product_id,tenant_id,user_id) on delete restrict
);
create unique index robot_v1_live_selective_presets_name_uidx
  on coinops.robot_v1_live_selective_contribution_presets(operator_id,lower(name));
create unique index robot_v1_live_selective_presets_default_uidx
  on coinops.robot_v1_live_selective_contribution_presets(operator_id,default_key)
  where default_key is not null;
create index robot_v1_live_selective_presets_active_idx
  on coinops.robot_v1_live_selective_contribution_presets(operator_id,status,updated_at desc);
create trigger robot_v1_live_selective_presets_touch
  before update on coinops.robot_v1_live_selective_contribution_presets
  for each row execute function private.coinops_touch_updated_at();

create table coinops.robot_v1_live_selective_contribution_preset_usages (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  tenant_id uuid not null,
  user_id uuid not null,
  operator_id uuid not null,
  preset_id uuid not null references coinops.robot_v1_live_selective_contribution_presets(id) on delete restrict,
  trading_engine_id uuid not null,
  request_id uuid not null,
  anchor_slot_number integer not null check(anchor_slot_number between 1 and 25),
  resolved_slot_numbers integer[] not null check(cardinality(resolved_slot_numbers) between 1 and 25),
  created_at timestamptz not null default now(),
  unique(operator_id,request_id),
  foreign key(operator_id,product_id,tenant_id,user_id)
    references coinops.operators(id,product_id,tenant_id,user_id) on delete restrict,
  foreign key(trading_engine_id)
    references coinops.trading_engines(id) on delete restrict
);

alter table coinops.robot_v1_live_selective_contribution_presets enable row level security;
alter table coinops.robot_v1_live_selective_contribution_presets force row level security;
alter table coinops.robot_v1_live_selective_contribution_preset_usages enable row level security;
alter table coinops.robot_v1_live_selective_contribution_preset_usages force row level security;
create policy selective_contribution_presets_owner_read
  on coinops.robot_v1_live_selective_contribution_presets for select to authenticated
  using(private.coinops_operator_owned(operator_id));
create policy selective_contribution_preset_usages_owner_read
  on coinops.robot_v1_live_selective_contribution_preset_usages for select to authenticated
  using(private.coinops_operator_owned(operator_id));
revoke all on coinops.robot_v1_live_selective_contribution_presets,
  coinops.robot_v1_live_selective_contribution_preset_usages from public,anon,authenticated;
grant select on coinops.robot_v1_live_selective_contribution_presets,
  coinops.robot_v1_live_selective_contribution_preset_usages to authenticated;
grant all on coinops.robot_v1_live_selective_contribution_presets,
  coinops.robot_v1_live_selective_contribution_preset_usages to service_role;

create function private.coinops_seed_selective_contribution_presets() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  insert into coinops.robot_v1_live_selective_contribution_presets
    (product_id,tenant_id,user_id,operator_id,name,total_slots,open_slots,following_slots,
      built_in,default_key,created_by)
  values
    (new.product_id,new.tenant_id,new.user_id,new.id,'1 aberto + 4 abaixo',5,1,4,true,'OPEN_1_BELOW_4',new.user_id),
    (new.product_id,new.tenant_id,new.user_id,new.id,'2 abertos + 3 abaixo',5,2,3,true,'OPEN_2_BELOW_3',new.user_id)
  on conflict do nothing;
  return new;
end $$;
revoke all on function private.coinops_seed_selective_contribution_presets() from public,anon,authenticated;
create trigger operators_seed_selective_contribution_presets
  after insert on coinops.operators for each row
  execute function private.coinops_seed_selective_contribution_presets();

insert into coinops.robot_v1_live_selective_contribution_presets
  (product_id,tenant_id,user_id,operator_id,name,total_slots,open_slots,following_slots,
    built_in,default_key,created_by)
select product_id,tenant_id,user_id,id,'1 aberto + 4 abaixo',5,1,4,true,'OPEN_1_BELOW_4',user_id
from coinops.operators
union all
select product_id,tenant_id,user_id,id,'2 abertos + 3 abaixo',5,2,3,true,'OPEN_2_BELOW_3',user_id
from coinops.operators
on conflict do nothing;

create function coinops.manage_live_selective_contribution_preset(
  p_operator_id uuid,p_actor_id uuid,p_action text,p_preset_id uuid,
  p_name text,p_total_slots integer,p_open_slots integer,p_following_slots integer,
  p_enabled boolean
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_operator coinops.operators%rowtype;
  v_preset coinops.robot_v1_live_selective_contribution_presets%rowtype;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','')<>'service_role'
    or p_operator_id is null or p_actor_id is null
    or p_action not in ('CREATE','UPDATE','TOGGLE','DELETE') then
    raise exception 'COINOPS_SELECTIVE_PRESET_INPUT_DENIED';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_operator_id::text||':selective-presets',0));
  select * into v_operator from coinops.operators
    where id=p_operator_id and status='ACTIVE' and user_id=p_actor_id for share;
  if v_operator.id is null then raise exception 'COINOPS_SELECTIVE_PRESET_SCOPE_DENIED'; end if;
  if p_action='CREATE' then
    if p_preset_id is not null or length(btrim(coalesce(p_name,''))) not between 3 and 80
      or p_total_slots not between 1 and 25 or p_open_slots not between 1 and 25
      or p_following_slots not between 0 and 24
      or p_total_slots<>p_open_slots+p_following_slots then
      raise exception 'COINOPS_SELECTIVE_PRESET_CONFIGURATION_INVALID';
    end if;
    insert into coinops.robot_v1_live_selective_contribution_presets
      (product_id,tenant_id,user_id,operator_id,name,total_slots,open_slots,following_slots,created_by)
    values(v_operator.product_id,v_operator.tenant_id,v_operator.user_id,v_operator.id,btrim(p_name),
      p_total_slots,p_open_slots,p_following_slots,p_actor_id) returning * into v_preset;
  else
    select * into v_preset from coinops.robot_v1_live_selective_contribution_presets
      where id=p_preset_id and operator_id=p_operator_id for update;
    if v_preset.id is null then raise exception 'COINOPS_SELECTIVE_PRESET_NOT_FOUND'; end if;
    if p_action='UPDATE' then
      if length(btrim(coalesce(p_name,''))) not between 3 and 80
        or p_total_slots not between 1 and 25 or p_open_slots not between 1 and 25
        or p_following_slots not between 0 and 24
        or p_total_slots<>p_open_slots+p_following_slots then
        raise exception 'COINOPS_SELECTIVE_PRESET_CONFIGURATION_INVALID';
      end if;
      update coinops.robot_v1_live_selective_contribution_presets set
        name=btrim(p_name),total_slots=p_total_slots,open_slots=p_open_slots,
        following_slots=p_following_slots where id=v_preset.id returning * into v_preset;
    elsif p_action='TOGGLE' then
      if p_enabled is null then raise exception 'COINOPS_SELECTIVE_PRESET_INPUT_DENIED'; end if;
      update coinops.robot_v1_live_selective_contribution_presets
        set status=case when p_enabled then 'ACTIVE' else 'DISABLED' end
        where id=v_preset.id returning * into v_preset;
    else
      if v_preset.built_in or v_preset.usage_count>0 then
        update coinops.robot_v1_live_selective_contribution_presets set status='DISABLED'
          where id=v_preset.id returning * into v_preset;
        return jsonb_build_object('id',v_preset.id,'status','DISABLED_USED','deleted',false);
      end if;
      delete from coinops.robot_v1_live_selective_contribution_presets where id=v_preset.id;
      return jsonb_build_object('id',v_preset.id,'status','DELETED','deleted',true);
    end if;
  end if;
  return jsonb_build_object('id',v_preset.id,'status',v_preset.status,'deleted',false);
exception when unique_violation then
  raise exception 'COINOPS_SELECTIVE_PRESET_NAME_CONFLICT';
end $$;
revoke all on function coinops.manage_live_selective_contribution_preset(uuid,uuid,text,uuid,text,integer,integer,integer,boolean)
  from public,anon,authenticated;
grant execute on function coinops.manage_live_selective_contribution_preset(uuid,uuid,text,uuid,text,integer,integer,integer,boolean)
  to service_role;

create function coinops.mark_live_selective_contribution_preset_usage(
  p_operator_id uuid,p_actor_id uuid,p_preset_id uuid,p_engine_id uuid,
  p_request_id uuid,p_anchor_slot_number integer,p_resolved_slot_numbers integer[]
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_operator coinops.operators%rowtype;
  v_preset coinops.robot_v1_live_selective_contribution_presets%rowtype;
  v_usage coinops.robot_v1_live_selective_contribution_preset_usages%rowtype;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.jwt()->>'role','')<>'service_role'
    or p_request_id is null or p_anchor_slot_number not between 1 and 25
    or cardinality(p_resolved_slot_numbers) not between 1 and 25
    or cardinality(p_resolved_slot_numbers)<>cardinality(array(select distinct unnest(p_resolved_slot_numbers)))
    or not (p_anchor_slot_number=any(p_resolved_slot_numbers)) then
    raise exception 'COINOPS_SELECTIVE_PRESET_USAGE_DENIED';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_operator_id::text||':'||p_request_id::text,0));
  select * into v_usage from coinops.robot_v1_live_selective_contribution_preset_usages
    where operator_id=p_operator_id and request_id=p_request_id;
  if v_usage.id is not null then
    if v_usage.preset_id<>p_preset_id or v_usage.trading_engine_id<>p_engine_id
      or v_usage.anchor_slot_number<>p_anchor_slot_number
      or v_usage.resolved_slot_numbers<>p_resolved_slot_numbers then
      raise exception 'COINOPS_SELECTIVE_PRESET_USAGE_REPLAY_CONFLICT';
    end if;
    return jsonb_build_object('id',v_usage.id,'status','REPLAYED');
  end if;
  select * into v_operator from coinops.operators
    where id=p_operator_id and status='ACTIVE' and user_id=p_actor_id for share;
  select * into v_preset from coinops.robot_v1_live_selective_contribution_presets
    where id=p_preset_id and operator_id=p_operator_id and status='ACTIVE' for update;
  if v_operator.id is null or v_preset.id is null
    or v_preset.total_slots<>cardinality(p_resolved_slot_numbers)
    or not exists(select 1 from coinops.trading_engines where id=p_engine_id
      and operator_id=p_operator_id and environment='REAL' and status='ACTIVE') then
    raise exception 'COINOPS_SELECTIVE_PRESET_USAGE_DENIED';
  end if;
  insert into coinops.robot_v1_live_selective_contribution_preset_usages
    (product_id,tenant_id,user_id,operator_id,preset_id,trading_engine_id,request_id,
      anchor_slot_number,resolved_slot_numbers)
  values(v_operator.product_id,v_operator.tenant_id,v_operator.user_id,p_operator_id,p_preset_id,
    p_engine_id,p_request_id,p_anchor_slot_number,p_resolved_slot_numbers) returning * into v_usage;
  update coinops.robot_v1_live_selective_contribution_presets
    set usage_count=usage_count+1 where id=p_preset_id;
  return jsonb_build_object('id',v_usage.id,'status','RECORDED');
end $$;
revoke all on function coinops.mark_live_selective_contribution_preset_usage(uuid,uuid,uuid,uuid,uuid,integer,integer[])
  from public,anon,authenticated;
grant execute on function coinops.mark_live_selective_contribution_preset_usage(uuid,uuid,uuid,uuid,uuid,integer,integer[])
  to service_role;

commit;

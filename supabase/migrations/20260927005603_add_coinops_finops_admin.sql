-- CoinOps FinOps is administrative observability, isolated from trading tables.
begin;
set local lock_timeout='3s';
set local statement_timeout='60s';
create table coinops.finops_services (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  operator_id uuid not null references coinops.operators(id) on delete restrict,
  service_key text not null check(length(service_key) between 1 and 150),
  provider text not null check(length(provider) between 1 and 80),
  name text not null check(length(name) between 1 and 150),
  shard_id text references coinops.executor_shards(id) on delete restrict,
  plan text, region text, resource_id text,
  currency text not null default 'USD' check(currency in ('USD','BRL')),
  recurring_monthly numeric(18,4) check(recurring_monthly>=0),
  actual_month_cost numeric(18,4), -- Signed provider credits are financial evidence too.
  variable_month_to_date numeric(18,4) check(variable_month_to_date>=0),
  allocation_percent numeric(7,4) check(allocation_percent between 0 and 100),
  cost_period date not null check(extract(day from cost_period)=1),
  billing_period_start timestamptz, billing_period_end timestamptz,
  check((billing_period_start is null and billing_period_end is null) or
    (billing_period_start is not null and billing_period_end is not null and billing_period_end > billing_period_start)),
  origin text not null default 'INDISPONIVEL' check(origin in ('REAL','ESTIMADO','RATEIO_ESTIMADO','INDISPONIVEL')),
  source_mode text not null default 'MANUAL' check(source_mode in ('API','MANUAL','DOCUMENTED')),
  pricing_date date, unit_price numeric(18,4) check(unit_price>=0), quantity numeric(18,4) check(quantity>=0),
  billing_mode text not null default 'MANUAL' check(billing_mode in ('MANUAL','DIGITALOCEAN','VERCEL')),
  source_note text not null default '' check(length(source_note)<=1000),
  source_url text,
  synced_at timestamptz,
  sync_status text not null default 'UNAVAILABLE' check(sync_status in ('OK','MANUAL','UNAVAILABLE','FAILED')),
  usage jsonb not null default '[]'::jsonb check(jsonb_typeof(usage)='array'),
  enabled boolean not null default true,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(operator_id,service_key)
);
create index finops_services_scope on coinops.finops_services(tenant_id,operator_id);

create table coinops.finops_service_revisions (
  id bigint generated always as identity primary key,
  service_id uuid not null references coinops.finops_services(id) on delete restrict,
  tenant_id uuid not null, operator_id uuid not null,
  recorded_at timestamptz not null default now(),
  before_value jsonb, after_value jsonb not null
);
create index finops_revisions_scope on coinops.finops_service_revisions(tenant_id,operator_id,recorded_at desc);

create table coinops.finops_snapshots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  operator_id uuid not null references coinops.operators(id) on delete restrict,
  period date not null check(extract(day from period)=1),
  snapshot_key text not null,
  captured_at timestamptz not null default now(),
  payload jsonb not null check(jsonb_typeof(payload)='object'),
  unique(operator_id,snapshot_key)
);
create index finops_snapshots_scope_period on coinops.finops_snapshots(tenant_id,operator_id,period desc,captured_at desc);

create table coinops.finops_alerts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  operator_id uuid not null references coinops.operators(id) on delete restrict,
  service_id uuid references coinops.finops_services(id) on delete restrict,
  alert_key text not null,
  code text not null check(code in ('COST_INCREASE','BILLING_SYNC_FAILED','UNEXPECTED_COST','SERVICE_LIMIT_WARNING','EXECUTOR_COST_CHANGE')),
  message text not null check(length(message)<=1000),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique(operator_id,alert_key)
);
create index finops_alerts_scope_open on coinops.finops_alerts(tenant_id,operator_id,last_seen_at desc) where resolved_at is null;

create table coinops.finops_sync_state (
  operator_id uuid primary key references coinops.operators(id) on delete restrict,
  tenant_id uuid not null,
  lease_owner uuid,
  lease_until timestamptz,
  last_synced_at timestamptz,
  last_external_synced_at timestamptz,
  last_status text,
  last_error text
);

create function coinops.finops_guard_scope() returns trigger
language plpgsql set search_path=pg_catalog,coinops as $$
begin
  if not exists(select 1 from coinops.operators o where o.id=new.operator_id and o.tenant_id=new.tenant_id) then
    raise exception 'COINOPS_FINOPS_SCOPE_INVALID';
  end if;
  if tg_op='UPDATE' and (new.operator_id is distinct from old.operator_id or new.tenant_id is distinct from old.tenant_id) then
    raise exception 'COINOPS_FINOPS_SCOPE_IMMUTABLE';
  end if;
  if to_jsonb(new)->>'service_id' is not null and not exists(select 1 from coinops.finops_services s
    where s.id=(to_jsonb(new)->>'service_id')::uuid and s.operator_id=new.operator_id and s.tenant_id=new.tenant_id) then
    raise exception 'COINOPS_FINOPS_SERVICE_SCOPE_INVALID';
  end if;
  return new;
end $$;
revoke all on function coinops.finops_guard_scope() from public,anon,authenticated;
grant execute on function coinops.finops_guard_scope() to service_role;

create function coinops.finops_audit_service() returns trigger
language plpgsql set search_path=pg_catalog,coinops as $$
begin
  if tg_op='INSERT' or (to_jsonb(new)-array['updated_at','synced_at']) is distinct from (to_jsonb(old)-array['updated_at','synced_at']) then
    insert into coinops.finops_service_revisions(service_id,tenant_id,operator_id,before_value,after_value)
      values(new.id,new.tenant_id,new.operator_id,case when tg_op='UPDATE' then to_jsonb(old) else null end,to_jsonb(new));
  end if;
  return new;
end $$;
revoke all on function coinops.finops_audit_service() from public,anon,authenticated;
grant execute on function coinops.finops_audit_service() to service_role;

do $$ declare t text; begin
  foreach t in array array['finops_services','finops_service_revisions','finops_snapshots','finops_alerts','finops_sync_state'] loop
    execute format('create trigger finops_scope before insert or update on coinops.%I for each row execute function coinops.finops_guard_scope()',t);
  end loop;
  foreach t in array array['finops_services','finops_service_revisions','finops_snapshots','finops_alerts','finops_sync_state'] loop
    execute format('alter table coinops.%I enable row level security',t);
    execute format('alter table coinops.%I force row level security',t);
    execute format('revoke all on coinops.%I from public,anon,authenticated,service_role',t);
    execute format('grant select,insert on coinops.%I to service_role',t);
  end loop;
end $$;
grant update on coinops.finops_services,coinops.finops_alerts,coinops.finops_sync_state to service_role;
grant usage,select on sequence coinops.finops_service_revisions_id_seq to service_role;
create trigger finops_service_audit after insert or update on coinops.finops_services
  for each row execute function coinops.finops_audit_service();

create function coinops.finops_immutable_observation() returns trigger
language plpgsql set search_path=pg_catalog,coinops as $$
begin
  raise exception 'COINOPS_FINOPS_OBSERVATION_IMMUTABLE';
end $$;
revoke all on function coinops.finops_immutable_observation() from public,anon,authenticated;
grant execute on function coinops.finops_immutable_observation() to service_role;
create trigger finops_snapshot_immutable before update or delete on coinops.finops_snapshots
  for each row execute function coinops.finops_immutable_observation();
create trigger finops_revision_immutable before update or delete on coinops.finops_service_revisions
  for each row execute function coinops.finops_immutable_observation();

comment on table coinops.finops_snapshots is 'Immutable FinOps observations with original currencies and frozen FX; capital is not platform revenue. Server ADMIN API only.';
comment on table coinops.finops_services is 'Platform operational costs only. Evidence priority REAL, ESTIMADO, RATEIO_ESTIMADO, INDISPONIVEL. Input source MANUAL/API/DOCUMENTED is separate. Unknown attribution or price stays NULL.';

create function coinops.finops_monthly_history(p_tenant_id uuid,p_operator_id uuid)
returns table(period date,captured_at timestamptz,payload jsonb)
language sql stable security invoker set search_path=pg_catalog,coinops as $$
  select distinct on (s.period) s.period,s.captured_at,s.payload
  from coinops.finops_snapshots s
  where s.tenant_id=p_tenant_id and s.operator_id=p_operator_id
  order by s.period desc,s.captured_at desc,s.id desc;
$$;
revoke all on function coinops.finops_monthly_history(uuid,uuid) from public,anon,authenticated;
grant execute on function coinops.finops_monthly_history(uuid,uuid) to service_role;

create function coinops.finops_claim_sync(p_tenant_id uuid,p_operator_id uuid,p_owner uuid)
returns boolean language plpgsql security invoker set search_path=pg_catalog,coinops as $$
begin
  if not exists(select 1 from coinops.operators o where o.id=p_operator_id and o.tenant_id=p_tenant_id and o.status='ACTIVE') then
    raise exception 'COINOPS_FINOPS_SCOPE_INVALID';
  end if;
  insert into coinops.finops_sync_state(operator_id,tenant_id) values(p_operator_id,p_tenant_id) on conflict do nothing;
  if p_owner is null then raise exception 'COINOPS_FINOPS_SYNC_OWNER_REQUIRED'; end if;
  -- Longer than the endpoint's 300s hard duration, never a trading lease.
  update coinops.finops_sync_state set lease_owner=p_owner,lease_until=now()+interval '6 minutes'
    where operator_id=p_operator_id and tenant_id=p_tenant_id and (lease_until is null or lease_until<now());
  return found;
end $$;
revoke all on function coinops.finops_claim_sync(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function coinops.finops_claim_sync(uuid,uuid,uuid) to service_role;

-- Fenced, atomic publication: an expired/crashed worker cannot publish a fresh
-- snapshot or overwrite the successful external-sync time of its successor.
create function coinops.finops_finish_sync(p_tenant_id uuid,p_operator_id uuid,p_owner uuid,
  p_snapshot_key text,p_external boolean,p_payload jsonb)
returns void language plpgsql security invoker set search_path=pg_catalog,coinops as $$
declare captured timestamptz;
begin
  perform 1 from coinops.finops_sync_state where operator_id=p_operator_id and tenant_id=p_tenant_id
    and lease_owner=p_owner and lease_until>clock_timestamp() for update;
  if not found then raise exception 'COINOPS_FINOPS_SYNC_LEASE_LOST'; end if;
  if jsonb_typeof(p_payload) is distinct from 'object' or coalesce(p_payload->>'syncStatus','') not in ('OK','PARTIAL')
    or p_snapshot_key is null or p_external is null then raise exception 'COINOPS_FINOPS_SNAPSHOT_INVALID'; end if;
  captured:=(p_payload->>'capturedAt')::timestamptz;
  if captured is null or captured>clock_timestamp()+interval '1 minute' then
    raise exception 'COINOPS_FINOPS_SNAPSHOT_INVALID'; end if;
  insert into coinops.finops_snapshots(tenant_id,operator_id,period,snapshot_key,captured_at,payload)
    values(p_tenant_id,p_operator_id,date_trunc('month',captured at time zone 'UTC')::date,p_snapshot_key,captured,p_payload);
  update coinops.finops_sync_state set last_synced_at=captured,
    last_external_synced_at=case when p_external then captured else last_external_synced_at end,
    last_status=p_payload->>'syncStatus',last_error=null
    where operator_id=p_operator_id and tenant_id=p_tenant_id and lease_owner=p_owner;
end $$;
revoke all on function coinops.finops_finish_sync(uuid,uuid,uuid,text,boolean,jsonb) from public,anon,authenticated;
grant execute on function coinops.finops_finish_sync(uuid,uuid,uuid,text,boolean,jsonb) to service_role;

-- Only resources already verified in the Executor 02 runbook receive this tariff.
-- Future executors are discovered with unknown price until resource evidence exists.
insert into coinops.finops_services(tenant_id,operator_id,service_key,provider,name,shard_id,plan,region,
  resource_id,currency,recurring_monthly,allocation_percent,cost_period,origin,source_mode,billing_mode,
  source_note,source_url,pricing_date,unit_price,quantity,sync_status)
select o.tenant_id,o.id,'executor:'||s.id,'DigitalOcean','Executor '||split_part(s.id,'-',2),s.id,'s-1vcpu-1gb','fra1',
  case when host(s.egress_ipv4)='164.90.223.159' then '603936458' else null end,
  'USD',6,100,date_trunc('month',now())::date,'ESTIMADO','DOCUMENTED','DIGITALOCEAN',
  'Tarifa-base documentada: Regular 1 vCPU / 1 GiB / 25 GB. US$ 6 por mês, US$ 0.00893/h. Plano/IP verificados no runbook de implantação; não é fatura e não inclui extras desconhecidos.',
  'https://www.digitalocean.com/pricing/droplets','2026-09-27',6,1,'OK'
from coinops.operators o cross join coinops.executor_shards s
where o.status='ACTIVE' and ((s.id='executor-01' and host(s.egress_ipv4)='46.101.104.48')
  or (s.id='executor-02' and host(s.egress_ipv4)='164.90.223.159'))
on conflict(operator_id,service_key) do nothing;

-- Authenticated provider evidence captured 2026-09-27. Shared amounts are
-- allocation estimates, never confirmed CoinOps invoices. No provider mutation.
insert into coinops.finops_services(tenant_id,operator_id,service_key,provider,name,plan,region,
  resource_id,currency,recurring_monthly,allocation_percent,cost_period,origin,source_mode,billing_mode,
  source_note,source_url,pricing_date,unit_price,quantity,synced_at,sync_status,usage)
select o.tenant_id,o.id,'supabase:otdfpmsegjxpqrzisfmi','Supabase','Supabase · OnPlay Platform compartilhada',
  'Pro · 2 projetos Micro na organização','sa-east-1','otdfpmsegjxpqrzisfmi','USD',35,35.2243,
  date_trunc('month',now())::date,'RATEIO_ESTIMADO','MANUAL','MANUAL',
  'Plano Pro confirmado. Base organização: US$25 + 2 Micro de US$10 - US$10 crédito = US$35/mês. Platform: 1/2 da base; CoinOps: 107429888/152494080 bytes relacionais dos schemas de produto (70,44856%). Parcela final 35,2243%. Proxy simplificado de storage, não medição de CPU/Auth/Realtime/egress. Ciclo 12/09-12/10; painel exibia custo atual US$25 e projeção US$34,30, não atribuídos como fatura CoinOps. Rever rateio ao mudar os recursos.',
  'https://supabase.com/pricing','2026-09-27',35,1,'2026-09-27T00:47:00Z','MANUAL',
  '[{"label":"Projetos Micro na organização","used":2,"limit":null,"unit":"projetos"},{"label":"CoinOps nos bytes relacionais de produto","used":70.44856,"limit":null,"unit":"% (proxy de rateio, não quota contratada)"}]'::jsonb
from coinops.operators o where o.status='ACTIVE'
on conflict(operator_id,service_key) do nothing;

insert into coinops.finops_services(tenant_id,operator_id,service_key,provider,name,plan,
  resource_id,currency,recurring_monthly,variable_month_to_date,allocation_percent,cost_period,
  billing_period_start,billing_period_end,origin,source_mode,billing_mode,
  source_note,source_url,pricing_date,unit_price,quantity,synced_at,sync_status,usage)
select o.tenant_id,o.id,'vercel:prj_GNCqXG8MVG2ePgU3y6vuosz06GoR','Vercel','Vercel · CoinOps/cripto',
  'Pro · 1 seat · equipe com 8 projetos','prj_GNCqXG8MVG2ePgU3y6vuosz06GoR','USD',20,16.15,12.5,
  date_trunc('month',now())::date,'2026-09-14T00:00:00Z','2026-10-14T00:00:00Z',
  'RATEIO_ESTIMADO','MANUAL','MANUAL',
  'Pro confirmado: base US$20/mês e US$20 crédito de uso. O painel em 27/09 exibia US$16,15 on-demand após crédito, invoice aberta US$36,15 (não paga). Rateio igual por 8 projetos cadastrados: 12,5%; proxy administrativo, não consumo medido por projeto. Variável projetada pelo ciclo 14/09-14/10, com datas civis aproximadas a UTC. Observability incluído e uso variável já integra on-demand; não duplicar. Rever manualmente período/uso e denominador.',
  'https://vercel.com/docs/plans/pro-plan','2026-09-27',20,1,'2026-09-27T00:48:00Z','MANUAL',
  '[{"label":"Projetos na equipe (rateio)","used":8,"limit":null,"unit":"projetos"},{"label":"Seats incluídos no plano","used":1,"limit":null,"unit":"seat"}]'::jsonb
from coinops.operators o where o.status='ACTIVE'
on conflict(operator_id,service_key) do nothing;
commit;

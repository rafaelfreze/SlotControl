-- coinops / otdfpmsegjxpqrzisfmi: institution-only operational measurement.
-- No financial, trading, account, tenant or customer data is read or changed.
-- Activation is a separate service-only operation after deployment; no historical backfill.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
-- Marketing v2 epoch isolation. Product: CoinOps; project otdfpmsegjxpqrzisfmi; schema coinops.
-- Prepared infrastructure only: this migration does not activate a baseline or alter legacy/operational records.
create table coinops.marketing_measurement_epochs (
 id uuid primary key,
 external_tenant text not null check(external_tenant='platform'),
 instrumentation_version integer not null default 2 check(instrumentation_version=2),
 rule_version integer not null default 2 check(rule_version=2),
 effective_at timestamptz,
 active boolean not null default false,
 dedup_salt bytea not null default extensions.gen_random_bytes(32),
 created_at timestamptz not null default statement_timestamp(),
 activated_by uuid,
 check(not active or effective_at is not null)
);
create unique index marketing_measurement_one_active_epoch_v2 on coinops.marketing_measurement_epochs(external_tenant) where active;
create table coinops.marketing_activity_v2_daily (
 epoch_id uuid not null references coinops.marketing_measurement_epochs(id),
 day date not null,
 event_name text not null check(event_name in ('page_view','qualified_session','contact_intent','scroll','engaged','link_click','button_click')),
 detail text not null default '' check(length(detail)<=80),
 page_path text not null check(length(page_path)<=300),
 channel text not null check(channel in ('google_ads','meta','organic','direct','other')),
 identity_scope text not null check(identity_scope in ('document','tab')),
 events bigint not null check(events>=0),
 primary key(epoch_id,day,event_name,detail,page_path,channel,identity_scope)
);
create table coinops.marketing_activity_v2_receipts (
 epoch_id uuid not null references coinops.marketing_measurement_epochs(id),
 receipt_key text not null check(length(receipt_key)<=100),
 expires_at timestamptz not null,
 primary key(epoch_id,receipt_key)
);
create table coinops.marketing_activity_v2_limits (
 epoch_id uuid not null references coinops.marketing_measurement_epochs(id), minute timestamptz not null, events integer not null check(events>0), primary key(epoch_id,minute)
);
alter table coinops.marketing_activity_v2_limits enable row level security;
revoke all on coinops.marketing_activity_v2_limits from public,anon,authenticated,service_role;
grant select,insert,update,delete on coinops.marketing_activity_v2_limits to service_role;
create index marketing_activity_v2_receipts_expiry on coinops.marketing_activity_v2_receipts(expires_at);
alter table coinops.marketing_measurement_epochs enable row level security;
alter table coinops.marketing_activity_v2_daily enable row level security;
alter table coinops.marketing_activity_v2_receipts enable row level security;
revoke all on coinops.marketing_measurement_epochs,coinops.marketing_activity_v2_daily,coinops.marketing_activity_v2_receipts from public,anon,authenticated,service_role;
grant select on coinops.marketing_measurement_epochs to service_role;
grant select,insert,update,delete on coinops.marketing_activity_v2_daily,coinops.marketing_activity_v2_receipts to service_role;

create function coinops.marketing_v2_tenant_allowed(p_external_tenant text)
returns boolean language sql stable security invoker set search_path='' as $allowed$
 select p_external_tenant is not null and p_external_tenant='platform';
$allowed$;
create function coinops.guard_marketing_measurement_epoch_v2()
returns trigger language plpgsql security invoker set search_path='' as $immutable$
begin
 if old.active and new is distinct from old then raise exception 'active_measurement_epoch_immutable' using errcode='22023'; end if;
 return new;
end; $immutable$;
create trigger marketing_epoch_v2_immutable before update on coinops.marketing_measurement_epochs for each row execute function coinops.guard_marketing_measurement_epoch_v2();

-- Called explicitly only after deployment, technical readiness, and native target validation.
-- No caller-supplied effective date: the actual activation timestamp is authoritative.
create function coinops.activate_marketing_measurement_epoch_v2(p_external_tenant text,p_epoch_id uuid,p_actor uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $activate$
declare epoch coinops.marketing_measurement_epochs; effective timestamptz;
begin
 if p_actor is not null then raise exception 'system_publication_context_required' using errcode='42501'; end if;
 if not coinops.marketing_v2_tenant_allowed(p_external_tenant) or p_epoch_id is null then raise exception 'tenant_unavailable' using errcode='42501'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('coinops.marketing_epoch:'||p_external_tenant,0));
 select * into epoch from coinops.marketing_measurement_epochs where external_tenant=p_external_tenant and active;
 if found then
  if epoch.id<>p_epoch_id then raise exception 'measurement_epoch_already_active' using errcode='40001'; end if;
  return jsonb_build_object('id',epoch.id,'effectiveAt',to_char(epoch.effective_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'instrumentationVersion',2);
 end if;
 effective:=clock_timestamp();
 insert into coinops.marketing_measurement_epochs(id,external_tenant,effective_at,active,activated_by) values(p_epoch_id,p_external_tenant,effective,true,p_actor)
 on conflict(id) do update set effective_at=excluded.effective_at,active=true,activated_by=excluded.activated_by
 where not coinops.marketing_measurement_epochs.active and coinops.marketing_measurement_epochs.external_tenant=p_external_tenant
 returning * into epoch;
 if not found then raise exception 'measurement_epoch_identity_mismatch' using errcode='40001'; end if;
 return jsonb_build_object('id',epoch.id,'effectiveAt',to_char(epoch.effective_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'instrumentationVersion',2);
end; $activate$;
create function coinops.get_marketing_measurement_epoch_v2(p_external_tenant text)
returns jsonb language plpgsql stable security invoker set search_path='' as $epoch$
declare epoch coinops.marketing_measurement_epochs;
begin
 if not coinops.marketing_v2_tenant_allowed(p_external_tenant) then raise exception 'tenant_unavailable' using errcode='42501'; end if;
 select * into epoch from coinops.marketing_measurement_epochs where external_tenant=p_external_tenant and active and instrumentation_version=2 and rule_version=2 and effective_at<=statement_timestamp();
 if not found then return null; end if;
 return jsonb_build_object('id',epoch.id,'effectiveAt',to_char(epoch.effective_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'instrumentationVersion',2);
end; $epoch$;

-- Raw session tokens are transient arguments only. Persisted keys use private per-epoch HMAC, scoped to a local day.
-- Event receipts expire in 24 hours; contact action dedupe lasts 30 minutes; no visitor/person identifier is produced.
create function coinops.record_marketing_activity_v2(p_external_tenant text,p_input jsonb)
returns boolean language plpgsql volatile security invoker set search_path='' as $record$
declare epoch coinops.marketing_measurement_epochs; now_at timestamptz:=statement_timestamp(); occurred timestamptz;
 event_id uuid; session_token uuid; event_name text; detail text; page_path text; channel text; identity_scope text; consent text; local_day date;
 session_key text; key text; claimed text; expires timestamptz; q jsonb; active_ms numeric; interaction text; scroll_percent numeric; qualifies boolean:=false; event_count integer;
begin
 if not coinops.marketing_v2_tenant_allowed(p_external_tenant) then return false; end if;
 select * into epoch from coinops.marketing_measurement_epochs where external_tenant=p_external_tenant and active and instrumentation_version=2 and rule_version=2 and effective_at<=now_at;
 if not found then return false; end if;
 if p_input is null or jsonb_typeof(p_input)<>'object' or p_input->>'version' is distinct from '2'
  or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('version','eventId','occurredAt','eventName','pagePath','detail','channel','campaign','device','consent','identityScope','sessionToken','qualification','slug')) then return false; end if;
 begin event_id:=(p_input->>'eventId')::uuid; session_token:=(p_input->>'sessionToken')::uuid; occurred:=(p_input->>'occurredAt')::timestamptz; exception when others then return false; end;
 if event_id is null or session_token is null or occurred is null or occurred<epoch.effective_at or occurred>now_at or occurred<now_at-interval '5 minutes' then return false; end if;
 event_name:=p_input->>'eventName'; detail:=coalesce(p_input->>'detail',''); page_path:=p_input->>'pagePath'; channel:=p_input->>'channel'; identity_scope:=p_input->>'identityScope'; consent:=p_input->>'consent';
 if event_name is null or event_name not in ('page_view','qualified_session','contact_intent','scroll','engaged','link_click','button_click')
  or page_path is null or length(page_path)>300 or page_path !~ '^/[A-Za-z0-9/_-]*$'
  or page_path ~ '^/(api|auth|master|painel|dashboard|app|login|cadastro|preview|previa|automacao|meu-coinops|alterar-senha|recuperar-senha)(/|$)'
  or channel is null or channel not in ('google_ads','meta','organic','direct','other')
  or identity_scope is null or identity_scope not in ('document','tab') or consent is null or consent not in ('accepted','declined','unknown')
  or (identity_scope='tab' and consent<>'accepted') or length(detail)>80 then return false; end if;
 if consent<>'accepted' then channel:='other'; end if;
 if event_name in ('page_view','qualified_session') and detail<>'' then return false; end if;
 if event_name='contact_intent' and detail not in ('whatsapp','phone','form') then return false; end if;
 if event_name='scroll' and detail not in ('25','50','75','100') then return false; end if;
 if event_name='engaged' and detail not in ('30s','60s') then return false; end if;
 if event_name='link_click' and detail not in ('whatsapp','phone','shopee','internal','external','header','hero','offer','local','final','sticky') then return false; end if;
 if event_name='button_click' and detail not in ('select_number','reserve_request','draw_request','draw_start','product_click','category_click','search','add_to_order','checkout_started','checkout_order_submit','whatsapp_order_submit','shipping_quote','order_view','affiliate_registration') then return false; end if;
 if event_name in ('qualified_session','contact_intent') then
  q:=p_input->'qualification';
  if q is null or jsonb_typeof(q)<>'object' or exists(select 1 from jsonb_object_keys(q) k where k not in ('activeMs','interaction','scrollPercent')) then return false; end if;
  begin active_ms:=(q->>'activeMs')::numeric; scroll_percent:=(q->>'scrollPercent')::numeric; exception when others then return false; end;
  interaction:=q->>'interaction';
  if active_ms is null or active_ms<>trunc(active_ms) or active_ms<0 or active_ms>86400000 or interaction is null or interaction not in ('scroll','relevant_click','contact') then return false; end if;
  if interaction='scroll' and (scroll_percent is null or scroll_percent<25 or scroll_percent>100) then return false; end if;
  if event_name='contact_intent' and interaction<>'contact' then return false; end if;
  qualifies:=interaction='contact' or active_ms>=5000 and interaction in ('scroll','relevant_click');
  if not qualifies then return false; end if;
 elsif p_input ? 'qualification' then return false;
 end if;
 insert into coinops.marketing_activity_v2_limits(epoch_id,minute,events) values(epoch.id,date_trunc('minute',now_at),1)
 on conflict(epoch_id,minute) do update set events=coinops.marketing_activity_v2_limits.events+1 returning events into event_count;
 if event_count>1000 then return false; end if;
 delete from coinops.marketing_activity_v2_limits where (epoch_id,minute) in(select epoch_id,minute from coinops.marketing_activity_v2_limits where minute<date_trunc('minute',now_at)-interval '2 minutes' order by minute limit 100);
 local_day:=(occurred at time zone 'America/Campo_Grande')::date;
 session_key:=encode(extensions.hmac(convert_to(p_external_tenant||':'||local_day::text||':'||session_token::text,'UTF8'),epoch.dedup_salt,'sha256'),'hex');
 claimed:=null;
 insert into coinops.marketing_activity_v2_receipts(epoch_id,receipt_key,expires_at) values(epoch.id,'event:'||event_id::text,now_at+interval '24 hours')
 on conflict(epoch_id,receipt_key) do update set expires_at=excluded.expires_at where coinops.marketing_activity_v2_receipts.expires_at<=now_at returning receipt_key into claimed;
 if claimed is null then return true; end if;
 if event_name in ('qualified_session','contact_intent') then
  claimed:=null;
  insert into coinops.marketing_activity_v2_receipts(epoch_id,receipt_key,expires_at) values(epoch.id,'qualified:'||session_key,now_at+interval '24 hours')
  on conflict(epoch_id,receipt_key) do update set expires_at=excluded.expires_at where coinops.marketing_activity_v2_receipts.expires_at<=now_at returning receipt_key into claimed;
  if claimed is not null then
   insert into coinops.marketing_activity_v2_daily(epoch_id,day,event_name,detail,page_path,channel,identity_scope,events)
    values(epoch.id,local_day,'qualified_session','',page_path,channel,identity_scope,1)
   on conflict on constraint marketing_activity_v2_daily_pkey do update set events=coinops.marketing_activity_v2_daily.events+1;
  end if;
 end if;
 if event_name='qualified_session' then return true; end if;
 if event_name='contact_intent' then
  claimed:=null;
  insert into coinops.marketing_activity_v2_receipts(epoch_id,receipt_key,expires_at) values(epoch.id,'contact:'||session_key||':'||detail,now_at+interval '30 minutes')
  on conflict(epoch_id,receipt_key) do update set expires_at=excluded.expires_at where coinops.marketing_activity_v2_receipts.expires_at<=now_at returning receipt_key into claimed;
  if claimed is null then return true; end if;
 end if;
 insert into coinops.marketing_activity_v2_daily(epoch_id,day,event_name,detail,page_path,channel,identity_scope,events)
  values(epoch.id,local_day,event_name,detail,page_path,channel,identity_scope,1)
 on conflict on constraint marketing_activity_v2_daily_pkey do update set events=coinops.marketing_activity_v2_daily.events+1;
 delete from coinops.marketing_activity_v2_receipts where (epoch_id,receipt_key) in
  (select epoch_id,receipt_key from coinops.marketing_activity_v2_receipts where expires_at<=now_at order by expires_at limit 100);
 delete from coinops.marketing_activity_v2_daily d where (d.epoch_id,d.day,d.event_name,d.detail,d.page_path,d.channel,d.identity_scope) in
  (select old.epoch_id,old.day,old.event_name,old.detail,old.page_path,old.channel,old.identity_scope from coinops.marketing_activity_v2_daily old where old.day<local_day-395 order by old.day limit 100);
 return true;
end; $record$;

create function coinops.marketing_measurement_snapshot_v2(p_external_tenant text,p_from date,p_to date,p_epoch_id uuid,p_effective_at timestamptz,p_instrumentation_version integer)
returns jsonb language plpgsql stable security invoker set search_path='' as $snapshot$
declare epoch coinops.marketing_measurement_epochs; start_day date; today date:=(statement_timestamp() at time zone 'America/Campo_Grande')::date;
 metrics jsonb; points jsonb; totals jsonb; scope text; available boolean; result jsonb; projection jsonb;
begin
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>30 or p_to>today or p_instrumentation_version is distinct from 2
  or not coinops.marketing_v2_tenant_allowed(p_external_tenant) then raise exception 'invalid_epoch_scope' using errcode='42501'; end if;
 select * into epoch from coinops.marketing_measurement_epochs where id=p_epoch_id and external_tenant=p_external_tenant and active and instrumentation_version=2 and rule_version=2 and effective_at=p_effective_at and effective_at<=statement_timestamp();
 if not found then raise exception 'measurement_epoch_unavailable' using errcode='P0002'; end if;
 start_day:=(epoch.effective_at at time zone 'America/Campo_Grande')::date; available:=p_to>=greatest(start_day,today-395);
 with daily as (select day,sum(events) filter(where event_name='page_view') views,sum(events) filter(where event_name='qualified_session') qualified,sum(events) filter(where event_name='contact_intent') contacts
 from coinops.marketing_activity_v2_daily where epoch_id=epoch.id and day between greatest(p_from,start_day,today-395) and p_to group by day),
 days as (select p_from+n as day from generate_series(0,p_to-p_from) n)
 select coalesce(jsonb_agg(jsonb_build_object('date',d.day,'pageviews',case when d.day>=greatest(start_day,today-395) then coalesce(a.views,0) end,'qualifiedSessions',case when d.day>=greatest(start_day,today-395) then coalesce(a.qualified,0) end,'contactIntents',case when d.day>=greatest(start_day,today-395) then coalesce(a.contacts,0) end) order by d.day),'[]'::jsonb)
 into points from days d left join daily a on a.day=d.day;
 select jsonb_build_object('rawPageviews',case when available then coalesce(sum(events) filter(where event_name='page_view'),0) end,'qualifiedSessions',case when available then coalesce(sum(events) filter(where event_name='qualified_session'),0) end,'contactIntents',case when available then coalesce(sum(events) filter(where event_name='contact_intent'),0) end) into totals
 from coinops.marketing_activity_v2_daily where epoch_id=epoch.id and day between greatest(p_from,start_day,today-395) and p_to;
 select case when count(distinct identity_scope)>1 then 'mixed' when count(*)=0 then 'unavailable' else min(identity_scope) end into scope from coinops.marketing_activity_v2_daily where epoch_id=epoch.id and day between greatest(p_from,start_day,today-395) and p_to;
 with days as(select p_from+n as day from generate_series(0,p_to-p_from) n), names(metric,event_name) as(values('visits','page_view'),('intents','contact_intent')),
 daily as(select day,event_name,sum(events)::bigint amount from coinops.marketing_activity_v2_daily where epoch_id=epoch.id and day between greatest(p_from,start_day,today-395) and p_to group by day,event_name)
 select coalesce(jsonb_agg(jsonb_build_object('date',d.day,'channel','all','metric',n.metric,'value',coalesce(a.amount,0),'population',case when n.metric='visits' then 'page_views' else 'events' end,'attribution','unattributed','quality',case when d.day=start_day or d.day=today then 'partial' else 'complete' end) order by d.day,n.metric),'[]'::jsonb)
 into metrics from days d cross join names n left join daily a on a.day=d.day and a.event_name=n.event_name where d.day>=greatest(start_day,today-395);
 result:=jsonb_build_object('version',1,'externalTenant',p_external_tenant,'from',p_from,'to',p_to,'timezone','America/Campo_Grande','currency','BRL','collectedAt',statement_timestamp(),
 'availableMetrics',case when available then '["visits","intents"]'::jsonb else '[]'::jsonb end,
 'coverageStart',case when available then jsonb_build_object('visits',greatest(start_day,today-395),'intents',greatest(start_day,today-395)) else '{}'::jsonb end,
 'definitions',case when available then jsonb_build_object('visits','Pageviews brutos elegíveis da instrumentação v2 após o marco zero; não são pessoas nem sessões qualificadas. Retenção de 395 dias.','intents','Intenções humanas de contato v2 por sessão efêmera e ação, deduplicadas por 30 minutos. Não confirmam conversa, lead ou venda.') else '{}'::jsonb end,
 'facts',metrics,'measurementEpoch',jsonb_build_object('id',epoch.id,'effectiveAt',to_char(epoch.effective_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'instrumentationVersion',2),
 'engagement',totals||jsonb_build_object('version',2,'estimatedVisitors',null,'identityScope',scope,'points',points));
 return result||jsonb_build_object('commercial',jsonb_build_object('version',1,'externalTenant',p_external_tenant,'from',p_from,'to',p_to,'timezone','America/Campo_Grande','collectedAt',statement_timestamp(),'availableMetrics','[]'::jsonb,'coverageStart','{}'::jsonb,'definitions','{}'::jsonb,'facts','[]'::jsonb));
end; $snapshot$;
revoke all on function coinops.marketing_v2_tenant_allowed(text),coinops.guard_marketing_measurement_epoch_v2(),coinops.activate_marketing_measurement_epoch_v2(text,uuid,uuid),coinops.get_marketing_measurement_epoch_v2(text),coinops.record_marketing_activity_v2(text,jsonb),coinops.marketing_measurement_snapshot_v2(text,date,date,uuid,timestamptz,integer) from public,anon,authenticated,service_role;
grant execute on function coinops.marketing_v2_tenant_allowed(text),coinops.guard_marketing_measurement_epoch_v2(),coinops.activate_marketing_measurement_epoch_v2(text,uuid,uuid),coinops.get_marketing_measurement_epoch_v2(text),coinops.record_marketing_activity_v2(text,jsonb),coinops.marketing_measurement_snapshot_v2(text,date,date,uuid,timestamptz,integer) to service_role;
comment on table coinops.marketing_activity_v2_daily is 'Epoch-isolated aggregate operational measurement. No legacy backfill, raw IP, visitor identifier, transcript or health data. Retention 395 days.';
comment on table coinops.marketing_activity_v2_receipts is 'Ephemeral technical idempotency and per-day HMAC session/action dedupe; receipts expire in 24 hours, contact action keys in 30 minutes. No people count.';






-- coinops / otdfpmsegjxpqrzisfmi.
-- Backward-compatible WhatsApp subset plus logical-session dedupe across time.
-- No consent, epoch, grant or historical aggregate changes.
set local lock_timeout='3s';
do $projection$
declare definition text; needle text;
begin
 select pg_catalog.pg_get_functiondef('coinops.marketing_measurement_snapshot_v2(text,date,date,uuid,timestamptz,integer)'::regprocedure) into definition;
 definition:=replace(definition,chr(13)||chr(10),chr(10));
 if position('whatsappClicks' in definition)>0 then raise exception 'marketing_whatsapp_projection_already_present_verify_history'; end if;
 needle:=$needle$sum(events) filter(where event_name='contact_intent') contacts$needle$;
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then raise exception 'marketing_whatsapp_daily_definition_changed'; end if;
 definition:=replace(definition,needle,$replace$sum(events) filter(where event_name='contact_intent') contacts,sum(events) filter(where event_name='contact_intent' and detail='whatsapp') whatsapp_clicks$replace$);
 needle:=$needle$'contactIntents',case when d.day>=greatest(start_day,today-395) then coalesce(a.contacts,0) end)$needle$;
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then raise exception 'marketing_whatsapp_points_definition_changed'; end if;
 definition:=replace(definition,needle,$replace$'contactIntents',case when d.day>=greatest(start_day,today-395) then coalesce(a.contacts,0) end,'whatsappClicks',case when d.day>=greatest(start_day,today-395) then coalesce(a.whatsapp_clicks,0) end)$replace$);
 needle:=$needle$'contactIntents',case when available then coalesce(sum(events) filter(where event_name='contact_intent'),0) end)$needle$;
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then raise exception 'marketing_whatsapp_totals_definition_changed'; end if;
 definition:=replace(definition,needle,$replace$'contactIntents',case when available then coalesce(sum(events) filter(where event_name='contact_intent'),0) end,'whatsappClicks',case when available then coalesce(sum(events) filter(where event_name='contact_intent' and detail='whatsapp'),0) end)$replace$);
 execute definition;
end $projection$;

-- The browser logical token expires within 24h. Preserve one event/action across
-- page changes, retries and midnight, without retaining a raw token or identity.
do $writer$
declare definition text; needle text;
begin
 select pg_catalog.pg_get_functiondef('coinops.record_marketing_activity_v2(text,jsonb)'::regprocedure) into definition;
 definition:=replace(definition,chr(13)||chr(10),chr(10));
 if position('legacy_today_key' in definition)>0 then raise exception 'marketing_session_dedupe_already_present_verify_history'; end if;
 needle:=$needle$session_key text; key text;$needle$;
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then raise exception 'marketing_session_declaration_changed'; end if;
 definition:=replace(definition,needle,$replace$session_key text; legacy_today_key text; legacy_yesterday_key text; key text;$replace$);
 needle:=$needle$session_key:=encode(extensions.hmac(convert_to(p_external_tenant||':'||local_day::text||':'||session_token::text,'UTF8'),epoch.dedup_salt,'sha256'),'hex');$needle$;
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then raise exception 'marketing_session_hash_definition_changed'; end if;
 definition:=replace(definition,needle,$replace$session_key:=encode(extensions.hmac(convert_to(p_external_tenant||':'||session_token::text,'UTF8'),epoch.dedup_salt,'sha256'),'hex');
 legacy_today_key:=encode(extensions.hmac(convert_to(p_external_tenant||':'||local_day::text||':'||session_token::text,'UTF8'),epoch.dedup_salt,'sha256'),'hex');
 legacy_yesterday_key:=encode(extensions.hmac(convert_to(p_external_tenant||':'||(local_day-1)::text||':'||session_token::text,'UTF8'),epoch.dedup_salt,'sha256'),'hex');$replace$);
 needle:=$needle$now_at+interval '30 minutes'$needle$;
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then raise exception 'marketing_session_contact_ttl_changed'; end if;
 definition:=replace(definition,needle,$replace$now_at+interval '24 hours'$replace$);
 needle:=$needle$if claimed is not null then$needle$;
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then raise exception 'marketing_session_qualified_claim_changed'; end if;
 definition:=replace(definition,needle,$replace$if claimed is not null and not exists(select 1 from coinops.marketing_activity_v2_receipts old
   where old.epoch_id=epoch.id and old.expires_at>now_at
    and old.receipt_key in ('qualified:'||legacy_today_key,'qualified:'||legacy_yesterday_key)) then$replace$);
 needle:=$needle$if claimed is null then return true; end if;
 end if;
 insert into coinops.marketing_activity_v2_daily$needle$;
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then raise exception 'marketing_session_contact_claim_changed'; end if;
 definition:=replace(definition,needle,$replace$if claimed is null or exists(select 1 from coinops.marketing_activity_v2_receipts old
   where old.epoch_id=epoch.id and old.expires_at>now_at-interval '23 hours 30 minutes'
    and old.receipt_key in ('contact:'||legacy_today_key||':'||detail,'contact:'||legacy_yesterday_key||':'||detail)) then return true; end if;
 end if;
 insert into coinops.marketing_activity_v2_daily$replace$);
 execute definition;
end $writer$;
comment on table coinops.marketing_activity_v2_receipts is 'Ephemeral per-epoch HMAC logical-session/action dedupe, 24-hour technical receipts; legacy civil-day receipts respected during rollout. No raw tokens or people count.';

notify pgrst,'reload schema';


commit;

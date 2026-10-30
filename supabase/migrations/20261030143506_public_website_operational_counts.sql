-- coinops / otdfpmsegjxpqrzisfmi. Institutional website only, no tenant or financial records.
-- Aggregate counters; no visitor/session IDs, cookies, full IP, query strings or message content.
create table coinops.website_activity_daily(day date not null,event_name text not null check(event_name in ('page_view','whatsapp_click','phone_click')),page text not null check(page in ('home','services','contact','other')),placement text not null check(placement in ('page','header','hero','inicio','servicos','services','sobre','resultados','trabalhos','contato','contact','final','final_cta','footer','floating','sticky','offer','local','catalog','other')),channel text not null check(channel in ('google_ads','meta','organic','direct','unknown')),value bigint not null check(value between 1 and 100000),primary key(day,event_name,page,placement,channel));
create table coinops.website_activity_receipts(event_id uuid primary key,expires_at timestamptz not null);
create index website_activity_receipts_expiry_idx on coinops.website_activity_receipts(expires_at);
create table coinops.website_activity_limits(minute timestamptz primary key,hits integer not null check(hits between 1 and 240));
create table coinops.website_read_nonces(nonce text primary key,expires_at timestamptz not null);
create index website_read_nonces_expiry_idx on coinops.website_read_nonces(expires_at);
alter table coinops.website_activity_daily enable row level security;alter table coinops.website_activity_receipts enable row level security;alter table coinops.website_activity_limits enable row level security;alter table coinops.website_read_nonces enable row level security;
revoke all on coinops.website_activity_daily,coinops.website_activity_receipts,coinops.website_activity_limits,coinops.website_read_nonces from public,anon,authenticated;
grant select,insert,update,delete on coinops.website_activity_daily,coinops.website_activity_receipts,coinops.website_activity_limits,coinops.website_read_nonces to service_role;
create function coinops.record_website_count_v1(p_event_id uuid,p_event text,p_page text,p_placement text,p_channel text) returns boolean language plpgsql security invoker set search_path='' as $$
declare claim uuid; hit_count integer; local_day date:=(now() at time zone 'America/Campo_Grande')::date;
begin
 if p_event_id is null or p_event is null or p_event not in ('page_view','whatsapp_click','phone_click') or p_page is null or p_page not in ('home','services','contact','other') or p_placement is null or p_placement not in ('page','header','hero','inicio','servicos','services','sobre','resultados','trabalhos','contato','contact','final','final_cta','footer','floating','sticky','offer','local','catalog','other') or p_channel is null or p_channel not in ('google_ads','meta','organic','direct','unknown') or (p_event='page_view' and p_placement<>'page') then raise exception 'invalid_event' using errcode='22023';end if;
 if exists(select 1 from coinops.website_activity_receipts where event_id=p_event_id and expires_at>now()) then return true;end if;
 insert into coinops.website_activity_limits as limits(minute,hits) values(date_trunc('minute',now()),1) on conflict(minute) do update set hits=limits.hits+1 where limits.hits<240 returning hits into hit_count;
 if hit_count is null then return false;end if;
 delete from coinops.website_activity_receipts where event_id in(select event_id from coinops.website_activity_receipts where expires_at<=now() order by expires_at limit 500);
 insert into coinops.website_activity_receipts values(p_event_id,now()+interval '24 hours') on conflict do nothing returning event_id into claim;if claim is null then return true;end if;
 insert into coinops.website_activity_daily as daily values(local_day,p_event,p_page,p_placement,p_channel,1) on conflict(day,event_name,page,placement,channel) do update set value=daily.value+1 where daily.value<100000;
 delete from coinops.website_activity_daily where (day,event_name,page,placement,channel) in(select day,event_name,page,placement,channel from coinops.website_activity_daily where day<local_day-395 order by day limit 500);
 delete from coinops.website_activity_limits where minute<date_trunc('minute',now())-interval '2 minutes';return true;
end;$$;
create function coinops.claim_website_read_nonce_v1(p_nonce text) returns boolean language plpgsql security invoker set search_path='' as $$
declare claim text;
begin
 if p_nonce is null or p_nonce !~ '^[a-fA-F0-9-]{36}$' then raise exception 'invalid_nonce' using errcode='22023';end if;
 delete from coinops.website_read_nonces where nonce in(select nonce from coinops.website_read_nonces where expires_at<=now() order by expires_at limit 500);
 insert into coinops.website_read_nonces values(p_nonce,now()+interval '5 minutes') on conflict do nothing returning nonce into claim;return claim is not null;
end;$$;
create function coinops.get_website_snapshot_v1(p_from date,p_to date) returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare first_day date; today date:=(now() at time zone 'America/Campo_Grande')::date; traffic jsonb; contacts jsonb;
begin
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>30 or p_to>today then raise exception 'invalid_range' using errcode='22023';end if;
 select min(day) into first_day from coinops.website_activity_daily where day>=today-395;
 select coalesce(jsonb_agg(jsonb_build_object('date',day,'channel',channel,'metric',metric,'value',amount,'population',case when metric='visits' then 'page_views' else 'events' end,'attribution',case when channel='unknown' then 'unattributed' else 'utm' end,'quality',case when day=first_day or day=today then 'partial' else 'complete' end)),'[]'::jsonb) into traffic from(select day,channel,case when event_name='page_view' then 'visits' else 'intents' end metric,sum(value)::bigint amount from coinops.website_activity_daily where day between greatest(p_from,today-395) and p_to group by 1,2,3) d;
 select coalesce(jsonb_agg(jsonb_build_object('date',day,'channel',channel,'metric',metric,'value',amount,'quality',case when day=first_day or day=today then 'partial' else 'complete' end)),'[]'::jsonb) into contacts from(select day,channel,case when event_name='whatsapp_click' then 'operational_whatsapp' else 'operational_phone' end metric,sum(value)::bigint amount from coinops.website_activity_daily where day between greatest(p_from,today-395) and p_to and event_name<>'page_view' group by 1,2,3) d;
 return jsonb_build_object('version',1,'externalTenant','platform','from',p_from,'to',p_to,'timezone','America/Campo_Grande','currency','BRL','collectedAt',now(),'availableMetrics',case when first_day is null then '[]'::jsonb else '["visits","intents"]'::jsonb end,'coverageStart',case when first_day is null then '{}'::jsonb else jsonb_build_object('visits',first_day,'intents',first_day) end,'definitions',jsonb_build_object('visits','Visualizações operacionais do site institucional, sem cookies de visitante ou identificação. Não são pessoas únicas. Retenção de 395 dias; início e hoje parciais.','intents','Cliques WhatsApp ou telefone do site institucional, com aceite, recusa ou sem escolha. Não comprova conversa, cliente ou venda.'),'facts',traffic,
 'measurement',jsonb_build_object('version',1,'externalTenant','platform','from',p_from,'to',p_to,'timezone','America/Campo_Grande','collectedAt',now(),'availableMetrics',case when first_day is null then '[]'::jsonb else '["operational_whatsapp","operational_phone"]'::jsonb end,'coverageStart',case when first_day is null then '{}'::jsonb else jsonb_build_object('operational_whatsapp',first_day,'operational_phone',first_day) end,'definitions',jsonb_build_object('operational_whatsapp','Cliques WhatsApp agregados no site institucional; fonte distinta de tenants e de eventos publicitários. Não identifica visitantes.','operational_phone','Cliques no telefone institucional; não comprova chamada atendida.'),'facts',contacts));
end;$$;
revoke all on function coinops.record_website_count_v1(uuid,text,text,text,text),coinops.claim_website_read_nonce_v1(text),coinops.get_website_snapshot_v1(date,date) from public,anon,authenticated;
grant execute on function coinops.record_website_count_v1(uuid,text,text,text,text),coinops.claim_website_read_nonce_v1(text),coinops.get_website_snapshot_v1(date,date) to service_role;

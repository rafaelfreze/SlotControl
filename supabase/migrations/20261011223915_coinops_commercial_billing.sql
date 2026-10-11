-- CoinOps commercial subscription only; official otdfpmsegjxpqrzisfmi / coinops.
-- No exchange, engine, order, execution, balance, worker or operational policy changes.
begin;
set local lock_timeout='3s';
set local statement_timeout='45s';

create function coinops.billing_identity_active(p_user uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from auth.users u where u.id=p_user and u.deleted_at is null
   and (u.banned_until is null or u.banned_until<=now())) and (
 exists(select 1 from coinops.operators o
   join public.product_memberships m on m.product_id=o.product_id and m.tenant_id=o.tenant_id and m.user_id=o.user_id
   join public.product_tenants pt on pt.product_id=o.product_id and pt.tenant_id=o.tenant_id
   join public.platform_tenants t on t.id=o.tenant_id join public.products p on p.id=o.product_id
   where o.user_id=p_user and o.status='ACTIVE' and m.status='active'
     and m.role_key in('coinops.owner','coinops.operator') and pt.status='active' and t.status='active'
     and p.code='coinops' and p.product_type='internal' and p.status='active'
     and not exists(select 1 from coinops.viewer_access v where v.user_id=p_user))
 or exists(select 1 from coinops.viewer_access v join coinops.operators o on o.id=v.operator_id
   join public.product_memberships m on m.product_id=o.product_id and m.tenant_id=o.tenant_id and m.user_id=o.user_id
   join public.product_tenants pt on pt.product_id=o.product_id and pt.tenant_id=o.tenant_id
   join public.platform_tenants t on t.id=o.tenant_id join public.products p on p.id=o.product_id
   join auth.users u on u.id=v.user_id
   where v.user_id=p_user and v.status='ACTIVE' and v.deleted_at is null and o.status='ACTIVE'
     and u.raw_app_meta_data->>'coinops_role'='VIEWER' and m.status='active'
     and m.role_key in('coinops.owner','coinops.operator') and pt.status='active' and t.status='active'
     and p.code='coinops' and p.product_type='internal' and p.status='active'));
$$;
revoke all on function coinops.billing_identity_active(uuid) from public,anon,authenticated;
grant execute on function coinops.billing_identity_active(uuid) to service_role;
create function coinops.billing_self_allowed(p_user uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select p_user=(select auth.uid()) and coinops.billing_identity_active(p_user);
$$;
revoke all on function coinops.billing_self_allowed(uuid) from public,anon;
grant execute on function coinops.billing_self_allowed(uuid) to authenticated,service_role;

create table coinops.saas_billing_projections(
 user_id uuid primary key references auth.users(id) on delete restrict,
 billing_subscription_id uuid not null unique,version bigint not null check(version>0),
 projection jsonb not null check(jsonb_typeof(projection)='object'
   and projection->>'product_key'='coinops' and projection->>'external_tenant_id'=user_id::text
   and projection->>'billing_subscription_id'=billing_subscription_id::text
   and not projection ? 'checkout_url'),updated_at timestamptz not null default now()
);
create table coinops.saas_billing_events(
 event_id uuid primary key,user_id uuid not null references auth.users(id) on delete restrict,
 billing_subscription_id uuid not null,version bigint not null,event_type text not null,
 applied boolean not null,created_at timestamptz not null default now()
);
create table coinops.saas_billing_nonces(nonce uuid primary key,created_at timestamptz not null default now());
create index saas_billing_events_user on coinops.saas_billing_events(user_id,created_at desc);
create index saas_billing_nonces_time on coinops.saas_billing_nonces(created_at);
create table coinops.saas_billing_sync(
 id boolean primary key default true check(id),cursor uuid,lease_until timestamptz,lease_token uuid,
 last_error text,synced_at timestamptz
);
insert into coinops.saas_billing_sync(id) values(true);
alter table coinops.saas_billing_projections enable row level security;
alter table coinops.saas_billing_projections force row level security;
alter table coinops.saas_billing_events enable row level security;
alter table coinops.saas_billing_nonces enable row level security;
alter table coinops.saas_billing_sync enable row level security;
revoke all on coinops.saas_billing_projections,coinops.saas_billing_events,coinops.saas_billing_nonces,coinops.saas_billing_sync from public,anon,authenticated;
grant all on coinops.saas_billing_projections,coinops.saas_billing_events,coinops.saas_billing_nonces,coinops.saas_billing_sync to service_role;
grant select on coinops.saas_billing_projections to authenticated;
create policy billing_self_read on coinops.saas_billing_projections for select to authenticated using(coinops.billing_self_allowed(user_id));

create function coinops.billing_discover_identities(p_cursor uuid default null,p_search text default '',p_limit integer default 50,p_user uuid default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;next_id uuid;begin
 if auth.role() is distinct from 'service_role' then raise exception 'billing_forbidden';end if;
 if p_limit not between 1 and 100 or length(coalesce(p_search,''))>160 then raise exception 'billing_invalid_query';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'slug',id::text,'owner_id',id,'status','active')order by id),'[]'::jsonb) into result from (
   select u.id,coalesce(nullif(btrim(v.display_name),''),nullif(left(btrim(u.raw_user_meta_data->>'display_name'),160),''),'Usuário CoinOps') name
   from auth.users u left join coinops.viewer_access v on v.user_id=u.id
   where coinops.billing_identity_active(u.id) and(p_cursor is null or u.id>p_cursor) and(p_user is null or u.id=p_user)
     and (coalesce(p_search,'')='' or coalesce(v.display_name,u.raw_user_meta_data->>'display_name','Usuário CoinOps') ilike '%'||p_search||'%')
   order by u.id limit p_limit
 ) identities;
 if jsonb_array_length(result)=p_limit then next_id:=(result->(p_limit-1)->>'id')::uuid;end if;
 return jsonb_build_object('ok',true,'tenants',result,'next_cursor',next_id);
end;$$;
revoke all on function coinops.billing_discover_identities(uuid,text,integer,uuid) from public,anon,authenticated;
grant execute on function coinops.billing_discover_identities(uuid,text,integer,uuid) to service_role;

create function coinops.claim_saas_billing_nonce(p_nonce uuid) returns void
language plpgsql security definer set search_path='' as $$begin
 if auth.role() is distinct from 'service_role' or p_nonce is null then raise exception 'billing_forbidden';end if;
 insert into coinops.saas_billing_nonces(nonce)values(p_nonce);
 delete from coinops.saas_billing_nonces where created_at<now()-interval '1 day';
end;$$;
revoke all on function coinops.claim_saas_billing_nonce(uuid) from public,anon,authenticated;
grant execute on function coinops.claim_saas_billing_nonce(uuid) to service_role;

create function coinops.apply_saas_billing_projection(p_projection jsonb,p_event_id uuid,p_nonce uuid,p_event_type text) returns boolean
language plpgsql security definer set search_path='' as $$
declare target uuid:=(p_projection->>'external_tenant_id')::uuid;sid uuid:=(p_projection->>'billing_subscription_id')::uuid;
 v bigint:=(p_projection->>'version')::bigint;old coinops.saas_billing_projections%rowtype;
 ev coinops.saas_billing_events%rowtype;clean jsonb;changed boolean:=false;begin
 if auth.role() is distinct from 'service_role' then raise exception 'billing_forbidden';end if;
 if p_projection->>'product_key' is distinct from 'coinops' or target is null or sid is null or v is null or v<1
   or p_event_id is null or p_nonce is null or length(coalesce(p_event_type,''))not between 3 and 80
   or p_projection->>'status' not in('trial','active','pending','overdue','grace','paused','canceled')
   or p_projection->>'status' is null then raise exception 'billing_invalid_projection';end if;
 perform pg_advisory_xact_lock(hashtextextended('coinops-commercial-billing:'||target::text,0));
 select * into old from coinops.saas_billing_projections where user_id=target for update;
 -- Revocation blocks a new binding and self access; existing financial history can still receive a cancellation/payment event.
 if old.user_id is null and not coinops.billing_identity_active(target) then raise exception 'billing_identity_inactive';end if;
 perform coinops.claim_saas_billing_nonce(p_nonce);
 select * into ev from coinops.saas_billing_events where event_id=p_event_id;
 if found then
   if ev.user_id<>target or ev.billing_subscription_id<>sid or ev.version<>v or ev.event_type<>p_event_type then raise exception 'billing_event_conflict';end if;
   return false;
 end if;
 if old.user_id is not null and old.billing_subscription_id<>sid then raise exception 'billing_binding_conflict';end if;
 if exists(select 1 from coinops.saas_billing_projections where billing_subscription_id=sid and user_id<>target)then raise exception 'billing_binding_conflict';end if;
 select jsonb_object_agg(key,value) into clean from jsonb_each(p_projection) where key=any(array[
 'billing_subscription_id','product_key','external_tenant_id','tenant_name','tenant_slug','plan_code','plan_name','amount_cents','status','version','trial_ends_at','billing_start_on','due_day','next_due_date','grace_until','last_paid_at','paused_at','canceled_at','manual_pause','registration_pending','capabilities','installment_id','balance_cents','contract_id','updated_at']);
 if old.user_id is null or v>old.version then
   insert into coinops.saas_billing_projections(user_id,billing_subscription_id,version,projection)values(target,sid,v,clean)
     on conflict(user_id)do update set version=excluded.version,projection=excluded.projection,updated_at=now();
   changed:=true;
 end if;
 insert into coinops.saas_billing_events(event_id,user_id,billing_subscription_id,version,event_type,applied)values(p_event_id,target,sid,v,p_event_type,changed);
 return changed;
end;$$;
revoke all on function coinops.apply_saas_billing_projection(jsonb,uuid,uuid,text) from public,anon,authenticated;
grant execute on function coinops.apply_saas_billing_projection(jsonb,uuid,uuid,text) to service_role;

create function coinops.claim_saas_billing_sync(p_nonce uuid,p_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$declare s coinops.saas_billing_sync%rowtype;begin
 if auth.role() is distinct from 'service_role' or p_token is null then raise exception 'billing_forbidden';end if;
 perform coinops.claim_saas_billing_nonce(p_nonce);
 select * into s from coinops.saas_billing_sync where id for update;
 if s.lease_until>now()then return jsonb_build_object('claimed',false);end if;
 update coinops.saas_billing_sync set lease_until=now()+interval '90 seconds',lease_token=p_token where id;
 return jsonb_build_object('claimed',true,'cursor',s.cursor);
end;$$;
create function coinops.finish_saas_billing_sync(p_token uuid,p_cursor uuid,p_error text) returns void
language plpgsql security definer set search_path='' as $$begin
 if auth.role() is distinct from 'service_role' or p_token is null then raise exception 'billing_forbidden';end if;
 update coinops.saas_billing_sync set cursor=case when p_error is null then p_cursor else cursor end,
   last_error=left(p_error,100),lease_until=null,lease_token=null,synced_at=case when p_error is null then now()else synced_at end
   where id and lease_token=p_token;
 if not found then raise exception 'billing_lease_lost';end if;
end;$$;
revoke all on function coinops.claim_saas_billing_sync(uuid,uuid),coinops.finish_saas_billing_sync(uuid,uuid,text) from public,anon,authenticated;
grant execute on function coinops.claim_saas_billing_sync(uuid,uuid),coinops.finish_saas_billing_sync(uuid,uuid,text) to service_role;
commit;

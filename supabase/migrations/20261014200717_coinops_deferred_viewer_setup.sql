-- CoinOps / OnPlay Platform otdfpmsegjxpqrzisfmi / coinops.
-- New identities only. No exchange, capital, engine or operational row changes.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
alter table coinops.viewer_access alter column exchange_account_id drop not null;
alter table coinops.viewer_access
 add column company_name text,
 add column owner_name text,
 add column whatsapp text,
 add column whatsapp_consent boolean not null default false;
alter table coinops.viewer_access add constraint viewer_contact_lengths check (
 (company_name is null or length(btrim(company_name)) between 2 and 120)
 and (owner_name is null or length(btrim(owner_name)) between 2 and 120)
 and (whatsapp is null or whatsapp ~ '^\+55[1-9][0-9](9[0-9]{8}|[2-9][0-9]{7})$'));
grant select(company_name,owner_name,whatsapp,whatsapp_consent) on coinops.viewer_access to authenticated;
create table coinops.viewer_signup_settings(
 singleton boolean primary key default true check(singleton),
 operator_id uuid not null references coinops.operators(id) on delete restrict
);
alter table coinops.viewer_signup_settings enable row level security;
alter table coinops.viewer_signup_settings force row level security;
revoke all on coinops.viewer_signup_settings from public,anon,authenticated;
grant all on coinops.viewer_signup_settings to service_role;
-- Only a proven unique active CoinOps operator becomes the default. Future
-- operators never silently change this existing administrative registry.
insert into coinops.viewer_signup_settings(singleton,operator_id)
select true,o.id from coinops.operators o join public.products p on p.id=o.product_id
where o.status='ACTIVE' and p.code='coinops'
 and (select count(*) from coinops.operators x join public.products q on q.id=x.product_id where x.status='ACTIVE' and q.code='coinops')=1;
create function coinops.mark_signup_viewer_v1() returns trigger
language plpgsql set search_path='' as $$
begin
 if new.raw_user_meta_data->>'onplay_product'='coinops' then
  new.raw_app_meta_data:=jsonb_set(coalesce(new.raw_app_meta_data,'{}'::jsonb),'{coinops_role}','"VIEWER"'::jsonb,true);
 end if;
 return new;
end $$;
revoke all on function coinops.mark_signup_viewer_v1() from public,anon,authenticated;
create trigger coinops_mark_signup_viewer before insert on auth.users for each row execute function coinops.mark_signup_viewer_v1();
create function coinops.create_signup_viewer_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare operator_row coinops.operators%rowtype;marker jsonb;company_name text;owner_name text;phone text;actor uuid;
begin
 if new.raw_user_meta_data->>'onplay_product' is distinct from 'coinops' then return new;end if;
 company_name:=btrim(new.raw_user_meta_data->>'company_name');owner_name:=btrim(new.raw_user_meta_data->>'owner_name');phone:=new.raw_user_meta_data->>'whatsapp';
 if coalesce(length(company_name),0) not between 2 and 120 or coalesce(length(owner_name),0) not between 2 and 120
  or phone is null or phone!~'^\+55[1-9][0-9](9[0-9]{8}|[2-9][0-9]{7})$' then
  raise exception 'coinops_signup_contact_invalid' using errcode='22023';end if;
 marker:=new.raw_app_meta_data->'coinops_provision';
 if marker is not null then
  select * into operator_row from coinops.operators where id=(marker->>'operator_id')::uuid and user_id=(marker->>'actor_id')::uuid and status='ACTIVE';
  actor:=(marker->>'actor_id')::uuid;
 else
  select o.* into operator_row from coinops.viewer_signup_settings c join coinops.operators o on o.id=c.operator_id where c.singleton and o.status='ACTIVE';
  actor:=new.id;
 end if;
 if operator_row.id is null or not exists(select 1 from public.products where id=operator_row.product_id and code='coinops') then
  raise exception 'coinops_signup_operator_unavailable' using errcode='42501';end if;
 insert into coinops.viewer_access(user_id,operator_id,exchange_account_id,display_name,email,status,created_by,company_name,owner_name,whatsapp,whatsapp_consent)
 values(new.id,operator_row.id,null,left(owner_name,80),lower(new.email),'ACTIVE',actor,company_name,owner_name,phone,false);
 return new;
end $$;
revoke all on function coinops.create_signup_viewer_v1() from public,anon,authenticated;
create trigger coinops_create_signup_viewer after insert on auth.users for each row execute function coinops.create_signup_viewer_v1();

-- Reserved QA identities cannot be discovered or bound to commercial billing.
create or replace function coinops.billing_identity_active(p_user uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from auth.users u where u.id=p_user and u.deleted_at is null
   and not coalesce(u.raw_app_meta_data->'onplay_qa'->>'product'='coinops' and u.raw_app_meta_data->'onplay_qa'->>'exclude_billing'='true',false)
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
commit;

-- Product coinops; project otdfpmsegjxpqrzisfmi; schema coinops.
-- Server-only bounded signup admission. Does not change Auth confirmation settings.
create table if not exists coinops.auth_signup_rate_windows (
 kind text not null check(kind in ('source','email','global')),
 key_hash text not null,
 window_start timestamptz not null,
 attempts integer not null check(attempts>0),
 primary key(kind,key_hash,window_start)
);
alter table coinops.auth_signup_rate_windows enable row level security;
revoke all on coinops.auth_signup_rate_windows from public,anon,authenticated,service_role;
create or replace function coinops.consume_public_signup_attempt(p_sourcehash text,p_emailhash text)
returns boolean language plpgsql security definer set search_path='' as $$
declare bucket timestamptz:=date_trunc('hour',clock_timestamp());current_count integer;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'signup_service_only' using errcode='42501';end if;
 if p_sourcehash!~'^[a-f0-9]{64}$' or p_emailhash!~'^[a-f0-9]{64}$' or p_sourcehash is null or p_emailhash is null then return false;end if;
 perform pg_advisory_xact_lock(hashtextextended('coinops:public_signup_admission',0));
 if exists(select 1 from coinops.auth_signup_rate_windows where window_start=bucket and
  ((kind='source' and key_hash=p_sourcehash and attempts>=10) or
   (kind='email' and key_hash=p_emailhash and attempts>=5) or (kind='global' and key_hash='all' and attempts>=100))) then return false;end if;
 insert into coinops.auth_signup_rate_windows(kind,key_hash,window_start,attempts)
 values('source',p_sourcehash,bucket,1),('email',p_emailhash,bucket,1),('global','all',bucket,1)
 on conflict(kind,key_hash,window_start) do update set attempts=coinops.auth_signup_rate_windows.attempts+1;
 delete from coinops.auth_signup_rate_windows where window_start<bucket-interval '2 days';
 return true;
end;$$;
revoke all on function coinops.consume_public_signup_attempt(text,text) from public,anon,authenticated;
grant execute on function coinops.consume_public_signup_attempt(text,text) to service_role;


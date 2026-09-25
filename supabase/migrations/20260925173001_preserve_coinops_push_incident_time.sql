-- An open alert remains the same incident across executor/cron upserts.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '60s';

create or replace function private.coinops_push_new_incident() returns trigger language plpgsql
  set search_path = '' as $$
begin
  if old.resolved_at is null then
    new.first_seen_at := old.first_seen_at;
  elsif new.resolved_at is null then
    new.first_seen_at := now();
  else
    new.first_seen_at := old.first_seen_at;
  end if;
  return new;
end $$;

commit;

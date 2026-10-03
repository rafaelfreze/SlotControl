-- DigitalOcean Droplet 605889779, FRA1, s-1vcpu-1gb (USD 6/month).
-- Public infrastructure only. No accounts/engines/orders are created or moved.
-- Admission remains fail-closed until canonical telemetry and preflight PASS.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
do $$
begin
  if exists(select 1 from coinops.executor_shards
    where id='executor-03' and egress_ipv4<>'167.71.37.166'::inet) then
    raise exception 'COINOPS_EXECUTOR03_IP_CONFLICT';
  end if;
  if exists(select 1 from coinops.executor_shards
    where id<>'executor-03' and egress_ipv4='167.71.37.166'::inet) then
    raise exception 'COINOPS_EXECUTOR_IP_ALREADY_BOUND';
  end if;
end $$;
insert into coinops.executor_shards(id,egress_ipv4,enabled,binance_limit_per_min,
  admission_ratio,incremental_engine_weight)
select 'executor-03','167.71.37.166'::inet,true,
  (p->>'binance_limit')::integer,(p->>'admission_ratio')::numeric,
  (p->>'incremental_weight')::integer
from (select coinops.executor_capacity_policy() as p) canonical
on conflict(id) do nothing;
commit;

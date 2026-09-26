-- Provisioned DigitalOcean droplet 603936458, FRA1. Public infrastructure only.
-- Admission still requires authenticated fresh telemetry; no account is moved.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';
do $$
begin
  if exists(select 1 from coinops.executor_shards
    where id='executor-02' and egress_ipv4<>'164.90.223.159'::inet) then
    raise exception 'COINOPS_EXECUTOR02_IP_CONFLICT';
  end if;
  if exists(select 1 from coinops.executor_shards
    where id<>'executor-02' and egress_ipv4='164.90.223.159'::inet) then
    raise exception 'COINOPS_EXECUTOR_IP_ALREADY_BOUND';
  end if;
end $$;
insert into coinops.executor_shards(id,egress_ipv4,enabled,binance_limit_per_min,
  admission_ratio,incremental_engine_weight)
values('executor-02','164.90.223.159',true,6000,.65,900)
on conflict(id) do nothing;
commit;

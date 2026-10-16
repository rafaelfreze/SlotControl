-- CoinOps control plane only. Preserve legacy25 and every existing LIVE engine.
-- No strategy, order, position, balance, lease or runtime mutation.
begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

create or replace function private.coinops_slot_workload_profile(p_shard_id text,p_environment text,p_slot_count integer)
returns jsonb language plpgsql stable set search_path='' as $$
declare a coinops.executor_admission_attestations%rowtype;
  r coinops.executor_admission_release%rowtype; policy jsonb:=coinops.executor_capacity_policy();
  proof jsonb; profile jsonb; units integer; upper_bound numeric; web_fingerprint text;
  required_scenarios text[]:=array['STEADY','ALL_TP_FILL_BURST','TRANSIENT_RETRIES','SIBLING_LOAD',
    'CPU_RAM','RECONCILIATION_BACKLOG','QUEUE_AND_RATE_LIMIT'];
begin
  if p_slot_count=25 then return jsonb_build_object('code','SLOT_WORKLOAD_CERTIFIED','capacity_units',1,'basis','LEGACY_25_SLOT_PROFILE'); end if;
  if p_slot_count is null or p_slot_count not between 2 and 100 or p_environment is distinct from 'REAL' then
    return jsonb_build_object('code','SLOT_WORKLOAD_UNCERTIFIED'); end if;
  select * into a from coinops.executor_admission_attestations where shard_id=p_shard_id;
  select * into r from coinops.executor_admission_release where singleton;
  proof:=a.evidence->'slot_workload';
  if a.shard_id is null or r.target_sha is null or a.target_sha is distinct from r.target_sha
    or a.runtime_sha256 is distinct from r.runtime_sha256 or a.node_version is distinct from r.node_version
    or a.policy_version is distinct from r.policy_version or a.policy_version is distinct from policy->>'version'
    or jsonb_typeof(proof) is distinct from 'object' or proof->>'contract' is distinct from 'SLOT_WORKLOAD_V1'
    or proof->>'environment' is distinct from p_environment or proof->>'target_sha' is distinct from r.target_sha
    or proof->>'runtime_sha256' is distinct from r.runtime_sha256 or proof->>'policy_version' is distinct from r.policy_version
    or jsonb_typeof(proof->'profiles') is distinct from 'array' then
    return jsonb_build_object('code','SLOT_WORKLOAD_UNCERTIFIED'); end if;
  if (select count(*) from jsonb_array_elements(proof->'profiles') p where p->'slot_count'=to_jsonb(p_slot_count))<>1 then
    return jsonb_build_object('code','SLOT_WORKLOAD_UNCERTIFIED'); end if;
  select p into profile from jsonb_array_elements(proof->'profiles') p where p->'slot_count'=to_jsonb(p_slot_count);
  -- This header is injected by the server-only service-role client from the
  -- prebuild-verified source graph, never accepted from an ADMIN browser body.
  -- All nested APPEND/reserve/activate paths share this one canonical guard.
  web_fingerprint:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb->>'x-coinops-workload-sha256';
  if web_fingerprint is null or web_fingerprint!~'^[a-f0-9]{64}$'
    or profile->>'web_workload_sha256' is distinct from web_fingerprint then
    return jsonb_build_object('code','SLOT_WORKLOAD_UNCERTIFIED'); end if;
  if profile->>'status' is distinct from 'PASS'
    or jsonb_typeof(profile->'capacity_units') is distinct from 'number'
    or profile->>'capacity_units' !~ '^[1-9][0-9]*$'
    or jsonb_typeof(profile->'upper_bound_weight_per_minute') is distinct from 'number'
    or profile->>'upper_bound_weight_per_minute' !~ '^[0-9]+([.][0-9]+)?$'
    or profile->>'evidence_sha256' is null or profile->>'evidence_sha256' !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(profile->'scenarios') is distinct from 'object'
    or exists(select 1 from unnest(required_scenarios) s where profile->'scenarios'->>s is distinct from 'PASS') then
    return jsonb_build_object('code','SLOT_WORKLOAD_UNCERTIFIED'); end if;
  units:=(profile->>'capacity_units')::integer; upper_bound:=(profile->>'upper_bound_weight_per_minute')::numeric;
  if units not between 1 and 25 or upper_bound<=0 or upper_bound>units*(policy->>'incremental_weight')::numeric then
    return jsonb_build_object('code','SLOT_WORKLOAD_UNCERTIFIED'); end if;
  return jsonb_build_object('code','SLOT_WORKLOAD_CERTIFIED','capacity_units',units,
    'upper_bound_weight_per_minute',upper_bound,'evidence_sha256',profile->>'evidence_sha256',
    'web_workload_sha256',web_fingerprint,'basis','ATTESTED_EXACT_SLOT_WORKLOAD');
exception when data_exception then
  return jsonb_build_object('code','SLOT_WORKLOAD_UNCERTIFIED');
end $$;
revoke all on function private.coinops_slot_workload_profile(text,text,integer) from public,anon,authenticated;
grant execute on function private.coinops_slot_workload_profile(text,text,integer) to service_role;

commit;

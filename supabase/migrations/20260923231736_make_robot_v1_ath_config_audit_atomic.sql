-- Phase 5.0: queued profile configuration and its evidence commit together.
-- No parameters, orders, balances, environment permissions or history changed.
create or replace function coinops.audit_robot_v1_ath_config_save()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.next_config_version is null or
     (new.next_config_version is not distinct from old.next_config_version and
      new.next_gain_rate is not distinct from old.next_gain_rate and
      new.next_normal_spacing_rate is not distinct from old.next_normal_spacing_rate and
      new.next_post_ath_spacing_rate is not distinct from old.next_post_ath_spacing_rate and
      new.ath_floor_reference is not distinct from old.ath_floor_reference) then
    return new;
  end if;
  if new.next_config_version <= coalesce(old.next_config_version, old.config_version)
     or new.product_id is distinct from old.product_id or new.tenant_id is distinct from old.tenant_id
     or new.user_id is distinct from old.user_id or new.environment is distinct from old.environment
     or new.asset is distinct from old.asset then
    raise exception 'COINOPS_ATH_CONFIG_VERSION_OR_SCOPE_INVALID';
  end if;
  insert into coinops.robot_v1_ath_events
    (profile_id,product_id,tenant_id,user_id,environment,asset,event_key,event_type,details,observed_at)
  values (new.id,new.product_id,new.tenant_id,new.user_id,new.environment,new.asset,
    'STRATEGY_CONFIG_SAVED:' || new.next_config_version,'STRATEGY_CONFIG_SAVED',
    jsonb_build_object('next_config_version',new.next_config_version,'gain_rate',new.next_gain_rate,
      'normal_spacing_rate',new.next_normal_spacing_rate,'post_ath_spacing_rate',new.next_post_ath_spacing_rate,
      'floor_reference',new.ath_floor_reference,'evidence_basis','ATOMIC_PROFILE_UPDATE'),clock_timestamp());
  return new;
end;
$$;
revoke all on function coinops.audit_robot_v1_ath_config_save() from public, anon, authenticated;
grant execute on function coinops.audit_robot_v1_ath_config_save() to service_role;
create trigger robot_v1_ath_config_atomic_audit after update on coinops.robot_v1_ath_profiles
for each row execute function coinops.audit_robot_v1_ath_config_save();

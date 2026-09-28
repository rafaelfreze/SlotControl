#!/usr/bin/env bash
# Executor01's existing checkout only. No credential, registry or state migration.
set -euo pipefail
set +x
umask 077
fail() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }
script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$script_directory/runtime-preflight.sh"
[[ ${EUID} -eq 0 ]] || fail 'ROOT_REQUIRED'
[[ $# -eq 1 && $1 =~ ^[a-f0-9]{40}$ ]] || fail 'Usage: deploy-legacy.sh FULL_REVIEWED_MAIN_SHA'
revision=$1
/usr/local/bin/node "$script_directory/fleet-parity.mjs" --check-target "$revision" || fail 'FLEET_RELEASE_TARGET_REQUIRED'
repo=/opt/coinops/source
env_file=/etc/coinops/live-executor.env
[[ -d $repo/.git && ! -L $repo && ! -e /opt/coinops/current ]] || fail 'LEGACY_CHECKOUT_REQUIRED'
[[ -f $env_file && ! -L $env_file && $(stat -c %u "$env_file") == 0 && $(stat -c %a "$env_file") == 600 ]] || fail 'PRIVATE_ROOT_ENV_REQUIRED'
shard=$(awk -F= '$1=="COINOPS_EXECUTOR_SHARD_ID"{print $2}' "$env_file")
[[ -z $shard || $shard == executor-01 ]] || fail 'EXECUTOR01_REQUIRED'
ipv4=$(awk -F= '$1=="LIVE_EXECUTOR_EGRESS_IP"{print $2}' "$env_file")
[[ $ipv4 == 46.101.104.48 && $(curl -4fsS --max-time 10 https://api.ipify.org) == "$ipv4" ]] || fail 'EXECUTOR01_EGRESS_MISMATCH'
runtime_service_identity "$repo"
exec 9>/run/coinops-shard-deploy.lock
flock -n 9 || fail 'DEPLOY_ALREADY_RUNNING'
[[ $(git -C "$repo" remote get-url origin) == https://github.com/rafaelfreze/SlotControl.git ]] || fail 'ORIGIN_MISMATCH'
[[ -z $(git -C "$repo" status --porcelain --untracked-files=all) ]] || fail 'CLEAN_WORKTREE_REQUIRED'
previous=$(git -C "$repo" rev-parse HEAD)
old_version=$(awk -F= '$1=="COINOPS_EXECUTOR_VERSION"{print $2}' "$env_file")
[[ $previous =~ ^[a-f0-9]{40}$ && $old_version =~ ^[a-zA-Z0-9._-]{1,128}$ ]] || fail 'PREVIOUS_RELEASE_INVALID'
git -C "$repo" fetch origin refs/heads/main:refs/remotes/origin/main
[[ $(git -C "$repo" rev-parse "$revision^{commit}") == "$revision" ]] || fail 'COMMIT_NOT_FOUND'
git -C "$repo" merge-base --is-ancestor "$revision" refs/remotes/origin/main || fail 'SHA_NOT_IN_MAIN'
git -C "$repo" merge-base --is-ancestor "$previous" "$revision" || fail 'FAST_FORWARD_REQUIRED'

set_version() {
  local value=$1 temporary
  temporary=$(mktemp /etc/coinops/.env-version.XXXXXX)
  awk -v value="$value" 'BEGIN{found=0} /^COINOPS_EXECUTOR_VERSION=/{print "COINOPS_EXECUTOR_VERSION="value;found=1;next} {print} END{if(!found) print "COINOPS_EXECUTOR_VERSION="value}' "$env_file" > "$temporary"
  [[ $(awk '!/^COINOPS_EXECUTOR_VERSION=/' "$env_file" | sha256sum) == $(awk '!/^COINOPS_EXECUTOR_VERSION=/' "$temporary" | sha256sum) ]] || fail 'PROTECTED_ENV_CHANGED'
  chmod 600 "$temporary"; chown root:root "$temporary"; mv -f "$temporary" "$env_file"
}
public_code_permissions() {
  # Only tracked runtime source/package files, never .git, env, vault or state.
  local file
  chmod go+x "$repo" "$repo/apps" "$repo/apps/web" "$repo/apps/web/lib" "$repo/apps/live-executor" || return 1
  [[ -z $(find "$repo/apps/live-executor/src" "$repo/apps/web/lib/execution" -type l -print -quit) ]] || return 1
  find "$repo/apps/live-executor/src" "$repo/apps/web/lib/execution" -type d -exec chmod go+rx {} + || return 1
  while IFS= read -r -d '' file; do
    [[ -f $repo/$file && ! -L $repo/$file ]] || return 1
    chmod go+r "$repo/$file" || return 1
  done < <(git -C "$repo" ls-files -z -- apps/live-executor/src apps/live-executor/package.json apps/web/lib/execution)
}
health_matches() {
  local expected=$1 attempt health_file
  health_file=$(mktemp /run/coinops-legacy-health.XXXXXX)
  for attempt in $(seq 1 15); do
    if curl -fsS --max-time 15 http://127.0.0.1:8080/health > "$health_file" \
      && /usr/local/bin/node --input-type=module -e 'import{readFileSync}from"node:fs";const h=JSON.parse(readFileSync(process.argv[1],"utf8"));process.exit(h.healthy===true&&h.executor_shard_id==="executor-01"&&h.actual_executor_version===process.argv[2]&&h.egress_ipv4_verified===true&&h.egress_ipv4===process.argv[3]?0:1)' "$health_file" "$expected" "$ipv4"; then
      return 0
    fi
    sleep 2
  done
  return 1
}
rollback() {
  # This is an exact, recorded prior commit; switch refuses dirty/conflicting
  # changes instead of force-resetting anything. umask applies on rollback too.
  [[ -z $(git -C "$repo" status --porcelain --untracked-files=all) ]] || fail 'ROLLBACK_WORKTREE_DIRTY'
  (umask 022; git -C "$repo" switch --detach "$previous") || fail 'ROLLBACK_CHECKOUT_FAILED'
  public_code_permissions || fail 'ROLLBACK_CODE_PERMISSIONS_FAILED'
  runtime_preflight "$repo" || fail 'ROLLBACK_SERVICE_IMPORT_FAILED'
  set_version "$old_version"
  systemctl restart coinops-live-executor || fail 'ROLLBACK_RESTART_FAILED'
  health_matches "$old_version" || fail 'ROLLBACK_HEALTH_FAILED'
  printf 'DEPLOY_FAILED_ROLLED_BACK shard=executor-01 sha=%s; state preserved.\n' "$previous" >&2
  exit 1
}

# Validate the exact candidate while the established executor keeps running.
# Public source is world-readable; no env, vault or runtime state enters stage.
staging=$(mktemp -d /opt/coinops/.legacy-preflight.XXXXXX)
(umask 022; git -C "$repo" archive "$revision" apps/live-executor apps/web/lib/execution | tar -x -C "$staging")
chmod -R u=rwX,go=rX "$staging"
runtime_preflight "$staging" || fail 'CANDIDATE_SERVICE_IMPORT_FAILED'
public_code_permissions || fail 'CURRENT_CODE_PERMISSIONS_FAILED'
runtime_preflight "$repo" || fail 'CURRENT_SERVICE_IMPORT_FAILED'
if [[ $previous == "$revision" && $old_version == "$revision" ]] \
  && systemctl is-active --quiet coinops-live-executor && health_matches "$revision"; then
  printf 'ALREADY_DEPLOYED shard=executor-01 sha=%s (no restart); FLEET_PARITY_REQUIRED before closing rollout\n' "$revision"; exit 0
fi
(umask 022; git -C "$repo" merge --ff-only "$revision") || fail 'FAST_FORWARD_FAILED'
public_code_permissions || rollback
runtime_preflight "$repo" || rollback
set_version "$revision"
systemctl restart coinops-live-executor || rollback
health_matches "$revision" || rollback
printf 'DEPLOY_HEALTHY shard=executor-01 sha=%s ip=%s\n' "$revision" "$ipv4"
printf 'FLEET_PARITY_REQUIRED: run fleet-parity.mjs --verify from reviewed main before closing this rollout.\n'

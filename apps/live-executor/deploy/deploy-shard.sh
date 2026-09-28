#!/usr/bin/env bash
# Deploy/rollback code only. State, Binance vault, registry and leases remain in place.
set -euo pipefail
set +x
umask 077
fail() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }
script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$script_directory/runtime-preflight.sh"
[[ ${EUID} -eq 0 ]] || fail 'ROOT_REQUIRED'
[[ $# -eq 2 ]] || fail 'Usage: deploy-shard.sh executor-02 FULL_REVIEWED_MAIN_SHA'
shard=$1; revision=$2
[[ $shard =~ ^executor-[0-9]{2,4}$ && $shard != executor-01 && $shard != executor-00 ]] || fail 'EXECUTOR01_FORBIDDEN'
[[ $revision =~ ^[a-f0-9]{40}$ ]] || fail 'FULL_COMMIT_SHA_REQUIRED'
env_file=/etc/coinops/live-executor.env
[[ -f $env_file && ! -L $env_file && $(stat -c %u "$env_file") == 0 && $(stat -c %a "$env_file") == 600 ]] || fail 'PRIVATE_ROOT_ENV_REQUIRED'
[[ $(awk -F= '$1=="COINOPS_EXECUTOR_SHARD_ID"{print $2}' "$env_file") == "$shard" ]] || fail 'SHARD_ID_MISMATCH'
ipv4=$(awk -F= '$1=="LIVE_EXECUTOR_EGRESS_IP"{print $2}' "$env_file")
[[ -n $ipv4 && $ipv4 != 46.101.104.48 ]] || fail 'EXECUTOR01_FORBIDDEN'
[[ $(curl -4fsS --max-time 10 https://api.ipify.org) == "$ipv4" ]] || fail 'EGRESS_IP_MISMATCH'
[[ ! -e /opt/coinops/source ]] || fail 'LEGACY_CHECKOUT_FORBIDDEN'
runtime_service_identity /opt/coinops/current
exec 9>/run/coinops-shard-deploy.lock
flock -n 9 || fail 'DEPLOY_ALREADY_RUNNING'
repo=/opt/coinops/repository.git
if [[ ! -d $repo ]]; then
  git init --bare "$repo"
  git --git-dir="$repo" remote add origin https://github.com/rafaelfreze/SlotControl.git
fi
[[ $(git --git-dir="$repo" remote get-url origin) == https://github.com/rafaelfreze/SlotControl.git ]] || fail 'ORIGIN_MISMATCH'
# Fetch the fully qualified branch without pruning the single tracking ref.
# The previous abbreviated/pruned fetch deleted this ref on the initial VPS.
# Avoid that ambiguous combination; no other refs are needed or deployed.
git --git-dir="$repo" fetch origin refs/heads/main:refs/remotes/origin/main
[[ $(git --git-dir="$repo" rev-parse "$revision^{commit}") == "$revision" ]] || fail 'COMMIT_NOT_FOUND'
git --git-dir="$repo" merge-base --is-ancestor "$revision" refs/remotes/origin/main || fail 'SHA_NOT_IN_MAIN'
release=/opt/coinops/releases/$revision
if [[ ! -d $release ]]; then
  staging=$(mktemp -d /opt/coinops/releases/.staging.XXXXXX)
  (umask 022; git --git-dir="$repo" archive "$revision" apps/live-executor apps/web/lib/execution | tar -x -C "$staging")
  printf '%s\n' "$revision" > "$staging/REVISION"
  chmod -R u=rwX,go=rX "$staging"
  runtime_preflight "$staging" || fail 'CANDIDATE_SERVICE_IMPORT_FAILED'
  mv "$staging" "$release"
fi
[[ ! -L $release && $(cat "$release/REVISION") == "$revision" ]] || fail 'RELEASE_IDENTITY_MISMATCH'
chmod -R u=rwX,go=rX "$release"
runtime_preflight "$release" || fail 'RELEASE_SERVICE_IMPORT_FAILED'
previous=''
if [[ -L /opt/coinops/current ]]; then
  previous=$(readlink -f /opt/coinops/current)
elif [[ -e /opt/coinops/current ]]; then
  fail 'CURRENT_MUST_BE_RELEASE_SYMLINK'
fi
if [[ -n $previous ]]; then
  [[ $previous =~ ^/opt/coinops/releases/[a-f0-9]{40}$ && -f $previous/REVISION ]] || fail 'PREVIOUS_RELEASE_INVALID'
  chmod -R u=rwX,go=rX "$previous"
  runtime_preflight "$previous" || fail 'ROLLBACK_SERVICE_IMPORT_FAILED'
fi
old_version=$(awk -F= '$1=="COINOPS_EXECUTOR_VERSION"{print $2}' "$env_file")
[[ -z $previous || $old_version =~ ^[a-zA-Z0-9._-]{1,128}$ ]] || fail 'PREVIOUS_VERSION_INVALID'
set_version() {
  local value=$1 temporary
  temporary=$(mktemp /etc/coinops/.env-version.XXXXXX)
  awk -v value="$value" 'BEGIN{found=0} /^COINOPS_EXECUTOR_VERSION=/{print "COINOPS_EXECUTOR_VERSION="value;found=1;next} {print} END{if(!found) print "COINOPS_EXECUTOR_VERSION="value}' "$env_file" > "$temporary"
  chmod 600 "$temporary"; chown root:root "$temporary"; mv -f "$temporary" "$env_file"
}
switch_release() {
  local target=$1
  ln -s "$target" /opt/coinops/current.next
  mv -Tf /opt/coinops/current.next /opt/coinops/current
}
health_matches() {
  local expected=$1 attempt health_file
  health_file=$(mktemp /run/coinops-shard-health.XXXXXX)
  for attempt in $(seq 1 15); do
    if curl -fsS --max-time 15 http://127.0.0.1:8080/health > "$health_file" \
      && /usr/local/bin/node --input-type=module -e 'import{readFileSync}from"node:fs";const h=JSON.parse(readFileSync(process.argv[1],"utf8"));process.exit(h.healthy===true&&h.executor_shard_id===process.argv[2]&&h.actual_executor_version===process.argv[3]&&h.egress_ipv4_verified===true&&h.egress_ipv4===process.argv[4]?0:1)' "$health_file" "$shard" "$expected" "$ipv4"; then
      return 0
    fi
    sleep 2
  done
  return 1
}
[[ ! -e /opt/coinops/current.next && ! -L /opt/coinops/current.next ]] || fail 'INTERRUPTED_SWITCH_REQUIRES_INSPECTION'
if [[ $previous == "$release" && $old_version == "$revision" ]] \
  && systemctl is-active --quiet coinops-live-executor && health_matches "$revision"; then
  printf 'ALREADY_DEPLOYED shard=%s sha=%s (no restart)\n' "$shard" "$revision"; exit 0
fi
set_version "$revision"
switch_release "$release"
restart_ok=true
systemctl restart coinops-live-executor || restart_ok=false
healthy=false
if [[ $restart_ok == true ]] && health_matches "$revision"; then healthy=true; fi
if [[ $healthy != true ]]; then
  if [[ -n $previous ]]; then
    (umask 022; chmod -R u=rwX,go=rX "$previous")
    runtime_preflight "$previous" || fail 'ROLLBACK_SERVICE_IMPORT_FAILED'
    switch_release "$previous"; set_version "$old_version"; systemctl restart coinops-live-executor || fail 'ROLLBACK_RESTART_FAILED'
    health_matches "$old_version" || fail 'ROLLBACK_HEALTH_FAILED'
    printf 'DEPLOY_FAILED_ROLLED_BACK shard=%s previous=%s; previous health confirmed.\n' "$shard" "$(basename "$previous")" >&2
  else
    systemctl stop coinops-live-executor
    printf 'FIRST_DEPLOY_FAILED shard=%s; state preserved; inspect logs.\n' "$shard" >&2
  fi
  exit 1
fi
printf 'DEPLOY_HEALTHY shard=%s sha=%s ip=%s\n' "$shard" "$revision" "$ipv4"

#!/usr/bin/env bash
# Maintenance-only publication from GitHub/main. No financial runtime restart,
# env, vault, registry, claims, strategy, order or database changes.
set -euo pipefail
set +x
umask 022
fail() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }
[[ ${EUID} -eq 0 ]] || fail ROOT_REQUIRED
[[ $# -eq 1 && $1 =~ ^[a-f0-9]{40}$ ]] || fail 'Usage: install-nonce-retention.sh FULL_REVIEWED_MAIN_SHA'
revision=$1
[[ $(/usr/local/bin/node --version) =~ ^v24\.[0-9]+\.[0-9]+$ ]] || fail NODE24_REQUIRED
for binary in git flock runuser systemd-analyze; do command -v "$binary" >/dev/null || fail MAINTENANCE_DEPENDENCY_MISSING; done
service_user=$(systemctl show coinops-live-executor.service --property=User --value)
service_group=$(systemctl show coinops-live-executor.service --property=Group --value)
[[ $service_user == coinops-executor && $service_group == coinops-executor && $(id -u "$service_user") != 0 ]] \
  || fail NONROOT_EXECUTOR_SERVICE_IDENTITY_REQUIRED
before_pid=$(systemctl show coinops-live-executor.service --property=MainPID --value)
before_start=$(systemctl show coinops-live-executor.service --property=ExecMainStartTimestampMonotonic --value)
[[ $before_pid =~ ^[0-9]+$ && $before_pid != 0 && $before_start =~ ^[0-9]+$ ]] || fail RUNNING_EXECUTOR_REQUIRED
systemctl is-active --quiet coinops-live-executor.service || fail RUNNING_EXECUTOR_REQUIRED
state=/var/lib/coinops-live-executor
[[ -d $state && ! -L $state && $(realpath -e "$state") == "$state" \
  && $(stat -c %u "$state") == "$(id -u "$service_user")" && $(stat -c %a "$state") == 700 ]] \
  || fail PRIVATE_EXECUTOR_STATE_REQUIRED
if [[ ! -e $state/nonces && ! -L $state/nonces ]]; then
  runuser -u "$service_user" -g "$service_group" -- mkdir -m 700 -- "$state/nonces"
fi
[[ -d $state/nonces && ! -L $state/nonces && $(realpath -e "$state/nonces") == "$state/nonces" \
  && $(stat -c %u "$state/nonces") == "$(id -u "$service_user")" && $(stat -c %a "$state/nonces") == 700 ]] \
  || fail PRIVATE_NONCE_CACHE_REQUIRED
if [[ -d /opt/coinops/source/.git && ! -L /opt/coinops/source ]]; then
  repo=/opt/coinops/source
  git_command=(git -C "$repo")
elif [[ -d /opt/coinops/repository.git && ! -L /opt/coinops/repository.git ]]; then
  repo=/opt/coinops/repository.git
  git_command=(git --git-dir="$repo")
else fail ESTABLISHED_OFFICIAL_GIT_REQUIRED; fi
[[ $("${git_command[@]}" remote get-url origin) == https://github.com/rafaelfreze/SlotControl.git ]] || fail ORIGIN_MISMATCH
"${git_command[@]}" fetch origin refs/heads/main:refs/remotes/origin/main
[[ $("${git_command[@]}" rev-parse "$revision^{commit}") == "$revision" ]] || fail COMMIT_NOT_FOUND
"${git_command[@]}" merge-base --is-ancestor "$revision" refs/remotes/origin/main || fail SHA_NOT_IN_MAIN
assets=(apps/live-executor/src/nonce-retention.mjs
  apps/live-executor/deploy/nonce-maintenance.mjs
  apps/live-executor/deploy/run-nonce-retention.sh
  apps/live-executor/deploy/coinops-nonce-retention.service
  apps/live-executor/deploy/coinops-nonce-retention.timer
  apps/live-executor/deploy/install-nonce-retention.sh)
for file in "${assets[@]}"; do
  tree=$("${git_command[@]}" ls-tree "$revision" -- "$file")
  [[ $tree =~ ^100(644|755)\ blob\ [a-f0-9]{40}[[:space:]] && $tree == *$'\t'"$file" ]] || fail PUBLIC_MAINTENANCE_BLOB_REQUIRED
done
maintenance=/opt/coinops/maintenance
for directory in "$maintenance" "$maintenance/releases"; do
  if [[ -e $directory || -L $directory ]]; then
    [[ -d $directory && ! -L $directory && $(realpath -e "$directory") == "$directory" \
      && $(stat -c %u "$directory") == 0 && $(stat -c %a "$directory") == 755 ]] || fail PRIVATE_MAINTENANCE_CODE_ROOT_REQUIRED
  else install -d -o root -g root -m 755 "$directory"; fi
done
release=$maintenance/releases/$revision
exec 8>/run/coinops-nonce-maintenance-install.lock
flock --exclusive --nonblock 8 || fail MAINTENANCE_INSTALL_ALREADY_RUNNING
if [[ ! -e $release && ! -L $release ]]; then
  staging=$(mktemp -d "$maintenance/releases/.staging.XXXXXX")
  [[ $staging == "$maintenance/releases/.staging."* && ! -L $staging ]] || fail STAGING_IDENTITY_INVALID
  "${git_command[@]}" archive "$revision" "${assets[@]}" | tar -x -C "$staging"
  chmod -R u=rwX,go=rX "$staging"
  chown -R root:root "$staging"
  # Both Node and shell entrypoints are read explicitly; no maintenance asset
  # requires an executable mode, even when Git records an executable shell file.
  for file in "${assets[@]}"; do chmod 644 "$staging/$file"; done
  printf '%s\n' "$revision" > "$staging/REVISION"
  mv -- "$staging" "$release"
fi
[[ -d $release && ! -L $release && $(realpath -e "$release") == "$release" \
  && $(stat -c %u "$release") == 0 && $(stat -c %a "$release") == 755 \
  && -f $release/REVISION && ! -L $release/REVISION \
  && $(stat -c %u "$release/REVISION") == 0 && $(stat -c %a "$release/REVISION") == 644 \
  && $(cat "$release/REVISION") == "$revision" ]] || fail MAINTENANCE_RELEASE_IDENTITY_MISMATCH
for file in "${assets[@]}"; do
  candidate=$release/$file
  parent=$(dirname -- "$candidate")
  while [[ $parent != "$maintenance/releases" ]]; do
    [[ $parent == "$release" || $parent == "$release/"* ]] || fail MAINTENANCE_PUBLIC_DIRECTORY_INVALID
    [[ -d $parent && ! -L $parent && $(realpath -e "$parent") == "$parent" \
      && $(stat -c %u "$parent") == 0 && $(stat -c %a "$parent") == 755 ]] || fail MAINTENANCE_PUBLIC_DIRECTORY_INVALID
    parent=$(dirname -- "$parent")
  done
  [[ -f $candidate && ! -L $candidate && $(realpath -e "$candidate") == "$candidate" \
    && $(stat -c %u "$candidate") == 0 && $(stat -c %a "$candidate") == 644 && $(stat -c %h "$candidate") == 1 \
    && $("${git_command[@]}" hash-object "$candidate") == "$("${git_command[@]}" rev-parse "$revision:$file")" ]] \
    || fail MAINTENANCE_PUBLIC_FILE_HASH_MISMATCH
done
maintenance_fingerprint=$(/usr/local/bin/node --input-type=module -e '
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const [root, ...paths] = process.argv.slice(1);
const lines = paths.sort().map(path => `${path}\0${createHash("sha256").update(readFileSync(join(root, path))).digest("hex")}\n`);
process.stdout.write(createHash("sha256").update(lines.join("")).digest("hex"));
' "$release" "${assets[@]}")
[[ $maintenance_fingerprint =~ ^[a-f0-9]{64}$ ]] || fail MAINTENANCE_FINGERPRINT_INVALID
for module in "$release/apps/live-executor/src/nonce-retention.mjs" "$release/apps/live-executor/deploy/nonce-maintenance.mjs"; do
  runuser -u "$service_user" -g "$service_group" -- /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin \
    /usr/local/bin/node --check "$module" || fail MAINTENANCE_SERVICE_IMPORT_FAILED
done
runuser -u "$service_user" -g "$service_group" -- /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin \
  /usr/local/bin/node "$release/apps/live-executor/deploy/nonce-maintenance.mjs" --dry-run || fail MAINTENANCE_DRY_RUN_FAILED
systemd-analyze verify "$release/apps/live-executor/deploy/coinops-nonce-retention.service" \
  "$release/apps/live-executor/deploy/coinops-nonce-retention.timer" || fail MAINTENANCE_UNIT_INVALID
for unit in coinops-nonce-retention.service coinops-nonce-retention.timer; do
  target=/etc/systemd/system/$unit
  if [[ -e $target || -L $target ]]; then
    [[ -f $target && ! -L $target && $(stat -c %u "$target") == 0 && $(stat -c %a "$target") == 644 ]] \
      || fail MAINTENANCE_EXISTING_UNIT_NOT_PUBLIC_ROOT_FILE
  fi
done
if [[ -e $maintenance/current || -L $maintenance/current ]]; then
  [[ -L $maintenance/current && $(readlink -f "$maintenance/current") =~ ^/opt/coinops/maintenance/releases/[a-f0-9]{40}$ ]] \
    || fail MAINTENANCE_CURRENT_RELEASE_INVALID
fi
[[ ! -e $maintenance/current.next && ! -L $maintenance/current.next ]] || fail MAINTENANCE_INTERRUPTED_SWITCH_REQUIRES_INSPECTION
ln -s "$release" "$maintenance/current.next"
mv -Tf "$maintenance/current.next" "$maintenance/current"
install -o root -g root -m 644 "$release/apps/live-executor/deploy/coinops-nonce-retention.service" /etc/systemd/system/coinops-nonce-retention.service
install -o root -g root -m 644 "$release/apps/live-executor/deploy/coinops-nonce-retention.timer" /etc/systemd/system/coinops-nonce-retention.timer
systemctl daemon-reload
systemctl enable --now coinops-nonce-retention.timer
[[ $(systemctl show coinops-live-executor.service --property=MainPID --value) == "$before_pid" \
  && $(systemctl show coinops-live-executor.service --property=ExecMainStartTimestampMonotonic --value) == "$before_start" ]] \
  || fail EXECUTOR_PROCESS_CHANGED_DURING_MAINTENANCE_INSTALL
systemctl is-active --quiet coinops-live-executor.service || fail EXECUTOR_NOT_ACTIVE_AFTER_MAINTENANCE_INSTALL
printf 'NONCE_MAINTENANCE_INSTALLED sha=%s fingerprint=%s executor_pid=%s executor_start_monotonic=%s executor_restart=NO runtime_env_changes=NO\n' \
  "$revision" "$maintenance_fingerprint" "$before_pid" "$before_start"

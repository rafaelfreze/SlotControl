#!/usr/bin/env bash
# A separate nonfinancial maintenance process. Never load the executor env.
set -euo pipefail
set +x
umask 077
fail() { printf '{"error":"%s"}\n' "$1" >&2; exit 1; }
[[ $# -eq 0 && $(id -un) == coinops-executor && $(id -u) != 0 ]] || fail NONCE_MAINTENANCE_SERVICE_USER_REQUIRED
state=/var/lib/coinops-live-executor
lock_directory=/run/coinops-nonce-retention
lock_file=$lock_directory/maintenance.lock
for directory in "$state" "$state/nonces" "$lock_directory"; do
  [[ -d $directory && ! -L $directory && $(realpath -e "$directory") == "$directory" \
    && $(stat -c %u "$directory") == "$(id -u)" && $(stat -c %a "$directory") == 700 ]] \
    || fail NONCE_MAINTENANCE_PRIVATE_DIRECTORY_REQUIRED
done
if [[ -e $lock_file || -L $lock_file ]]; then
  [[ -f $lock_file && ! -L $lock_file && $(stat -c %u "$lock_file") == "$(id -u)" \
    && $(stat -c %a "$lock_file") == 600 && $(stat -c %h "$lock_file") == 1 ]] \
    || fail NONCE_MAINTENANCE_PRIVATE_LOCK_REQUIRED
fi
# Keep this inode stable across oneshots and manual runs. The Node helper proves
# the inherited descriptor's identity and exclusive kernel FLOCK before unlink.
exec 9>"$lock_file"
if ! /usr/bin/flock --exclusive --nonblock 9; then
  printf '{"code":"NONCE_MAINTENANCE_ALREADY_RUNNING"}\n'
  exit 0
fi
script_directory=$(dirname -- "$(realpath -e -- "${BASH_SOURCE[0]}")")
[[ $script_directory =~ ^/opt/coinops/maintenance/releases/[a-f0-9]{40}/apps/live-executor/deploy$ ]] \
  || fail NONCE_MAINTENANCE_RELEASE_REQUIRED
exec /usr/local/bin/node "$script_directory/nonce-maintenance.mjs" --apply

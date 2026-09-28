#!/usr/bin/env bash
# Source from a reviewed deploy script. Never load service secrets for an import.
runtime_service_identity() {
  local expected_root=$1
  service_user=$(systemctl show coinops-live-executor.service --property=User --value)
  service_group=$(systemctl show coinops-live-executor.service --property=Group --value)
  [[ $service_user =~ ^[a-z_][a-z0-9_-]*$ ]] || fail 'NONROOT_SERVICE_USER_REQUIRED'
  local service_uid
  service_uid=$(id -u "$service_user") || fail 'SERVICE_USER_NOT_FOUND'
  [[ $service_uid =~ ^[0-9]+$ && $service_uid != 0 ]] || fail 'NONROOT_SERVICE_USER_REQUIRED'
  [[ -n $service_group ]] || service_group=$(id -gn "$service_user")
  [[ $service_group =~ ^[a-z_][a-z0-9_-]*$ ]] || fail 'SERVICE_GROUP_INVALID'
  [[ $(systemctl show coinops-live-executor.service --property=WorkingDirectory --value) == "$expected_root/apps/live-executor" ]] || fail 'SERVICE_WORKDIR_MISMATCH'
  [[ $(systemctl show coinops-live-executor.service --property=ExecStart --value) == *"/usr/local/bin/node --experimental-strip-types $expected_root/apps/live-executor/src/server.mjs"* ]] || fail 'SERVICE_ENTRYPOINT_MISMATCH'
}

runtime_preflight() {
  local code_root=$1
  # runuser applies the real service UID/GID; a successful root import cannot
  # prove that the service can traverse/read a 0600 file created by root.
  runuser -u "$service_user" -g "$service_group" -- /usr/bin/env -i -C / PATH=/usr/local/bin:/usr/bin:/bin \
    /usr/local/bin/node --experimental-strip-types --input-type=module -e '
import { accessSync, constants, lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const root = realpathSync(process.argv[1]);
function readable(path) {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new Error("RUNTIME_SYMLINK_FORBIDDEN");
  accessSync(path, constants.R_OK | (info.isDirectory() ? constants.X_OK : 0));
  if (info.isDirectory()) for (const name of readdirSync(path)) readable(join(path, name));
}
for (const path of ["apps/live-executor/src", "apps/live-executor/package.json", "apps/web/lib/execution"])
  readable(join(root, path));
const runtime = await import(pathToFileURL(join(root, "apps/live-executor/src/server.mjs")));
if (typeof runtime.createExecutorHandler !== "function") throw new Error("RUNTIME_IMPORT_INVALID");
console.log("SERVICE_USER_RUNTIME_READ_IMPORT_PASS");
' "$code_root"
}

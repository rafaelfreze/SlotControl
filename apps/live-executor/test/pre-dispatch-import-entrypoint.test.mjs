import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
test("maintenance entrypoint resolves native imports then denies missing scope before any filesystem action", () => {
  const file = fileURLToPath(new URL("../deploy/import-pre-dispatch-rejection.mjs", import.meta.url));
  const result = spawnSync(process.execPath, ["--experimental-strip-types", file], { encoding: "utf8", windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PRE_DISPATCH_IMPORT_SCOPE_DENIED/);
  assert.doesNotMatch(result.stderr, /SyntaxError|does not provide an export|ERR_MODULE_NOT_FOUND/);
});

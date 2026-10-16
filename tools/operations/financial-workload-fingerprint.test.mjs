import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { computeFinancialWorkloadFingerprint, generatedManifest, GENERATED_FILE, sourceImports }
  from "./financial-workload-fingerprint.mjs";
const ts = createRequire(new URL("../../apps/web/package.json", import.meta.url))("typescript");
function fixture(changes = {}) {
  return { "apps/web/tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", moduleResolution: "bundler", paths: { "@/*": ["./*"] } } }),
    "apps/web/package.json": "{}", "apps/web/package-lock.json": '{"lockfileVersion":3}',
    "tools/operations/financial-workload-fingerprint.mjs": "reviewed-builder",
    "apps/web/lib/root.ts": 'import {value} from "@/lib/value"; export * from "./dynamic"; import "./supabase/workload-fingerprint.generated";',
    "apps/web/lib/value.ts": "export const value = 1;",
    "apps/web/lib/dynamic.ts": 'export async function f() { return import(`./leaf`); }',
    "apps/web/lib/leaf.ts": "export const leaf = true;", ...changes };
}
function fingerprint(files) {
  return computeFinancialWorkloadFingerprint({ ts, entries: ["apps/web/lib/root.ts"],
    readSource: path => { assert.ok(Object.hasOwn(files, path), path); return files[path]; },
    fileExists: path => Object.hasOwn(files, path) });
}
test("AST follows aliases/reexports/literal dynamic imports; generated constant excludes itself and docs are stable", () => {
  const files = fixture(), result = fingerprint(files);
  assert.equal(result.file_count, 8);
  assert.ok(result.files.some(row => row.path === "apps/web/lib/leaf.ts"));
  assert.ok(!result.files.some(row => row.path === GENERATED_FILE));
  assert.equal(fingerprint({ ...files, [GENERATED_FILE]: "arbitrary", "docs/note.md": "changed" }).web_workload_sha256, result.web_workload_sha256);
  assert.equal(fingerprint(Object.fromEntries(Object.entries(files).map(([k,v]) => [k,v.replaceAll("\n", "\r\n")]))).web_workload_sha256, result.web_workload_sha256);
  assert.match(generatedManifest(result), /import "server-only"/);
  const config = JSON.parse(files["apps/web/tsconfig.json"]);
  config.include = [".next-generated/types/**/*.ts"];
  assert.equal(fingerprint({ ...files, "apps/web/tsconfig.json": JSON.stringify(config) }).web_workload_sha256, result.web_workload_sha256);
  config.compilerOptions.target = "ES2022";
  assert.notEqual(fingerprint({ ...files, "apps/web/tsconfig.json": JSON.stringify(config) }).web_workload_sha256, result.web_workload_sha256);
});
test("financial dependency or lockfile edits change the fingerprint; alias or dynamic ambiguity fails closed", () => {
  const files = fixture(), result = fingerprint(files);
  for (const path of ["apps/web/lib/leaf.ts", "apps/web/package-lock.json"])
    assert.notEqual(fingerprint({ ...files, [path]: path.endsWith(".json") ? '{"lockfileVersion":2}' : "export const leaf = false;" }).web_workload_sha256, result.web_workload_sha256);
  assert.throws(() => fingerprint(fixture({ "apps/web/lib/dynamic.ts": "const path='x'; import(path);" })), /DYNAMIC_IMPORT_UNREVIEWED/);
  assert.throws(() => fingerprint(fixture({ "apps/web/tsconfig.json": '{"compilerOptions":{"baseUrl":".","moduleResolution":"bundler","paths":{"@/*":["./other/*"]}}}' })), /ALIAS_CONFIGURATION_UNREVIEWED/);
  assert.throws(() => fingerprint(fixture({ "apps/web/lib/root.ts": 'import "./missing";' })), /IMPORT_UNRESOLVED/);
  assert.throws(() => fingerprint(fixture({ "apps/web/lib/root.ts": 'import "../../../secrets";' })), /IMPORT_OUTSIDE_SOURCE/);
});
test("unknown require/eval and syntax errors are rejected rather than skipped", () => {
  for (const source of ['require(name);', 'const r=require; r(path);', 'module.require("x");',
    'import { createRequire as loader } from "node:module";', 'eval("x");',
    'const r=createRequire(import.meta.url);', 'import("x", { with: {type:"json"} });'])
    assert.throws(() => sourceImports(source, "root.ts", ts), /DYNAMIC_IMPORT_UNREVIEWED/);
  assert.throws(() => sourceImports("import {", "root.ts", ts), /SOURCE_PARSE_FAILED/);
});

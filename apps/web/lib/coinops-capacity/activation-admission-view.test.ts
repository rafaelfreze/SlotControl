import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { activationAdmissionFromEvidence, activationAdmissionView } from "./activation-admission-view.ts";

test("Samya: prepared cycle does not advertise admission during persisted recovery", () => {
  const evidence = { code: "CAPACITY_REQUIRED", reason: "RECOVERY_STABILIZING", healthy_seconds: 599.559,
    policy: { reopen_healthy_seconds: 600 }, decision_observed_at: "2026-10-03T23:16:42.051Z" };
  const admission = activationAdmissionFromEvidence(evidence);
  const view = activationAdmissionView(admission);
  assert.equal(view.allowed, false);
  assert.match(view.message, /faltavam 1s/);
  assert.match(view.message, /Não é falta de saldo/);
  // Reload and elapsed browser time cannot reopen a server-side gate.
  assert.deepEqual(activationAdmissionView(activationAdmissionFromEvidence(evidence)), view);
  assert.equal(activationAdmissionView({ ...admission, healthySeconds: 1000 }).allowed, false);
});

test("canonical CAPACITY_OK alone opens presentation; no frontend thresholds", () => {
  const recovered = activationAdmissionFromEvidence({ code: "CAPACITY_OK", reason: "SUSTAINED_HEADROOM_AVAILABLE" });
  assert.equal(activationAdmissionView(recovered).allowed, true);
  for (const evidence of [null, {}, { code: "CAPACITY_UNKNOWN" }, { code: "CAPACITY_REQUIRED", reason: "CURRENT_WEIGHT_CRITICAL" }])
    assert.equal(activationAdmissionView(activationAdmissionFromEvidence(evidence)).allowed, false);
  assert.equal(activationAdmissionView(undefined).allowed, false);
});

test("untrusted numeric evidence cannot produce invented countdown", () => {
  const admission = activationAdmissionFromEvidence({ code: "CAPACITY_REQUIRED", reason: "RECOVERY_STABILIZING",
    healthy_seconds: "599", policy: { reopen_healthy_seconds: Infinity } });
  assert.equal(admission.healthySeconds, null);
  assert.equal(admission.requiredHealthySeconds, null);
  assert.doesNotMatch(activationAdmissionView(admission).message, /faltavam/);
});

test("GET reads one canonical decision without Binance, reservation, or hysteresis mutation", () => {
  const source = readFileSync(new URL("../../app/api/coinops-engine-control/route.ts", import.meta.url), "utf8");
  const get = source.slice(source.indexOf("export async function GET"), source.indexOf("type Intent"));
  assert.equal((get.match(/rpc\("preview_executor_admission"/g) ?? []).length, 1);
  assert.doesNotMatch(get, /reserveEngineCapacity|operatorAccountSnapshot|\.update\(|\.insert\(/);
  assert.match(get, /preparing && selectedAccount\?\.executor_shard_id/);
  assert.match(get, /admissionRead\?\.error \? null/);
  const ui = readFileSync(new URL("../../app/automacao/engine-control-center.tsx", import.meta.url), "utf8");
  assert.match(ui, /engine\.environment === "REAL" && !admission\.allowed/);
  assert.match(ui, /PREPARADO · AGUARDANDO ADMISSÃO/);
  assert.match(ui, /Atualizar estado · sem ordens/);
});

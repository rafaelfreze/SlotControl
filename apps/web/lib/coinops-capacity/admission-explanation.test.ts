import assert from "node:assert/strict";
import test from "node:test";
import { admissionTelemetryExplanation, explainAdmission, pressureExplanation, withAdmissionTelemetry,
  type AdmissionExplanation } from "./admission-explanation.ts";

const decision = (changes: Partial<AdmissionExplanation> = {}): AdmissionExplanation => ({
  code:"CAPACITY_REQUIRED", reason:"PROJECTED_BINANCE_WEIGHT_ABOVE_ADMISSION_LIMIT",
  observed_weight:4498,reserved_weight:0,incremental_weight:900,projected_weight:5398,projected_percent:89.97,
  admission_limit_weight:3900,recovery_headroom_weight:2100,remaining_weight:-1498,
  pressure_phase:"WARNING",additional_engines:0,
  policy:{version:"capacity-v2-20260929",binance_limit:6000,admission_ratio:.65,recovery_ratio:.35,
    incremental_weight:900,incremental_source:"CONSERVATIVE_UNCALIBRATED",peak_hold_minutes:15},...changes,
});
test("capacity UI explains both exact rejection and preserved headroom without seven-engine promise",()=>{
  assert.match(explainAdmission(decision()),/90.0% > limite 65%/);
  assert.match(explainAdmission(decision({code:"CAPACITY_OK",projected_percent:61})),/61.0%.*35% preservada/);
  assert.match(explainAdmission(decision({code:"CAPACITY_UNKNOWN",reason:"RUNTIME_PARITY"})),/runtime diferente/);
  assert.match(explainAdmission(),/indisponível/);
});
test("transient peak is observation, recovery persists independently of reload",()=>{
  assert.match(pressureExplanation("TRANSIENT_SPIKE")!,/15 min.*pico isolado não fecha/);
  assert.match(pressureExplanation("SUSTAINED_PRESSURE")!,/média/);
  assert.match(pressureExplanation("RECOVERY")!,/10 min.*Reload não/);
  assert.match(explainAdmission(decision({reason:"RECOVERY_STABILIZING",healthy_seconds:300})),/5\/10 min/);
});

const observed = "2026-10-11T16:00:00.000Z";
const observationTime = Date.parse(observed) + 10_000;
const sample = (samples: number, changes: Record<string, unknown> = {}) => ({ observed_at: observed,
  weight_observed_at: observed, heartbeat_at: observed, binance_weight_samples: samples, ...changes });
const windowDecision = (changes: Partial<AdmissionExplanation> = {}) => decision({
  code: "CAPACITY_UNKNOWN", reason: "CAPACITY_TELEMETRY_MISSING_OR_STALE", decision_observed_at: observed,
  policy: { ...decision().policy, minimum_weight_samples: 15, telemetry_max_age_seconds: 120,
    reopen_healthy_seconds: 600, reopen_ratio: .60 }, ...changes,
});

test("fresh short windows display real 0/15 and 14/15 observations without granting admission", () => {
  for (const count of [0, 14]) {
    const source = windowDecision();
    const view = withAdmissionTelemetry(source, sample(count), observationTime)!;
    assert.equal(view.code, "CAPACITY_UNKNOWN");
    assert.equal(view.reason, source.reason);
    assert.equal(view.additional_engines, source.additional_engines);
    assert.equal(view.telemetry?.timing, "FRESH");
    assert.equal(view.telemetry?.decision_matches_sample, true);
    assert.match(explainAdmission(view), new RegExp(`${count}/15 amostras reais`));
    assert.match(admissionTelemetryExplanation(view)!, /janela em formação.*mesma amostra/);
    assert.equal(source.telemetry, undefined);
  }
});

test("15 samples never imply admission or advance the persisted recovery clock", () => {
  const view = withAdmissionTelemetry(windowDecision({ code: "CAPACITY_REQUIRED", reason: "RECOVERY_STABILIZING",
    healthy_seconds: 300 }), sample(15), observationTime)!;
  assert.equal(view.code, "CAPACITY_REQUIRED");
  assert.equal(view.healthy_seconds, 300);
  assert.match(explainAdmission(view), /estabilização 5\/10 min/);
  assert.match(admissionTelemetryExplanation(view)!, /15\/15.*mínimo de amostras atingido/);
  assert.match(explainAdmission(withAdmissionTelemetry(windowDecision(), sample(15), observationTime)), /telemetria ausente ou desatualizada/);
});

test("stale or absent timestamps are distinct from window formation", () => {
  const stale = withAdmissionTelemetry(windowDecision(), sample(14), observationTime + 120_000)!;
  assert.equal(stale.telemetry?.timing, "STALE");
  assert.match(explainAdmission(stale), /fora da validade/);
  assert.doesNotMatch(explainAdmission(stale), /janela pendente/);
  const missing = withAdmissionTelemetry(windowDecision(), sample(14, { weight_observed_at: null }), observationTime)!;
  assert.equal(missing.telemetry?.timing, "UNVERIFIED");
  assert.match(admissionTelemetryExplanation(missing)!, /datas.*não confirmadas/);
  const future = withAdmissionTelemetry(windowDecision(), sample(14), Date.parse(observed) - 10_001)!;
  assert.equal(future.telemetry?.timing, "STALE");
});

test("different snapshots and other failed gates cannot be explained away as warm-up", () => {
  const mismatch = withAdmissionTelemetry(windowDecision({ decision_observed_at: "2026-10-11T15:59:00Z" }), sample(14), observationTime)!;
  assert.equal(mismatch.telemetry?.decision_matches_sample, false);
  assert.match(admissionTelemetryExplanation(mismatch)!, /snapshot distinto da decisão/);
  assert.doesNotMatch(explainAdmission(mismatch), /14\/15 amostras reais/);
  const parity = withAdmissionTelemetry(windowDecision({ reason: "RUNTIME_PARITY" }), sample(14), observationTime)!;
  assert.match(explainAdmission(parity), /runtime diferente/);
  assert.equal(withAdmissionTelemetry(undefined, sample(14), observationTime), undefined);
  assert.equal(admissionTelemetryExplanation(undefined), null);
});

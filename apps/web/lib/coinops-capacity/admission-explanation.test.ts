import assert from "node:assert/strict";
import test from "node:test";
import { explainAdmission, pressureExplanation, type AdmissionExplanation } from "./admission-explanation.ts";

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

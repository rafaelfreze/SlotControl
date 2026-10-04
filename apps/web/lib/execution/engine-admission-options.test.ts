import assert from "node:assert/strict";
import test from "node:test";
import { rankEngineAdmissionOptions, type EngineAdmissionOption } from "./engine-admission-options.ts";
const option = (shardId: string, capacityCode: string, credential: EngineAdmissionOption["credential"] = "VALIDATED") =>
  ({ shardId, ip: "192.0.2.1", capacityCode, projectedPercent: 60, credential });

test("new engine chooses03 when existing02 is full; no existing binding is moved", () => {
  const original = [option("executor-02", "CAPACITY_REQUIRED"), option("executor-03", "CAPACITY_OK")];
  const ranked = rankEngineAdmissionOptions(original);
  assert.equal(ranked[0].shardId, "executor-03");
  assert.equal(original[0].shardId, "executor-02");
});
test("eligible but unvalidated IP remains explicit, never silently authorized", () => {
  assert.equal(rankEngineAdmissionOptions([option("executor-03", "CAPACITY_OK", "VALIDATION_REQUIRED"),
    option("executor-04", "CAPACITY_OK")])[0].shardId, "executor-04");
  assert.equal(rankEngineAdmissionOptions([option("executor-03", "CAPACITY_UNKNOWN")])[0].capacityCode, "CAPACITY_UNKNOWN");
});

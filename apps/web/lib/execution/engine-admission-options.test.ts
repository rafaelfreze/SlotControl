import assert from "node:assert/strict";
import test from "node:test";
import { engineWorkloadCertificationNotice, knownEngineCapacityReason, rankEngineAdmissionOptions, type EngineAdmissionOption } from "./engine-admission-options.ts";
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

test("100-slot uncertified copy is truthful and cannot turn incomplete capacity into eligibility", () => {
  const unknown = { ...option("executor-03", "CAPACITY_UNKNOWN"), capacityReason: "SLOT_WORKLOAD_UNCERTIFIED" as const };
  const notice = engineWorkloadCertificationNotice([unknown], 100);
  assert.match(notice!, /100 slots ainda não está certificada/);
  assert.match(notice!, /não significa que o executor esteja lotado/);
  assert.match(notice!, /motores existentes continuam inalterados/);
  assert.equal(engineWorkloadCertificationNotice([unknown], 25), null);
  assert.equal(engineWorkloadCertificationNotice([{ ...unknown, capacityCode: "CAPACITY_OK" }], 100), null);
  assert.equal(knownEngineCapacityReason({ secret: "do not serialize" }), null);
  assert.equal(knownEngineCapacityReason("arbitrary provider text"), null);
  assert.equal(rankEngineAdmissionOptions([unknown])[0].capacityCode, "CAPACITY_UNKNOWN");
});

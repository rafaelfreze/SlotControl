import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../../app/automacao/page.tsx", import.meta.url), "utf8");
const strip = readFileSync(new URL("../../app/automacao/automation-cockpit.tsx", import.meta.url), "utf8");
const results = readFileSync(new URL("../../app/automacao/automation-results.tsx", import.meta.url), "utf8");

test("temporal UI carries original event IDs and uses classified health in the shared top strip", () => {
  assert.match(page, /robot_v1_testnet_events"\)\.select\("id,run_id,event_type,slot_number,observed_at,details"\)/);
  assert.match(page, /testnetOperating: testnetHealth\.some\(\(health\) => health\.healthy\)/);
  assert.match(page, /testnetError: testnetHealth\.some\(\(health\) => health\.tone === "error"\)/);
  assert.match(page, /testnetAttention: testnetHealth\.some\(\(health\) => health\.tone === "attention"\)/);
  assert.match(strip, /status\.testnetError \? "DIVERGÊNCIA ATIVA" : status\.testnetAttention \? "ATENÇÃO"/);
  assert.match(strip, /LIVE BLOQUEADO/);
});

test("current slot state and historical evidence are rendered separately without a simple red missed badge", () => {
  assert.match(results, /status\(row\.operationalState, row\.entry_origin\)/);
  assert.doesNotMatch(results, /status\(row\.entry_state/);
  assert.match(results, /OCORRÊNCIA HISTÓRICA/);
  assert.match(results, /detail\.persisted_entry_state/);
  assert.match(results, /Aguarda condição ou ciclo futuro/);
  assert.match(results, /não foi rearmado nem comprado retroativamente/);
  assert.match(results, /temporalSummary\.historicalCount/);
  assert.match(results, /temporalSummary\.currentVersionCount/);
  assert.match(results, /temporalSummary\.activeIssueCount/);
});

test("causal TP window and proven crossing upper bound are not presented as an exact crossing timestamp", () => {
  assert.match(results, /occurrence\.occurred_at_basis === "TP_FILL_UNRECONCILED_WINDOW_START"/);
  assert.match(results, /Início da janela causal \(TP\), não horário exato do cruzamento/);
  assert.match(results, /occurrence\.occurred_by_at \? <p>Cruzamento já ocorrido até \{date\(occurrence\.occurred_by_at\)\}/);
  assert.match(results, /primeiro cruzamento \{date\(occurrence\.first_cross_at\)\}/);
  assert.match(results, /registro \{date\(occurrence\.created_at\)\}/);
});

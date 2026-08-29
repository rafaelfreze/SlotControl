import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serverSource = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
const actionSource = readFileSync(
  new URL("../../app/plano-crescimento/monitoring-actions.ts", import.meta.url),
  "utf8"
);
const panelSource = readFileSync(
  new URL("../../app/plano-crescimento/official-monitoring-panel.tsx", import.meta.url),
  "utf8"
);

test("baseline exige preview ready e sem erros no servidor e na interface", () => {
  assert.match(serverSource, /ready:\s*boolean/);
  assert.match(serverSource, /errors:\s*string\[\]/);
  assert.match(actionSource, /preview\.ready !== true/);
  assert.match(actionSource, /preview\.errors\.length > 0/);
  assert.match(panelSource, /preview\?\.ready === true/);
  assert.match(panelSource, /disabled=\{!canActivate\}/);
});

test("baseline exibe o bloqueio de trilha economica sem anunciar estado pronto", () => {
  assert.match(panelSource, /FUNDED_SLOT_WITHOUT_ECONOMIC_TRACE/);
  assert.match(panelSource, /Revis\u00e3o necess\u00e1ria/);
  assert.match(panelSource, /Ativa\u00e7\u00e3o bloqueada/);
  assert.match(panelSource, /previewReady \? "Pronto para ativar"/);
});

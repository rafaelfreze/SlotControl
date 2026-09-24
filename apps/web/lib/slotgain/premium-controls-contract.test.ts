import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file: string) => readFileSync(new URL(`../../app/automacao/${file}`, import.meta.url), "utf8");
const controls = read("premium-controls.tsx");
const shadow = read("shadow-controls.tsx");
const legacyShadow = read("automation-mobile.tsx");
const center = read("automation-center.tsx");
const premium = read("premium-automation.tsx");
const primitives = read("premium-primitives.tsx");

test("premium controls reuse existing environment components without dispatch on render", () => {
  assert.match(controls, /<ShadowControls[^>]+data=\{data\} asset=\{asset\}/);
  assert.match(controls, /selectTestnetAssetData\(data, asset\)/);
  assert.match(controls, /<TestnetControls[^>]+data=\{testnetData\} asset=\{asset\}/);
  assert.match(controls, /<LivePreparationPanel[^>]+data=\{data\.livePreparation\} asset=\{asset\}/);
  assert.doesNotMatch(controls, /\b(?:useEffect|setInterval|fetch|createOrder|cancelOrder)\s*\(/);
});

test("shared Shadow controls preserve all commands and explicit destructive-action guards", () => {
  assert.match(legacyShadow, /<ShadowControls data=\{props\} asset=\{selectedAsset\}/);
  assert.doesNotMatch(legacyShadow, /action=\{(?:controlRobotV1Shadow|saveRobotV1Parameters)\}/);
  assert.equal((shadow.match(/action=\{controlRobotV1Shadow\}/g) || []).length, 4);
  assert.match(shadow, /name="command" value="start"[^]*?disabled=\{Boolean\(cycle\)\}/);
  assert.match(shadow, /name="command" value=\{config\?\.pause_new_entries \? "resume" : "pause"\}/);
  assert.match(shadow, /onSubmit=\{confirmKill\}/);
  assert.match(shadow, /window\.confirm\("Ativar o kill switch pausa novas entradas deste robô Shadow\./);
  assert.match(shadow, /name="command" value="restart"/);
  assert.match(shadow, /name="restart_confirmed" value="yes" required/);
  assert.match(shadow, /action=\{saveRobotV1Parameters\}/);
  assert.match(shadow, /name="capital_usdc" type="number" min="0\.01" max="2500" step="0\.01"/);
  for (const field of ["gain_percent", "spacing_percent"]) {
    assert.ok(shadow.includes(`name="${field}" type="number" min="0.1" max="20" step="0.1"`));
  }
  assert.match(shadow, /name="preset" value="quick" formNoValidate/);
});

test("shared Testnet controls preserve execution gates and isolate virtual actions", () => {
  assert.match(center, /export function TestnetControls/);
  assert.equal((center.match(/action=\{reconcileCoinOpsTestnet\}/g) || []).length, 1);
  assert.equal((center.match(/action=\{startCoinOpsTestnet\}/g) || []).length, 1);
  assert.match(center, /data\.testnetEnabled && data\.testnetRun\?\.status === "ACTIVE" \? <form action=\{reconcileCoinOpsTestnet\}/);
  assert.match(center, /data\.testnetEnabled && data\.testnet\?\.ok && \(!data\.testnetRun \|\| data\.testnetRun\.status === "COMPLETED"\) \? <form action=\{startCoinOpsTestnet\}/);
  assert.match(center, /disabled title="Pausa segura ainda não implementada/);
  assert.match(center, /<TestnetControls data=\{data\} asset=\{selectedAsset\}/);
  assert.doesNotMatch(shadow, /LIVE bloqueado|BTC LIVE OFF/);
  assert.doesNotMatch(controls, /LIVE BLOQUEADO|BTC LIVE OFF/);
});

test("Shadow number inputs receive numeric defaults instead of localized decimal commas", () => {
  assert.match(shadow, /name="gain_percent"[^>]+defaultValue=\{Number\(config\?\.next_gain_rate \?\? config\?\.gain_rate \?\? 0\) \* 100\}/);
  assert.match(shadow, /name="spacing_percent"[^>]+defaultValue=\{Number\(config\?\.next_entry_spacing \?\? config\?\.entry_spacing \?\? 0\) \* 100\}/);
  assert.doesNotMatch(shadow, /defaultValue=\{percent\(/);
  assert.match(shadow, /gain \{percent\(cycle\?\.gain_rate \?\? config\?\.gain_rate\)\}%/);
});

test("premium navigation is presentation-only and keeps operational actions behind existing panels", () => {
  assert.doesNotMatch(premium, /\b(?:createOrder|cancelOrder|reconcileCoinOpsTestnet|controlRobotV1Shadow|confirmCoinOpsManualAdjustment|reverseCoinOpsManualAdjustment)\s*\(/);
  assert.doesNotMatch(premium, /from ["'][^"']*-(?:actions|server)["']/);
  assert.match(premium, /<PremiumControls[^>]+data=\{data\} view=\{view\} asset=\{asset\}/);
  assert.match(premium, /<AutomationDetails[^>]+data=\{data\} section="all" asset=\{asset\}/);
  assert.match(premium, /href="\/automacao\/simulador-ath"/);
  assert.match(premium, /href="\/automacao\/simulador-ajustes"/);
  assert.match(premium, /href="\/relatorios"/);
});

test("premium drawer retains native modal semantics and an accessible close control", () => {
  assert.match(primitives, /useRef<HTMLDialogElement>/);
  assert.match(primitives, /dialog\.showModal\(\)/);
  assert.match(primitives, /dialog\.close\(\)/);
  assert.match(primitives, /<dialog[^>]+aria-labelledby=\{titleId\}/);
  assert.match(primitives, /onCancel=\{onClose\}/);
  assert.match(primitives, /aria-label="Fechar" onClick=\{onClose\}/);
  assert.match(primitives, /<h2 id=\{titleId\}>\{title\}<\/h2>/);
});

test("isolated simulator copy does not claim the operating LIVE environment is blocked", () => {
  const athSimulator = read("simulador-ath/simulator-client.tsx");
  const adjustmentSimulator = read("simulador-ajustes/page.tsx");
  assert.match(athSimulator, /Não envia ordens à Production nem altera o estado LIVE\./);
  assert.match(adjustmentSimulator, /não altera Shadow, Testnet ou Production/);
  for (const source of [athSimulator, adjustmentSimulator]) {
    assert.doesNotMatch(source, /Production READ-ONLY|LIVE bloqueado|BTC LIVE OFF/);
  }
});

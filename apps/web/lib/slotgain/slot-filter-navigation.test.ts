import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { addNoticeToPath, getSlotsReturnPath } from "./slot-filter-navigation.ts";

const actionSource = readFileSync(
  new URL("../../app/dashboard/actions.ts", import.meta.url),
  "utf8"
);
const mobileSlotsSource = readFileSync(
  new URL("../../app/slots/slots-client.tsx", import.meta.url),
  "utf8"
);
const desktopSlotsSource = readFileSync(
  new URL("../../app/slots/desktop-slots.tsx", import.meta.url),
  "utf8"
);

test("preserva filtros de ativo ao voltar para Slots", () => {
  assert.equal(getSlotsReturnPath("BTC"), "/slots?asset=BTC");
  assert.equal(getSlotsReturnPath("SOL"), "/slots?asset=SOL");
});

test("preserva filtros de status usados no mobile e desktop", () => {
  assert.equal(getSlotsReturnPath("aberto"), "/slots?flow=gain");
  assert.equal(getSlotsReturnPath("open"), "/slots?flow=gain");
  assert.equal(getSlotsReturnPath("closed"), "/slots?flow=abrir");
  assert.equal(getSlotsReturnPath("free"), "/slots?flow=abrir");
});

test("filtro ausente ou nao permitido retorna para Todos sem aceitar URL arbitraria", () => {
  assert.equal(getSlotsReturnPath("all"), "/slots");
  assert.equal(getSlotsReturnPath("https://example.com"), "/slots");
  assert.equal(getSlotsReturnPath(null), "/slots");
});

test("mensagem e adicionada sem remover o filtro selecionado", () => {
  const result = addNoticeToPath(getSlotsReturnPath("SOL"), "Gain registrado.");
  const url = new URL(result, "https://coinops.local");

  assert.equal(url.pathname, "/slots");
  assert.equal(url.searchParams.get("asset"), "SOL");
  assert.equal(url.searchParams.get("notice"), "Gain registrado.");
});

test("Abrir e Gain enviam e reutilizam o filtro em mobile e desktop", () => {
  const openSlotSource = actionSource.slice(
    actionSource.indexOf("export async function openSlot"),
    actionSource.indexOf("export async function registerGain")
  );
  const registerGainSource = actionSource.slice(
    actionSource.indexOf("export async function registerGain"),
    actionSource.indexOf("export async function resetSlot")
  );

  assert.match(mobileSlotsSource, /returnFilter={activeFilter}/);
  assert.ok((mobileSlotsSource.match(/hidden={{ returnFilter }}/g) || []).length >= 2);
  assert.ok((mobileSlotsSource.match(/entryPrice: String\(Math\.round\(livePrice\)\), returnFilter/g) || []).length >= 2);
  assert.ok((desktopSlotsSource.match(/returnFilter: filter/g) || []).length >= 2);
  assert.match(desktopSlotsSource, /returnFilter={filter}/);
  assert.match(mobileSlotsSource, /initialFlow={initialFlow}/);
  assert.match(desktopSlotsSource, /initialFlow === "gain"/);
  assert.match(desktopSlotsSource, /initialFlow === "abrir"/);
  assert.match(openSlotSource, /getSlotsReturnPath\(formData\.get\("returnFilter"\)\)/);
  assert.match(registerGainSource, /getSlotsReturnPath\(formData\.get\("returnFilter"\)\)/);
  for (const source of [openSlotSource, registerGainSource]) {
    const finishLines = source.split("\n").filter((line) => line.includes("finish("));
    assert.ok(finishLines.length > 0);
    for (const line of finishLines) assert.match(line, /returnPath\);/);
  }
});

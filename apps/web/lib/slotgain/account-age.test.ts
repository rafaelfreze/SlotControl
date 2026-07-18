import assert from "node:assert/strict";
import test from "node:test";

import { formatAccountCreatedDate, getAccountAgeDays } from "./account-age.ts";

test("conta criada hoje inicia com zero dias no fuso do usuario", () => {
  const now = new Date("2026-07-18T16:00:00.000Z");
  assert.equal(getAccountAgeDays("2026-07-18T04:00:00.000Z", now, "America/Cuiaba"), 0);
});

test("tempo em operacao muda no proximo dia local e nunca fica negativo", () => {
  const now = new Date("2026-07-18T16:00:00.000Z");
  assert.equal(getAccountAgeDays("2026-07-17T16:00:00.000Z", now, "America/Cuiaba"), 1);
  assert.equal(getAccountAgeDays("2026-07-19T00:00:00.000Z", now, "America/Cuiaba"), 0);
});

test("data invalida ou ausente tem fallback seguro", () => {
  assert.equal(getAccountAgeDays(null), 0);
  assert.equal(getAccountAgeDays("invalida"), 0);
  assert.equal(formatAccountCreatedDate(null), "Data de criacao indisponivel");
});

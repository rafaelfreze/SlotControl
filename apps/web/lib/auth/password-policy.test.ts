import assert from "node:assert/strict";
import test from "node:test";

import { friendlyAuthError, PASSWORD_CONFIRMATION_MESSAGE, PASSWORD_MIN_LENGTH_MESSAGE, validateNewPassword } from "./password-policy.ts";

test("aceita qualquer composição com oito ou mais caracteres", () => {
  for (const password of ["12345678", "abcdefgh", "abcd1234", "Abcd123!", "senha-completa-123", "uma senha longa sem limite artificial"]) assert.equal(validateNewPassword(password), null);
});

test("rejeita senha curta e confirmação diferente", () => {
  assert.equal(validateNewPassword("1234567"), PASSWORD_MIN_LENGTH_MESSAGE);
  assert.equal(validateNewPassword("12345678", "abcdefgh"), PASSWORD_CONFIRMATION_MESSAGE);
});

test("normaliza erros esperados e inesperados", () => {
  assert.match(friendlyAuthError({ code: "user_already_exists" }, "signup"), /Já existe/);
  assert.match(friendlyAuthError({ status: 429 }, "signup"), /Muitas tentativas/);
  assert.notEqual(friendlyAuthError({}, "signup"), "{}");
});

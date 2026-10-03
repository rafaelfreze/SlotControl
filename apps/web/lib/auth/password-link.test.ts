import assert from "node:assert/strict";
import test from "node:test";

import { parsePasswordLink, passwordLinkError } from "./password-link.ts";

test("password links accept only complete invite or recovery sessions", () => {
  assert.deepEqual(parsePasswordLink("#type=invite&access_token=access&refresh_token=refresh"),
    { kind: "session", accessToken: "access", refreshToken: "refresh" });
  assert.deepEqual(parsePasswordLink("#type=recovery&access_token=access&refresh_token=refresh"),
    { kind: "session", accessToken: "access", refreshToken: "refresh" });
  for (const value of ["", "#type=invite&access_token=access", "#type=signup&access_token=access&refresh_token=refresh",
    "#error=access_denied&type=recovery", "#type=recovery&refresh_token=refresh"])
    assert.notEqual(parsePasswordLink(value).kind, "session");
});

test("disabled access is distinguished from expired links without exposing Auth payloads", () => {
  const disabled = parsePasswordLink("#error=access_denied&error_code=user_banned&error_description=User+is+banned");
  assert.deepEqual(disabled, { kind: "invalid", reason: "disabled" });
  assert.match(passwordLinkError(disabled), /acesso foi desativado/);
  const expired = parsePasswordLink("#error=access_denied&error_code=otp_expired&error_description=secret");
  assert.deepEqual(expired, { kind: "invalid" });
  assert.match(passwordLinkError(expired), /inválido ou expirado/);
  assert.doesNotMatch(passwordLinkError(expired), /secret/);
});

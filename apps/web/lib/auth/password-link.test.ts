import assert from "node:assert/strict";
import test from "node:test";

import { parsePasswordLink } from "./password-link.ts";

test("password links accept only complete invite or recovery sessions", () => {
  assert.deepEqual(parsePasswordLink("#type=invite&access_token=access&refresh_token=refresh"),
    { kind: "session", accessToken: "access", refreshToken: "refresh" });
  assert.deepEqual(parsePasswordLink("#type=recovery&access_token=access&refresh_token=refresh"),
    { kind: "session", accessToken: "access", refreshToken: "refresh" });
  for (const value of ["", "#type=invite&access_token=access", "#type=signup&access_token=access&refresh_token=refresh",
    "#error=access_denied&type=recovery", "#type=recovery&refresh_token=refresh"])
    assert.notEqual(parsePasswordLink(value).kind, "session");
});

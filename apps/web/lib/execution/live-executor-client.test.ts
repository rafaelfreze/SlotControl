import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";

import { signedDryRunHeaders } from "./live-executor-client.ts";

test("Vercel HMAC matches executor canonical method/path/timestamp/nonce/body hash", () => {
  const secret = "test-only-32-byte-minimum-secret-for-executor";
  const body = JSON.stringify({ action: "DRY_RUN", symbol: "BTCBRL" });
  const headers = signedDryRunHeaders(secret, body, "COINOPS:REAL:BTC:diagnostic", 1_780_000_000_000,
    "deterministicnonce1234567890");
  const hash = createHash("sha256").update(body).digest("hex");
  const canonical = ["POST", "/v1/dry-run", "1780000000000", "deterministicnonce1234567890", hash].join("\n");
  assert.equal(headers.get("x-coinops-body-sha256"), hash);
  assert.equal(headers.get("x-coinops-signature"),
    createHmac("sha256", secret).update(canonical).digest("hex"));
  assert.throws(() => signedDryRunHeaders("short", body, "key"), /EXECUTOR_AUTH_NOT_CONFIGURED/);
});

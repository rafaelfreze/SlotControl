import assert from "node:assert/strict";
import test from "node:test";
import { testnetCredentialCoverage } from "./environment-telemetry.ts";

test("Testnet inventory evidence is explicit credential coverage, not a fictional REAL registry", () => {
  assert.equal(testnetCredentialCoverage({}, []), false);
  assert.equal(testnetCredentialCoverage({ registry_scope: "CREDENTIAL_BOUND_TRANSPORT" }, []), false);
  assert.equal(testnetCredentialCoverage({ registry_scope: "CREDENTIAL_BOUND_TRANSPORT", credential_account_ids: [] }, []), true);
  assert.equal(testnetCredentialCoverage({ registry_scope: "CREDENTIAL_BOUND_TRANSPORT",
    credential_account_ids: ["active", "inactive"] }, ["active"]), true);
  assert.equal(testnetCredentialCoverage({ registry_scope: "CREDENTIAL_BOUND_TRANSPORT",
    credential_account_ids: ["foreign"] }, ["active"]), false);
});

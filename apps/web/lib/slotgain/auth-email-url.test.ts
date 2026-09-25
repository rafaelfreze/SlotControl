import assert from "node:assert/strict";
import test from "node:test";

import { getCoinOpsAuthCallback, getCoinOpsPasswordRedirect } from "../auth-email-url.ts";

test("CoinOps signup email can return to the operational home", () => {
  const callback = new URL(getCoinOpsAuthCallback("/automacao"));
  assert.equal(callback.pathname, "/auth/callback");
  assert.equal(callback.searchParams.get("next"), "/automacao");
});

test("CoinOps password links land directly on the browser form at the canonical origin", () => {
  const environment = process.env as Record<string, string | undefined>;
  const previousEnvironment = process.env.NODE_ENV;
  const previousSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  environment.NODE_ENV = "production";
  environment.NEXT_PUBLIC_SITE_URL = "https://cripto-flax.vercel.app";
  try {
    assert.equal(
      getCoinOpsPasswordRedirect(),
      "https://cripto-flax.vercel.app/redefinir-senha"
    );
  } finally {
    environment.NODE_ENV = previousEnvironment;
    environment.NEXT_PUBLIC_SITE_URL = previousSiteUrl;
  }
});

test("CoinOps Auth email callbacks fail closed for another product origin", () => {
  const environment = process.env as Record<string, string | undefined>;
  const previousEnvironment = process.env.NODE_ENV;
  const previousSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  environment.NODE_ENV = "production";
  environment.NEXT_PUBLIC_SITE_URL = "https://nexxfitpro.com.br";
  try {
    assert.equal(
      getCoinOpsAuthCallback("/automacao"),
      "https://cripto-flax.vercel.app/auth/callback?next=%2Fautomacao"
    );
  } finally {
    environment.NODE_ENV = previousEnvironment;
    environment.NEXT_PUBLIC_SITE_URL = previousSiteUrl;
  }
});

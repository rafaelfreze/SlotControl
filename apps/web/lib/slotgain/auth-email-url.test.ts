import assert from "node:assert/strict";
import test from "node:test";

import { getCoinOpsAuthCallback } from "../auth-email-url.ts";

test("CoinOps Auth email callbacks use the canonical production origin", () => {
  const environment = process.env as Record<string, string | undefined>;
  const previousEnvironment = process.env.NODE_ENV;
  const previousSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  environment.NODE_ENV = "production";
  environment.NEXT_PUBLIC_SITE_URL = "https://cripto-flax.vercel.app";
  try {
    assert.equal(
      getCoinOpsAuthCallback("/redefinir-senha"),
      "https://cripto-flax.vercel.app/auth/callback?next=%2Fredefinir-senha"
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
      getCoinOpsAuthCallback("/dashboard"),
      "https://cripto-flax.vercel.app/auth/callback?next=%2Fdashboard"
    );
  } finally {
    environment.NODE_ENV = previousEnvironment;
    environment.NEXT_PUBLIC_SITE_URL = previousSiteUrl;
  }
});

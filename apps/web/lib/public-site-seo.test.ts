import assert from "node:assert/strict";
import test from "node:test";
import { PUBLIC_SITE_ORIGIN, publicHomeMetadata, publicRobots, publicSitemap } from "./public-site-seo.ts";

test("only the official anonymous homepage is canonical and listed in the sitemap", () => {
  assert.equal(publicHomeMetadata.alternates?.canonical, `${PUBLIC_SITE_ORIGIN}/`);
  const sitemap = publicSitemap();
  assert.equal(sitemap.length, 1);
  assert.equal(sitemap[0].url, "https://cripto-flax.vercel.app/");
  assert(!JSON.stringify(sitemap).match(/login|cadastro|api\/|dashboard|automacao|tenant|account|token|\?/));
});
test("robots excludes native app, authentication and APIs while preserving public assets", () => {
  const robots = publicRobots();
  assert.equal(robots.sitemap, `${PUBLIC_SITE_ORIGIN}/sitemap.xml`);
  const rules = robots.rules as { allow: string; disallow: string[] };
  assert.equal(rules.allow, "/");
  for (const path of ["/api/", "/login", "/cadastro", "/auth/", "/dashboard", "/automacao", "/meu-coinops", "/slots"]) {
    assert(rules.disallow.includes(path));
  }
  assert(!rules.disallow.includes("/_next"));
  assert(!rules.disallow.includes("/"));
});

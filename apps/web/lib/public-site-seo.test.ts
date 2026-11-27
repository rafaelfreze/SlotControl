import assert from "node:assert/strict";
import test from "node:test";
import { PUBLIC_SHARE_IMAGE, PUBLIC_SITE_DESCRIPTION, PUBLIC_SITE_NAME, PUBLIC_SITE_ORIGIN, publicHomeJsonLd, publicHomeMetadata, publicHomeStructuredData, publicRobots, publicSitemap } from "./public-site-seo.ts";

test("only the official anonymous homepage is canonical and listed in the sitemap", () => {
  assert.equal(publicHomeMetadata.alternates?.canonical, `${PUBLIC_SITE_ORIGIN}/`);
  const sitemap = publicSitemap();
  assert.equal(sitemap.length, 1);
  assert.equal(sitemap[0].url, "https://cripto-flax.vercel.app/");
  assert(!JSON.stringify(sitemap).match(/login|cadastro|api\/|dashboard|automacao|tenant|account|token|\?/));
});
test("sharing uses the already published CoinOps icon with absolute canonical origin and factual copy", () => {
  assert.equal(PUBLIC_SHARE_IMAGE, "https://cripto-flax.vercel.app/icon-512x512.png");
  const og = publicHomeMetadata.openGraph as {title:string;description:string;url:string;images:Array<{url:string;width:number;height:number;alt:string}>};
  assert.equal(og.title, PUBLIC_SITE_NAME); assert.equal(og.description, PUBLIC_SITE_DESCRIPTION);
  assert.equal(og.url, `${PUBLIC_SITE_ORIGIN}/`);
  assert.deepEqual(og.images.map(image=>[image.url,image.width,image.height,image.alt]), [[PUBLIC_SHARE_IMAGE,512,512,"CoinOps"]]);
  assert.deepEqual((publicHomeMetadata.twitter as {images:string[]}).images,[PUBLIC_SHARE_IMAGE]);
});
test("structured data describes only the public homepage and preserves its actual site identity", () => {
  const graph = publicHomeStructuredData["@graph"];
  assert.equal(publicHomeStructuredData["@context"], "https://schema.org");
  assert.deepEqual(graph.map(node=>node["@type"]),["WebSite","WebPage"]);
  assert.ok(graph.every(node=>node.url===`${PUBLIC_SITE_ORIGIN}/`&&node.name===PUBLIC_SITE_NAME&&node.description===PUBLIC_SITE_DESCRIPTION&&node["@id"].startsWith(`${PUBLIC_SITE_ORIGIN}/#`)));
  assert.equal(new Set(graph.map(node=>node["@id"])).size,2);
  assert.deepEqual(JSON.parse(publicHomeJsonLd),publicHomeStructuredData);
  assert.doesNotMatch(publicHomeJsonLd,/tenant|account|token|gain|profit|offers|aggregateRating|price|balance|datePublished|dateModified|<\/script/);
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

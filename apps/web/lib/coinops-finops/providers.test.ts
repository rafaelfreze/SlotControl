import assert from "node:assert/strict";
import test from "node:test";
import { fetchDigitalOceanCosts, fetchFinopsFx, fetchVercelProjectCosts, parsePtaxQuote,
  parseUsdtBrlQuote, parseVercelProjectCosts } from "./providers.ts";

const now = new Date("2026-09-26T23:00:00.000Z");
const fx = { value: [{ cotacaoVenda: 5.32, dataHoraCotacao: "2026-09-25 13:05:00.000" }] };
const period = { projectId: "prj_coinops", from: "2026-09-01T00:00:00.000Z", to: "2026-09-27T00:00:00.000Z" };
const billing = (changes: Record<string, unknown> = {}) => ({ BilledCost: "1.25", BillingCurrency: "USD", Tags: { ProjectId: "prj_coinops" },
  ChargePeriodStart: "2026-09-25T00:00:00Z", ChargePeriodEnd: "2026-09-26T00:00:00Z", ServiceName: "Functions", ConsumedUnit: "hours", ConsumedQuantity: "2", ...changes });
const fakeFetch = (fn: (url: URL, init?: RequestInit) => unknown | Response): typeof fetch => async (input, init) => {
  const result = fn(new URL(String(input)), init);
  return result instanceof Response ? result : Response.json(result);
};
const droplet = (ip: string, id: number) => ({ id, networks: { v4: [{ type: "public", ip_address: ip }] },
  size: { slug: "s-1vcpu-1gb", price_monthly: 6, memory: 1024, disk: 25, transfer: 1 }, region: { slug: "fra1" } });

test("PTAX retains official source/timestamp and never treats stale/future rates as fresh", () => {
  const quote = parsePtaxQuote(fx, now);
  assert.equal(quote.base, "USD");
  assert.equal(quote.rate, 5.32);
  assert.equal(quote.observedAt, "2026-09-25T16:05:00.000Z");
  assert.throws(() => parsePtaxQuote({ value: [{ cotacaoVenda: 5, dataHoraCotacao: "2026-09-10 13:00:00" }] }, now), /STALE_OR_MISSING/);
  assert.throws(() => parsePtaxQuote({ value: [{ cotacaoVenda: 5, dataHoraCotacao: "2026-09-27 13:00:00" }] }, now), /STALE_OR_MISSING/);
});

test("USDT conversion is an independent market quote, not presumed USD parity", () => {
  const quote = parseUsdtBrlQuote({ symbol: "USDTBRL", lastPrice: "5.47", closeTime: now.getTime() }, now);
  assert.equal(quote.base, "USDT");
  assert.equal(quote.rate, 5.47);
  assert.throws(() => parseUsdtBrlQuote({ symbol: "USDTUSD", lastPrice: "1", closeTime: now.getTime() }, now), /INVALID/);
});

test("FX partial provider failure preserves successful quote; no network secret or trading request", async () => {
  const requests: URL[] = [];
  const result = await fetchFinopsFx(now, fakeFetch((url, init) => {
    requests.push(url);
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    if (url.hostname === "olinda.bcb.gov.br") {
      assert.equal(url.href.includes("+"), false);
      assert.ok(url.href.includes("dataHoraCotacao%20desc"));
      assert.equal(url.searchParams.get("$orderby"), "dataHoraCotacao desc");
      return fx;
    }
    return new Response("Unavailable", { status: 503 });
  }));
  assert.deepEqual(result.map(row => row.base), ["USD"]);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].hostname, "data-api.binance.vision");
  assert.equal(requests[1].searchParams.get("symbol"), "USDTBRL");
  await assert.rejects(fetchFinopsFx(now, fakeFetch(() => { throw new Error("private token detail"); })), /^Error: FINOPS_FX_UNAVAILABLE$/);
});

test("FX market-data-only endpoint supplies USDT independently when BCB is unavailable", async () => {
  const quotes = await fetchFinopsFx(now, fakeFetch((url, init) => {
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    if (url.hostname === "olinda.bcb.gov.br") throw new Error("provider internal response not to disclose");
    assert.equal(url.hostname, "data-api.binance.vision");
    assert.equal(url.pathname, "/api/v3/ticker/24hr");
    assert.equal(url.searchParams.get("symbol"), "USDTBRL");
    return { symbol: "USDTBRL", lastPrice: "5.19", closeTime: now.getTime() };
  }));
  assert.deepEqual(quotes.map((quote) => [quote.base, quote.rate]), [["USDT", 5.19]]);
});

test("DigitalOcean matches primary public IP exactly across pages and never follows next URL", async () => {
  const requests: string[] = [];
  const rows = await fetchDigitalOceanCosts("fixture-token", [{ id: "one", ip: "46.101.104.48" }, { id: "two", ip: "164.90.223.159" }], fakeFetch((url, init) => {
    requests.push(url.href);
    assert.equal(url.hostname, "api.digitalocean.com");
    assert.equal(init?.redirect, "error");
    return url.searchParams.get("page") === "1"
      ? { droplets: [droplet("46.101.104.48", 1), droplet("1.1.1.1", 99)], links: { pages: { next: "https://malicious.invalid/token" } } }
      : { droplets: [droplet("164.90.223.159", 2)], links: {} };
  }));
  assert.equal(requests.length, 2);
  assert.deepEqual(rows.map(row => [row.shardId, row.monthlyUsd]), [["one", 6], ["two", 6]]);
  assert.match(rows[0].notes[0], /ESTIMADO/);
  assert.equal(rows[0].quantity, 1);
  assert.equal(rows[0].unitPrice, 6);
});

test("DigitalOcean missing/deactivated shard is not assigned a fabricated zero cost", async () => {
  assert.deepEqual(await fetchDigitalOceanCosts("fixture", [{ id: "missing", ip: "2.2.2.2" }], fakeFetch(() => ({ droplets: [] }))), []);
  await assert.rejects(fetchDigitalOceanCosts("fixture", [{ id: "a", ip: "2.2.2.2" }, { id: "b", ip: "2.2.2.2" }]), /MAPPING_INVALID/);
  await assert.rejects(fetchDigitalOceanCosts("fixture", [{ id: "a", ip: "2.2.2.2" }], fakeFetch(() => ({ droplets: [droplet("2.2.2.2", 1), droplet("2.2.2.2", 2)] }))), /OWNERSHIP_INVALID/);
});

test("DigitalOcean has bounded pagination and sanitized provider failures", async () => {
  let count = 0;
  await assert.rejects(fetchDigitalOceanCosts("fixture", [{ id: "a", ip: "2.2.2.2" }], fakeFetch(() => {
    count += 1; return { droplets: [], links: { pages: { next: "next" } } };
  })), /PAGINATION_LIMIT/);
  assert.equal(count, 10);
  await assert.rejects(fetchDigitalOceanCosts("fixture", [{ id: "a", ip: "2.2.2.2" }], fakeFetch(() => { throw new Error("Authorization: secret"); })), /^Error: FINOPS_DO_UNAVAILABLE$/);
});

test("Vercel attributes only exact ProjectId, preserves credits and excludes shared team fees", () => {
  const result = parseVercelProjectCosts([billing(), billing({ BilledCost: "-0.25" }),
    billing({ Tags: { ProjectId: "prj_other" }, BilledCost: "100" }), billing({ Tags: {}, BilledCost: "20" })].map(row => JSON.stringify(row)).join("\n"), period, now);
  assert.equal(result.monthToDate, 1);
  assert.equal(result.matchedRows, 2);
  assert.equal(result.excludedRows, 2);
  assert.equal(result.usage[0].used, 4);
  assert.match(result.notes[0], /MANUAL/);
});

test("Vercel supports BRL without summing incompatible currencies or unknown attribution", () => {
  assert.equal(parseVercelProjectCosts(JSON.stringify(billing({ BillingCurrency: "BRL" })), period).currency, "BRL");
  assert.throws(() => parseVercelProjectCosts([billing(), billing({ BillingCurrency: "BRL" })].map(row => JSON.stringify(row)).join("\n"), period), /MIXED_CURRENCY/);
  assert.equal(parseVercelProjectCosts(JSON.stringify(billing({ Tags: {} })), period).monthToDate, null);
  assert.throws(() => parseVercelProjectCosts(JSON.stringify(billing({ BilledCost: "NaN" })), period), /SCHEMA/);
});

test("Vercel uses official fixed host and rejects scope/schema/response overflow", async () => {
  const result = await fetchVercelProjectCosts("fixture", { ...period, teamId: "team_coinops" }, fakeFetch((url, init) => {
    assert.equal(url.hostname, "api.vercel.com");
    assert.equal(url.searchParams.get("teamId"), "team_coinops");
    assert.equal(init?.method, "GET");
    return new Response(JSON.stringify(billing()));
  }));
  assert.equal(result.monthToDate, 1.25);
  await assert.rejects(fetchVercelProjectCosts("fixture", { ...period, teamId: "https://evil" }), /SCOPE_INVALID/);
  await assert.rejects(fetchVercelProjectCosts("fixture", { ...period, teamId: "team_coinops" }, fakeFetch(() => new Response("denied", { status: 403 }))), /FINOPS_VERCEL_HTTP_403/);
  await assert.rejects(fetchVercelProjectCosts("fixture", { ...period, teamId: "team_coinops" }, fakeFetch(() => new Response("x", { headers: { "content-length": "99999999" } }))), /TOO_LARGE/);
});

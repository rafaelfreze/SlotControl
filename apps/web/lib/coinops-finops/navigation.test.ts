import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildFinopsNavigation } from "./navigation.ts";

const accountId = "8f16c84e-17cf-41d6-af0f-b3fa7a64ab89";

test("default and ALL keep an explicit safe Início/Custos round-trip context", () => {
  const expected = { costsHref: "/custos-operacao?view=live&account=ALL&market=ALL",
    automationHref: "/automacao?view=live&account=ALL&market=ALL" };
  assert.deepEqual(buildFinopsNavigation(), expected);
  assert.deepEqual(buildFinopsNavigation({ view: "live", account: "ALL", market: "ALL" }), expected);
});

test("selected account and SOLBRL return unchanged, independently of account display name", () => {
  const context = { view: "live", account: accountId, market: "SOLBRL" };
  const navigation = buildFinopsNavigation(context);
  assert.equal(navigation.costsHref, `/custos-operacao?view=live&account=${accountId}&market=SOLBRL`);
  assert.equal(navigation.automationHref, `/automacao?view=live&account=${accountId}&market=SOLBRL`);
  const query = new URL(navigation.costsHref, "https://coinops.example.invalid").searchParams;
  assert.deepEqual(buildFinopsNavigation(Object.fromEntries(query)), navigation);
  assert.deepEqual(context, { view: "live", account: accountId, market: "SOLBRL" });
});

test("each supported view and native market preserves filters, including Testnet", () => {
  for (const view of ["live", "testnet", "shadow", "overview"]) {
    for (const market of ["ALL", "BTCBRL", "SOLBRL", "BTCUSDT", "SOLUSDT"]) {
      const result = buildFinopsNavigation({ view, account: accountId, market });
      for (const href of [result.costsHref, result.automationHref]) {
        const url = new URL(href, "https://coinops.example.invalid");
        assert.equal(url.searchParams.get("view"), view);
        assert.equal(url.searchParams.get("account"), accountId);
        assert.equal(url.searchParams.get("market"), market);
      }
    }
  }
});

test("UUID input canonicalizes case and never accepts display names as routing identities", () => {
  assert.deepEqual(buildFinopsNavigation({ account: accountId.toUpperCase() }), buildFinopsNavigation({ account: accountId }));
  for (const account of ["Dete", "Rafael", "Thyely", "not-a-uuid", "11111111-1111-4111-111111111111"]) {
    assert.equal(new URL(buildFinopsNavigation({ account }).automationHref, "https://coinops.example.invalid")
      .searchParams.get("account"), "ALL");
  }
});

test("malformed, duplicate and external-looking parameters cannot redirect or inject a query", () => {
  for (const value of [undefined, null, 42, {}, ["live"], [accountId, accountId],
    "https://evil.example/", "//evil.example", "javascript:alert(1)", "../admin", "live&account=other",
    `${accountId}&returnTo=https://evil.example`, "BTCUSDT#outside", "SOLBRL%26extra=1"]) {
    const result = buildFinopsNavigation({ view: value, account: value, market: value });
    assert.deepEqual(result, buildFinopsNavigation());
    for (const href of [result.costsHref, result.automationHref]) {
      const url = new URL(href, "https://coinops.example.invalid");
      assert.equal(url.origin, "https://coinops.example.invalid");
      assert.deepEqual([...url.searchParams.keys()], ["view", "account", "market"]);
    }
  }
});

test("unknown returnTo/redirect and server query values do not flow into either destination", () => {
  const query: Record<string, unknown> = { view: "testnet", account: accountId, market: "BTCUSDT",
    returnTo: "https://evil.example", redirect: "//evil.example", engine: "untrusted", token: "unused-fixture" };
  assert.deepEqual(buildFinopsNavigation(query), buildFinopsNavigation({
    view: "testnet", account: accountId, market: "BTCUSDT",
  }));
});

test("both premium Costs links use current selection and menu Home uses the same context", () => {
  const source = readFileSync(new URL("../../app/automacao/premium-automation.tsx", import.meta.url), "utf8");
  assert.match(source, /buildFinopsNavigation\(\{ view, account: selection\.accountId, market: selection\.symbol \}\)/);
  assert.equal((source.match(/href=\{finopsNavigation\.costsHref\}/g) ?? []).length, 2);
  assert.match(source, /href=\{finopsNavigation\.automationHref\}>Início da Automação/);
  assert.doesNotMatch(source, /href="\/custos-operacao"/);
});

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { fetchOperationalData } from "../supabase/no-store-fetch.ts";

const require = createRequire(import.meta.url);

test("Next 14 GET force-dynamic alone caches run discovery; operational fetch always observes new cycles", async () => {
  // Exercise the installed Next implementation, not a hand-written imitation of its cache rules.
  // Next aliases React to its bundled server runtime; plain node:test does not apply that alias.
  const react = require("react");
  const previousReactCache = react.cache;
  react.cache = require("next/dist/compiled/react").cache;
  const { patchFetch } = require("next/dist/server/lib/patch-fetch.js");
  const originalFetch = globalThis.fetch;
  let activeRuns = ["SOL-old"];
  let originReads = 0;
  const cache = new Map<string, unknown>();
  const incrementalCache = {
    fetchCacheKey: async (url: string) => url,
    lock: async () => async () => {},
    get: async (key: string) => cache.get(key) || null,
    set: async (key: string, value: unknown) => { cache.set(key, { value, isStale: false }); },
  };
  // This is exactly the GET-only force-dynamic store set by app-route/module.js in Next 14.2.35.
  const newStore = () => ({ forceDynamic: true, revalidate: false, isStaticGeneration: false, urlPathname: "/api/cron/testnet-execution", incrementalCache });
  let store = newStore();
  try {
    globalThis.fetch = async () => { originReads++; return Response.json(activeRuns); };
    patchFetch({ serverHooks: {}, staticGenerationAsyncStorage: { getStore: () => store } });
    const url = "https://operational-data.invalid/rest/v1/robot_v1_testnet_runs";
    const init = { headers: { authorization: "Bearer fixture-not-a-secret" } };
    assert.deepEqual(await (await fetch(url, init)).json(), ["SOL-old"]);
    activeRuns = ["SOL-new", "BTC-new"];
    store = newStore();
    assert.deepEqual(await (await fetch(url, init)).json(), ["SOL-old"], "reproduces the pre-fix stale active run discovery");
    assert.equal(originReads, 1);
    store = newStore();
    assert.deepEqual(await (await fetchOperationalData(url, init)).json(), ["SOL-new", "BTC-new"]);
    activeRuns = ["SOL-newest", "BTC-new"];
    store = newStore();
    assert.deepEqual(await (await fetchOperationalData(url, init)).json(), ["SOL-newest", "BTC-new"]);
    assert.equal(originReads, 3);
  } finally { globalThis.fetch = originalFetch; react.cache = previousReactCache; }
});

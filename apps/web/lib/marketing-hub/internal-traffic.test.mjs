import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as qa from "../../vendor/marketing-internal-traffic-1.3.5/internal-traffic.mjs";
function load(path, mocks, globals = {}) {
 const code = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
 const module = { exports: {} };
 vm.runInNewContext(code, { module, exports: module.exports, Response, ...globals, require: key => { if (!(key in mocks)) throw Error("Unexpected dependency " + key); return mocks[key]; } });
 return module.exports;
}
test("public CoinOps wrapper suppresses the original counter during QA or explicit preview", () => {
 let internal = false;
 const api = load("components/marketing/website-counter.tsx", { "next/navigation": { usePathname: () => "/" }, "@/vendor/marketing-internal-traffic-1.3.5/internal-traffic.mjs": { isInternalTraffic: () => internal }, "@/vendor/marketing-1.3.2/website-counter.mjs": { WebsiteCounter: "counter" }, "react/jsx-runtime": { jsx: (type, props) => ({ type, props }) } });
 assert.equal(api.PublicWebsiteCounter({}).props.preview, false);
 internal = true; assert.equal(api.PublicWebsiteCounter({}).props.preview, true);
 internal = false; assert.equal(api.PublicWebsiteCounter({ preview: true }).props.preview, true);
});
test("QA ingestion bypasses the database; unmarked production keeps the existing path", async () => {
 let dbCalls = 0, counts = 0;
 const api = load("app/api/marketing/platform/route.ts", { "@/vendor/marketing-internal-traffic-1.3.5/internal-traffic.mjs": qa, "@/vendor/marketing-1.3.2/website-server.mjs": { async serveWebsiteCounter() { counts++; return new Response(null,{status:204}); } }, "@/lib/marketing-hub/website-source": { websiteDb() { dbCalls++; return {}; }, websiteProduct: "coinops" } });
 for (const headers of [{ "x-onplay-qa":"1" }, { referer:"https://cripto-flax.vercel.app/?onplay_qa=1" }, { referer:"https://cripto-flax.vercel.app/preview/site" }]) assert.equal((await api.POST(new Request("https://cripto-flax.vercel.app/api/marketing/platform",{method:"POST",headers}))).status,204);
 assert.equal(dbCalls,0);assert.equal(counts,0);
 assert.equal((await api.POST(new Request("https://cripto-flax.vercel.app/api/marketing/platform",{method:"POST"}))).status,204);
 assert.equal(dbCalls,1);assert.equal(counts,1);
});
test("a technical production host alone is public; QA is one removable boolean, never an ID", () => {
 assert.equal(qa.isInternalTrafficRequest(new Request("https://cripto-flax.vercel.app/api/marketing/platform")),false);
 const original=Object.getOwnPropertyDescriptor(globalThis,"window"), stored=new Map();
 const context={location:{search:"?onplay_qa=1",hostname:"cripto-flax.vercel.app",pathname:"/"},navigator:{webdriver:false},sessionStorage:{getItem:key=>stored.get(key),setItem:(key,value)=>stored.set(key,value),removeItem:key=>stored.delete(key)}};
 Object.defineProperty(globalThis,"window",{configurable:true,value:context});
 try {assert.equal(qa.isInternalTraffic(),true);assert.deepEqual([...stored],[["onplay:qa","1"]]);context.location.search="";assert.equal(qa.isInternalTraffic(),true);context.location.search="?onplay_qa=0";assert.equal(qa.isInternalTraffic(),false);assert.equal(stored.size,0);} finally {if(original)Object.defineProperty(globalThis,"window",original);else Reflect.deleteProperty(globalThis,"window");}
});

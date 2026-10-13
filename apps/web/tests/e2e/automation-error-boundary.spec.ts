import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const root = process.cwd();
const transpile = (path: string) => ts.transpileModule(readFileSync(resolve(root, path), "utf8"), {
  fileName: path, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.React, esModuleInterop: true },
}).outputText;

/** Offline browser fixture: no server loader, financial action, or provider call. */
async function mountError(page: Page, digest: string | null, width = 390, online = true, retained = false) {
  const requests: string[] = [], errors: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => route.request().url() === "http://127.0.0.1:39999/automacao"
    ? route.fulfill({ contentType: "text/html", body: '<html><body><div id="fixture"></div></body></html>' }) : route.abort());
  await page.goto("http://127.0.0.1:39999/automacao");
  await page.setViewportSize({ width, height: 844 });
  await page.clock.install({ time: new Date("2026-10-13T12:00:00Z") });
  await page.addScriptTag({ path: resolve(root, "node_modules/react/umd/react.production.min.js") });
  await page.addScriptTag({ path: resolve(root, "node_modules/react-dom/umd/react-dom.production.min.js") });
  const boundary = transpile("app/automacao/error.tsx"), policy = transpile("app/automacao/automation-read-recovery.ts");
  await page.addScriptTag({ content: `(() => {
    const React = window.React;
    const modules = { policy: function(require,module,exports){ ${policy} }, boundary: function(require,module,exports){ ${boundary} } };
    const cache = {};
    window.__calls = []; window.__online = ${JSON.stringify(online)}; window.__visible = 'visible';
    Object.defineProperty(navigator,'onLine',{get:()=>window.__online});
    Object.defineProperty(document,'visibilityState',{get:()=>window.__visible});
    const router = { refresh: () => window.__calls.push('refresh') };
    function require(id) {
      if(id==='react')return React;
      if(id==='next/navigation')return {useRouter:()=>router};
      const name = id==='./automation-read-recovery' ? 'policy' : id;
      if(cache[name])return cache[name].exports;
      const module = {exports:{}};cache[name]=module;modules[name](require,module,module.exports);return module.exports;
    }
    const Recovery=require('policy'), Boundary=require('boundary').default;
    const initialError=new Error('Synthetic read failure');initialError.digest=${JSON.stringify(digest)};
    const retained=${JSON.stringify(retained)};
    function Healthy(){React.useEffect(()=>{Recovery.clearAutomationReadRecovery(sessionStorage,location.pathname)},[]);return React.createElement('p',null,'Painel carregado');}
    function App(){
      const [generation,setGeneration]=React.useState(0),[healthy,setHealthy]=React.useState(false),[error,setError]=React.useState(initialError);
      window.__healthy=()=>setHealthy(true);window.__fail=()=>{setHealthy(false);setGeneration(value=>value+1)};
      return healthy ? React.createElement(Healthy) : React.createElement(Boundary,{key:retained?'retained':generation,error,reset:()=>{
        window.__calls.push('reset');const failure=new Error('Synthetic retry failed');failure.digest=${JSON.stringify(digest)};setError(failure);setGeneration(value=>value+1)
      }});
    }
    window.ReactDOM.createRoot(document.getElementById('fixture')).render(React.createElement(App));
  })();` });
  await expect(page.getByRole("heading", { name: "Automação temporariamente indisponível" })).toBeVisible();
  return { requests, errors };
}

const calls = (page: Page) => page.evaluate(() => (window as unknown as { __calls: string[] }).__calls);
async function safe(page: Page, audit: Awaited<ReturnType<typeof mountError>>) {
  expect(audit.errors).toEqual([]);
  expect(audit.requests).toEqual(["http://127.0.0.1:39999/automacao"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}

for (const width of [390, 1440]) test(`painel transitório recupera por episódio com dois GETs máximos em ${width}px`, async ({ page }) => {
  const audit = await mountError(page, "COINOPS_AUTOMATION_READ_TRANSIENT", width);
  await page.clock.runFor(5_001);
  expect(await calls(page)).toEqual(["refresh", "reset"]);
  await page.clock.runFor(15_001);
  expect(await calls(page)).toEqual(["refresh", "reset", "refresh", "reset"]);
  await page.evaluate(() => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); });
  await page.clock.runFor(60_000);
  expect(await calls(page)).toHaveLength(4);
  await page.evaluate(() => (window as unknown as { __healthy: () => void }).__healthy());
  await expect(page.getByText("Painel carregado")).toBeVisible();
  await page.evaluate(() => (window as unknown as { __fail: () => void }).__fail());
  await page.clock.runFor(5_001);
  expect(await calls(page)).toHaveLength(6);
  await safe(page, audit);
});

test("erro de permissão não tenta sozinho e retry manual renova GET e boundary", async ({ page }) => {
  const audit = await mountError(page, "42501");
  await page.clock.runFor(60_000);
  await page.evaluate(() => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); });
  await page.clock.runFor(60_000);
  expect(await calls(page)).toEqual([]);
  await page.getByRole("button", { name: "Tentar novamente" }).click();
  expect(await calls(page)).toEqual(["refresh", "reset"]);
  await page.clock.runFor(60_000);
  expect(await calls(page)).toHaveLength(2);
  await safe(page, audit);
});

test("painel offline ou oculto não consome tentativas de recuperação", async ({ page }) => {
  const audit = await mountError(page, "COINOPS_AUTOMATION_READ_TRANSIENT", 390, false);
  await page.clock.runFor(20_000);
  expect(await calls(page)).toEqual([]);
  await page.evaluate(() => { (window as unknown as { __online: boolean }).__online = true; window.dispatchEvent(new Event("online")); });
  await page.clock.runFor(5_001);
  expect(await calls(page)).toHaveLength(2);
  await page.evaluate(() => { (window as unknown as { __visible: string }).__visible = "hidden"; });
  await page.clock.runFor(15_001);
  expect(await calls(page)).toHaveLength(2);
  await page.evaluate(() => { (window as unknown as { __visible: string }).__visible = "visible"; document.dispatchEvent(new Event("visibilitychange")); });
  await page.clock.runFor(15_001);
  expect(await calls(page)).toHaveLength(4);
  await safe(page, audit);
});

test("boundary retido com mesmo digest reabre guard após resposta falha, não o orçamento", async ({ page }) => {
  const audit = await mountError(page, "COINOPS_AUTOMATION_READ_TRANSIENT", 390, true, true);
  await page.clock.runFor(5_001);
  expect(await calls(page)).toHaveLength(2);
  await page.clock.runFor(15_001);
  expect(await calls(page)).toHaveLength(4);
  await page.clock.runFor(60_000);
  expect(await calls(page)).toHaveLength(4);
  const manual = page.getByRole("button", { name: "Tentar novamente" });
  await expect(manual).toBeEnabled();
  await manual.click();
  expect(await calls(page)).toHaveLength(6);
  await expect(manual).toBeEnabled();
  await manual.click();
  expect(await calls(page)).toHaveLength(8);
  await page.clock.runFor(60_000);
  expect(await calls(page)).toHaveLength(8);
  await safe(page, audit);
});

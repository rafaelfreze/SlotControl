import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

import { AUTHENTICATED_HOME, getAuthDestination } from "./navigation.ts";

test("entrada sem destino usa Automação, sem transformar Resumo em redirect", () => {
  assert.equal(AUTHENTICATED_HOME, "/automacao");
  assert.equal(getAuthDestination(), "/automacao");
  assert.equal(getAuthDestination({ redirectTo: "" }), "/automacao");
  assert.equal(getAuthDestination({ redirectTo: "/dashboard" }), "/dashboard");
});

test("retornos internos explícitos preservam rota, filtros e fragmento", () => {
  for (const key of ["redirectTo", "returnTo", "next"]) {
    assert.equal(getAuthDestination({ [key]: "/automacao?view=testnet&market=BTCUSDC#slots" }),
      "/automacao?view=testnet&market=BTCUSDC#slots");
    assert.equal(getAuthDestination({ [key]: "/redefinir-senha" }), "/redefinir-senha");
  }
  assert.equal(getAuthDestination({ redirectTo: "/slots", next: "/dashboard" }), "/slots");
});

test("destinos externos, scripts, barras ambíguas e controles falham fechados", () => {
  for (const value of ["https://example.com", "//example.com", "/\\example.com", "javascript:alert(1)",
    "data:text/html,unsafe", "dashboard", " /dashboard", "/\n/evil", "/%5cevil", "/%0devil", [], {}, 42]) {
    assert.equal(getAuthDestination({ redirectTo: value }), "/automacao", String(value));
  }
});

function compile(relative: string, dependencies: Record<string, unknown>) {
  const source = readFileSync(new URL(relative, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX
  } }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", compiled)((name: string) => {
    assert.ok(name in dependencies, `Unexpected auth dependency: ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}

type ResponseResult = { location?: string; passthrough?: boolean; cookies: { set: () => void } };
const nextServer = { NextResponse: {
  redirect: (url: URL): ResponseResult => ({ location: url.toString(), cookies: { set() {} } }),
  next: (): ResponseResult => ({ passthrough: true, cookies: { set() {} } })
} };
const navigation = { AUTHENTICATED_HOME, getAuthDestination };

function callback(configured = true, error: unknown = null) {
  const exchanged: string[] = [];
  const evaluatedModule = compile("../../app/auth/callback/route.ts", {
    "next/server": nextServer,
    "@/lib/auth/navigation": navigation,
    "@/lib/supabase/server": {
      isSupabaseConfigured: () => configured,
      createClient: () => ({ auth: { exchangeCodeForSession: async (code: string) => {
        exchanged.push(code);
        return { error };
      } } })
    }
  }) as { GET: (request: { url: string }) => Promise<ResponseResult> };
  return { ...evaluatedModule, exchanged };
}

test("callback troca o code uma vez e usa o novo destino padrão sem vazar o code", async () => {
  const handler = callback();
  const result = await handler.GET({ url: "https://coinops.example/auth/callback?code=fixture" });
  assert.equal(result.location, "https://coinops.example/automacao");
  assert.deepEqual(handler.exchanged, ["fixture"]);
});

test("callback conserva next interno e sua query, incluindo recuperação de senha", async () => {
  for (const next of ["/dashboard", "/redefinir-senha", "/automacao?view=real#slots"]) {
    const result = await callback().GET({ url: `https://coinops.example/auth/callback?code=fixture&next=${encodeURIComponent(next)}` });
    assert.equal(result.location, `https://coinops.example${next}`);
  }
});

test("callback externo inválido volta ao home interno", async () => {
  const result = await callback().GET({ url: "https://coinops.example/auth/callback?next=https%3A%2F%2Fevil.example" });
  assert.equal(result.location, "https://coinops.example/automacao");
});

test("erros e ambiente ausente continuam voltando ao login, sem mudar autenticação", async () => {
  const unavailable = callback(false);
  assert.equal((await unavailable.GET({ url: "https://coinops.example/auth/callback?code=fixture" })).location,
    "https://coinops.example/login?setup=missing-env");
  assert.deepEqual(unavailable.exchanged, []);
  const failure = callback(true, { message: "fixture error" });
  assert.equal((await failure.GET({ url: "https://coinops.example/auth/callback?code=fixture" })).location,
    "https://coinops.example/login?auth=callback-error");
  assert.deepEqual(failure.exchanged, ["fixture"]);
});

async function runMiddleware(path: string, authenticated: boolean) {
  const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const previousKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fixture.invalid";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "fixture-public-key";
  let userChecks = 0;
  try {
    const { middleware } = compile("../../middleware.ts", {
      "next/server": nextServer,
      "@/lib/auth/navigation": navigation,
      "@/lib/supabase/env": { getSupabaseDataSchema: () => "coinops" },
      "@supabase/ssr": { createServerClient: () => ({ auth: { getUser: async () => {
        userChecks += 1;
        return { data: { user: authenticated ? { id: "fixture" } : null } };
      } } }) }
    }) as { middleware: (request: unknown) => Promise<ResponseResult> };
    const url = new URL(path, "https://coinops.example");
    const request = { url: url.toString(), nextUrl: Object.assign(url, { clone: () => new URL(url) }),
      cookies: { getAll: () => [], set() {} } };
    const response = await middleware(request);
    assert.equal(userChecks, 1, "validated getUser remains required");
    return response;
  } finally {
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = previousKey;
  }
}

test("sessão já autenticada no login/cadastro vai à Automação por padrão", async () => {
  for (const route of ["/login", "/cadastro"]) {
    assert.equal((await runMiddleware(route, true)).location, "https://coinops.example/automacao");
  }
});

test("middleware preserva retornos internos validados e rejeita externos", async () => {
  assert.equal((await runMiddleware("/login?redirectTo=%2Fdashboard", true)).location, "https://coinops.example/dashboard");
  assert.equal((await runMiddleware("/login?returnTo=%2Fautomacao%3Fview%3Dtestnet", true)).location,
    "https://coinops.example/automacao?view=testnet");
  assert.equal((await runMiddleware("/login?next=https%3A%2F%2Fevil.example", true)).location, "https://coinops.example/automacao");
});

test("Resumo e rotas existentes mantêm seus guards, sem novo redirect quando autenticado", async () => {
  assert.equal((await runMiddleware("/dashboard", true)).passthrough, true);
  assert.equal((await runMiddleware("/dashboard", false)).location, "https://coinops.example/login?redirectTo=%2Fdashboard");
});

test("root autenticado usa Automação e ainda exige usuário verificado", async () => {
  let checks = 0;
  const { default: home } = compile("../../app/page.tsx", {
    "react/jsx-runtime": {}, "next/link": {}, "@/components/app/coinops-brand": {},
    "@/lib/auth/navigation": navigation,
    "next/navigation": { redirect: (path: string) => { throw new Error(`redirect:${path}`); } },
    "@/lib/supabase/server": { isSupabaseConfigured: () => true,
      createClient: () => ({ auth: { getUser: async () => {
        checks += 1;
        return { data: { user: { email: "fixture@example.invalid" } } };
      } } }) }
  }) as { default: () => Promise<unknown> };
  await assert.rejects(home, /redirect:\/automacao/);
  assert.equal(checks, 1);
});

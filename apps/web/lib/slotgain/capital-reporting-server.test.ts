import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";

import { loadCapitalReportingEntries } from "./capital-reporting-server.ts";

function reportingClient(total: number, options: { cap?: number; failPage?: number; changeCountPage?: number } = {}) {
  const calls: { from: number; to: number; filters: [string, unknown][] }[] = [];
  const client = {
    from(table: string) {
      assert.equal(table, "capital_reporting_entries");
      const filters: [string, unknown][] = [];
      const query = {
        select(fields: string, settings: { count: string }) {
          assert.ok(fields.includes("incorporated_in_opening,source"));
          assert.equal(settings.count, "exact");
          return query;
        },
        lte(column: string, value: string) {
          assert.equal(column, "created_at");
          assert.ok(Number.isFinite(Date.parse(value)));
          return query;
        },
        order() { return query; },
        eq(column: string, value: unknown) { filters.push([column, value]); return query; },
        async range(from: number, to: number) {
          calls.push({ from, to, filters });
          if (calls.length === options.failPage) return { data: null, count: null, error: { message: "Falha sintética" } };
          return {
            data: Array.from({ length: Math.min(total - from, to - from + 1, options.cap || 500) }, (_, index) => ({ id: `entry-${from + index}` })),
            count: calls.length === options.changeCountPage ? total + 1 : total,
            error: null
          };
        }
      };
      return query;
    }
  };
  return { client: client as unknown as SupabaseClient, calls };
}

test("leitura de capital inclui mais de 1000 linhas sem truncar totais", async () => {
  const { client, calls } = reportingClient(1102);
  const result = await loadCapitalReportingEntries(client);
  assert.equal(result.error, null);
  assert.equal(result.data.length, 1102);
  assert.deepEqual(calls.map((call) => call.from), [0, 500, 1000]);
  assert.ok(calls.every((call) => call.filters.some(([column, value]) => column === "incorporated_in_opening" && value === false)));
});

test("usa contagem exata mesmo se servidor limitar cada pagina abaixo do solicitado", async () => {
  const { client, calls } = reportingClient(251, { cap: 100 });
  const result = await loadCapitalReportingEntries(client, { slotId: "slot-1", includeIncorporated: true });
  assert.equal(result.data.length, 251);
  assert.deepEqual(calls.map((call) => call.from), [0, 100, 200]);
  assert.ok(calls.every((call) => call.filters.length === 1 && call.filters[0][0] === "slot_id" && call.filters[0][1] === "slot-1"));
});

test("zero registros nao requer outra pagina", async () => {
  const { client, calls } = reportingClient(0);
  assert.deepEqual(await loadCapitalReportingEntries(client), { data: [], error: null });
  assert.equal(calls.length, 1);
});

test("erro na pagina seguinte nao retorna soma financeira parcial", async () => {
  const { client } = reportingClient(1001, { failPage: 2 });
  await assert.rejects(loadCapitalReportingEntries(client), /Não foi possível carregar os lançamentos de capital/);
});

test("mudanca de contagem durante leitura falha explicitamente sem total inconsistente", async () => {
  const { client } = reportingClient(1001, { changeCountPage: 2 });
  await assert.rejects(loadCapitalReportingEntries(client), /mudaram durante a leitura/);
});

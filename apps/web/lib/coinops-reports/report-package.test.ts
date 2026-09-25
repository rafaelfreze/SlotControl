import test from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { buildCsv, buildZip, crc32, sha256, stableJson, sanitizeExportValue } from "./export-format.ts";
import { parseReportFilters, reportDates } from "./filters.ts";
import { buildReportPackage, REPORT_FILES, type PackagedAudit } from "./report-package.ts";
import { STRATEGY_4_1_EFFECTIVE_AT } from "./missed-level-temporal.ts";

const now = new Date("2026-09-23T02:30:00.000Z");
const filters = parseReportFilters(new URLSearchParams("preset=today"), now);

test("períodos usam dias inclusivos Campo Grande e intervalo UTC exclusivo", () => {
  assert.equal(filters.start, "2026-09-22T04:00:00.000Z");
  assert.equal(filters.end, "2026-09-23T04:00:00.000Z");
  assert.deepEqual(reportDates(filters), { start: "2026-09-22", end: "2026-09-22" });
  assert.equal(parseReportFilters(new URLSearchParams("preset=7d"), now).start, "2026-09-16T04:00:00.000Z");
  assert.equal(parseReportFilters(new URLSearchParams("preset=month"), now).start, "2026-09-01T04:00:00.000Z");
});
test("filtros rejeitam escopo cliente, datas inválidas/futuras e janelas excessivas", () => {
  assert.throws(() => parseReportFilters(new URLSearchParams("preset=custom&start=2026-99-01&end=2026-99-02"), now), /REPORT_DATE_INVALID/);
  for (const params of ["tenant_id=outro", "userId=x", "preset=custom&start=2026-02-30&end=2026-03-01", "start=2026-09-23&end=2026-09-24", "start=2024-01-01&end=2026-01-01", "asset=ETH", "environment=PRODUCTION", "start=2026-01-01", "preset=invalid"]) assert.throws(() => parseReportFilters(new URLSearchParams(params), now), params);
});
test("filtro isolado preserva ativo/ambiente explicitamente selecionado", () => {
  const selected = parseReportFilters(new URLSearchParams("asset=SOL&environment=TESTNET"), now);
  assert.deepEqual(selected.assets, ["SOL"]); assert.deepEqual(selected.environments, ["TESTNET"]);
});

/** Independent ZIP reader: local headers, deflate, CRC and central directory/EOCD offsets. */
function unzip(bytes: Uint8Array) {
  const data = Buffer.from(bytes), files = new Map<string, string>();
  let cursor = 0;
  while (data.readUInt32LE(cursor) === 0x04034b50) {
    const method = data.readUInt16LE(cursor + 8), crc = data.readUInt32LE(cursor + 14), size = data.readUInt32LE(cursor + 18), rawSize = data.readUInt32LE(cursor + 22), nameSize = data.readUInt16LE(cursor + 26), extra = data.readUInt16LE(cursor + 28);
    const name = data.subarray(cursor + 30, cursor + 30 + nameSize).toString("utf8"), start = cursor + 30 + nameSize + extra;
    assert.equal(method, 8); const raw = inflateRawSync(data.subarray(start, start + size));
    assert.equal(raw.length, rawSize); assert.equal(crc32(raw), crc); files.set(name, raw.toString("utf8")); cursor = start + size;
  }
  const centralStart = cursor;
  while (data.readUInt32LE(cursor) === 0x02014b50) cursor += 46 + data.readUInt16LE(cursor + 28) + data.readUInt16LE(cursor + 30) + data.readUInt16LE(cursor + 32);
  assert.equal(data.readUInt32LE(cursor), 0x06054b50); assert.equal(data.readUInt16LE(cursor + 10), files.size); assert.equal(data.readUInt32LE(cursor + 16), centralStart); assert.equal(data.readUInt32LE(cursor + 12), cursor - centralStart); assert.equal(cursor + 22, data.length);
  return files;
}

test("CSV Excel UTF-8 BOM/ponto e vírgula protege fórmulas e preserva aspas/newlines", () => {
  const csv = buildCsv([{ name: '=HYPERLINK("https://exemplo")', amount: -1.25, note: "ação; ganho\nlinha \"2\"" }], [{ key: "name", label: "Nome" }, { key: "amount", label: "Valor" }, { key: "note", label: "Observação" }]);
  assert.equal(Buffer.from(csv).subarray(0, 3).toString("hex"), "efbbbf");
  assert.match(csv, /"Nome";"Valor";"Observação"\r\n/);
  assert.ok(csv.includes('"\'=HYPERLINK(""https://exemplo"")"')); assert.ok(csv.includes('"-1.25"')); assert.ok(csv.includes('ação; ganho\nlinha ""2""'));
});
test("sanitização recursiva remove segredos de JSON, células e texto sem remover clientOrderId", () => {
  const json = stableJson({ nested: { apiKey: "SENSITIVE_API_VALUE", cookie: "SENSITIVE_COOKIE", reason: { token: "SENSITIVE_TOKEN", sessionToken: "SENSITIVE_SESSION", csrfToken: "SENSITIVE_CSRF" }, clientOrderId: "COV1-SOL-1-1-BUY-abcdef012345abcdef", details: "api_secret=VERY_SECRET token=ANOTHER_SECRET Bearer PRIVATE_BEARER" }, password: "SENSITIVE_PASSWORD", authorization: "AUTH_VALUE", headers: { random: "SECRET_HEADER" } });
  for (const value of ["SENSITIVE", "VERY_SECRET", "ANOTHER_SECRET", "PRIVATE_BEARER", "AUTH_VALUE", "SECRET_HEADER"]) assert.ok(!json.includes(value));
  assert.ok(json.includes("COV1-SOL-1-1-BUY-abcdef012345abcdef"));
});
test("ZIP íntegro com UTF-8, conteúdo vazio e nome seguro", () => {
  const files = unzip(buildZip([{ name: "RESUMO.md", content: "Auditoria — ação e saúde 🟢" }, { name: "00_RESUMO.csv", content: "\uFEFFAtivo;Lucro\r\nSOL;1.25" }]));
  assert.equal(files.get("RESUMO.md"), "Auditoria — ação e saúde 🟢");
  assert.ok(files.get("00_RESUMO.csv")?.startsWith("\uFEFF"));
  assert.throws(() => buildZip([{ name: "../private", content: "x" }]));
});

test("texto livre com Basic, cookies ou segredo entre aspas não conserva sufixos", () => {
  for (const value of ['Authorization: Basic ZHVtbXk6c2VjcmV0', 'Cookie: sid=DUMMY_SESSION; other=DUMMY_COOKIE', 'password="secret phrase with spaces"', 'api_key=abc; downstream private text']) {
    assert.equal(sanitizeExportValue(value), "[REDACTED]");
    assert.ok(!buildCsv([{ reason: value }], [{ key: "reason", label: "Motivo" }]).includes(value));
  }
  assert.equal(sanitizeExportValue("clientOrderId=COV1-SOL-1-1-BUY-abcdef012345abcdef"), "clientOrderId=COV1-SOL-1-1-BUY-abcdef012345abcdef");
});

const sample: PackagedAudit = { datasets: { summary: [{ environment: "SHADOW", asset: "SOL", symbol: "SOLUSDC", gains: 2, operations: 2, cycles: 1, realized_pnl: .1, capital_start: 250, capital_end: 250.1, missed_levels: 0, errors: 0, health: "WARNING", new_audit_field: "evidência" }], checks: [{ code: "SOURCE_GAP", status: "WARNING", explanation: "Fonte histórica não registrada." }] }, warnings: ["Snapshot atual não é histórico."], incompleteSources: ["cron_history"] };
test("pacote v12 contém contexto de conta/motor e evidência LIVE/ATH/aportes com hashes", () => {
  const packaged = buildReportPackage(sample, filters, now.toISOString(), "abc123");
  const files = unzip(packaged.zip()), manifest = JSON.parse(files.get("manifest.json")!);
  assert.equal(files.size, 26); assert.equal(manifest.report_version, 12); assert.equal(manifest.timezone, "America/Campo_Grande"); assert.equal(manifest.app_commit_sha, "abc123");
  assert.equal(manifest.schema_version, "coinops/robot-v1/reports-v12-strategy-price-invariant"); assert.ok(files.has("16_MISSED_TEMPORAL.csv")); assert.ok(files.has("17_METAS_MENSAIS.csv")); assert.ok(files.has("REGIME_ATH.csv")); assert.ok(files.has("AJUSTES_MANUAIS.csv")); assert.ok(files.has("LIVE_PREPARATION.csv")); assert.ok(files.has("LIVE_EXECUTION.csv")); assert.ok(files.has("APORTES.csv"));
  for (const file of REPORT_FILES) assert.match(files.get(file.name)!, /exchange_account_id.*trading_engine_id.*quote_asset/);
  for (const file of REPORT_FILES) assert.equal(manifest.row_counts[file.name], sample.datasets[file.key]?.length || 0);
  assert.deepEqual([...files.keys()].sort(), manifest.included_files.sort());
  for (const [name, metadata] of Object.entries(manifest.file_metadata) as Array<[string, { bytes: number; sha256: string }]>) { assert.equal(Buffer.byteLength(files.get(name)!), metadata.bytes); assert.equal(sha256(files.get(name)!), metadata.sha256); }
  assert.deepEqual(JSON.parse(files.get("AUDITORIA_COMPLETA.json")!).datasets.summary, sample.datasets.summary);
});

test("Desde Strategy 4.1.0 preserves exact proven UTC boundary despite date-only UI fields", () => {
  const current = new Date("2026-09-23T16:00:00Z");
  const exact = parseReportFilters(new URLSearchParams("preset=strategy4_1&start=2026-08-25&end=2026-09-23"), current);
  assert.equal(exact.start, STRATEGY_4_1_EFFECTIVE_AT); assert.equal(exact.temporalWindow, "SINCE_STRATEGY_4_1");
  const pack = buildReportPackage(sample, exact, current.toISOString());
  assert.equal(pack.manifest.period_start, STRATEGY_4_1_EFFECTIVE_AT); assert.equal(pack.manifest.audit_window, "SINCE_STRATEGY_4_1");
  assert.equal(JSON.parse(pack.files.find((row) => row.name === "AUDITORIA_COMPLETA.json")!.content).strategy_effective_at, STRATEGY_4_1_EFFECTIVE_AT);
  assert.throws(() => parseReportFilters(new URLSearchParams("preset=strategy4_1"), now), /REPORT_STRATEGY_WINDOW_UNAVAILABLE/);
});
test("saída determinística para snapshot idêntico e nova propriedade preservada na exportação", () => {
  const first = buildReportPackage(sample, filters, now.toISOString(), "abc123"), second = buildReportPackage(sample, filters, now.toISOString(), "abc123");
  assert.deepEqual(first.zip(), second.zip());
  assert.ok(first.files.find((file) => file.name === "00_RESUMO.csv")?.content.includes("new_audit_field"));
  assert.ok(first.files.find((file) => file.name === "RESUMO.md")?.content.includes("2 gains"));
  assert.ok(first.files.find((file) => file.name === "RESUMO.md")?.content.includes("cron_history"));
});

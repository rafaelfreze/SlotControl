import { NextResponse } from "next/server";
import { loadRawReportSources, iterateReportCandles } from "@/lib/coinops-reports/source-server";
import { ReportSourceError } from "@/lib/coinops-reports/source-contract";
import { buildAuditReport } from "@/lib/coinops-reports/report-engine";
import { parseReportFilters, reportDates, REPORT_VERSION, REPORT_TIMEZONE } from "@/lib/coinops-reports/filters";
import { buildReportPackage, REPORT_FILES } from "@/lib/coinops-reports/report-package";
import { csvHeader, csvRows, sanitizeExportValue, type ExportColumn } from "@/lib/coinops-reports/export-format";
import { CANDLE_EXPORT_MAX_DAYS } from "@/lib/coinops-reports/candle-export-parts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const preferredRegion = "gru1";
export const maxDuration = 60;
const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache", Vary: "Cookie", "X-Content-Type-Options": "nosniff" };
const downloadHeaders = (name: string, type: string) => ({ ...PRIVATE_HEADERS, "Content-Type": type, "Content-Disposition": `attachment; filename="${name}"` });
const CANDLE_COLUMNS: ExportColumn[] = ["symbol", "candle_open_at", "candle_close_at", "open_price", "high_price", "low_price", "close_price", "source", "created_at"].map((key) => ({ key, label: key }));

/** Read-only reporting endpoint. No exchange adapter or execution service is imported. */
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams, format = params.get("format") || "preview";
    if (!["preview", "zip", "csv", "json", "markdown", "candles"].includes(format)) throw new Error("REPORT_FORMAT_INVALID");
    const filters = parseReportFilters(params);
    const requestedFile = params.get("file");
    const allowedFiles: string[] = REPORT_FILES.map((file) => file.name);
    if (format === "csv" && (!requestedFile || !allowedFiles.includes(requestedFile))) throw new Error("REPORT_FILE_INVALID");
    if (format === "candles") {
      if (Date.parse(filters.end) - Date.parse(filters.start) > CANDLE_EXPORT_MAX_DAYS * 86_400_000) throw new Error("REPORT_CANDLES_CHUNK_REQUIRED");
      const iterator = iterateReportCandles(filters);
      // Authenticate and query before sending headers; auth failures never become downloads.
      const first = await iterator.next();
      const encoder = new TextEncoder();
      let sentFirst = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(encoder.encode(csvHeader(CANDLE_COLUMNS))); },
        async pull(controller) {
          try {
            const page = sentFirst ? await iterator.next() : first; sentFirst = true;
            if (page.done) { controller.close(); return; }
            controller.enqueue(encoder.encode(csvRows(page.value.map((row) => ({ ...row, source: "BINANCE_PRODUCTION_MARKET_DATA_SHADOW" })), CANDLE_COLUMNS)));
          } catch { controller.error(new Error("COINOPS_REPORT_CANDLES_INCOMPLETE")); await iterator.return(undefined); }
        },
        async cancel() { await iterator.return(undefined); }
      });
      const dates = reportDates(filters);
      return new Response(stream, { headers: downloadHeaders(`coinops-candles-1m-${dates.start}_${dates.end}.csv`, "text/csv; charset=utf-8") });
    }
    const source = await loadRawReportSources(filters);
    const report = buildAuditReport(source, filters);
    const packaged = buildReportPackage(report, filters, source.generatedAt, process.env.VERCEL_GIT_COMMIT_SHA || null);
    if (format === "preview") {
      return NextResponse.json(sanitizeExportValue({ reportVersion: REPORT_VERSION, timezone: REPORT_TIMEZONE, generatedAt: source.generatedAt, filters, summaries: report.datasets.summary, checks: report.datasets.checks, warnings: report.warnings, incompleteSources: report.incompleteSources, rowCounts: packaged.manifest.row_counts, files: packaged.files.map((file) => ({ name: file.name, bytes: Buffer.byteLength(file.content), rows: packaged.manifest.row_counts[file.name] ?? null, description: REPORT_FILES.find((definition) => definition.name === file.name)?.description || file.name })), safety: { production: "READ_ONLY", live: "BLOCKED", writes: 0 } }), { headers: PRIVATE_HEADERS });
    }
    if (format === "zip") return new Response(packaged.zip() as BodyInit, { headers: downloadHeaders(packaged.filename, "application/zip") });
    const name = format === "json" ? (requestedFile === "manifest.json" ? "manifest.json" : "AUDITORIA_COMPLETA.json") : format === "markdown" ? "RESUMO.md" : requestedFile!;
    const file = packaged.files.find((item) => item.name === name);
    if (!file) throw new Error("REPORT_FILE_INVALID");
    return new Response(file.content, { headers: downloadHeaders(file.name, format === "json" ? "application/json; charset=utf-8" : format === "markdown" ? "text/markdown; charset=utf-8" : "text/csv; charset=utf-8") });
  } catch (error) {
    const code = error instanceof Error && /^(COINOPS_REPORT_[A-Z_]+(?::[a-z0-9_]+)?|REPORT_[A-Z_]+)$/.test(error.message) ? error.message : "COINOPS_REPORT_UNAVAILABLE";
    const status = error instanceof ReportSourceError ? error.status : code.startsWith("REPORT_") ? 400 : 503;
    return NextResponse.json({ error: code, message: status === 401 ? "Entre novamente para exportar seus relatórios." : status === 403 ? "Você não tem acesso a este escopo de relatório." : code === "REPORT_CANDLES_CHUNK_REQUIRED" ? "Baixe os candles completos em partes de até 7 dias na aba Exportações. Todas as partes do período ficam disponíveis." : status === 400 ? "Revise período, ativo, ambiente e arquivo (máximo 366 dias)." : "Não foi possível carregar o relatório. Tente novamente; nenhuma operação foi executada." }, { status, headers: PRIVATE_HEADERS });
  }
}

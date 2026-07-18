"use client";

import { useMemo, useState } from "react";

import { AppHeader, FilterChips, MobileScreen, SectionCard } from "@/components/app/mobile-ui";
import { formatDate } from "@/lib/slotgain/format";
import type { HistoryEvent } from "@/lib/slotgain/types";

type AssetFilter = "ALL" | "BTC" | "SOL";
type ActionFilter = "all" | "abertura" | "gain" | "zerar";

type ParsedHistory = {
  message: string;
  asset: string;
  eventType: string;
  origin: string;
  expectedPrice: number | null;
  executedPrice: number | null;
  currentPrice: number | null;
  targetPrice: number | null;
  valueBefore: number | null;
  valueAfter: number | null;
  slotValue: number | null;
  gains: number | null;
  statusBefore: string | null;
  statusAfter: string | null;
  realizedProfit: number | null;
  note: string | null;
};

type ExportRow = {
  "ID Evento": string;
  "User ID": string;
  "Created At": string;
  Data: string;
  Ativo: string;
  Slot: string;
  Evento: string;
  "Evento Padronizado": string;
  Origem: string;
  "Preco de Entrada": string;
  "Preco Executado": string;
  "Preco Atual": string;
  "Preco Alvo": string;
  "Valor Antes": string;
  "Valor Depois": string;
  "Valor do Slot": string;
  "Gains do Slot": string;
  "Status Antes": string;
  "Status Depois": string;
  "Lucro Realizado": string;
  Observacao: string;
};

function parseLooseNumber(value: string | undefined) {
  if (!value) return null;
  const normalized = value.replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function extractLegacyNumbers(text: string) {
  return {
    targetPrice: parseLooseNumber(text.match(/(?:alvo|preco alvo|preço alvo)[:\s]+([\d.,]+)/i)?.[1]),
    currentPrice: parseLooseNumber(text.match(/(?:preco atual|preço atual|atual)[:\s]+([\d.,]+)/i)?.[1]),
    valueBefore: parseLooseNumber(text.match(/valor antes[:\s]+([\d.,]+)/i)?.[1]),
    valueAfter: parseLooseNumber(text.match(/valor depois[:\s]+([\d.,]+)/i)?.[1])
  };
}

function normalizeEventType(action: string, eventType: string) {
  const value = `${action} ${eventType}`.toLowerCase();
  if (value.includes("auto_gain") || value.includes("saida_automatica")) return "GAIN_AUTOMATICO";
  if (value.includes("gain")) return "GAIN_MANUAL";
  if (value.includes("entrada_automatica")) return "ABERTURA_AUTOMATICA";
  if (value.includes("abertura") || value.includes("entrada")) return "ABERTURA_MANUAL";
  if (value.includes("marcacao")) return "MARCACAO_MERCADO";
  if (value.includes("editar") || value.includes("edicao")) return "EDICAO";
  if (value.includes("zerar")) return "ZERAGEM";
  if (value.includes("estrategia")) return "ESTRATEGIA";
  return eventType || action;
}

function inferOrigin(action: string, eventType: string, origin?: string | null) {
  if (origin) return origin;
  const value = `${action} ${eventType}`.toLowerCase();
  if (value.includes("auto") || value.includes("cron")) return "AUTO_GAIN";
  if (value.includes("estrategia") || value.includes("automacao")) return "SISTEMA";
  return "MANUAL";
}

function parseHistoryDetail(item: HistoryEvent): ParsedHistory {
  try {
    const parsed = JSON.parse(item.detail) as Partial<ParsedHistory>;
    const legacy = extractLegacyNumbers(item.detail);
    const valueBefore = parsed.valueBefore ?? legacy.valueBefore ?? null;
    const valueAfter = parsed.valueAfter ?? legacy.valueAfter ?? null;
    return {
      message: String(parsed.message || item.detail || "Registro criado no Supabase."),
      asset: String(parsed.asset || item.strategy?.asset || item.strategy_key || "").toUpperCase(),
      eventType: String(parsed.eventType || item.action),
      origin: inferOrigin(item.action, String(parsed.eventType || item.action), parsed.origin),
      expectedPrice: parsed.expectedPrice ?? null,
      executedPrice: parsed.executedPrice ?? null,
      currentPrice: parsed.currentPrice ?? legacy.currentPrice ?? null,
      targetPrice: parsed.targetPrice ?? legacy.targetPrice ?? null,
      valueBefore,
      valueAfter,
      slotValue: parsed.slotValue ?? valueAfter ?? valueBefore ?? null,
      gains: parsed.gains ?? null,
      statusBefore: parsed.statusBefore ?? null,
      statusAfter: parsed.statusAfter ?? null,
      realizedProfit: parsed.realizedProfit ?? (valueBefore !== null && valueAfter !== null ? valueAfter - valueBefore : null),
      note: parsed.note ?? null
    };
  } catch {
    const legacy = extractLegacyNumbers(item.detail || "");
    const realizedProfit = legacy.valueBefore !== null && legacy.valueAfter !== null ? legacy.valueAfter - legacy.valueBefore : null;
    return {
      message: item.detail || "Registro criado no Supabase.",
      asset: String(item.strategy?.asset || item.strategy_key || "").toUpperCase(),
      eventType: item.action,
      origin: inferOrigin(item.action, item.action),
      expectedPrice: null,
      executedPrice: legacy.currentPrice,
      currentPrice: legacy.currentPrice,
      targetPrice: legacy.targetPrice,
      valueBefore: legacy.valueBefore,
      valueAfter: legacy.valueAfter,
      slotValue: legacy.valueAfter ?? legacy.valueBefore,
      gains: null,
      statusBefore: null,
      statusAfter: null,
      realizedProfit,
      note: item.detail || null
    };
  }
}

function formatExportDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("pt-BR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

function numberCell(value: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? String(value).replace(".", ",") : "";
}

function toExportRows(history: HistoryEvent[]): ExportRow[] {
  return history.map((item) => {
    const parsed = parseHistoryDetail(item);

    return {
      "ID Evento": item.id,
      "User ID": item.user_id || "",
      "Created At": item.created_at ? formatExportDate(item.created_at) : "",
      Data: formatExportDate(item.event_at),
      Ativo: parsed.asset || "-",
      Slot: item.slot_number ? String(item.slot_number) : "",
      Evento: parsed.eventType || item.action,
      "Evento Padronizado": normalizeEventType(item.action, parsed.eventType),
      Origem: parsed.origin,
      "Preco de Entrada": numberCell(parsed.expectedPrice),
      "Preco Executado": numberCell(parsed.executedPrice),
      "Preco Atual": numberCell(parsed.currentPrice),
      "Preco Alvo": numberCell(parsed.targetPrice),
      "Valor Antes": numberCell(parsed.valueBefore),
      "Valor Depois": numberCell(parsed.valueAfter),
      "Valor do Slot": numberCell(parsed.slotValue),
      "Gains do Slot": parsed.gains === null ? "" : String(parsed.gains),
      "Status Antes": parsed.statusBefore || "",
      "Status Depois": parsed.statusAfter || "",
      "Lucro Realizado": numberCell(parsed.realizedProfit),
      Observacao: parsed.note || parsed.message
    };
  });
}

function csvEscape(value: string) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function downloadBlob(fileName: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function downloadCsv(fileName: string, rows: Array<Record<string, string>>) {
  const headers = Object.keys(rows[0] || { Aviso: "Sem dados" });
  const body = rows.length ? rows : [{ Aviso: "Sem dados" }];
  const csv = [headers.join(";"), ...body.map((row) => headers.map((header) => csvEscape(row[header] || "")).join(";"))].join("\n");
  downloadBlob(fileName, `\uFEFF${csv}`, "text/csv;charset=utf-8");
}

function downloadExcelCsv(fileName: string, rows: Array<Record<string, string>>) {
  downloadCsv(fileName, rows);
}

function getMonthKey(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Sem data";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function toMonthlySummary(history: HistoryEvent[]) {
  const buckets = new Map<
    string,
    {
      month: string;
      asset: string;
      entries: number;
      gains: number;
      profit: number;
      slots: Set<string>;
      slotProfit: Map<string, number>;
    }
  >();

  history.forEach((item) => {
    const parsed = parseHistoryDetail(item);
    const asset = parsed.asset || "-";
    const key = `${getMonthKey(item.event_at)}-${asset}`;
    const current =
      buckets.get(key) ||
      {
        month: getMonthKey(item.event_at),
        asset,
        entries: 0,
        gains: 0,
        profit: 0,
        slots: new Set<string>(),
        slotProfit: new Map<string, number>()
      };
    const eventType = parsed.eventType.toLowerCase();
    const slot = item.slot_number ? String(item.slot_number) : "";
    const profit = Number(parsed.realizedProfit || 0);

    if (eventType.includes("entrada") || eventType.includes("abertura")) {
      current.entries += 1;
    }
    if (eventType.includes("gain") || eventType.includes("saida")) {
      current.gains += 1;
    }
    if (slot) {
      current.slots.add(slot);
      current.slotProfit.set(slot, Number(current.slotProfit.get(slot) || 0) + profit);
    }
    current.profit += profit;
    buckets.set(key, current);
  });

  return Array.from(buckets.values()).map((bucket) => {
    const slotRanking = Array.from(bucket.slotProfit.entries()).sort((first, second) => second[1] - first[1]);

    return {
      Mes: bucket.month,
      Ativo: bucket.asset,
      "Total de Entradas": String(bucket.entries),
      "Total de Gains": String(bucket.gains),
      "Lucro Realizado": String(bucket.profit),
      "Quantidade de Slots Usados": String(bucket.slots.size),
      "Melhor Slot": slotRanking[0]?.[0] || "",
      "Pior Slot": slotRanking.at(-1)?.[0] || ""
    };
  });
}

function toSlotSummary(history: HistoryEvent[]) {
  const rows = new Map<string, Record<string, string>>();

  history.forEach((item) => {
    const parsed = parseHistoryDetail(item);
    const asset = parsed.asset || "-";
    const slot = item.slot_number ? String(item.slot_number) : "";
    if (!slot) return;
    const key = `${asset}-${slot}`;
    const current = rows.get(key) || {
      Ativo: asset,
      Slot: slot,
      "Total de Entradas": "0",
      "Total de Gains": "0",
      "Lucro Total": "0",
      "Ultima Entrada": "",
      "Ultimo Gain": "",
      "Status Atual": ""
    };
    const eventType = parsed.eventType.toLowerCase();

    if (eventType.includes("entrada") || eventType.includes("abertura")) {
      current["Total de Entradas"] = String(Number(current["Total de Entradas"]) + 1);
      current["Ultima Entrada"] = formatExportDate(item.event_at);
    }
    if (eventType.includes("gain") || eventType.includes("saida")) {
      current["Total de Gains"] = String(Number(current["Total de Gains"]) + 1);
      current["Ultimo Gain"] = formatExportDate(item.event_at);
    }
    current["Lucro Total"] = String(Number(current["Lucro Total"] || 0) + Number(parsed.realizedProfit || 0));
    current["Status Atual"] = parsed.statusAfter || current["Status Atual"];
    rows.set(key, current);
  });

  return Array.from(rows.values());
}

export function HistoricoClient({ userEmail, history, error }: { userEmail: string; history: HistoryEvent[]; error: string | null }) {
  const [asset, setAsset] = useState<AssetFilter>("ALL");
  const [action, setAction] = useState<ActionFilter>("all");

  const filtered = useMemo(
    () =>
      history.filter((item) => {
        const key = (item.strategy?.asset || item.strategy_key || "").toUpperCase();
        const actionKey = item.action.toLowerCase();
        if (actionKey.includes("redistribu")) {
          return false;
        }
        const assetOk = asset === "ALL" || key === asset;
        const actionOk =
          action === "all" ||
          (action === "abertura" && (actionKey.includes("abertura") || actionKey.includes("entrada"))) ||
          (action === "gain" && (actionKey.includes("gain") || actionKey.includes("saida"))) ||
          (action === "zerar" && actionKey.includes("zerar"));
        return assetOk && actionOk;
      }),
    [asset, action, history]
  );

  return (
    <MobileScreen>
      <AppHeader title="Historico" backHref="/dashboard" />
      {error ? <section className="inline-alert dashboard-alert">Falha ao carregar historico: {error}</section> : null}
      <FilterChips
        value={asset}
        onChange={setAsset}
        options={[
          { label: "BTC", value: "BTC", count: history.filter((item) => (item.strategy?.asset || item.strategy_key)?.toUpperCase() === "BTC").length },
          { label: "SOL", value: "SOL", count: history.filter((item) => (item.strategy?.asset || item.strategy_key)?.toUpperCase() === "SOL").length },
          { label: "Todos", value: "ALL", count: history.length }
        ]}
      />
      <FilterChips
        value={action}
        onChange={setAction}
        options={[
          { label: "Abertura", value: "abertura" },
          { label: "Gain", value: "gain" },
          { label: "Zeragem", value: "zerar" },
          { label: "Todos", value: "all" }
        ]}
      />
      <SectionCard title="Exportacao" subtitle="CSV e Excel" tone="green">
        <div className="export-actions-grid">
          <button type="button" className="ghost-button compact-action" onClick={() => downloadCsv("historico-completo.csv", toExportRows(history))}>
            CSV completo
          </button>
          <button type="button" className="ghost-button compact-action" onClick={() => downloadExcelCsv("historico-completo-excel.csv", toExportRows(history))}>
            Excel CSV completo
          </button>
          <button type="button" className="ghost-button compact-action" onClick={() => downloadCsv("historico-btc.csv", toExportRows(history.filter((item) => parseHistoryDetail(item).asset === "BTC")))}>
            CSV BTC
          </button>
          <button type="button" className="ghost-button compact-action" onClick={() => downloadExcelCsv("historico-btc-excel.csv", toExportRows(history.filter((item) => parseHistoryDetail(item).asset === "BTC")))}>
            Excel CSV BTC
          </button>
          <button type="button" className="ghost-button compact-action" onClick={() => downloadCsv("historico-sol.csv", toExportRows(history.filter((item) => parseHistoryDetail(item).asset === "SOL")))}>
            CSV SOL
          </button>
          <button type="button" className="ghost-button compact-action" onClick={() => downloadExcelCsv("historico-sol-excel.csv", toExportRows(history.filter((item) => parseHistoryDetail(item).asset === "SOL")))}>
            Excel CSV SOL
          </button>
          <button type="button" className="ghost-button compact-action" onClick={() => downloadCsv("resumo-mensal.csv", toMonthlySummary(history))}>
            CSV mensal
          </button>
          <button type="button" className="ghost-button compact-action" onClick={() => downloadExcelCsv("resumo-mensal-excel.csv", toMonthlySummary(history))}>
            Excel CSV mensal
          </button>
          <button type="button" className="ghost-button compact-action" onClick={() => downloadCsv("resumo-por-slot.csv", toSlotSummary(history))}>
            CSV slots
          </button>
          <button type="button" className="ghost-button compact-action" onClick={() => downloadExcelCsv("resumo-por-slot-excel.csv", toSlotSummary(history))}>
            Excel CSV slots
          </button>
        </div>
      </SectionCard>
      <SectionCard title="Operacoes" subtitle={`${filtered.length} eventos`} tone="blue">
        <div className="timeline-list">
          {filtered.map((item) => {
            const parsed = parseHistoryDetail(item);
            const itemAsset = (parsed.asset || item.strategy?.asset || item.strategy_key || "SG").toUpperCase();
            return (
              <article key={item.id} className={`timeline-item ${itemAsset === "SOL" ? "purple" : "gold"}`}>
                <span>{itemAsset}</span>
                <div>
                  <strong>{item.action}</strong>
                  <p>{parsed.message}</p>
                  <small>
                    {formatDate(item.event_at)}
                    {item.slot_number ? ` | Slot #${item.slot_number}` : ""}
                  </small>
                </div>
              </article>
            );
          })}
          {filtered.length === 0 ? <p className="empty-copy padded-empty">Nenhum evento neste filtro.</p> : null}
        </div>
      </SectionCard>
    </MobileScreen>
  );
}

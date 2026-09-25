"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { allocateBulkSlots, splitBulkEngines } from "@/lib/execution/live-adjustment-plans";
import "./live-adjustments-center.css";

type Account = { id: string; display_name: string; is_legacy_default: boolean };
type Engine = { id: string; exchange_account_id: string; symbol: string; quote_asset: "BRL" | "USDT";
  base_asset: "BTC" | "SOL"; status: string; hard_cap_quote: number | string };
type Slot = { trading_engine_id: string; slot_number: number; entry_state: string; position_committed_brl: number | string };
type SlotAccount = { trading_engine_id: string; slot_number: number; balance_quote: number | string;
  contribution_quote: number | string; market_pnl_quote: number | string; fees_quote: number | string };
type Total = { trading_engine_id: string; slot_number: number; lifetime_gain_count: number; monthly_gain_count: number };
type Batch = { id: string; exchange_account_id: string; kind: string; quote_asset: string;
  origin_currency: string; origin_amount: number | string; amount_quote: number | string;
  reason: string; reversal_of: string | null; created_at: string };
type Plan = { id: string; exchange_account_id: string; quote_asset: string; revision: number;
  status: "ACTIVE" | "DISABLED"; origin_currency: "BRL" | "USDT";
  monthly_amount_origin: number | string; btc_percent: number; sol_percent: number;
  start_month: string; horizon_months: number; reason: string; created_at: string };
type Status = { accounts: Account[]; engines: Engine[]; slots: Slot[];
  slotAccounts: SlotAccount[]; totals: Total[]; batches: Batch[]; plans: Plan[] };
type Preview = { previewHash: string; account: string; quote: string; amount: number;
  origin: number; originCurrency: string; free: number; exposure: number;
  availableForNewCapital: number; accountCap: number; afterCap: number;
  outsideCoinOps: number; observedAt: string; executorIp: string;
  fxReference?: { referenceRate: number; effectiveRate: number; observedAt: string; source: string } | null;
  openCount: number; pendingForNextOperation: number;
  allocations: Array<{ engineId: string; slotNumber: number; amount: number; gainUnits: number;
    balanceBefore: number; balanceAfter: number; monthlyBefore: number; monthlyAfter: number;
    lifetimeBefore: number; lifetimeAfter: number; open: boolean; target: number }> };
type Draft = { action: string; kind?: string; accountId: string; quote: "BRL" | "USDT";
  engineId?: string; slotNumber?: number; gainUnits?: number; amount?: number;
  shares?: Array<{ engineId: string; amount: number }>; originCurrency?: "BRL" | "USDT";
  originAmount?: number; fxObservedAt?: string; evidence?: string; reason: string;
  requestId: string; previewHash?: string; originalId?: string; monthlyAmount?: number;
  btcPercent?: number; startMonth?: string; horizonMonths?: number };

function format(value: number | string | undefined, quote: string) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `${new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2,
    maximumFractionDigits: 2 }).format(amount)} ${quote}` : "—";
}

function nextPlanMonth(plan: Plan, now = new Date()) {
  if (plan.status !== "ACTIVE") return "—";
  const start = new Date(`${plan.start_month.slice(0, 7)}-01T00:00:00Z`);
  if (!Number.isFinite(start.getTime())) return "—";
  for (let index = 0; index < plan.horizon_months; index++) {
    const candidate = new Date(start); candidate.setUTCMonth(start.getUTCMonth() + index);
    if (candidate.getTime() > now.getTime()) return candidate.toISOString().slice(0, 10);
  }
  return "Horizonte encerrado";
}

async function control(input: Draft) {
  const response = await fetch("/api/coinops-live-adjustments", { method: "POST", credentials: "same-origin",
    cache: "no-store", headers: { "content-type": "application/json",
      "x-coinops-admin-intent": "live-adjustment" }, body: JSON.stringify(input) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "COINOPS_ADJUSTMENT_FAILED");
  return result;
}

export function LiveAdjustmentsCenter({ active, initialAccountId = "ALL", initialSymbol = "ALL" }:
  { active: boolean; initialAccountId?: string; initialSymbol?: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [accountId, setAccountId] = useState(initialAccountId === "ALL" ? "" : initialAccountId);
  const [quote, setQuote] = useState<"BRL" | "USDT">("BRL");
  const [kind, setKind] = useState<"MANUAL_GAIN" | "SLOT_CAPITAL" | "BULK_CAPITAL">("MANUAL_GAIN");
  const [engineId, setEngineId] = useState("");
  const [slotNumber, setSlotNumber] = useState(1);
  const [gainUnits, setGainUnits] = useState(1);
  const [amountText, setAmountText] = useState("");
  const [originCurrency, setOriginCurrency] = useState<"BRL" | "USDT">("BRL");
  const [originText, setOriginText] = useState("");
  const [evidence, setEvidence] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [distribution, setDistribution] = useState<"EQUAL" | "PERCENT" | "ABSOLUTE">("EQUAL");
  const [firstPercent, setFirstPercent] = useState(50);
  const [firstAmountText, setFirstAmountText] = useState("");
  const [reason, setReason] = useState("");
  const [planAmount, setPlanAmount] = useState("");
  const [planOrigin, setPlanOrigin] = useState<"BRL" | "USDT">("BRL");
  const [planBtc, setPlanBtc] = useState(50);
  const [planStart, setPlanStart] = useState(() => {
    const date = new Date(); date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + 1);
    return date.toISOString().slice(0, 7);
  });
  const [planMonths, setPlanMonths] = useState(24);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewDraft, setPreviewDraft] = useState<Draft | null>(null);
  const [reverse, setReverse] = useState<{ originalId: string; draft: Draft; previewHash: string;
    after: Array<{ engineId: string; slotNumber: number; delta: number; gainUnits: number }> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    const response = await fetch("/api/coinops-live-adjustments", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "COINOPS_ADJUSTMENT_STATUS_UNAVAILABLE");
    setStatus(data);
    const nextAccount = accountId || data.accounts?.[0]?.id;
    if (!accountId && nextAccount) setAccountId(nextAccount);
    const matchingEngines = (data.engines as Engine[]).filter((item) => item.exchange_account_id === nextAccount && item.status === "ACTIVE");
    const initialEngine = matchingEngines.find((item) => item.symbol === initialSymbol) ?? matchingEngines[0];
    if (initialEngine && !matchingEngines.some((item) => item.quote_asset === quote)) {
      setQuote(initialEngine.quote_asset);
      setOriginCurrency(initialEngine.quote_asset);
    }
    if (initialEngine && !engineId) setEngineId(initialEngine.id);
  }, [accountId, engineId, initialSymbol, quote]);
  useEffect(() => { if (active && !status) refresh().catch((cause) => setError(cause.message)); }, [active, status, refresh]);

  const account = status?.accounts.find((item) => item.id === accountId);
  const accountEngines = useMemo(() => (status?.engines ?? [])
    .filter((item) => item.exchange_account_id === accountId && item.status === "ACTIVE"), [status, accountId]);
  const quotes = [...new Set(accountEngines.map((item) => item.quote_asset))];
  const inQuote = accountEngines.filter((item) => item.quote_asset === quote);
  const selectedEngines = inQuote.filter((item) => selected.includes(item.id));
  const selectedSlot = status?.slots.find((item) => item.trading_engine_id === engineId
    && item.slot_number === slotNumber);
  const selectedAccount = status?.slotAccounts.find((item) => item.trading_engine_id === engineId
    && item.slot_number === slotNumber);
  const selectedTotal = status?.totals.find((item) => item.trading_engine_id === engineId
    && item.slot_number === slotNumber);
  const amount = Number(amountText.replace(",", "."));
  const firstAmount = Number(firstAmountText.replace(",", "."));
  const latestPlan = status?.plans.find((item) => item.exchange_account_id === accountId && item.quote_asset === quote);
  const currentMonth = new Date().toISOString().slice(0, 7);
  const realizedThisMonth = (status?.batches ?? []).filter((item) => item.exchange_account_id === accountId
    && item.quote_asset === quote && item.origin_currency === (latestPlan?.origin_currency ?? planOrigin)
    && ["CAPITAL", "REVERSAL"].includes(item.kind) && item.created_at.slice(0, 7) === currentMonth)
    .reduce((sum, item) => sum + Number(item.origin_amount), 0);
  const accountEngineIds = new Set(inQuote.map((item) => item.id));
  const scopedSlotAccounts = (status?.slotAccounts ?? []).filter((item) => accountEngineIds.has(item.trading_engine_id));
  const externalContributions = (status?.batches ?? []).filter((item) => item.exchange_account_id === accountId
    && item.quote_asset === quote && ["CAPITAL", "REVERSAL"].includes(item.kind))
    .reduce((sum, item) => sum + Number(item.amount_quote), 0);
  const marketResult = scopedSlotAccounts.reduce((sum, item) => sum + Number(item.market_pnl_quote) - Number(item.fees_quote), 0);
  const operationalBalance = scopedSlotAccounts.reduce((sum, item) => sum + Number(item.balance_quote), 0);

  function invalidate() { setPreview(null); setPreviewDraft(null); setReverse(null); setError(""); setNotice(""); setRequestId(crypto.randomUUID()); }
  function chooseAccount(value: string) {
    setAccountId(value);
    const nextQuote = status?.engines.find((item) => item.exchange_account_id === value)?.quote_asset ?? "BRL";
    setQuote(nextQuote); setOriginCurrency(nextQuote);
    setEngineId(status?.engines.find((item) => item.exchange_account_id === value)?.id ?? "");
    setSelected([]); invalidate();
  }
  function chooseQuote(value: "BRL" | "USDT") {
    setQuote(value); setOriginCurrency(value);
    setEngineId(accountEngines.find((item) => item.quote_asset === value)?.id ?? "");
    setSelected([]); invalidate();
  }
  function shares() {
    const ids = selectedEngines.map((item) => item.id);
    if (distribution === "ABSOLUTE" && ids.length === 2) {
      const total = Math.round(amount * 100), first = Math.round(firstAmount * 100);
      if (!Number.isSafeInteger(first) || first < 25 || total - first < 25)
        throw new Error("COINOPS_ADJUSTMENT_DISTRIBUTION_INVALID");
      return [{ engineId: ids[0], amount: first / 100 },
        { engineId: ids[1], amount: (total - first) / 100 }];
    }
    return splitBulkEngines(amount, ids, distribution === "EQUAL" ? 50 : firstPercent);
  }
  function draft(): Draft {
    if (!account || !quotes.includes(quote)) throw new Error("Selecione conta e moeda específicas.");
    if (account.is_legacy_default && kind !== "MANUAL_GAIN")
      throw new Error("O limite fixo de Rafael não permite capital adicional sem autorização separada.");
    const base: Draft = { action: "PREVIEW", kind: kind === "MANUAL_GAIN" ? "MANUAL_GAIN" : "CAPITAL",
      accountId, quote, originCurrency: kind === "MANUAL_GAIN" ? quote : originCurrency,
      reason: reason.trim(), requestId };
    if (kind === "MANUAL_GAIN") return { ...base, engineId, slotNumber, gainUnits };
    const currencyDetails = originCurrency === quote ? {} : {
      originAmount: Number(originText.replace(",", ".")), evidence: evidence.trim(),
      fxObservedAt: new Date().toISOString(),
    };
    return kind === "SLOT_CAPITAL"
      ? { ...base, engineId, slotNumber, amount, ...currencyDetails }
      : { ...base, amount, shares: shares(), ...currencyDetails };
  }
  async function makePreview() {
    try { setBusy(true); setError(""); setNotice(""); setReverse(null);
      const next = draft();
      if (next.shares) allocateBulkSlots(next.amount!, next.shares);
      const result = await control(next) as Preview;
      setPreview(result); setPreviewDraft(next);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha no preview."); }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (!preview || !previewDraft) return;
    if (!window.confirm(previewDraft.kind === "CAPITAL"
      ? `Registrar ${format(preview.amount, quote)} como capital externo da conta ${account?.display_name}? Nenhuma ordem ou posição OPEN será alterada.`
      : `Adicionar ${gainUnits} gain(s) manual(is) ao slot #${slotNumber} de ${account?.display_name}?`)) return;
    try { setBusy(true); setError("");
      const saved = await control({ ...previewDraft, action: "CONFIRM", previewHash: preview.previewHash });
      setNotice(saved.status === "REPLAYED" ? "Ajuste já aplicado; nenhuma duplicação." : "Ajuste registrado e auditado.");
      setPreview(null); setPreviewDraft(null); setRequestId(crypto.randomUUID());
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao registrar ajuste."); }
    finally { setBusy(false); }
  }
  async function previewReversal(batch: Batch) {
    try { setBusy(true); setError(""); setPreview(null);
      const next: Draft = { action: "REVERSE_PREVIEW", accountId, quote: batch.quote_asset as "BRL" | "USDT",
        reason: reason.trim(), requestId: crypto.randomUUID(), originalId: batch.id };
      const result = await control(next);
      setReverse({ originalId: batch.id, draft: next, previewHash: result.previewHash, after: result.after });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Estorno indisponível."); }
    finally { setBusy(false); }
  }
  async function confirmReversal() {
    if (!reverse || !window.confirm("Estornar este ajuste somente se todo o capital/gain continuar reversível? Nenhuma ordem será cancelada.")) return;
    try { setBusy(true); setError("");
      const result = await control({ ...reverse.draft, action: "REVERSE_CONFIRM", previewHash: reverse.previewHash });
      setNotice(result.status === "REPLAYED" ? "Estorno já registrado." : "Estorno auditável registrado.");
      setReverse(null); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha no estorno."); }
    finally { setBusy(false); }
  }
  async function savePlan(disable: boolean) {
    const source = disable ? latestPlan : null;
    const input: Draft = { action: disable ? "PLAN_DISABLE" : "PLAN_SAVE", accountId, quote,
      originCurrency: source?.origin_currency ?? planOrigin,
      monthlyAmount: source ? Number(source.monthly_amount_origin) : Number(planAmount.replace(",", ".")),
      btcPercent: source?.btc_percent ?? planBtc,
      startMonth: source?.start_month ?? `${planStart}-01`,
      horizonMonths: source?.horizon_months ?? planMonths,
      reason: reason.trim(), requestId: crypto.randomUUID() };
    if (!window.confirm(disable ? "Desativar somente o plano futuro? Aportes passados permanecem auditáveis."
      : "Salvar plano mensal? Isto não transfere dinheiro nem cria aportes futuros no ledger.")) return;
    try { setBusy(true); setError("");
      await control(input);
      setNotice(disable ? "Plano desativado sem movimentação." : "Plano salvo. Nenhum aporte foi executado.");
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha no plano."); }
    finally { setBusy(false); }
  }

  return <section className="lac-center" aria-label="Ajustes LIVE por conta e motor">
    <header><h3>Ajustes · capital e gains</h3><p>Real · Binance Spot. Conta, moeda, motor e slot são obrigatórios. Preview não cria ordens.</p></header>
    {error ? <p className="lac-error" role="alert">{error}</p> : null}
    {notice ? <p className="lac-notice" role="status">{notice}</p> : null}
    {!status ? <p role="status">Carregando contas e ledger…</p> : <>
      <div className="lac-kpis"><span>Capital externo registrado<strong>{format(externalContributions, quote)}</strong></span>
        <span>Resultado líquido de mercado<strong>{format(marketResult, quote)}</strong></span>
        <span>Saldo operacional nos slots<strong>{format(operationalBalance, quote)}</strong></span></div>
      <div className="lac-grid"><label>Conta<select value={accountId} onChange={(event) => chooseAccount(event.target.value)}>
        <option value="">Selecione</option>{status.accounts.map((item) => <option value={item.id} key={item.id}>{item.display_name}</option>)}</select></label>
      <label>Moeda do motor<select value={quote} onChange={(event) => chooseQuote(event.target.value as "BRL" | "USDT")}>
        {quotes.map((item) => <option value={item} key={item}>{item}</option>)}</select></label></div>
      <div className="lac-mode" role="group" aria-label="Tipo de ajuste">
        {([['MANUAL_GAIN','Adicionar gain'],['SLOT_CAPITAL','Adicionar saldo'],['BULK_CAPITAL','Aporte em massa']] as const).map(([key,label]) =>
          <button type="button" key={key} aria-pressed={kind === key} onClick={() => { setKind(key); invalidate(); }}>{label}</button>)}</div>
      {kind !== "BULK_CAPITAL" ? <div className="lac-grid">
        <label>Motor<select value={engineId} onChange={(event) => { setEngineId(event.target.value); invalidate(); }}>
          <option value="">Selecione</option>{inQuote.map((item) => <option value={item.id} key={item.id}>{item.symbol}</option>)}</select></label>
        <label>Slot físico<select value={slotNumber} onChange={(event) => { setSlotNumber(Number(event.target.value)); invalidate(); }}>
          {Array.from({ length: 25 }, (_, index) => <option value={index + 1} key={index}>Slot #{index + 1}</option>)}</select></label>
      </div> : <fieldset className="lac-engines"><legend>Motores que receberão o aporte</legend>
        {inQuote.map((item) => <label key={item.id}><input type="checkbox" checked={selected.includes(item.id)}
          onChange={(event) => { setSelected(event.target.checked ? [...selected,item.id] : selected.filter((id) => id !== item.id)); invalidate(); }} />{item.symbol} · limite {format(item.hard_cap_quote, quote)}</label>)}
      </fieldset>}
      {kind === "MANUAL_GAIN" ? <div className="lac-grid"><label>Quantidade de gains<input type="number" min={1} max={25}
        value={gainUnits} onChange={(event) => { setGainUnits(Number(event.target.value)); invalidate(); }} /></label>
        <p className="lac-slot-note">{selectedSlot ? `${selectedSlot.entry_state} · saldo ${format(selectedAccount?.balance_quote, quote)} · ${selectedTotal?.monthly_gain_count ?? 0} no mês · ${selectedTotal?.lifetime_gain_count ?? 0} totais` : "Escolha o motor e o slot."}</p></div>
        : <><div className="lac-grid"><label>Aporte em {quote} realmente creditado<input inputMode="decimal" value={amountText}
          onChange={(event) => { setAmountText(event.target.value); invalidate(); }} placeholder="0,00" /></label>
          <label>Moeda de origem<select value={originCurrency} onChange={(event) => { setOriginCurrency(event.target.value as "BRL" | "USDT"); invalidate(); }}>
            <option value={quote}>{quote}</option>{quote === "USDT" ? <option value="BRL">BRL convertido para USDT</option> : null}</select></label></div>
          {originCurrency !== quote ? <div className="lac-grid"><label>Valor original em BRL<input inputMode="decimal" value={originText}
            onChange={(event) => { setOriginText(event.target.value); invalidate(); }} placeholder="0,00" /></label>
            <label>Evidência da conversão / crédito<input value={evidence} onChange={(event) => { setEvidence(event.target.value); invalidate(); }}
              placeholder="ID ou referência da conversão" /></label></div> : null}
          {kind === "SLOT_CAPITAL" ? <p className="lac-slot-note">{selectedSlot?.entry_state === "OPEN"
            ? "OPEN: posição, quantidade, entrada e TP permanecem intactos; saldo novo vale para a próxima operação."
            : "Sem posição: o capital entra no saldo do slot, mas não dispara uma BUY."}</p> : null}
          {kind === "BULK_CAPITAL" && selectedEngines.length === 2 ? <div className="lac-grid">
            <label>Divisão<select value={distribution} onChange={(event) => { setDistribution(event.target.value as typeof distribution); invalidate(); }}>
              <option value="EQUAL">Igual · 50/50</option><option value="PERCENT">Percentual</option>
              <option value="ABSOLUTE">Valor absoluto</option></select></label>
            {distribution === "PERCENT" ? <label>{selectedEngines[0].symbol} · %<input type="number" min={1} max={99}
              value={firstPercent} onChange={(event) => { setFirstPercent(Number(event.target.value)); invalidate(); }} /></label> : null}
            {distribution === "ABSOLUTE" ? <label>{selectedEngines[0].symbol} · {quote}<input inputMode="decimal"
              value={firstAmountText} onChange={(event) => { setFirstAmountText(event.target.value); invalidate(); }} /></label> : null}
          </div> : null}
          {kind === "BULK_CAPITAL" ? <p className="lac-slot-note">O valor de cada motor é distribuído igualmente entre seus 25 slots, com sobra de centavos explícita.</p> : null}</>}
      <label>Motivo<input value={reason} maxLength={160} onChange={(event) => { setReason(event.target.value); invalidate(); }}
        placeholder="Obrigatório para auditoria" /></label>
      <div className="lac-actions"><button type="button" disabled={busy} onClick={makePreview}>Pré-visualizar · sem ordens</button>
        <button type="button" className="lac-quiet" onClick={() => refresh().catch((cause) => setError(cause.message))}>Atualizar estado</button></div>
      {preview ? <div className="lac-preview"><h4>Antes → ajuste → depois</h4>
        <p><strong>{preview.account} · {quote}</strong> · Binance livre {format(preview.free, quote)} · CoinOps {format(preview.accountCap, quote)} → {format(preview.afterCap, quote)}</p>
        {previewDraft?.kind === "CAPITAL" ? <p>Aporte {format(preview.amount, quote)} · disponível comprovado {format(preview.availableForNewCapital, quote)} · fora do CoinOps depois {format(preview.outsideCoinOps, quote)}</p> : null}
        {preview.fxReference ? <p>Conversão declarada: {format(preview.origin, "BRL")} → {format(preview.amount, "USDT")} ·
          taxa efetiva {preview.fxReference.effectiveRate.toFixed(4)} BRL/USDT · referência pública Binance
          {" "}{preview.fxReference.referenceRate.toFixed(4)} em {preview.fxReference.observedAt}.
          O crédito USDT é conferido no saldo Spot; a referência não comprova por si só o ID da conversão.</p> : null}
        <p>{preview.allocations.length} slot(s) · {preview.openCount} OPEN · {format(preview.pendingForNextOperation, quote)} pendente da próxima operação em slots OPEN.</p>
        <p>Nenhuma posição OPEN, preço médio, quantidade ou TP será alterado. Nenhuma ordem será criada pelo ajuste.</p>
        <details><summary>Ver todos os slots afetados</summary><div className="lac-items">{preview.allocations.map((item) =>
          <p key={`${item.engineId}:${item.slotNumber}`}><b>{inQuote.find((engine) => engine.id === item.engineId)?.symbol} · #{item.slotNumber}</b>
            <span>{item.open ? "OPEN" : "sem posição"} · {format(item.balanceBefore, quote)} + {format(item.amount, quote)} → {format(item.balanceAfter, quote)}</span>
            <span>{item.monthlyBefore}/{item.target} → {item.monthlyAfter}/{item.target} ganhos do mês{item.monthlyBefore < item.target && item.monthlyAfter >= item.target ? " · META BATIDA" : ""}</span></p>)}</div></details>
        <button type="button" disabled={busy} onClick={confirm}>Confirmar ajuste auditável</button></div> : null}
      <details className="lac-history"><summary>Histórico e estornos</summary>
        {(status.batches ?? []).filter((item) => item.exchange_account_id === accountId).map((batch) =>
          <div key={batch.id}><span><b>{batch.kind === "MANUAL_GAIN" ? "GAIN MANUAL" : batch.kind === "REVERSAL" ? "ESTORNO" : "APORTE EXTERNO"}</b>
            {" · "}{format(batch.amount_quote, batch.quote_asset)} · {new Date(batch.created_at).toLocaleString("pt-BR")}</span>
            <small>{batch.reason}</small>{batch.kind !== "REVERSAL" && !status.batches.some((item) => item.reversal_of === batch.id)
              ? <button type="button" disabled={busy || reason.trim().length < 3} onClick={() => previewReversal(batch)}>Prévia de estorno</button> : null}</div>)}
        {reverse ? <div className="lac-preview"><strong>Estorno · {reverse.after.length} slot(s)</strong>
          <p>Somente se os saldos, a sequência e as ordens continuarem reversíveis. Nenhuma venda ou cancelamento automático.</p>
          <button type="button" disabled={busy} onClick={confirmReversal}>Confirmar estorno seguro</button></div> : null}
      </details>
      <details className="lac-history"><summary>Plano mensal · sem movimentação automática</summary>
        {latestPlan ? <p>Versão {latestPlan.revision} · {latestPlan.status === "ACTIVE" ? "ATIVO" : "DESATIVADO"} ·
          {" "}{format(latestPlan.monthly_amount_origin, latestPlan.origin_currency)}/mês · BTC {latestPlan.btc_percent}% / SOL {latestPlan.sol_percent}% ·
          início {latestPlan.start_month.slice(0, 7)} · {latestPlan.horizon_months} meses ·
          próxima data prevista {nextPlanMonth(latestPlan)}.</p> : null}
        <p>Planejado {latestPlan?.status === "ACTIVE" ? format(latestPlan.monthly_amount_origin, latestPlan.origin_currency) : "—"}
          {" · "}realizado neste mês {format(realizedThisMonth, latestPlan?.origin_currency ?? planOrigin)}.
          Moedas diferentes não são somadas nem convertidas sem evidência real.</p>
        <div className="lac-grid"><label>Valor mensal<input inputMode="decimal" value={planAmount}
          onChange={(event) => setPlanAmount(event.target.value)} placeholder="1000,00" /></label>
          <label>Moeda planejada<select value={planOrigin} onChange={(event) => setPlanOrigin(event.target.value as "BRL" | "USDT")}>
            <option value="BRL">BRL</option><option value="USDT">USDT</option></select></label>
          <label>BTC %<input type="number" min={0} max={100} value={planBtc}
            onChange={(event) => setPlanBtc(Number(event.target.value))} /></label>
          <label>SOL %<input value={`${100 - planBtc}%`} readOnly /></label>
          <label>Primeiro mês<input type="month" value={planStart} onChange={(event) => setPlanStart(event.target.value)} /></label>
          <label>Horizonte em meses<input type="number" min={1} max={120} value={planMonths}
            onChange={(event) => setPlanMonths(Number(event.target.value))} /></label></div>
        <p className="lac-slot-note">Use o motivo acima para salvar/desativar. Cada mudança cria uma revisão auditável;
          nenhuma agenda executa depósito, conversão ou ordem.</p>
        <div className="lac-actions"><button type="button" disabled={busy || reason.trim().length < 3}
          onClick={() => savePlan(false)}>Salvar plano</button>
          {latestPlan?.status === "ACTIVE" ? <button type="button" disabled={busy || reason.trim().length < 3}
            onClick={() => savePlan(true)}>Desativar plano</button> : null}</div>
      </details>
    </>}
  </section>;
}

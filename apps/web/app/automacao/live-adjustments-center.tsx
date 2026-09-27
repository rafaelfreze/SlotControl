"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { allocateBulkSlots, allocateSelectedSlots, splitBulkEngines } from "@/lib/execution/live-adjustment-plans";
import { resolveSelectiveContributionPresetRegions } from "@/lib/execution/selective-contribution-presets";
import "./live-adjustments-center.css";

type Account = { id: string; display_name: string; is_legacy_default: boolean };
type Engine = { id: string; exchange_account_id: string; symbol: string; quote_asset: "BRL" | "USDT";
  base_asset: "BTC" | "SOL"; status: string; hard_cap_quote: number | string };
type Slot = { trading_engine_id: string; slot_number: number; operation_sequence: number; entry_state: string;
  position_committed_brl: number | string; target_buy_price: number | string; entry_reference_price: number | string;
  operational_rank: number | null };
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
type SelectiveBatch = { id: string; exchange_account_id: string; trading_engine_id: string;
  quote_asset: string; amount_quote: number | string; reason: string; source: string; created_at: string };
type SelectiveAllocation = { id: string; batch_id: string; trading_engine_id: string; slot_number: number;
  amount_quote: number | string; status: "PENDING" | "APPLIED" | "CANCELLED"; source: string;
  created_at: string; applied_at: string | null; applied_operation_sequence: number | null };
type LiveOrder = { trading_engine_id: string; slot_number: number; operation_sequence: number;
  side: "BUY" | "SELL"; purpose: string; status: string; cumulative_quote: number | string;
  executed_quantity: number | string; price: number | string | null };
type Preset = { id: string; name: string; total_slots: number; open_slots: number;
  following_slots: number; status: "ACTIVE" | "DISABLED"; built_in: boolean; usage_count: number;
  created_at: string; updated_at: string };
type Status = { accounts: Account[]; engines: Engine[]; slots: Slot[];
  slotAccounts: SlotAccount[]; totals: Total[]; batches: Batch[]; plans: Plan[];
  selectiveBatches: SelectiveBatch[]; selectiveAllocations: SelectiveAllocation[]; orders: LiveOrder[];
  presets: Preset[] };
type Preview = { previewHash: string; account: string; quote: string; amount: number;
  origin: number; originCurrency: string; free: number; exposure: number;
  availableForNewCapital: number; accountCap: number; afterCap: number;
  outsideCoinOps: number; observedAt: string; executorIp: string;
  fxReference?: { referenceRate: number; effectiveRate: number; observedAt: string; source: string } | null;
  openCount: number; pendingForNextOperation: number;
  allocations: Array<{ engineId: string; slotNumber: number; amount: number; gainUnits: number;
    balanceBefore: number; balanceAfter: number; balanceAfterApplication: number;
    monthlyBefore: number; monthlyAfter: number;
    lifetimeBefore: number; lifetimeAfter: number; open: boolean; target: number;
    allocationStatus: "PENDING" | "APPLIED" }>;
  presetSelection?: { id: string; name: string; anchorSlotNumber: number; openSlots: number;
    followingSlots: number; resolvedSlotNumbers: number[] } | null };
type Draft = { action: string; kind?: string; accountId: string; quote: "BRL" | "USDT";
  engineId?: string; slotNumber?: number; gainUnits?: number; amount?: number;
  shares?: Array<{ engineId: string; amount: number }>; originCurrency?: "BRL" | "USDT";
  selectedSlots?: number[]; customAllocations?: Array<{ slotNumber: number; amount: number }>;
  selectionMode?: "MANUAL" | "PRESET"; presetId?: string; presetAnchorSlot?: number;
  originAmount?: number; fxObservedAt?: string; evidence?: string; reason: string;
  requestId: string; previewHash?: string; originalId?: string; monthlyAmount?: number;
  btcPercent?: number; startMonth?: string; horizonMonths?: number };
type PresetCommand = { action: "PRESET_CREATE" | "PRESET_UPDATE" | "PRESET_TOGGLE" | "PRESET_DELETE";
  presetId?: string; name?: string; totalSlots?: number; openSlots?: number; followingSlots?: number;
  enabled?: boolean };

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

async function control(input: Draft | PresetCommand) {
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
  const [kind, setKind] = useState<"MANUAL_GAIN" | "SLOT_CAPITAL" | "BULK_CAPITAL" | "SELECTIVE_CAPITAL" | "PRESET_CAPITAL">("MANUAL_GAIN");
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
  const [selectedSlots, setSelectedSlots] = useState<number[]>([]);
  const [slotFilter, setSlotFilter] = useState<"ALL" | "OPEN" | "AVAILABLE" | "PENDING">("ALL");
  const [slotDistribution, setSlotDistribution] = useState<"EQUAL" | "CUSTOM">("EQUAL");
  const [customSlotAmounts, setCustomSlotAmounts] = useState<Record<number, string>>({});
  const [presetId, setPresetId] = useState("");
  const [presetAnchorSlot, setPresetAnchorSlot] = useState<number | null>(null);
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [presetName, setPresetName] = useState("");
  const [presetTotalSlots, setPresetTotalSlots] = useState(3);
  const [presetOpenSlots, setPresetOpenSlots] = useState(1);
  const [presetFollowingSlots, setPresetFollowingSlots] = useState(2);
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
    const firstPreset = (data.presets as Preset[] | undefined)?.find((item) => item.status === "ACTIVE");
    if (!presetId && firstPreset) setPresetId(firstPreset.id);
  }, [accountId, engineId, initialSymbol, presetId, quote]);
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
    .reduce((sum, item) => sum + Number(item.amount_quote), 0)
    + (status?.selectiveBatches ?? []).filter((item) => item.exchange_account_id === accountId
      && item.quote_asset === quote).reduce((sum, item) => sum + Number(item.amount_quote), 0);
  const marketResult = scopedSlotAccounts.reduce((sum, item) => sum + Number(item.market_pnl_quote) - Number(item.fees_quote), 0);
  const operationalBalance = scopedSlotAccounts.reduce((sum, item) => sum + Number(item.balance_quote), 0);
  const selectivePending = (status?.selectiveAllocations ?? []).filter((item) => item.status === "PENDING");
  const pendingBySlot = new Map<string, number>();
  for (const item of selectivePending) {
    const key = `${item.trading_engine_id}:${item.slot_number}`;
    pendingBySlot.set(key, (pendingBySlot.get(key) ?? 0) + Number(item.amount_quote));
  }
  const engineSlots = useMemo(() => (status?.slots ?? [])
    .filter((item) => item.trading_engine_id === engineId)
    .sort((left, right) => Number(left.operational_rank) - Number(right.operational_rank)), [status, engineId]);
  const activePresets = (status?.presets ?? []).filter((item) => item.status === "ACTIVE");
  const selectedPreset = activePresets.find((item) => item.id === presetId) ?? activePresets[0];
  const presetRegions = useMemo(() => {
    if (!selectedPreset || engineSlots.length !== 25) return [];
    try {
      return resolveSelectiveContributionPresetRegions({ id: selectedPreset.id, name: selectedPreset.name,
        totalSlots: selectedPreset.total_slots, openSlots: selectedPreset.open_slots,
        followingSlots: selectedPreset.following_slots }, engineSlots.map((slot) => ({
        slotNumber: slot.slot_number, operationalRank: slot.operational_rank, entryState: slot.entry_state,
      })));
    } catch { return []; }
  }, [selectedPreset, engineSlots]);
  const selectedPresetRegion = presetRegions.find((region) => region.anchorSlotNumber === presetAnchorSlot)
    ?? presetRegions[0];
  const effectiveSelectedSlots = useMemo(() => kind === "PRESET_CAPITAL"
    ? selectedPresetRegion?.slotNumbers ?? [] : selectedSlots,
  [kind, selectedPresetRegion, selectedSlots]);
  const proposedBySlot = useMemo(() => {
    try {
      const custom = slotDistribution === "CUSTOM" ? effectiveSelectedSlots.map((number) => ({
        slotNumber: number, amount: Number((customSlotAmounts[number] ?? "").replace(",", ".")),
      })) : undefined;
      return new Map(allocateSelectedSlots(amount, engineId, effectiveSelectedSlots, custom)
        .map((item) => [item.slotNumber, item.amount]));
    } catch { return new Map<number, number>(); }
  }, [amount, customSlotAmounts, effectiveSelectedSlots, engineId, slotDistribution]);

  function invalidate() { setPreview(null); setPreviewDraft(null); setReverse(null); setError(""); setNotice(""); setRequestId(crypto.randomUUID()); }
  function chooseAccount(value: string) {
    setAccountId(value);
    const nextQuote = status?.engines.find((item) => item.exchange_account_id === value)?.quote_asset ?? "BRL";
    setQuote(nextQuote); setOriginCurrency(nextQuote);
    setEngineId(status?.engines.find((item) => item.exchange_account_id === value)?.id ?? "");
    setSelected([]); setSelectedSlots([]); setCustomSlotAmounts({}); setPresetAnchorSlot(null); invalidate();
  }
  function chooseQuote(value: "BRL" | "USDT") {
    setQuote(value); setOriginCurrency(value);
    setEngineId(accountEngines.find((item) => item.quote_asset === value)?.id ?? "");
    setSelected([]); setSelectedSlots([]); setCustomSlotAmounts({}); setPresetAnchorSlot(null); invalidate();
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
    if (account.is_legacy_default && kind !== "MANUAL_GAIN" && kind !== "SELECTIVE_CAPITAL" && kind !== "PRESET_CAPITAL")
      throw new Error("O limite fixo de Rafael não permite capital adicional sem autorização separada.");
    const base: Draft = { action: "PREVIEW", kind: kind === "MANUAL_GAIN" ? "MANUAL_GAIN"
      : kind === "SELECTIVE_CAPITAL" || kind === "PRESET_CAPITAL" ? "SELECTIVE_CAPITAL" : "CAPITAL",
      accountId, quote, originCurrency: kind === "MANUAL_GAIN" ? quote : originCurrency,
      reason: reason.trim(), requestId };
    if (kind === "MANUAL_GAIN") return { ...base, engineId, slotNumber, gainUnits };
    const currencyDetails = originCurrency === quote ? {} : {
      originAmount: Number(originText.replace(",", ".")), evidence: evidence.trim(),
      fxObservedAt: new Date().toISOString(),
    };
    if (kind === "SELECTIVE_CAPITAL" || kind === "PRESET_CAPITAL") {
      const resolvedSlots = kind === "PRESET_CAPITAL"
        ? selectedPresetRegion?.slotNumbers ?? [] : selectedSlots;
      if (kind === "PRESET_CAPITAL" && (!selectedPreset || !selectedPresetRegion))
        throw new Error("Preset não pode formar a quantidade de slots nesta região.");
      const customAllocations = slotDistribution === "CUSTOM" ? resolvedSlots.map((selectedSlotNumber) => ({
        slotNumber: selectedSlotNumber,
        amount: Number((customSlotAmounts[selectedSlotNumber] ?? "").replace(",", ".")),
      })) : undefined;
      allocateSelectedSlots(amount, engineId, resolvedSlots, customAllocations);
      return { ...base, engineId, amount, selectedSlots: resolvedSlots, customAllocations,
        selectionMode: kind === "PRESET_CAPITAL" ? "PRESET" : "MANUAL",
        presetId: kind === "PRESET_CAPITAL" ? selectedPreset?.id : undefined,
        presetAnchorSlot: kind === "PRESET_CAPITAL" ? selectedPresetRegion?.anchorSlotNumber : undefined,
        ...currencyDetails };
    }
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
    if (!window.confirm(["CAPITAL", "SELECTIVE_CAPITAL"].includes(previewDraft.kind ?? "")
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

  function resetPresetForm() {
    setEditingPresetId(null); setPresetName(""); setPresetTotalSlots(3);
    setPresetOpenSlots(1); setPresetFollowingSlots(2);
  }
  function editPreset(preset: Preset) {
    setEditingPresetId(preset.id); setPresetName(preset.name); setPresetTotalSlots(preset.total_slots);
    setPresetOpenSlots(preset.open_slots); setPresetFollowingSlots(preset.following_slots);
  }
  async function savePreset() {
    try {
      setBusy(true); setError("");
      await control({ action: editingPresetId ? "PRESET_UPDATE" : "PRESET_CREATE",
        presetId: editingPresetId ?? undefined, name: presetName.trim(), totalSlots: presetTotalSlots,
        openSlots: presetOpenSlots, followingSlots: presetFollowingSlots });
      setNotice(editingPresetId ? "Predefinição atualizada. Nenhum aporte foi executado."
        : "Predefinição criada. Nenhum aporte foi executado.");
      resetPresetForm(); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao salvar predefinição."); }
    finally { setBusy(false); }
  }
  async function togglePreset(preset: Preset) {
    try {
      setBusy(true); setError("");
      await control({ action: "PRESET_TOGGLE", presetId: preset.id, enabled: preset.status !== "ACTIVE" });
      setNotice(preset.status === "ACTIVE" ? "Predefinição desativada." : "Predefinição ativada.");
      if (preset.id === presetId) setPresetAnchorSlot(null);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao alterar predefinição."); }
    finally { setBusy(false); }
  }
  async function deletePreset(preset: Preset) {
    if (!window.confirm(preset.usage_count > 0 || preset.built_in
      ? "Esta predefinição será desativada e preservada para auditoria. Continuar?"
      : "Excluir esta predefinição ainda não utilizada?")) return;
    try {
      setBusy(true); setError("");
      const result = await control({ action: "PRESET_DELETE", presetId: preset.id });
      setNotice(result.deleted ? "Predefinição não utilizada excluída."
        : "Predefinição preservada e desativada por segurança.");
      if (preset.id === presetId) { setPresetId(""); setPresetAnchorSlot(null); }
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao excluir predefinição."); }
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
        {([['MANUAL_GAIN','Adicionar gain'],['SLOT_CAPITAL','Adicionar saldo'],
          ['BULK_CAPITAL','Todos os slots'],['SELECTIVE_CAPITAL','Selecionar manualmente'],
          ['PRESET_CAPITAL','Predefinição']] as const).map(([key,label]) =>
          <button type="button" key={key} aria-pressed={kind === key} onClick={() => { setKind(key); invalidate(); }}>{label}</button>)}</div>
      {kind !== "BULK_CAPITAL" ? <div className="lac-grid">
        <label>Motor<select value={engineId} onChange={(event) => { setEngineId(event.target.value); setSelectedSlots([]); setCustomSlotAmounts({}); setPresetAnchorSlot(null); invalidate(); }}>
          <option value="">Selecione</option>{inQuote.map((item) => <option value={item.id} key={item.id}>{item.symbol}</option>)}</select></label>
        {kind !== "SELECTIVE_CAPITAL" && kind !== "PRESET_CAPITAL" ? <label>Slot físico<select value={slotNumber} onChange={(event) => { setSlotNumber(Number(event.target.value)); invalidate(); }}>
          {Array.from({ length: 25 }, (_, index) => <option value={index + 1} key={index}>Slot #{index + 1}</option>)}</select></label>
          : <p className="lac-slot-note">{kind === "PRESET_CAPITAL"
            ? "A predefinição resolve a região pela ordem operacional oficial do motor."
            : "Escolha manualmente qualquer subconjunto dos 25 slots deste motor."}</p>}
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
      {kind === "SELECTIVE_CAPITAL" || kind === "PRESET_CAPITAL" ? <section className="lac-selective" aria-label="Aporte em slots selecionados">
        <div className="lac-selective-head"><div><strong>{kind === "PRESET_CAPITAL" ? "Região predefinida" : "Slots do motor"}</strong>
          <small>{effectiveSelectedSlots.length} selecionado(s)
          {effectiveSelectedSlots.length && Number.isFinite(amount) ? ` · ${slotDistribution === "EQUAL" ? format(amount / effectiveSelectedSlots.length, quote) : "valores personalizados"}` : ""}</small></div>
          <label>Distribuição<select value={slotDistribution} onChange={(event) => { setSlotDistribution(event.target.value as "EQUAL" | "CUSTOM"); invalidate(); }}>
            <option value="EQUAL">Igual entre selecionados</option><option value="CUSTOM">Personalizar valores</option></select></label></div>
        {kind === "PRESET_CAPITAL" ? <><div className="lac-grid">
          <label>Predefinição<select value={selectedPreset?.id ?? ""} onChange={(event) => {
            setPresetId(event.target.value); setPresetAnchorSlot(null); setCustomSlotAmounts({}); invalidate();
          }}><option value="">Selecione</option>{activePresets.map((preset) => <option value={preset.id} key={preset.id}>
            {preset.name} · {preset.total_slots} slots</option>)}</select></label>
          <label>Região / âncora<select value={selectedPresetRegion?.anchorSlotNumber ?? ""} onChange={(event) => {
            setPresetAnchorSlot(Number(event.target.value)); setCustomSlotAmounts({}); invalidate();
          }}><option value="">Selecione</option>{presetRegions.map((region, index) => <option value={region.anchorSlotNumber} key={region.anchorSlotNumber}>
            Região {String.fromCharCode(65 + index)} · OPEN {region.openAnchorSlotNumbers.map((slot) => `#${slot}`).join(" + ")} · até #{region.slotNumbers.at(-1)}
          </option>)}</select></label></div>
          {!selectedPreset ? <p className="lac-error">Crie ou ative uma predefinição.</p>
            : !presetRegions.length ? <p className="lac-error">Preset não pode formar {selectedPreset.total_slots} slots nesta região. Escolha outro preset ou a seleção manual.</p>
              : <p className="lac-slot-note">{selectedPreset.name} · ordem operacional oficial · {selectedPresetRegion?.slotNumbers.map((slot) => `#${slot}`).join(" → ")}</p>}
        </> : <><div className="lac-slot-filters" role="group" aria-label="Filtrar slots">
          {([['ALL','Todos'],['OPEN','OPEN'],['AVAILABLE','Disponíveis'],['PENDING','Com aporte pendente']] as const).map(([key,label]) =>
            <button type="button" key={key} aria-pressed={slotFilter === key} onClick={() => setSlotFilter(key)}>{label}</button>)}</div></>}
        <div className="lac-slot-picker">{engineSlots.filter((slot) => kind === "PRESET_CAPITAL"
          ? effectiveSelectedSlots.includes(slot.slot_number) : (() => {
          const pending = pendingBySlot.get(`${slot.trading_engine_id}:${slot.slot_number}`) ?? 0;
          return slotFilter === "ALL" || slotFilter === "OPEN" && slot.entry_state === "OPEN"
            || slotFilter === "AVAILABLE" && slot.entry_state !== "OPEN"
            || slotFilter === "PENDING" && pending > 0;
        })()).map((slot) => {
          const accountRow = status?.slotAccounts.find((item) => item.trading_engine_id === slot.trading_engine_id && item.slot_number === slot.slot_number);
          const totalRow = status?.totals.find((item) => item.trading_engine_id === slot.trading_engine_id && item.slot_number === slot.slot_number);
          const pending = pendingBySlot.get(`${slot.trading_engine_id}:${slot.slot_number}`) ?? 0;
          const buys = (status?.orders ?? []).filter((order) => order.trading_engine_id === slot.trading_engine_id
            && order.slot_number === slot.slot_number && order.operation_sequence === slot.operation_sequence
            && order.side === "BUY" && Number(order.executed_quantity) > 0);
          const quantity = buys.reduce((sum, order) => sum + Number(order.executed_quantity), 0);
          const entry = quantity ? buys.reduce((sum, order) => sum + Number(order.cumulative_quote), 0) / quantity : null;
          const checked = effectiveSelectedSlots.includes(slot.slot_number);
          return <label className={`lac-slot-choice${checked ? " is-selected" : ""}`} key={slot.slot_number}>
            <span className="lac-slot-title">{kind === "SELECTIVE_CAPITAL" ? <input type="checkbox" checked={checked} onChange={(event) => {
              setSelectedSlots(event.target.checked ? [...selectedSlots,slot.slot_number].sort((a,b) => a-b)
                : selectedSlots.filter((number) => number !== slot.slot_number)); invalidate();
            }} /> : null}<b>#{slot.slot_number}</b><em>{slot.entry_state === "OPEN" ? "OPEN"
              : slot.entry_state === "ARMED" ? "PRÓXIMA BUY" : "DISPONÍVEL"}</em></span>
            <span>{format(accountRow?.balance_quote, quote)} capital</span>
            {proposedBySlot.has(slot.slot_number) ? <span>+ {format(proposedBySlot.get(slot.slot_number), quote)} aporte</span> : null}
            {pending > 0 ? <strong>+ {format(pending, quote)} pendente</strong> : null}
            <small>{entry ? `Entrada ${format(entry, quote)}` : `Próxima referência ${format(slot.target_buy_price, quote)}`}
              {` · ${totalRow?.lifetime_gain_count ?? 0} gains`}</small>
            <small>{slot.entry_state === "OPEN" ? "Aplicação após o fechamento" : slot.entry_state === "ARMED" ? "Ordem atual não será alterada" : "Disponível no ledger; sem BUY automática"}</small>
            {checked && slotDistribution === "CUSTOM" ? <input aria-label={`Valor do slot ${slot.slot_number}`} inputMode="decimal"
              value={customSlotAmounts[slot.slot_number] ?? ""} placeholder="0,00" onChange={(event) => {
                setCustomSlotAmounts({ ...customSlotAmounts, [slot.slot_number]: event.target.value }); invalidate();
              }} /> : null}
          </label>;
        })}</div>
      </section> : null}
      {kind === "PRESET_CAPITAL" ? <details className="lac-history lac-preset-manager"><summary>Gerenciar predefinições</summary>
        <p className="lac-slot-note">Configuração somente de seleção: criar, editar ou desativar não movimenta capital e não envia ordens.</p>
        <div className="lac-grid"><label>Nome<input value={presetName} maxLength={80}
          onChange={(event) => setPresetName(event.target.value)} placeholder="Ex.: 1 + 2" /></label>
          <label>Total de slots<input type="number" min={1} max={25} value={presetTotalSlots}
            onChange={(event) => setPresetTotalSlots(Number(event.target.value))} /></label>
          <label>Slots OPEN da região<input type="number" min={1} max={25} value={presetOpenSlots}
            onChange={(event) => setPresetOpenSlots(Number(event.target.value))} /></label>
          <label>Seguintes abaixo<input type="number" min={0} max={24} value={presetFollowingSlots}
            onChange={(event) => setPresetFollowingSlots(Number(event.target.value))} /></label></div>
        <p className={presetTotalSlots === presetOpenSlots + presetFollowingSlots ? "lac-slot-note" : "lac-error"}>
          Total deve ser exatamente OPEN + abaixo: {presetOpenSlots} + {presetFollowingSlots} = {presetOpenSlots + presetFollowingSlots}.</p>
        <div className="lac-actions"><button type="button" disabled={busy || presetName.trim().length < 3
          || presetTotalSlots !== presetOpenSlots + presetFollowingSlots} onClick={savePreset}>
          {editingPresetId ? "Salvar alterações" : "Criar predefinição"}</button>
          {editingPresetId ? <button type="button" className="lac-quiet" onClick={resetPresetForm}>Cancelar edição</button> : null}</div>
        <div className="lac-preset-list">{status.presets.map((preset) => <div key={preset.id}>
          <span><b>{preset.name}</b> · {preset.open_slots} OPEN + {preset.following_slots} abaixo · {preset.total_slots} slots</span>
          <small>{preset.status === "ACTIVE" ? "ATIVA" : "DESATIVADA"} · {preset.usage_count} uso(s){preset.built_in ? " · padrão CoinOps" : ""}</small>
          <div><button type="button" disabled={busy} onClick={() => editPreset(preset)}>Editar</button>
            <button type="button" disabled={busy} onClick={() => togglePreset(preset)}>{preset.status === "ACTIVE" ? "Desativar" : "Ativar"}</button>
            <button type="button" disabled={busy} onClick={() => deletePreset(preset)}>Excluir</button></div>
        </div>)}</div>
      </details> : null}
      <label>Motivo<input value={reason} maxLength={160} onChange={(event) => { setReason(event.target.value); invalidate(); }}
        placeholder="Obrigatório para auditoria" /></label>
      <div className="lac-actions"><button type="button" disabled={busy} onClick={makePreview}>Pré-visualizar · sem ordens</button>
        <button type="button" className="lac-quiet" onClick={() => refresh().catch((cause) => setError(cause.message))}>Atualizar estado</button></div>
      {preview ? <div className="lac-preview"><h4>Antes → ajuste → depois</h4>
        <p><strong>{preview.account} · {quote}</strong> · Binance livre {format(preview.free, quote)} · CoinOps {format(preview.accountCap, quote)} → {format(preview.afterCap, quote)}</p>
        {["CAPITAL","SELECTIVE_CAPITAL"].includes(previewDraft?.kind ?? "") ? <p>Aporte {format(preview.amount, quote)} · disponível comprovado {format(preview.availableForNewCapital, quote)} · fora do CoinOps depois {format(preview.outsideCoinOps, quote)}</p> : null}
        {preview.fxReference ? <p>Conversão declarada: {format(preview.origin, "BRL")} → {format(preview.amount, "USDT")} ·
          taxa efetiva {preview.fxReference.effectiveRate.toFixed(4)} BRL/USDT · referência pública Binance
          {" "}{preview.fxReference.referenceRate.toFixed(4)} em {preview.fxReference.observedAt}.
          O crédito USDT é conferido no saldo Spot; a referência não comprova por si só o ID da conversão.</p> : null}
        {preview.presetSelection ? <p><strong>Preset: {preview.presetSelection.name}</strong> · âncora #{preview.presetSelection.anchorSlotNumber} ·
          {" "}{preview.presetSelection.openSlots} OPEN + {preview.presetSelection.followingSlots} abaixo ·
          {" "}{preview.presetSelection.resolvedSlotNumbers.map((slot) => `#${slot}`).join(" → ")}</p> : null}
        <p>{preview.allocations.length} slot(s) · {preview.openCount} OPEN · {format(preview.pendingForNextOperation, quote)} pendente da próxima operação em slots OPEN.</p>
        <p>Nenhuma posição OPEN, preço médio, quantidade ou TP será alterado. Nenhuma ordem será criada pelo ajuste.</p>
        <details><summary>Ver todos os slots afetados</summary><div className="lac-items">{preview.allocations.map((item) =>
          <p key={`${item.engineId}:${item.slotNumber}`}><b>{inQuote.find((engine) => engine.id === item.engineId)?.symbol} · #{item.slotNumber}</b>
            <span>{item.open ? "OPEN" : "sem posição"} · {format(item.balanceBefore, quote)}
              {item.allocationStatus === "PENDING"
                ? ` · + ${format(item.amount, quote)} APORTE PENDENTE · após fechamento ${format(item.balanceAfterApplication, quote)} · posição atual intacta`
                : ` + ${format(item.amount, quote)} → ${format(item.balanceAfter, quote)}`}</span>
            <span>{item.monthlyBefore}/{item.target} → {item.monthlyAfter}/{item.target} ganhos do mês{item.monthlyBefore < item.target && item.monthlyAfter >= item.target ? " · META BATIDA" : ""}</span></p>)}</div></details>
        <button type="button" disabled={busy} onClick={confirm}>Confirmar ajuste auditável</button></div> : null}
      <details className="lac-history"><summary>Histórico e estornos</summary>
        {(status.selectiveBatches ?? []).filter((item) => item.exchange_account_id === accountId).map((batch) => {
          const allocations = status.selectiveAllocations.filter((item) => item.batch_id === batch.id);
          const pending = allocations.filter((item) => item.status === "PENDING").length;
          return <div key={batch.id}><span><b>APORTE EM SLOTS SELECIONADOS</b>{" · "}{format(batch.amount_quote, batch.quote_asset)}
            {" · "}{new Date(batch.created_at).toLocaleString("pt-BR")}</span>
            <small>{allocations.length} slots · {pending} pendente(s) · {batch.reason}</small></div>;
        })}
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

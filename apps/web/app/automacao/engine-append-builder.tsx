"use client";
import { useState } from "react";
import type { EngineAdmissionOption } from "@/lib/execution/engine-admission-options";
type Preview = { previewHash: string; status: string; executorIp: string; quote: string;
  free: number; allocatedCapital: number; availableCapital: number; capital: number;
  engines: Array<{ symbol: string; validSlots: number; minimumCapital: number; monthlyTarget: number;
    firstEntry: number; firstTp: number; nextBuy: number; currentPrice: number; minNotional: number }> };
const decimal = (value: string) => value.trim().replace(",", ".");
const defaults = { BTC: ["1.2", "2", "5", "7"], SOL: ["5.5", "3", "8", "2"] };
const money = (value: number, quote: string) => `${value.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} ${quote}`;
export function EngineAppendBuilder({ accountId, name, hostingShards, onChanged }: {
  accountId: string; name: string; hostingShards: string[]; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [options, setOptions] = useState<EngineAdmissionOption[]>([]), [shardId, setShardId] = useState("");
  const [asset, setAsset] = useState<"BTC" | "SOL">("SOL"), [quote, setQuote] = useState<"BRL" | "USDT">("BRL");
  const [capital, setCapital] = useState(""), [rates, setRates] = useState(defaults.SOL);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID()), [preview, setPreview] = useState<Preview | null>(null);
  const [apiKey, setApiKey] = useState(""), [apiSecret, setApiSecret] = useState("");
  const selected = options.find((option) => option.shardId === shardId);
  async function send(path: string, input: Record<string, unknown>, intent = "engine-control") {
    const response = await fetch(path, { method: "POST", cache: "no-store", credentials: "same-origin",
      headers: { "content-type": "application/json", "x-coinops-admin-intent": intent }, body: JSON.stringify(input) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "COINOPS_ENGINE_CONTROL_FAILED");
    return result;
  }
  async function work(action: () => Promise<void>) {
    if (busy) return; setBusy(true); setMessage("");
    try { await action(); } catch (error) {
      const code = error instanceof Error ? error.message : "";
      setMessage(code === "COINOPS_ACCOUNT_ORDER_BUDGET_PROBE_BUSY"
        ? "Outra consulta dos limites Binance está em andamento. Aguarde alguns segundos e tente novamente neste formulário."
        : code || "Ação não concluída. Confira o estado antes de repetir.");
    }
    finally { setBusy(false); }
  }
  function invalidate() { setPreview(null); setRequestId(crypto.randomUUID()); }
  async function loadOptions() {
    const result = await send("/api/coinops-engine-control", { action: "APPEND_OPTIONS", accountId });
    setOptions(result.options); setShardId((previous) => result.options.some((item: EngineAdmissionOption) => item.shardId === previous)
      ? previous : result.options.find((item: EngineAdmissionOption) => item.capacityCode === "CAPACITY_OK")?.shardId ?? "");
  }
  async function validateConnection(id: string, connect = false) {
    await send("/api/coinops-binance-accounts", { operation: connect ? "CONNECT_SHARD" : "REVALIDATE_SHARD",
      accountId, shardId: id, environment: "REAL", requestId: crypto.randomUUID(),
      ...(connect ? { apiKey, apiSecret } : {}) }, "binance-credentials");
  }
  function plan(action: string) {
    return { action, accountId, shardId, requestId, quote, capital: decimal(capital), previewHash: preview?.previewHash,
      engines: [{ asset, capital: decimal(capital), gainPercent: decimal(rates[0]), spacingPercent: decimal(rates[1]),
        postAthPercent: decimal(rates[2]), monthlyTarget: Number(rates[3]) }] };
  }
  return <section aria-label={`Adicionar motor em ${name}`}>
    <button type="button" className="px-button px-button-primary" disabled={busy} onClick={() => {
      setOpen((value) => !value); if (!open) void work(loadOptions);
      else { setApiKey(""); setApiSecret(""); }
    }}>{open ? "Fechar novo motor" : "+ Adicionar motor"}</button>
    {open ? <div className="px-engine-builder"><h3>Novo motor independente · {name}</h3>
      <p>Motores existentes não serão movidos ou alterados. O mesmo par pode ser escolhido novamente.
        Salvar prepara um novo motor INACTIVE; ativação REAL é uma confirmação separada.</p>
      <div className="px-engine-form-grid"><label>Executor do novo motor<select value={shardId} disabled={busy}
        onChange={(event) => { setShardId(event.target.value); invalidate(); }}>
        <option value="">Selecione um executor elegível</option>{options.map((item) => <option key={item.shardId} value={item.shardId}
          disabled={item.capacityCode !== "CAPACITY_OK"}>{item.shardId.replace("executor-", "Executor ")} ·
          {item.capacityCode === "CAPACITY_OK" ? "+1 SIM" : "+1 NÃO"} · {item.ip} · {item.credential === "VALIDATED" ? "IP validado" : "Validar IP"}</option>)}</select></label>
        <button type="button" className="px-button" disabled={busy} onClick={() => void work(loadOptions)}>Atualizar capacidade · sem ordens</button></div>
      {selected ? <><p>IP para whitelist Binance: <strong>{selected.ip}</strong>. Adicione este IP sem remover os anteriores.
        Não compartilhamos vaults entre executores.</p>
        <button type="button" className="px-button" disabled={busy} onClick={() => void work(async () => {
          for (const id of [...new Set([...hostingShards, shardId])].sort()) await validateConnection(id);
          await loadOptions(); setMessage("Conexões dos executores da conta validadas com GET. Nenhuma ordem enviada.");
        })}>Validar conexões já configuradas · sem ordens</button>
        {selected.credential !== "VALIDATED" ? <fieldset><legend>Credencial no novo IP</legend>
          <p>Se a credencial já está instalada, use a validação acima. Caso contrário, informe-a aqui após incluir o IP na whitelist.</p>
          <label>API Key<input type="password" autoComplete="off" value={apiKey} disabled={busy}
            onChange={(event) => setApiKey(event.target.value)} /></label>
          <label>API Secret<input type="password" autoComplete="new-password" value={apiSecret} disabled={busy}
            onChange={(event) => setApiSecret(event.target.value)} /></label>
          <button type="button" className="px-button" disabled={busy || !apiKey || !apiSecret} onClick={() => void work(async () => {
            try { await validateConnection(shardId, true); }
            finally { setApiKey(""); setApiSecret(""); }
            await loadOptions(); invalidate(); setMessage("Credencial validada e protegida somente neste executor.");
          })}>Validar e salvar credencial neste IP</button></fieldset> : null}</> :
        <p role="status">Sem executor certificado com capacidade comprovada, o novo motor não será admitido.</p>}
      <div className="px-engine-form-grid"><label>Ativo<select value={asset} disabled={busy}
        onChange={(event) => { const next = event.target.value as "BTC" | "SOL"; setAsset(next); setRates(defaults[next]); invalidate(); }}>
        <option value="BTC">BTC</option><option value="SOL">SOL</option></select></label>
        <label>Moeda<select value={quote} disabled={busy} onChange={(event) => { setQuote(event.target.value as "BRL" | "USDT"); invalidate(); }}>
          <option value="BRL">BRL</option><option value="USDT">USDT</option></select></label>
        <label>Capital adicional do novo motor<input type="text" inputMode="decimal" value={capital} disabled={busy}
          onChange={(event) => { setCapital(event.target.value); invalidate(); }} /></label>
        {["Gain %", "Queda normal %", "Queda pós-ATH %", "Meta por slot/mês"].map((label, index) => <label key={label}>{label}
          <input type="text" inputMode={index === 3 ? "numeric" : "decimal"} value={rates[index]} disabled={busy}
            onChange={(event) => { setRates((current) => current.map((value, i) => i === index ? event.target.value : value)); invalidate(); }} /></label>)}</div>
      <button type="button" className="px-button" disabled={busy || !capital || selected?.credential !== "VALIDATED"
        || selected.capacityCode !== "CAPACITY_OK"} onClick={() => void work(async () => {
        setPreview(null); const result = await send("/api/coinops-engine-control", plan("APPEND_PREVIEW"));
        setPreview(result); setMessage("Preview com consultas GET. Nenhuma ordem ou motor foi criado.");
      })}>Pré-visualizar novo motor · sem ordens</button>
      {preview ? <section className="px-engine-preview" aria-label="Preview do motor adicional">
        <h4>{asset}/{quote} · novo motor · {shardId.replace("executor-", "Executor ")}</h4>
        <p>Saldo Spot {money(preview.free, quote)} · capital já autorizado {money(preview.allocatedCapital, quote)} ·
          disponível para nova alocação {money(preview.availableCapital, quote)} · novo capital {money(preview.capital, quote)}.</p>
        {preview.engines.map((engine, index) => <p key={index}>25 slots · {engine.validSlots}/25 executáveis · mínimo estimado {money(engine.minimumCapital, quote)} ·
          meta {engine.monthlyTarget}/slot/mês · primeira entrada estimada {engine.firstEntry} → TP {engine.firstTp} · próxima BUY {engine.nextBuy}.</p>)}
        <button type="button" className="px-button px-button-primary" disabled={busy || preview.status !== "PREVIEW_NO_ORDER"}
          onClick={() => void work(async () => {
            const result = await send("/api/coinops-engine-control", plan("APPEND_PROVISION"));
            setMessage(`${result.engines.length} motor novo INACTIVE com identidade própria. Nenhuma ordem enviada.`);
            invalidate(); await onChanged();
          })}>Confirmar e preparar motor INACTIVE</button>
      </section> : null}
      {message ? <p role="status">{message}</p> : null}
    </div> : null}
  </section>;
}

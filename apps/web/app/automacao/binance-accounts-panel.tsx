"use client";

import { useEffect, useState, type FormEvent } from "react";

type Validation = { status: string; evidence: { environment?: string; status?: string;
  fingerprint?: string | null; executor_ip?: string | null; whitelist_accepted?: boolean | null;
  account_identity?: string | null; permission?: Record<string, boolean | null>;
  balances?: Array<{ asset: string; free: number; locked: number }>;
  validated_at?: string | null } };
type Account = { id: string; name: string; status: string; killSwitch: boolean; legacy: boolean;
  credentialRef: string | null; validation: Validation | null };
type StagedEngine = { id: string; accountId: string; environment: string; symbol: string; quoteAsset: string;
  status: string; hardCap: number; slotCount: number | null; initialSlotQuote: number | null };

const endpoint = "/api/coinops-binance-accounts";

export function BinanceAccountsPanel() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [engines, setEngines] = useState<StagedEngine[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [accountId, setAccountId] = useState(() => crypto.randomUUID());
  const [selected, setSelected] = useState("");
  const [recoverEnvironment, setRecoverEnvironment] = useState("REAL");
  async function refresh() {
    const response = await fetch(endpoint, { cache: "no-store", credentials: "same-origin" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Consulta indisponível");
    setAccounts(payload.accounts ?? []);
    setEngines(payload.engines ?? []);
  }
  useEffect(() => { void refresh().catch(() => setMessage("Contas Binance indisponíveis no momento.")); }, []);
  async function perform(operation: string, extra: Record<string, string>, id = selected || accountId) {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(endpoint, { method: "POST", cache: "no-store", credentials: "same-origin",
        headers: { "content-type": "application/json", "x-coinops-admin-intent": "binance-credentials" },
        body: JSON.stringify({ operation, requestId: crypto.randomUUID(), accountId: id, ...extra }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Validação não concluída");
      setMessage(operation === "CONNECT" || operation === "REPLACE"
        ? `Credencial salva no executor · ${payload.status}. Motor não foi ativado.`
        : operation === "REVALIDATE" ? `Validação GET concluída · ${payload.status}.`
          : operation === "REMOVE" ? "Credencial removida; histórico de auditoria preservado."
            : "Conta desativada; nenhuma ordem foi cancelada.");
      await refresh();
      if (operation === "CONNECT") { setSelected(id); setAccountId(crypto.randomUUID()); }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Operação não concluída. Nenhuma ordem foi enviada.");
      await refresh().catch(() => {});
    } finally { setBusy(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const operation = selected ? "REPLACE" : "CONNECT";
    const extra = { displayName: String(fields.get("displayName") ?? ""),
      environment: String(fields.get("environment") ?? "REAL"),
      apiKey: String(fields.get("apiKey") ?? ""), apiSecret: String(fields.get("apiSecret") ?? "") };
    form.reset(); // Never keep a secret in React state after submission.
    await perform(operation, extra);
  }
  async function prepare(engine: StagedEngine) {
    if (engine.status !== "INACTIVE" || engine.environment !== "REAL"
      || !["BTCUSDT", "SOLUSDT"].includes(engine.symbol) || !active || active.id !== engine.accountId) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/coinops-live-activation", { method: "POST", cache: "no-store",
        credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "PREPARE", asset: engine.symbol.startsWith("BTC") ? "BTC" : "SOL",
          exchange_account_id: engine.accountId, trading_engine_id: engine.id }) });
      const result = await response.json();
      if (!response.ok || result.status !== "PREPARED") throw new Error(result.error ?? result.gate ?? "PREPARATION_FAILED");
      setMessage(`${engine.symbol}: 25 slots preparados no ledger; nenhuma ordem enviada. Ciclo ${result.cycle_id}.`);
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Preparação indisponível."); }
    finally { setBusy(false); }
  }
  const active = accounts.find((item) => item.id === selected);
  return <section className="px-onboarding" aria-label="Contas Binance">
    <h2>Contas Binance</h2>
    <p>Credenciais enviadas por HTTPS ao executor de IP fixo. O Secret não é mostrado após salvar. Cadastro e validação não ativam motores nem enviam ordens.</p>
    <label>Conta<select value={selected} onChange={(event) => setSelected(event.target.value)}>
      <option value="">Adicionar conta Binance</option>
      {accounts.filter((item) => !item.legacy).map((item) => <option key={item.id} value={item.id}>{item.name} · {item.status}</option>)}
    </select></label>
    {active?.validation ? <div className="px-onboarding-checks" aria-label="Resultado da validação Binance">
      <p><strong>{active.validation.evidence.status ?? active.validation.status}</strong> · {active.validation.evidence.environment} · {active.validation.evidence.account_identity ?? "Identidade de API não fornecida pela Binance"}</p>
      <p>Executor: {active.validation.evidence.executor_ip ?? "não confirmado"} · Whitelist: {String(active.validation.evidence.whitelist_accepted ?? "não confirmada")} · Fingerprint: {active.validation.evidence.fingerprint ?? "—"}</p>
      <p>Última validação: {active.validation.evidence.validated_at ?? "—"}</p>
      <div className="px-account-permissions">{Object.entries(active.validation.evidence.permission ?? {}).map(([key, value]) => <span key={key}>{key}: {value === null ? "desconhecido" : value ? "sim" : "não"}</span>)}</div>
      <details><summary>Saldos observados · leitura</summary><div className="px-account-permissions">{(active.validation.evidence.balances ?? []).filter((balance) => balance.free || balance.locked).map((balance) => <span key={balance.asset}>{balance.asset}: livre {balance.free} · bloqueado {balance.locked}</span>)}</div></details>
    </div> : null}
    {(!active || active.status === "INACTIVE") && <form className="px-onboarding-form" onSubmit={submit} autoComplete="off">
      {!active ? <><label>Nome da conta<input name="displayName" maxLength={80} required autoComplete="off" /></label>
        <label>Ambiente<select name="environment" defaultValue="REAL"><option value="REAL">Binance Production</option><option value="TESTNET">Spot Testnet</option></select></label></> : null}
      <label>API Key<input name="apiKey" type="password" minLength={32} maxLength={128} required autoComplete="off" spellCheck={false} /></label>
      <label>API Secret<input name="apiSecret" type="password" minLength={32} maxLength={128} required autoComplete="off" spellCheck={false} /></label>
      <button type="submit" className="px-button" disabled={busy}>{active ? "Substituir credencial" : "Conectar e validar"}</button>
    </form>}
    {active && !active.validation && <label>Ambiente para recuperar validação<select value={recoverEnvironment} onChange={(event) => setRecoverEnvironment(event.target.value)}><option value="REAL">Binance Production</option><option value="TESTNET">Spot Testnet</option></select></label>}
    {active && <div className="px-account-actions">
      <button type="button" className="px-button" disabled={busy} onClick={() => void perform("REVALIDATE", active.validation ? {} : { environment: recoverEnvironment })}>Validar novamente</button>
      <button type="button" className="px-button" disabled={busy || active.status !== "INACTIVE"} onClick={() => void perform("DEACTIVATE", {})}>Desativar conta</button>
      <button type="button" className="px-button" disabled={busy || active.status !== "INACTIVE"} onClick={() => void perform("REMOVE", {})}>Remover credencial</button>
    </div>}
    {active && engines.filter((engine) => engine.accountId === active.id).length > 0 && <div className="px-onboarding-checks" aria-label="Motores da conta">
      <h3>Motores da conta</h3>
      {engines.filter((engine) => engine.accountId === active.id).map((engine) => <p key={engine.id}>
        {engine.symbol} · {engine.status} · {engine.hardCap} {engine.quoteAsset} · {engine.slotCount ?? "—"} slots ·
        {" "}{engine.initialSlotQuote ?? "—"} {engine.quoteAsset}/slot
        {active.status === "INACTIVE" && engine.status === "INACTIVE" && <button type="button"
          className="px-button" disabled={busy || active.validation?.evidence.status !== "PASS"}
          onClick={() => void prepare(engine)}>Preparar 25 slots · sem ordens</button>}
      </p>)}
    </div>}
    {message && <p role="status">{message}</p>}
  </section>;
}

"use client";

import { useEffect, useState, type FormEvent } from "react";
import { credentialOnboardingOperation } from "@/lib/execution/credential-onboarding";

type Validation = { status: string; evidence: { environment?: string; status?: string;
  fingerprint?: string | null; executor_ip?: string | null; whitelist_accepted?: boolean | null;
  account_identity?: string | null; permission?: Record<string, boolean | null>;
  balances?: Array<{ asset: string; free: number; locked: number }>;
  validated_at?: string | null } };
type Account = { id: string; name: string; status: string; killSwitch: boolean; legacy: boolean;
  credentialRef: string | null; validation: Validation | null; shardId: string;
  executorIp: string | null; onboardingEnvironment: string | null };
type StagedEngine = { id: string; accountId: string; environment: string; symbol: string; quoteAsset: string;
  status: string; hardCap: number; slotCount: number | null; initialSlotQuote: number | null };
type AvailableShard = { id: string; state: string; egressIp: string; canAddEngine: boolean;
  canAddTwoEngineAccount: boolean };

const endpoint = "/api/coinops-binance-accounts";

export function BinanceAccountsPanel() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [engines, setEngines] = useState<StagedEngine[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [accountId, setAccountId] = useState(() => crypto.randomUUID());
  const [selected, setSelected] = useState("");
  const [recoverEnvironment, setRecoverEnvironment] = useState("REAL");
  const [shards, setShards] = useState<AvailableShard[]>([]);
  const [targetShard, setTargetShard] = useState("");
  async function refresh() {
    const response = await fetch(endpoint, { cache: "no-store", credentials: "same-origin" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Consulta indisponível");
    setAccounts(payload.accounts ?? []);
    setEngines(payload.engines ?? []);
    // Capacity may be unavailable without preventing access to existing accounts.
    await fetch("/api/coinops-capacity", { cache: "no-store", credentials: "same-origin" })
      .then(async (result) => setShards(result.ok ? (await result.json()).shards ?? [] : []))
      .catch(() => setShards([]));
  }
  useEffect(() => { void refresh().catch(() => setMessage("Contas Binance indisponíveis no momento.")); }, []);
  async function perform(operation: string, extra: Record<string, string | number>, id = selected || accountId) {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(endpoint, { method: "POST", cache: "no-store", credentials: "same-origin",
        headers: { "content-type": "application/json", "x-coinops-admin-intent": "binance-credentials" },
        body: JSON.stringify({ operation, requestId: crypto.randomUUID(), accountId: id, ...extra }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Validação não concluída");
      setMessage(operation === "ASSIGN"
        ? extra.environment === "TESTNET"
          ? "Executor atribuído. Cadastre uma API Spot Testnet neste executor. Nenhuma ordem foi enviada."
          : "Executor atribuído. Configure o IP na whitelist Binance antes de cadastrar a API. Nenhuma ordem foi enviada."
        : operation === "REASSIGN_STAGED"
        ? "Conta preparada reatribuída. Configure a whitelist com o novo IP e insira novamente a API Key e Secret abaixo. Nenhum motor foi ativado e nenhuma credencial foi copiada."
        : operation === "CONNECT" || operation === "REPLACE"
        ? `Credencial salva no executor · ${payload.status}. Motor não foi ativado.`
        : operation === "REVALIDATE" ? `Validação GET concluída · ${payload.status}.`
          : operation === "REMOVE" ? "Credencial removida; histórico de auditoria preservado."
            : "Conta desativada; nenhuma ordem foi cancelada.");
      await refresh();
      if (operation === "ASSIGN" || operation === "CONNECT") { setSelected(id); setAccountId(crypto.randomUUID()); }
    } catch (error) {
      const code = error instanceof Error ? error.message : "Operação não concluída. Nenhuma ordem foi enviada.";
      setMessage(code === "COINOPS_CAPACITY_REQUIRED"
        ? "Capacidade do executor atingida. Adicione/expanda um executor antes de ativar novas contas."
        : code === "COINOPS_CAPACITY_UNKNOWN"
          ? "Telemetria indisponível ou desatualizada. Nova conta bloqueada por segurança; motores existentes continuam operando."
          : code === "EXECUTOR_CREDENTIAL_ALREADY_BOUND"
            ? "Esta API Key já está vinculada a outra conta neste executor. Crie uma API exclusiva na Binance da conta selecionada e configure a whitelist com o IP exibido. Nenhuma credencial ou motor novo foi ativado."
            : code === "EXECUTOR_BINANCE_CREDENTIALS_MISSING"
              ? "Esta conta ainda não possui credencial salva no executor atribuído. Insira a API Key e o Secret da própria conta em Conectar e validar."
          : code);
      await refresh().catch(() => {});
    } finally { setBusy(false); }
  }
  async function assign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    await perform("ASSIGN", { displayName: String(fields.get("displayName") ?? ""),
      environment: String(fields.get("environment") ?? "REAL"),
      plannedEngines: Number(fields.get("plannedEngines")) });
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    if (!active || !active.executorIp) return;
    const operation = credentialOnboardingOperation(active.validation);
    const extra = { displayName: active.name,
      environment: active.onboardingEnvironment ?? active.validation?.evidence.environment ?? recoverEnvironment,
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
  const assignedEnvironment = active?.onboardingEnvironment ?? active?.validation?.evidence.environment ?? recoverEnvironment;
  const accountEngines = engines.filter((engine) => engine.accountId === active?.id);
  const canRequestReassignment = active?.status === "INACTIVE" && active.killSwitch && !active.legacy
    && assignedEnvironment === "REAL" && accountEngines.every((engine) => engine.status === "INACTIVE" && engine.environment === "REAL");
  const targets = shards.filter((shard) => shard.id !== active?.shardId && shard.state === "HEALTHY"
    && (accountEngines.length > 1 ? shard.canAddTwoEngineAccount : shard.canAddEngine));
  return <section className="px-onboarding" aria-label="Contas Binance">
    <h2>Contas Binance</h2>
    <p>Credenciais enviadas por HTTPS ao executor de IP fixo. O Secret não é mostrado após salvar. Cadastro e validação não ativam motores nem enviam ordens.</p>
    <label>Conta<select value={selected} onChange={(event) => setSelected(event.target.value)}>
      <option value="">Adicionar conta Binance</option>
      {accounts.filter((item) => !item.legacy && item.onboardingEnvironment !== "TESTNET").map((item) => <option key={item.id} value={item.id}>{item.name} · {item.status}</option>)}
    </select></label>
    {active?.validation ? <div className="px-onboarding-checks" aria-label="Resultado da validação Binance">
      <p><strong>{active.validation.evidence.status ?? active.validation.status}</strong> · {active.validation.evidence.environment} · {active.validation.evidence.account_identity ?? "Identidade de API não fornecida pela Binance"}</p>
      <p>Executor: {active.validation.evidence.executor_ip ?? "não confirmado"} · Whitelist: {String(active.validation.evidence.whitelist_accepted ?? "não confirmada")} · Fingerprint: {active.validation.evidence.fingerprint ?? "—"}</p>
      <p>Última validação: {active.validation.evidence.validated_at ?? "—"}</p>
      <div className="px-account-permissions">{Object.entries(active.validation.evidence.permission ?? {}).map(([key, value]) => <span key={key}>{key}: {value === null ? "desconhecido" : value ? "sim" : "não"}</span>)}</div>
      <details><summary>Saldos observados · leitura</summary><div className="px-account-permissions">{(active.validation.evidence.balances ?? []).filter((balance) => balance.free || balance.locked).map((balance) => <span key={balance.asset}>{balance.asset}: livre {balance.free} · bloqueado {balance.locked}</span>)}</div></details>
    </div> : null}
    {!active && <form className="px-onboarding-form" onSubmit={assign} autoComplete="off">
      <label>Nome da conta<input name="displayName" maxLength={80} required autoComplete="off" /></label>
      <input type="hidden" name="environment" value="REAL" />
      <label>Motores planejados<select name="plannedEngines" defaultValue="2"><option value="1">1 motor</option><option value="2">2 motores · BTC e SOL</option></select></label>
      <button type="submit" className="px-button" disabled={busy}>Selecionar executor e obter IP</button>
      <small>Primeiro verificamos capacidade e fixamos o executor desta conta. Cadastro sem credenciais, capital ou ordens. A capacidade será verificada novamente antes da ativação.</small>
    </form>}
    {active && <div className="px-onboarding-checks" aria-label="Executor atribuído">
      <p><strong>Executor atribuído: {active.shardId.replace("executor-", "Executor ")}</strong></p>
      <p>IP para whitelist Binance: <strong>{active.executorIp ?? "indisponível"}</strong></p>
      <small>Esta conta permanece neste executor. Não existe migração automática entre IPs. {assignedEnvironment === "REAL"
        ? "Whitelist, permissão Spot e credencial serão validadas; saques e transferências devem permanecer desativados."
        : "Testnet usa fundos fictícios. A Binance Testnet não expõe a verificação de whitelist e permissões de Production."}</small>
    </div>}
    {active?.status === "INACTIVE" && <form key={active.id} className="px-onboarding-form" onSubmit={submit} autoComplete="off">
      {assignedEnvironment === "REAL" ? <label><input type="checkbox" required /> Configurei a whitelist Binance com o IP {active.executorIp ?? "indisponível"}.</label> : null}
      <label>API Key<input name="apiKey" type="password" minLength={32} maxLength={128} required autoComplete="off" spellCheck={false} /></label>
      <label>API Secret<input name="apiSecret" type="password" minLength={32} maxLength={128} required autoComplete="off" spellCheck={false} /></label>
      <button type="submit" className="px-button" disabled={busy || !active.executorIp}>{credentialOnboardingOperation(active.validation) === "REPLACE" ? "Substituir credencial" : "Conectar e validar"}</button>
    </form>}
    {active && canRequestReassignment && <details className="px-onboarding-checks">
      <summary>Alterar executor de conta preparada · somente se nunca operou</summary>
      <p>Não migra contas LIVE. O servidor recusará qualquer histórico de ordem, fill, posição ou ativação. A credencial anterior não será copiada; será necessário conectar a API novamente no destino.</p>
      <label>Executor de destino<select value={targetShard} disabled={busy} onChange={(event) => setTargetShard(event.target.value)}>
        <option value="">Selecione um executor saudável</option>
        {targets.map((shard) => <option key={shard.id} value={shard.id}>{shard.id.replace("executor-", "Executor ")} · IP {shard.egressIp}</option>)}
      </select></label>
      {!targets.length && <small>Nenhum outro executor possui telemetria e margem suficientes neste momento.</small>}
      <button type="button" className="px-button" disabled={busy || !targets.some((shard) => shard.id === targetShard)}
        onClick={() => {
          const target = targets.find((shard) => shard.id === targetShard);
          if (target && window.confirm(`Reatribuir ${active.name} para ${target.id} (IP ${target.egressIp})? Apenas conta que nunca operou é permitida. Você precisará inserir a API novamente. Nenhum motor será ativado.`))
            void perform("REASSIGN_STAGED", { fromShardId: active.shardId, toShardId: target.id });
        }}>Reatribuir conta preparada · sem ativar</button>
    </details>}
    {active && !active.validation && !active.onboardingEnvironment && <label>Ambiente para recuperar validação<select value={recoverEnvironment} onChange={(event) => setRecoverEnvironment(event.target.value)}><option value="REAL">Binance Production</option></select></label>}
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

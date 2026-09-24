"use client";

import { useState } from "react";
import type { PremiumOperatorPresentation } from "./premium-operator";
import { latestOnboardingChecks, ONBOARDING_STEPS, type AccountDraft, type OnboardingCheck } from "./operator-onboarding";
import { saveAccountOnboardingDraft, verifyAccountOnboardingReadOnly } from "./operator-onboarding-actions";

export function OperatorOnboardingPanel({ operator, checks }: { operator: PremiumOperatorPresentation; checks: OnboardingCheck[] }) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [ids, setIds] = useState<{ accountId: string; engineId: string } | null>(null);
  const [selected, setSelected] = useState(operator.engines[0]?.engineId ?? "");
  const current = operator.engines.find((engine) => engine.engineId === selected);
  const steps = current ? latestOnboardingChecks(checks, current.accountId, current.engineId)
    : ONBOARDING_STEPS.map(([key, label]) => ({ key, label, evidence: null }));
  const code = (error: unknown) => error instanceof Error && /^COINOPS_[A-Z0-9_]+$/.test(error.message)
    ? error.message : "Não foi possível concluir a preparação. Nenhuma ativação foi feita.";
  return <section className="px-onboarding" aria-label="Contas e onboarding">
    <p>Administração privada do operador. Preparar uma conta não ativa trading nem envia ordens. Não informe API key ou secret neste painel.</p>
    <label>Motor para consultar checklist<select aria-label="Motor do onboarding" value={selected} onChange={(event) => setSelected(event.target.value)}>{operator.engines.map((engine) => <option key={engine.engineId} value={engine.engineId}>{engine.accountDisplayName} · {engine.environment} · {engine.symbol}</option>)}</select></label>
    <p className="px-caption">IPv4 do executor: <strong>46.101.104.48</strong>. Whitelist e permissões exigem evidência técnica; um checkbox não aprova gates.</p>
    <ol className="px-onboarding-checks">{steps.map((step) => <li key={step.key}><span>{step.label}</span><strong>{step.evidence?.status ?? "PENDING"}</strong><small>{step.evidence?.checked_at ?? "Sem evidência de onboarding registrada; não indica falha do LIVE existente."}</small></li>)}</ol>
    {current?.environment === "REAL" ? <button type="button" className="px-button" disabled={busy} onClick={async () => {
      setBusy(true); setMessage(""); try { const result = await verifyAccountOnboardingReadOnly({ accountId: current.accountId, engineId: current.engineId });
        setMessage(`${result.status}: ${result.code}`); } catch (error) { setMessage(code(error)); } finally { setBusy(false); }
    }}>Verificar GET READ-ONLY · sem ordens</button> : null}
    <details><summary>Preparar nova conta/motor inativo</summary>
      <p>Cria somente rascunho administrativo com kill switch ON. Credenciais são instaladas pelo fluxo seguro do executor, fora do browser. A ativação é uma etapa futura, separada e bloqueada aqui.</p>
      <form className="px-onboarding-form" onSubmit={async (event) => {
        event.preventDefault(); const form = new FormData(event.currentTarget);
        const target = ids ?? { accountId: crypto.randomUUID(), engineId: crypto.randomUUID() }; setIds(target); setBusy(true); setMessage("");
        const input = { ...target, ...Object.fromEntries(form.entries()) } as AccountDraft;
        try { await saveAccountOnboardingDraft(input); setMessage("Rascunho salvo: INACTIVE, kill switch ON. Nenhuma credencial foi copiada e nenhuma ordem foi enviada."); }
        catch (error) { setMessage(code(error)); } finally { setBusy(false); }
      }}>
        <label>Nome da conta<input name="displayName" maxLength={80} required autoComplete="off" /></label>
        <label>Ambiente<select name="environment" defaultValue="REAL"><option value="REAL">Real · inativo</option><option value="SHADOW">Shadow</option><option value="TESTNET">Testnet</option></select></label>
        <label>Mercado<select name="symbol" defaultValue="BTCBRL">{["BTCBRL", "SOLBRL", "BTCUSDT", "SOLUSDT", "BTCUSDC", "SOLUSDC"].map((symbol) => <option key={symbol}>{symbol}</option>)}</select></label>
        {[["capital", "Capital lógico · moeda do par"], ["engineCap", "Hard cap do motor"], ["accountCap", "Hard cap conta/moeda"], ["gainPercent", "Gain %"], ["spacingPercent", "Queda normal %"], ["postAthPercent", "Queda pós-ATH %"]].map(([name, label]) => <label key={name}>{label}<input name={name} type="number" min="0.00000001" step="any" required /></label>)}
        <button type="submit" className="px-button" disabled={busy}>Salvar rascunho inativo</button>
      </form>
    </details>
    {message ? <p role="status">{message}</p> : null}
  </section>;
}

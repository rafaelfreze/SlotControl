"use client";

import { useEffect, useState } from "react";
import { applicationKey, subscriptionUsesKey } from "./push-subscription-key";

type Status = { active: boolean; warningEnabled: boolean; lastSuccessAt: string | null; lastFailureCode: string | null };

const pushErrors: Record<string, string> = {
  COINOPS_PUSH_SUBSCRIPTION_EXPIRED: "A assinatura anterior expirou. Tente ativar novamente para criar uma nova neste iPhone.",
  COINOPS_PUSH_PROVIDER_AUTH_FAILED: "O serviço de notificações recusou a autenticação do CoinOps. Nenhum dispositivo foi ativado; avise o suporte.",
  COINOPS_PUSH_PROVIDER_THROTTLED: "O serviço de notificações está limitando pedidos. Aguarde alguns minutos e tente novamente.",
  COINOPS_PUSH_PROVIDER_UNAVAILABLE: "O serviço de notificações não confirmou o dispositivo. Tente novamente em instantes.",
  COINOPS_PUSH_VAPID_PAIR_MISMATCH: "A configuração de notificações do servidor está inconsistente. Avise o suporte; nenhum dispositivo foi ativado.",
};

export function PushNotificationsPanel({ testnetEngines = [] }: { testnetEngines?: Array<{ id: string; label: string }> }) {
  const [publicKey, setPublicKey] = useState("");
  const [deviceCount, setDeviceCount] = useState(0);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [probeEngine, setProbeEngine] = useState("");
  const supported = typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const ios = typeof navigator !== "undefined" && /iPhone|iPad/i.test(navigator.userAgent);
  const standalone = typeof window !== "undefined" && (window.matchMedia("(display-mode: standalone)").matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true);

  async function request(action: string, subscription: PushSubscription, extra: Record<string, unknown> = {}) {
    const response = await fetch("/api/coinops-push", { method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "content-type": "application/json", "x-coinops-admin-intent": "push-device" },
      body: JSON.stringify({ action, subscription: subscription.toJSON(), ...extra }) });
    const result = await response.json();
    if (!response.ok) throw new Error(pushErrors[result.error] ?? result.error ?? "Falha na configuração push");
    return result;
  }

  async function currentSubscription() {
    const registration = await navigator.serviceWorker.getRegistration("/");
    return registration?.pushManager.getSubscription() ?? null;
  }

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    void (async () => {
      const response = await fetch("/api/coinops-push", { credentials: "same-origin", cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(pushErrors[result.error] ?? result.error ?? "Configuração indisponível");
      const subscription = await currentSubscription();
      const local = subscription ? await request("STATUS", subscription) : null;
      if (!cancelled) { setPublicKey(result.publicKey); setDeviceCount(result.activeDeviceCount ?? 0);
        setStatus(local ?? { active: false, warningEnabled: true, lastSuccessAt: null, lastFailureCode: null }); }
    })().catch((error) => { if (!cancelled) setMessage(error instanceof Error ? error.message : "Push indisponível"); });
    return () => { cancelled = true; };
  }, [supported]);

  async function enable() {
    if (!supported || !publicKey) return;
    setBusy(true); setMessage("");
    try {
      if (ios && !standalone) throw new Error("No iPhone, adicione CoinOps à Tela de Início e abra pelo ícone antes de ativar.");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Permissão de notificações não concedida neste dispositivo.");
      const registration = await navigator.serviceWorker.register("/coinops-sw.js", { scope: "/" });
      let subscription = await registration.pushManager.getSubscription();
      if (subscription && !subscriptionUsesKey(subscription, publicKey)) {
        if (!await subscription.unsubscribe()) throw new Error("Não foi possível substituir a assinatura antiga neste iPhone.");
        subscription = null;
      }
      subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true,
        applicationServerKey: applicationKey(publicKey) });
      const result = await request("REGISTER", subscription);
      setStatus({ active: true, warningEnabled: true, lastSuccessAt: new Date().toISOString(), lastFailureCode: null });
      setDeviceCount((count) => count + (result.alreadyRegistered ? 0 : 1));
      setMessage(result.tested ? "Notificações ativas. O envio de confirmação foi solicitado." : "Notificações já ativas neste dispositivo.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Não foi possível ativar."); }
    finally { setBusy(false); }
  }

  async function act(action: "TEST" | "DISABLE" | "PREFERENCES" | "TESTNET_PROBE", extra: Record<string, unknown> = {}) {
    setBusy(true); setMessage("");
    try {
      const subscription = await currentSubscription();
      if (!subscription) throw new Error("Este dispositivo não possui subscription ativa.");
      const result = await request(action, subscription, extra);
      if (action === "DISABLE") { await subscription.unsubscribe(); setStatus({ active: false, warningEnabled: true,
        lastSuccessAt: null, lastFailureCode: null }); setDeviceCount((count) => Math.max(0, count - 1));
        setMessage("Notificações desativadas neste dispositivo."); }
      else if (action === "TEST") setMessage("Notificação de teste enviada. Confira as notificações do dispositivo.");
      else if (action === "TESTNET_PROBE") setMessage("Alerta controlado Testnet registrado; envio pelo servidor no próximo minuto. Nenhuma ordem foi alterada.");
      else { setStatus((current) => current ? { ...current, warningEnabled: result.warningEnabled } : current);
        setMessage("Preferência salva."); }
    } catch (error) { setMessage(error instanceof Error ? error.message : "Operação indisponível."); }
    finally { setBusy(false); }
  }

  return <section className="px-onboarding" aria-label="Notificações operacionais">
    <h2>Notificações</h2>
    <p>Alertas críticos de todos os seus motores, inclusive com CoinOps fechado. Cada aparelho precisa ser ativado separadamente.</p>
    {ios && !standalone ? <p>iPhone: Compartilhar → Adicionar à Tela de Início → abrir CoinOps pelo ícone → Ativar notificações.</p> : null}
    {!supported ? <p>Este navegador não oferece Web Push. No iPhone, use o aplicativo da Tela de Início.</p> : null}
    <p role="status">{status?.active ? "● NOTIFICAÇÕES ATIVAS neste dispositivo" : "Notificações desativadas neste dispositivo"} · {deviceCount} dispositivo(s) ativo(s)</p>
    {status?.lastFailureCode ? <p>Última falha: {status.lastFailureCode}</p> : null}
    <div className="px-account-permissions">
      {!status?.active ? <button type="button" className="px-button" disabled={!supported || !publicKey || busy} onClick={() => void enable()}>Ativar notificações neste dispositivo</button>
        : <><button type="button" className="px-button" disabled={busy} onClick={() => void act("TEST")}>Enviar notificação de teste</button>
          <button type="button" className="px-button" disabled={busy} onClick={() => void act("DISABLE")}>Desativar neste dispositivo</button>
          <label><input type="checkbox" checked={status.warningEnabled} disabled={busy}
            onChange={(event) => void act("PREFERENCES", { warningEnabled: event.target.checked })} /> Receber warnings operacionais</label></>}
    </div>
    {status?.active && testnetEngines.length ? <div className="px-account-permissions"><label>Teste controlado Testnet
      <select value={probeEngine} onChange={(event) => setProbeEngine(event.target.value)}>
        <option value="">Selecione um motor Testnet</option>
        {testnetEngines.map((engine) => <option value={engine.id} key={engine.id}>{engine.label}</option>)}
      </select></label><button type="button" className="px-button" disabled={busy || !probeEngine}
        onClick={() => void act("TESTNET_PROBE", { engineId: probeEngine })}>Testar alerta Testnet</button></div> : null}
    <small>CRITICAL sempre envia push. INFO permanece somente no painel. Nenhuma notificação inicia ou altera ordens.</small>
    {message ? <p role="alert">{message}</p> : null}
  </section>;
}

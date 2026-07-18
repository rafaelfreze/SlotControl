"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { deactivateCurrentPushSubscription, deactivatePushSubscription, saveNotificationPreferences, savePushSubscription, sendPushTestNotification } from "@/app/config/notification-actions";
import { activatePushNotificationsOnThisDevice, activePushSubscriptionCount, getLocalPushSubscription, getPushCapability, getPushClientErrorMessage, getPushPlatform, isStandaloneApp } from "@/lib/push/client";
import { type NotificationPreferences, type PushPlatform, type PushSubscriptionRecord } from "@/lib/push/types";

type PermissionState = "unsupported" | "requires-pwa" | "default" | "granted" | "denied" | "insecure";
type CurrentDeviceState = "checking" | "inactive" | "active" | "needs-sync";

type Props = {
  initialPreferences: NotificationPreferences;
  subscriptions: PushSubscriptionRecord[];
  vapidPublicKey: string | null;
};

function getPermissionState(): PermissionState {
  if (typeof window === "undefined") return "unsupported";
  const platform = getPushPlatform(navigator.userAgent || "");
  const capability = getPushCapability({
    secure: window.isSecureContext,
    hasServiceWorker: "serviceWorker" in navigator,
    hasPushManager: "PushManager" in window,
    hasNotification: "Notification" in window,
    platform,
    standalone: isStandaloneApp(window.matchMedia("(display-mode: standalone)").matches, (navigator as Navigator & { standalone?: boolean }).standalone === true)
  });
  if (capability === "unsupported" || capability === "requires-pwa" || capability === "insecure") return capability;
  return Notification.permission;
}

function deviceName(subscription: PushSubscriptionRecord) {
  if (subscription.device_name) return subscription.device_name;
  if (subscription.platform === "ios") return "iPhone ou iPad";
  if (subscription.platform === "android") return "Android";
  if (subscription.platform === "desktop") return "Computador";
  return "Dispositivo";
}

export function PushNotificationsSettings({ initialPreferences, subscriptions, vapidPublicKey }: Props) {
  const [preferences, setPreferences] = useState(initialPreferences);
  const [permission, setPermission] = useState<PermissionState>("unsupported");
  const [currentDevice, setCurrentDevice] = useState<CurrentDeviceState>("checking");
  const [currentEndpoint, setCurrentEndpoint] = useState<string | null>(null);
  const [activeCount, setActiveCount] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const activeSubscriptions = useMemo(() => subscriptions.filter((item) => item.is_active && !item.revoked_at), [subscriptions]);

  useEffect(() => {
    setActiveCount(activePushSubscriptionCount(activeSubscriptions));
  }, [activeSubscriptions]);

  useEffect(() => {
    let cancelled = false;
    setPermission(getPermissionState());
    void (async () => {
      try {
        const subscription = await getLocalPushSubscription();
        if (cancelled) return;
        if (!subscription) {
          setCurrentEndpoint(null);
          setCurrentDevice("inactive");
          return;
        }
        setCurrentEndpoint(subscription.endpoint);
        setCurrentDevice(activeSubscriptions.some((item) => item.endpoint === subscription.endpoint) ? "active" : "needs-sync");
      } catch (error) {
        if (!cancelled) {
          setCurrentDevice("inactive");
          setLastError(getPushClientErrorMessage(error));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSubscriptions]);

  function reportError(error: unknown, fallback: string) {
    const message = error instanceof Error ? error.message : fallback;
    setLastError(message);
    setNotice(message);
  }

  function persistPreferences(next: NotificationPreferences) {
    setPreferences(next);
    startTransition(async () => {
      try {
        await saveNotificationPreferences(next);
        router.refresh();
        setNotice("Preferências de notificações salvas.");
      } catch (error) {
        setPreferences(initialPreferences);
        reportError(error, "Não foi possível salvar as preferências.");
      }
    });
  }

  function activate() {
    startTransition(async () => {
      try {
        const subscription = await activatePushNotificationsOnThisDevice(vapidPublicKey || "");
        const result = await savePushSubscription({
          endpoint: subscription.endpoint,
          p256dh: subscription.p256dh,
          auth: subscription.auth,
          userAgent: subscription.userAgent,
          platform: subscription.platform
        });
        setPermission("granted");
        setCurrentEndpoint(subscription.endpoint);
        setCurrentDevice("active");
        setActiveCount(result.activeCount);
        setLastError(null);
        router.refresh();
        setNotice(subscription.created ? "Notificações ativas neste celular." : "A inscrição existente deste celular foi sincronizada e está ativa.");
      } catch (error) {
        setPermission(getPermissionState());
        reportError(error, "Não foi possível ativar as notificações neste celular.");
      }
    });
  }

  function deactivateThisDevice() {
    startTransition(async () => {
      try {
        const subscription = await getLocalPushSubscription();
        if (!subscription) {
          throw new Error("Não foi encontrada uma inscrição local neste celular.");
        }

        let browserUnsubscribeFailed = false;
        try {
          await subscription.unsubscribe();
        } catch {
          browserUnsubscribeFailed = true;
        }
        const result = await deactivateCurrentPushSubscription(subscription.endpoint);
        setCurrentEndpoint(null);
        setCurrentDevice("inactive");
        setActiveCount(result.activeCount);
        setLastError(null);
        router.refresh();
        setNotice(browserUnsubscribeFailed ? "O dispositivo foi desativado no servidor. Reabra o aplicativo para concluir a limpeza local." : "Notificações desativadas neste celular.");
      } catch (error) {
        reportError(error, "Não foi possível desativar as notificações neste celular.");
      }
    });
  }

  function testNotification() {
    startTransition(async () => {
      try {
        const result = await sendPushTestNotification();
        setActiveCount(result.activeCount);
        setLastError(null);
        setNotice(result.queued ? "Teste enfileirado para envio." : "Notificação de teste enviada pelo pipeline de produção.");
      } catch (error) {
        reportError(error, "Não foi possível enviar o teste.");
      }
    });
  }

  const permissionLabel: Record<PermissionState, string> = {
    unsupported: "Indisponível neste navegador",
    "requires-pwa": "Requer instalação como aplicativo/PWA",
    insecure: "Requer conexão HTTPS",
    default: "Permissão ainda não solicitada",
    granted: "Permissão autorizada",
    denied: "Permissão negada"
  };
  const currentDeviceLabel: Record<CurrentDeviceState, string> = {
    checking: "Verificando inscrição local",
    inactive: "Não ativado",
    active: "Ativo",
    "needs-sync": "Inscrição local ainda não sincronizada"
  };
  const canActivate = !isPending && permission !== "denied" && permission !== "unsupported" && permission !== "insecure" && permission !== "requires-pwa";

  return (
    <section className="section-card push-notifications-card">
      <div className="section-card-heading">
        <div><strong>Notificações</strong><span>Entradas e saídas confirmadas</span></div>
      </div>
      {notice ? <p className="form-success">{notice}</p> : null}
      <div className="settings-list modern-settings">
        <div><span>Permissão</span><strong>{permissionLabel[permission]}</strong></div>
        <div><span>Este celular</span><strong>{currentDeviceLabel[currentDevice]}</strong></div>
        <div><span>Dispositivos ativos</span><strong>{activeCount}</strong></div>
      </div>
      {permission === "requires-pwa" ? <p className="settings-hint">No iPhone/iPad, toque em Compartilhar, escolha “Adicionar à Tela de Início” e abra o Slot Control pelo ícone instalado.</p> : null}
      {permission === "denied" ? <p className="settings-hint">A permissão foi bloqueada. Reative-a nas configurações do Safari, Chrome ou do sistema operacional.</p> : null}
      <div className="push-actions">
        {currentDevice === "active" ? <button className="solid-button" type="button" disabled={isPending} onClick={deactivateThisDevice}>Desativar neste celular</button> : <button className="solid-button" type="button" disabled={!canActivate} onClick={activate}>{currentDevice === "needs-sync" ? "Sincronizar notificações neste celular" : "Ativar notificações neste celular"}</button>}
        <button className="ghost-button compact-action" type="button" disabled={isPending || !activeCount || !preferences.global_enabled} onClick={testNotification}>Enviar notificação de teste</button>
      </div>
      <fieldset className="notification-preferences" disabled={isPending}>
        <legend>Preferências</legend>
        {[
          ["btc_entry_enabled", "Avisar entrada de BTC"], ["btc_exit_enabled", "Avisar saída de BTC"],
          ["sol_entry_enabled", "Avisar entrada de SOL"], ["sol_exit_enabled", "Avisar saída de SOL"],
          ["automatic_events_enabled", "Eventos automáticos"], ["manual_events_enabled", "Eventos manuais"],
          ["privacy_mode", "Ocultar valores na tela bloqueada"]
        ].map(([key, label]) => <label key={key} className="notification-checkbox"><input type="checkbox" checked={Boolean(preferences[key as keyof NotificationPreferences])} onChange={(event) => persistPreferences({ ...preferences, [key]: event.target.checked })} />{label}</label>)}
      </fieldset>
      <details className="settings-hint"><summary>Diagnóstico técnico</summary><div>Service Worker: {permission === "unsupported" ? "indisponível" : "verificado no navegador"}</div><div>PushManager: {permission === "unsupported" ? "indisponível" : "compatível"}</div><div>Modo instalado: {getPushPlatform(typeof navigator === "undefined" ? "" : navigator.userAgent) === "ios" ? (permission === "requires-pwa" ? "não" : "sim") : "não aplicável"}</div><div>Inscrição local: {currentEndpoint ? "encontrada" : "não encontrada"}</div><div>Inscrição no backend: {currentDevice === "active" ? "ativa" : currentDevice === "needs-sync" ? "pendente de sincronização" : "não encontrada"}</div>{lastError ? <div>Último erro: {lastError}</div> : null}</details>
      {subscriptions.length ? <div className="registered-devices"><strong>Dispositivos cadastrados</strong>{subscriptions.map((subscription) => <div className="registered-device" key={subscription.id}><span>{deviceName(subscription)} · {subscription.platform} · {subscription.is_active && !subscription.revoked_at ? "ativo" : "desativado"}</span><small>Ativado em {new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" }).format(new Date(subscription.created_at))}{subscription.last_success_at ? " · último envio confirmado" : ""}</small>{subscription.is_active && !subscription.revoked_at ? <button type="button" className="danger-button compact-action" disabled={isPending} onClick={() => startTransition(async () => { try { const result = await deactivatePushSubscription(subscription.id); setActiveCount(result.activeCount); if (subscription.endpoint === currentEndpoint) setCurrentDevice("inactive"); router.refresh(); setNotice("Dispositivo desativado."); } catch (error) { reportError(error, "Não foi possível desativar o dispositivo."); } })}>Desativar</button> : null}</div>)}</div> : null}
    </section>
  );
}

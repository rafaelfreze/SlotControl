"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { removePushSubscription, saveNotificationPreferences, savePushSubscription, sendPushTestNotification } from "@/app/config/notification-actions";
import { urlBase64ToUint8Array } from "@/lib/push/payload";
import { type NotificationPreferences, type PushPlatform, type PushSubscriptionRecord } from "@/lib/push/types";

type PermissionState = "unsupported" | "requires-pwa" | "default" | "granted" | "denied";

type Props = {
  initialPreferences: NotificationPreferences;
  subscriptions: PushSubscriptionRecord[];
  vapidPublicKey: string | null;
};

function getPlatform(): PushPlatform {
  const userAgent = navigator.userAgent || "";
  if (/iPad|iPhone|iPod/.test(userAgent)) return "ios";
  if (/Android/.test(userAgent)) return "android";
  if (userAgent) return "desktop";
  return "unknown";
}

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function getPermissionState(): PermissionState {
  if (!window.isSecureContext || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  if (getPlatform() === "ios" && !isStandalone()) return "requires-pwa";
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
  const [notice, setNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const activeSubscriptions = useMemo(() => subscriptions.filter((item) => item.is_active), [subscriptions]);

  useEffect(() => {
    setPermission(getPermissionState());
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => setNotice("Não foi possível preparar o serviço de notificações neste navegador."));
    }
  }, []);

  function persistPreferences(next: NotificationPreferences) {
    setPreferences(next);
    startTransition(async () => {
      try {
        await saveNotificationPreferences(next);
        router.refresh();
        setNotice("Preferências de notificações salvas.");
      } catch (error) {
        setPreferences(initialPreferences);
        setNotice(error instanceof Error ? error.message : "Não foi possível salvar as preferências.");
      }
    });
  }

  function activate() {
    if (!vapidPublicKey) {
      setNotice("As chaves de notificações ainda não estão configuradas no ambiente publicado.");
      return;
    }

    startTransition(async () => {
      try {
        const currentPermission = getPermissionState();
        if (currentPermission === "requires-pwa") {
          setPermission(currentPermission);
          setNotice("No iPhone/iPad, adicione o Slot Control à Tela de Início e abra pelo ícone antes de ativar.");
          return;
        }
        if (currentPermission === "unsupported") {
          setPermission(currentPermission);
          setNotice("Este navegador não oferece suporte a notificações push.");
          return;
        }
        const requested = currentPermission === "default" ? await Notification.requestPermission() : currentPermission;
        setPermission(requested);
        if (requested !== "granted") {
          setNotice("A permissão foi negada. Reative-a nas configurações do navegador ou do sistema.");
          return;
        }

        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) });
        const json = subscription.toJSON();
        if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error("O navegador não retornou uma inscrição push válida.");

        await savePushSubscription({
          endpoint: json.endpoint,
          p256dh: json.keys.p256dh,
          auth: json.keys.auth,
          userAgent: navigator.userAgent,
          platform: getPlatform()
        });
        router.refresh();
        setNotice("Notificações ativas neste celular.");
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Não foi possível ativar as notificações neste celular.");
      }
    });
  }

  function testNotification() {
    startTransition(async () => {
      try {
        const result = await sendPushTestNotification();
        setNotice(result.queued ? "Teste enfileirado para envio." : "Notificação de teste enviada para os dispositivos ativos.");
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Não foi possível enviar o teste.");
      }
    });
  }

  const permissionLabel: Record<PermissionState, string> = {
    unsupported: "Indisponível neste navegador",
    "requires-pwa": "Requer instalação como aplicativo/PWA",
    default: "Permissão ainda não solicitada",
    granted: "Permissão autorizada",
    denied: "Permissão negada"
  };

  return (
    <section className="section-card push-notifications-card">
      <div className="section-card-heading">
        <div><strong>Notificações</strong><span>Entradas e saídas confirmadas</span></div>
      </div>
      {notice ? <p className="form-success">{notice}</p> : null}
      <div className="settings-list modern-settings">
        <div><span>Permissão</span><strong>{permissionLabel[permission]}</strong></div>
        <div><span>Dispositivos ativos</span><strong>{activeSubscriptions.length}</strong></div>
      </div>
      {permission === "requires-pwa" ? <p className="settings-hint">No iPhone/iPad, toque em Compartilhar, escolha “Adicionar à Tela de Início” e abra o Slot Control pelo ícone instalado.</p> : null}
      {permission === "denied" ? <p className="settings-hint">A permissão foi bloqueada. Reative-a nas configurações do Safari, Chrome ou do sistema operacional.</p> : null}
      <div className="push-actions">
        <button className="solid-button" type="button" disabled={isPending || permission === "denied"} onClick={activate}>
          {activeSubscriptions.length ? "Notificações ativas neste celular" : "Ativar notificações neste celular"}
        </button>
        <button className="ghost-button compact-action" type="button" disabled={isPending || !activeSubscriptions.length || !preferences.global_enabled} onClick={testNotification}>Enviar notificação de teste</button>
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
      {subscriptions.length ? <div className="registered-devices"><strong>Dispositivos cadastrados</strong>{subscriptions.map((subscription) => <div className="registered-device" key={subscription.id}><span>{deviceName(subscription)} · {subscription.platform}</span><small>Ativado em {new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" }).format(new Date(subscription.created_at))}{subscription.last_success_at ? " · último envio confirmado" : ""}</small><button type="button" className="danger-button compact-action" disabled={isPending} onClick={() => startTransition(async () => { try { await removePushSubscription(subscription.id); router.refresh(); setNotice("Dispositivo removido."); } catch { setNotice("Não foi possível remover o dispositivo."); } })}>Remover</button></div>)}</div> : null}
    </section>
  );
}

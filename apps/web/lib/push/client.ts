import { urlBase64ToUint8Array } from "./payload";
import { getPushCapability, getPushPlatform, isStandaloneApp, shouldCreatePushSubscription, type PushCapability } from "./client-state";

export { activePushSubscriptionCount, getPushCapability, getPushPlatform, isStandaloneApp, shouldCreatePushSubscription, type PushCapability } from "./client-state";

export class PushClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PushClientError";
    this.code = code;
  }
}

export type SerializedPushSubscription = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type CurrentPushDeviceDiagnostics = {
  permission: NotificationPermission | "unsupported";
  serviceWorkerSupported: boolean;
  pushManagerSupported: boolean;
  standalone: boolean;
  serviceWorkerRegistered: boolean;
  serviceWorkerControllingPage: boolean;
  localSubscriptionPresent: boolean;
  endpointPresent: boolean;
  p256dhLength: number;
  authLength: number;
  error: string | null;
};

function getBrowserCapability(): PushCapability {
  const platform = getPushPlatform(navigator.userAgent || "");
  const standalone = isStandaloneApp(
    window.matchMedia("(display-mode: standalone)").matches,
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );

  return getPushCapability({
    secure: window.isSecureContext,
    hasServiceWorker: "serviceWorker" in navigator,
    hasPushManager: "PushManager" in window,
    hasNotification: "Notification" in window,
    platform,
    standalone
  });
}

function capabilityError(capability: PushCapability): never {
  if (capability === "requires-pwa") {
    throw new PushClientError("requires_pwa", "Para receber notificações no iPhone, abra este aplicativo pela Tela de Início.");
  }
  if (capability === "insecure") {
    throw new PushClientError("insecure", "As notificações exigem uma conexão segura (HTTPS).");
  }
  throw new PushClientError("unsupported", "Este navegador não oferece suporte a notificações push.");
}

function base64FromArrayBuffer(value: ArrayBuffer | null) {
  if (!value) return null;
  const bytes = new Uint8Array(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return window.btoa(binary);
}

export function serializePushSubscription(subscription: PushSubscription): SerializedPushSubscription {
  const json = subscription.toJSON();
  const endpoint = json.endpoint || subscription.endpoint;
  const p256dh = json.keys?.p256dh || base64FromArrayBuffer(subscription.getKey("p256dh"));
  const auth = json.keys?.auth || base64FromArrayBuffer(subscription.getKey("auth"));

  if (!endpoint || !p256dh || !auth) {
    throw new PushClientError("invalid_subscription", "O navegador não retornou uma inscrição push válida.");
  }

  return { endpoint, p256dh, auth };
}

export async function getPushRegistration() {
  const capability = getBrowserCapability();
  if (capability !== "ready") capabilityError(capability);

  const expectedScope = new URL("/", window.location.origin).href;
  let registration: ServiceWorkerRegistration;
  try {
    registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch {
    throw new PushClientError("service_worker_registration", "Não foi possível registrar o serviço de notificações neste navegador.");
  }

  if (registration.scope !== expectedScope) {
    throw new PushClientError("service_worker_scope", "O serviço de notificações foi registrado com um escopo inválido.");
  }

  let ready: ServiceWorkerRegistration;
  try {
    ready = await navigator.serviceWorker.ready;
  } catch {
    throw new PushClientError("service_worker_ready", "O serviço de notificações não ficou pronto. Atualize o aplicativo e tente novamente.");
  }

  if (ready.scope !== expectedScope || !ready.active) {
    throw new PushClientError("service_worker_ready", "O serviço de notificações não ficou ativo no escopo do aplicativo.");
  }

  return ready;
}

export async function getLocalPushSubscription() {
  const capability = getBrowserCapability();
  if (capability !== "ready") return null;
  const registration = await getPushRegistration();
  return registration.pushManager.getSubscription();
}

export async function inspectCurrentPushDevice(): Promise<CurrentPushDeviceDiagnostics> {
  if (typeof window === "undefined") {
    return { permission: "unsupported", serviceWorkerSupported: false, pushManagerSupported: false, standalone: false, serviceWorkerRegistered: false, serviceWorkerControllingPage: false, localSubscriptionPresent: false, endpointPresent: false, p256dhLength: 0, authLength: 0, error: null };
  }
  const serviceWorkerSupported = "serviceWorker" in navigator;
  const pushManagerSupported = "PushManager" in window;
  const standalone = isStandaloneApp(window.matchMedia("(display-mode: standalone)").matches, (navigator as Navigator & { standalone?: boolean }).standalone === true);
  const base = {
    permission: "Notification" in window ? Notification.permission : "unsupported" as const,
    serviceWorkerSupported,
    pushManagerSupported,
    standalone,
    serviceWorkerRegistered: false,
    serviceWorkerControllingPage: serviceWorkerSupported && Boolean(navigator.serviceWorker.controller),
    localSubscriptionPresent: false,
    endpointPresent: false,
    p256dhLength: 0,
    authLength: 0,
    error: null as string | null
  };
  if (!serviceWorkerSupported || !pushManagerSupported) return base;
  try {
    const registration = await getPushRegistration();
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return { ...base, serviceWorkerRegistered: true };
    const serialized = serializePushSubscription(subscription);
    return {
      ...base,
      serviceWorkerRegistered: true,
      serviceWorkerControllingPage: Boolean(navigator.serviceWorker.controller),
      localSubscriptionPresent: true,
      endpointPresent: Boolean(serialized.endpoint),
      p256dhLength: serialized.p256dh.length,
      authLength: serialized.auth.length
    };
  } catch (error) {
    return { ...base, error: getPushClientErrorMessage(error) };
  }
}

export async function activatePushNotificationsOnThisDevice(vapidPublicKey: string) {
  if (!vapidPublicKey?.trim()) {
    throw new PushClientError("vapid_missing", "A chave pública de notificações não está configurada no ambiente publicado.");
  }

  const capability = getBrowserCapability();
  if (capability !== "ready") capabilityError(capability);

  const registration = await getPushRegistration();
  const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  if (permission !== "granted") {
    throw new PushClientError("permission_denied", "A permissão foi negada. Reative-a nas configurações do navegador ou do sistema.");
  }

  let subscription = await registration.pushManager.getSubscription();
  const created = shouldCreatePushSubscription(subscription);
  if (created) {
    try {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey.trim())
      });
    } catch (error) {
      if (error instanceof PushClientError) throw error;
      throw new PushClientError("subscribe_failed", "Não foi possível criar a inscrição push neste celular. Verifique a permissão e tente novamente.");
    }
  }

  if (!subscription) {
    throw new PushClientError("subscription_missing", "Não foi possível recuperar a inscrição push deste celular.");
  }

  return { ...serializePushSubscription(subscription), created, platform: getPushPlatform(navigator.userAgent || ""), userAgent: navigator.userAgent || "" };
}

export function getPushClientErrorMessage(error: unknown) {
  if (error instanceof PushClientError) return error.message;
  return "Não foi possível ativar as notificações neste celular. Verifique sua conexão e tente novamente.";
}

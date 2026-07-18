import type { PushPlatform, PushSubscriptionRecord } from "./types";

export type PushCapability = "ready" | "unsupported" | "requires-pwa" | "insecure";

export function getPushPlatform(userAgent: string): PushPlatform {
  if (/iPad|iPhone|iPod/.test(userAgent)) return "ios";
  if (/Android/.test(userAgent)) return "android";
  if (userAgent) return "desktop";
  return "unknown";
}

export function isStandaloneApp(displayModeStandalone: boolean, safariStandalone: boolean) {
  return displayModeStandalone || safariStandalone;
}

export function getPushCapability(input: {
  secure: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  platform: PushPlatform;
  standalone: boolean;
}): PushCapability {
  if (!input.secure) return "insecure";
  if (!input.hasServiceWorker || !input.hasPushManager || !input.hasNotification) return "unsupported";
  if (input.platform === "ios" && !input.standalone) return "requires-pwa";
  return "ready";
}

export function shouldCreatePushSubscription(existing: Pick<PushSubscription, "endpoint"> | null) {
  return !existing?.endpoint;
}

export function activePushSubscriptionCount(records: ReadonlyArray<Pick<PushSubscriptionRecord, "endpoint" | "is_active" | "revoked_at">>) {
  return new Set(records.filter((record) => record.is_active && !record.revoked_at && record.endpoint.startsWith("https://")).map((record) => record.endpoint)).size;
}

export type PushPlatform = "ios" | "android" | "desktop" | "unknown";
export type PushOrigin = "manual" | "automatic" | "test";
export type PushEventType = "slot_entry" | "slot_exit" | "test";

export type NotificationPreferences = {
  global_enabled: boolean;
  btc_entry_enabled: boolean;
  btc_exit_enabled: boolean;
  sol_entry_enabled: boolean;
  sol_exit_enabled: boolean;
  manual_events_enabled: boolean;
  automatic_events_enabled: boolean;
  privacy_mode: boolean;
  quiet_hours_enabled: boolean;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
};

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  global_enabled: false,
  btc_entry_enabled: true,
  btc_exit_enabled: true,
  sol_entry_enabled: true,
  sol_exit_enabled: true,
  manual_events_enabled: true,
  automatic_events_enabled: true,
  privacy_mode: false,
  quiet_hours_enabled: false,
  quiet_hours_start: null,
  quiet_hours_end: null
};

export type PushSubscriptionRecord = {
  id: string;
  endpoint: string;
  user_agent: string | null;
  device_name: string | null;
  platform: PushPlatform;
  is_active: boolean;
  created_at: string;
  last_success_at: string | null;
  last_seen_at: string | null;
  revoked_at: string | null;
};

export type PushOutboxRecord = {
  id: string;
  event_id: string;
  user_id: string;
  event_type: PushEventType;
  origin: PushOrigin;
  asset: "BTC" | "SOL" | null;
  slot_id: string | null;
  operation_id: string | null;
  payload: Record<string, unknown>;
  status: "pending" | "processing" | "sent" | "partial" | "failed" | "cancelled";
  attempt_count: number;
};

export type PushNotificationContent = {
  title: string;
  body: string;
  tag: string;
  url: string;
  data: Record<string, unknown>;
};

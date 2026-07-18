import { createHash } from "node:crypto";

/**
 * The Web Push Topic header only accepts URL-safe Base64 characters and at
 * most 32 characters. Notification tags are intentionally more expressive,
 * so never send them as the transport topic directly.
 */
export function createWebPushTopic(tag: string) {
  return createHash("sha256").update(tag).digest("base64url").slice(0, 32);
}

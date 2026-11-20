/** Local, anonymous event receipts. No identity, attribution or payload is kept
 * here or sent to the server; the clock is only a 30-minute inactivity limit. */
export declare const ACTIVITY_INACTIVITY_MS: number;
export type ActivityDedupeFlag = "qualified" | "whatsapp" | "phone" | "form";
export type ActivityDedupeReceipt = {
    version: 1;
    activeAt: number;
    qualified: boolean;
    whatsapp: boolean;
    phone: boolean;
    form: boolean;
};
export declare function activityDedupeKey(endpoint: string, slug?: string, sessionKey?: string): string;
/** Reads and OR-merges receipts before every claim. Reading never renews time. */
export declare function readActivityDedupe(key: string): ActivityDedupeReceipt | undefined;
/** Only the first observed page/gesture starts a missing receipt. Existing
 * navigation and refresh retain the last real activity, without extending it. */
export declare function ensureActivityDedupe(key: string, initialAt?: number): ActivityDedupeReceipt;
/** Called only after the existing engagement observer validates a real gesture. */
export declare function touchActivityDedupe(key: string): ActivityDedupeReceipt;
/** Synchronous claim precedes network work, including the bounded retry. */
export declare function claimActivityDedupe(key: string, flag: ActivityDedupeFlag): boolean;
/** Flush the last gesture clock, never the time of pagehide/unmount itself. */
export declare function flushActivityDedupe(key: string): void;

export declare function claimOperationalEvent(event: Event, scope: string): boolean;
/** One ephemeral transport receipt, reused on a single bounded retry. Never a visitor ID. */
export declare function sendOperational(endpoint: string, payload: Record<string, unknown>): void;
export declare function operationalChannel(search: string, referrer: string): "google_ads" | "meta" | "organic" | "direct" | "unknown";

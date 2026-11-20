export declare const ACTIVITY_ACTIONS: readonly ["select_number", "reserve_request", "draw_request", "draw_start", "product_click", "category_click", "search", "add_to_order", "checkout_started", "checkout_order_submit", "whatsapp_order_submit", "shipping_quote", "order_view", "affiliate_registration"];
export declare const ACTIVITY_V2_EVENTS: readonly ["page_view", "scroll", "engaged", "link_click", "button_click", "qualified_session", "contact_intent"];
export type ActivityV2Event = typeof ACTIVITY_V2_EVENTS[number];
export type ActivityChannel = "google_ads" | "meta" | "organic" | "direct" | "other";
export type ActivityConsent = "accepted" | "declined" | "unknown";
export type ActivityQualification = {
    activeMs: number;
    interaction: "scroll" | "relevant_click" | "contact";
    scrollPercent?: number;
};
export type OperationalV2Input = {
    version: 2;
    eventId: string;
    occurredAt: string;
    eventName: ActivityV2Event;
    pagePath: string;
    detail: string;
    channel: ActivityChannel;
    campaign: string;
    device: "mobile" | "tablet" | "desktop" | "unknown";
    consent: ActivityConsent;
    identityScope: "tab" | "document";
    sessionToken: string;
    qualification?: ActivityQualification;
    slug?: string;
    attributionV1?: true;
    organicSocialNetworkV2?: "instagram" | "facebook" | "google";
};
export declare function activityV2Path(value: unknown): string | null;
export declare function activityCampaign(value: unknown): string;
/** Versioned, minimal envelope. Tenant/site/environment are server decisions. */
export declare function normalizeActivityV2(raw: unknown, now?: number, allowSlug?: boolean, acceptDetail?: (eventName: ActivityV2Event, detail: string) => boolean): OperationalV2Input | null;

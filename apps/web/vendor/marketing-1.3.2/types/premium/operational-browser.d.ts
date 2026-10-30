export type OperationalAction = "page_view" | "whatsapp_click" | "phone_click";
/** One ephemeral transport receipt, reused on a single bounded retry. Never a visitor ID. */
export declare function sendOperational(endpoint: string, payload: Record<string, unknown>): void;
export declare function operationalChannel(search: string, referrer: string): "google_ads" | "meta" | "organic" | "direct" | "unknown";
/** Attach only on public templates. No storage, tags, identifiers, URL query or message body. */
export declare function observeOperationalClicks({ endpoint, slug, root, sendView, onView, }: {
    endpoint: string;
    slug?: string;
    root?: string;
    sendView?: boolean;
    onView?: () => void;
}): () => void;

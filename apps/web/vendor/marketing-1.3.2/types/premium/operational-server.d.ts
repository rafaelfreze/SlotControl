export type OperationalInput = {
    version: 1;
    slug?: string;
    eventId: string;
    event: "page_view" | "whatsapp_click" | "phone_click";
    placement: string;
    page: "home" | "services" | "contact" | "other";
    channel: "google_ads" | "meta" | "organic" | "direct" | "unknown";
};
export declare function parseOperationalInput(raw: unknown): OperationalInput | null;
/** HTTP guard resolves tenant on the server from the published site and verified host. */
export declare function serveOperationalRequest(request: Request, resolve: (host: string, slug?: string) => Promise<string | null>, record: (tenant: string, input: OperationalInput) => Promise<boolean>, routePath?: "/api/marketing/operational" | "/api/marketing/platform"): Promise<Response>;

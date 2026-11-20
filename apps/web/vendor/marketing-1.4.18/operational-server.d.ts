import { type OperationalV2Input } from "./activity-contract.js";
export { normalizeActivityV2, ACTIVITY_V2_EVENTS, ACTIVITY_ACTIONS, type OperationalV2Input, type ActivityQualification } from "./activity-contract.js";
/** Runtime deployment identity cannot be supplied by the event payload. */
export declare function isProductionMeasurementEnvironment(env?: Record<string, string | undefined>): boolean;
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
export declare function serveOperationalRequest(request: Request, resolve: (host: string, slug?: string) => Promise<string | null>, record: (tenant: string, input: OperationalInput) => Promise<boolean>, routePath?: "/api/marketing/operational" | "/api/marketing/operational-v2" | "/api/marketing/platform", recordV2?: (tenant: string, input: OperationalV2Input) => Promise<boolean>): Promise<Response>;

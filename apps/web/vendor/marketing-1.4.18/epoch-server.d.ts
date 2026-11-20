import { type SourceSnapshot } from "../marketing-1.3.2/kit.mjs";
export type EpochProduct = "servnexx" | "zelyvara" | "onfood" | "nexxfitpro" | "onplay_finance" | "coinops";
export type MeasurementEpoch = {
    id: string;
    effectiveAt: string;
    instrumentationVersion: 2;
};
export type EngagementSnapshot = {
    version: 2;
    rawPageviews: number | null;
    qualifiedSessions: number | null;
    estimatedVisitors: number | null;
    contactIntents: number | null;
    whatsappClicks?: number | null;
    identityScope: "document" | "tab" | "mixed" | "unavailable";
    points: Array<{
        date: string;
        pageviews: number | null;
        qualifiedSessions: number | null;
        contactIntents: number | null;
        whatsappClicks?: number | null;
    }>;
};
export type EpochSnapshot = SourceSnapshot & {
    measurementEpoch: MeasurementEpoch;
    engagement?: EngagementSnapshot;
};
export type EpochRequest = {
    operation: "snapshot";
    externalTenant: string;
    from: string;
    to: string;
    epochId: string;
    effectiveAt: string;
    instrumentationVersion: 2;
};
export type EpochRpc = {
    rpc(name: "consume_marketing_hub_nonce" | "get_marketing_measurement_epoch_v2" | "marketing_measurement_snapshot_v2" | "record_marketing_activity_v2", args: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: unknown;
    }>;
};
/** The epoch metadata is a proof from the product registry, never an optional client hint. */
export declare function parseMeasurementEpoch(raw: unknown): MeasurementEpoch;
export declare function parseEpochRequest(raw: unknown): EpochRequest;
export declare function validateEpochSnapshot(raw: unknown, input: EpochRequest): EpochSnapshot;
/** Native caller must resolve membership/tenant permissions before invoking this product-local adapter. */
export declare function readLocalEpochSnapshot(input: {
    product: EpochProduct;
    externalTenant: string;
    from: string;
    to: string;
}, db: EpochRpc): Promise<EpochSnapshot>;
/** Use only with an already-validated request and a backend client fixed to this product schema. */
export declare function readProvenEpochSnapshot(input: EpochRequest, db: EpochRpc): Promise<EpochSnapshot>;
/** V2 has its own signed path and strict epoch DTO. V1 cannot silently satisfy this request. */
export declare function serveEpochExport(request: Request, product: EpochProduct, db: EpochRpc, secret: string): Promise<Response>;
/** Calendar default without altering the shared legacy period parser. */
export declare function monthPeriodSearch(search: Record<string, string | undefined>, now?: Date): Record<string, string | undefined>;
/** Combine only snapshots proven to belong to the same activation; never bridge v1 history. */
export declare function mergeEpochEngagement(parts: EpochSnapshot[]): {
    measurementEpoch: MeasurementEpoch;
    engagement?: EngagementSnapshot;
};
export type EpochDashboardData = import("../marketing-1.3.2/kit.mjs").HubDashboard & {
    measurementEpoch?: MeasurementEpoch;
    engagement?: EngagementSnapshot;
};
/** New native panels consume only v2. A legacy RPC, paid report or previous cache is never a fallback. */
export declare function readEpochDashboard(base: import("../marketing-1.3.2/kit.mjs").HubDashboard, product: EpochProduct, externalTenant: string, db: EpochRpc): Promise<EpochDashboardData>;
export declare function resolveEpochPeriod(search: Record<string, string | undefined>, _timezone?: string, now?: Date): import("../marketing-1.3.2/kit.mjs").HubPeriod & {
    selection: string;
};
export declare function recordEpochActivity(db: EpochRpc, externalTenant: string, input: import("./activity-contract.js").OperationalV2Input): Promise<boolean>;

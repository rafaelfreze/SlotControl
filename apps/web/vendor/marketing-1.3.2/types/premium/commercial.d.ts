import { type MeasurementSnapshot } from "./measurement.js";
import { type Channel, type HubDashboard, type SourceSnapshot } from "../kit/index.js";
export declare const COMMERCIAL_TIMEZONE = "America/Campo_Grande";
export declare const COMMERCIAL_METRICS: readonly ["quotes_requested", "quotes_created", "quotes_approved", "appointments_completed", "orders_completed", "qualified_leads"];
export type CommercialMetric = typeof COMMERCIAL_METRICS[number];
export declare const commercialNames: Record<CommercialMetric, string>;
export type CommercialSnapshot = {
    version: 1;
    externalTenant: string;
    from: string;
    to: string;
    timezone: typeof COMMERCIAL_TIMEZONE;
    collectedAt: string;
    temporalNote?: string;
    availableMetrics: CommercialMetric[];
    coverageStart: Partial<Record<CommercialMetric, string>>;
    definitions: Partial<Record<CommercialMetric, string>>;
    facts: Array<{
        date: string;
        channel: "all";
        metric: CommercialMetric;
        value: number;
        quality: "complete" | "partial";
    }>;
};
export type MarketingSnapshot = SourceSnapshot & {
    commercial?: CommercialSnapshot;
    measurement?: MeasurementSnapshot;
};
/** Optional additive DTO. Unknown fields, identifiers and payloads never cross this boundary. */
export declare function validateMarketingSnapshot(raw: unknown, maxDays?: number): MarketingSnapshot;
export declare function mergeCommercialSnapshots(parts: MarketingSnapshot[], from: string, to: string): CommercialSnapshot | undefined;
/** No attribution by timing: operational records have no advertising channel. */
export declare function commercialMetrics(parts: MarketingSnapshot[], channel: Channel | "all", from: string, to: string): HubDashboard["metrics"];

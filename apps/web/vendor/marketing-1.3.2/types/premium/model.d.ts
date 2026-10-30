export { MEASUREMENT_METRICS, measurementNames, mergeMeasurementSnapshots } from "./measurement.js";
export type { MeasurementSnapshot, MeasurementMetric } from "./measurement.js";
import { type Channel, type CountMetric, type HubDashboard, type HubPeriod, type SourceSnapshot } from "../kit/index.js";
export { COMMERCIAL_TIMEZONE, COMMERCIAL_METRICS, commercialNames, validateMarketingSnapshot, mergeCommercialSnapshots } from "./commercial.js";
export type { CommercialMetric, CommercialSnapshot, MarketingSnapshot } from "./commercial.js";
export type Product = "onplay_fiscal" | "servnexx" | "zelyvara" | "onfood" | "nexxfitpro" | "onplay_finance" | "coinops";
export declare const productNames: Record<Product, string>;
export declare const channelNames: Record<Channel | "all", string>;
export declare const metricNames: Record<CountMetric, string>;
export declare function businessMetrics(data: HubDashboard): HubDashboard["metrics"];
export type Point = {
    date: string;
    visits: number | null;
    intents: number | null;
    conversations: number | null;
};
export type PageCount = {
    path: string;
    views: number;
};
export type PremiumData = HubDashboard & {
    points?: Point[];
    measurementPoints?: Array<{
        date: string;
        whatsapp: number | null;
        phone: number | null;
    }>;
    pages?: PageCount[] | null;
    partialMetrics?: string[];
    definitions?: Partial<Record<CountMetric, string>>;
};
export type AdReport = {
    id: string;
    companyKey: string;
    platform: "google_ads" | "meta";
    accountId: string;
    campaignId: string;
    campaignName: string;
    from: string;
    to: string;
    timezone: string;
    currency: "BRL";
    spendCents: number;
    impressions: number | null;
    clicks: number | null;
    conversions: number | null;
    qualifiedLeads: number | null;
    qualifiedEvidence: string | null;
    coverage: "complete" | "partial";
    source: "official_export" | "authenticated_dashboard" | "official_api" | "manual";
    evidence: string;
    notes: string;
    collectedAt: string;
    createdAt: string;
    supersedes: string | null;
};
export type PaidData = {
    available: boolean;
    reports: AdReport[];
    history?: AdReport[];
    message?: string;
    legacySpend?: Array<{
        platform: "google_ads" | "meta";
        spendCents: number;
    }>;
};
export declare function validCompanyKey(value: unknown): value is string;
/** Strict DTO boundary: no arbitrary JSON, profile, contact or credential reaches clients. */
export declare function parseAdReport(raw: unknown): AdReport;
export declare function parsePaidData(raw: unknown, key: string, from: string, to: string): PaidData;
export declare function summarizePaid(paid: PaidData | undefined, from: string, to: string, channel: Channel | "all"): {
    rows: AdReport[];
    legacy: {
        platform: "google_ads" | "meta";
        spendCents: number;
    }[];
    complete: boolean;
    overlaps: boolean;
    spend: number | null;
    clicks: number | null;
    conversions: number | null;
    impressions: number | null;
    qualified: number | null;
    cpc: number | null;
    cpa: number | null;
};
/** One calculation used by Master and native products. Never counts people from page views. */
export declare function fromSnapshots(base: HubDashboard, inputs: SourceSnapshot[]): PremiumData;
export declare function comparison(current: PremiumData, previous: PremiumData | undefined, key: string): number | null;
export declare function stages(data: PremiumData, product: Product): {
    key: "visits" | "intents" | "leads" | "conversations" | "appointments" | "closures" | "purchases";
    label: string;
    value: number | null;
}[];
export declare function blankData(period: HubPeriod, name: string, channel: Channel | "all"): PremiumData;

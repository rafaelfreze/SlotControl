import { type Channel, type SourceSnapshot } from "../kit/index.js";
export declare const MEASUREMENT_METRICS: readonly ["operational_whatsapp", "operational_phone", "authorized_intents", "meta_contacts"];
export type MeasurementMetric = typeof MEASUREMENT_METRICS[number];
export declare const measurementNames: Record<MeasurementMetric, string>;
export type MeasurementSnapshot = {
    version: 1;
    externalTenant: string;
    from: string;
    to: string;
    timezone: "America/Campo_Grande";
    collectedAt: string;
    availableMetrics: MeasurementMetric[];
    coverageStart: Partial<Record<MeasurementMetric, string>>;
    definitions: Partial<Record<MeasurementMetric, string>>;
    facts: Array<{
        date: string;
        channel: Channel | "all";
        metric: MeasurementMetric;
        value: number;
        quality: "complete" | "partial";
    }>;
};
type Input = SourceSnapshot & {
    measurement?: MeasurementSnapshot;
};
/** Whitelist aggregate facts. Advertising receipts require a real provider source. */
export declare function validateMeasurement(raw: unknown, base: SourceSnapshot, maxDays: number): MeasurementSnapshot | undefined;
export declare function mergeMeasurementSnapshots(parts: Input[], from: string, to: string): MeasurementSnapshot | undefined;
export declare function measurementValues(parts: Input[], channel: Channel | "all", from: string, to: string): {
    metrics: import("../kit/index.js").HubMetric[];
    points: {
        date: string;
        whatsapp: number | null;
        phone: number | null;
    }[];
};
export {};

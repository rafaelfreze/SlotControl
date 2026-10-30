import { type Channel, type CountMetric, type HubDashboard, type HubPeriod, type SourceSnapshot } from "./types.js";
export declare const metricLabels: Record<CountMetric, string>;
export declare function reliableRatio(numerator: number | null, denominator: number | null, compatible: boolean): number | null;
export declare function validateSnapshot(input: unknown, maxDays?: number): SourceSnapshot;
export declare function emptyDashboard(period: HubPeriod, name?: string, channel?: Channel | "all", notice?: string): HubDashboard;
/** One chosen product link per view. Do not sum CRM populations across products. */
export declare function applySourceSnapshot(dashboard: HubDashboard, snapshot: SourceSnapshot): HubDashboard;

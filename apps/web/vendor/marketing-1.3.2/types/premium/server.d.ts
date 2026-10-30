import { type PaidData, type Product } from "./model.js";
import { type HubDashboard, type HubPeriod } from "../kit/index.js";
/** Only call AFTER native authorization resolves the tenant. No tenant comes from this client helper. */
export declare function readPublishedReports(product: Exclude<Product, "onplay_fiscal" | "onplay_finance" | "coinops">, tenant: string, from: string, to: string): Promise<PaidData>;
export declare function readPreviousDashboard<T extends HubDashboard>(current: T, load: (period: HubPeriod) => Promise<T>): Promise<T | undefined>;

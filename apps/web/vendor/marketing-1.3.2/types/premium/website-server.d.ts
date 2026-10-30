import { type HubPeriod } from "../kit/index.js";
import { type PremiumData } from "./model.js";
export declare const WEBSITE_PRODUCTS: {
    readonly servnexx: {
        readonly label: "ServNexx · site institucional";
        readonly schema: "servnexx";
        readonly hosts: readonly ["www.servnexx.com.br", "servnexx.com.br"];
    };
    readonly zelyvara: {
        readonly label: "Zelyvara · site institucional";
        readonly schema: "zelyvara";
        readonly hosts: readonly ["www.zelyvara.com.br", "zelyvara.com.br"];
    };
    readonly onfood: {
        readonly label: "OnFood · site institucional";
        readonly schema: "onfood";
        readonly hosts: readonly ["onfooddigital.com.br", "www.onfooddigital.com.br"];
    };
    readonly nexxfitpro: {
        readonly label: "NexxFit Pro · site institucional";
        readonly schema: "nexxfitpro";
        readonly hosts: readonly ["nexxfitpro.com.br", "www.nexxfitpro.com.br"];
    };
    readonly onplay_finance: {
        readonly label: "OnPlay Finance · site institucional";
        readonly schema: "onplay_finance";
        readonly hosts: readonly ["on-play-finance.vercel.app"];
    };
    readonly coinops: {
        readonly label: "CoinOps · site institucional";
        readonly schema: "coinops";
        readonly hosts: readonly ["cripto-flax.vercel.app"];
    };
};
export type WebsiteProduct = keyof typeof WEBSITE_PRODUCTS;
export type WebsiteDb = {
    rpc(name: "record_website_count_v1" | "claim_website_read_nonce_v1" | "get_website_snapshot_v1", args: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: unknown;
    }>;
};
export declare function assertWebsiteBackend(product: WebsiteProduct, url: string | undefined, schema: string): void;
/** Dedicated aggregate scope; never signs advertising or tenant requests. */
export declare function signWebsiteRead(product: WebsiteProduct, secret: string, path: string, body: string): {
    "content-type": string;
    "x-onplay-website-product": "servnexx" | "zelyvara" | "onfood" | "nexxfitpro" | "onplay_finance" | "coinops";
    "x-onplay-timestamp": string;
    "x-onplay-nonce": `${string}-${string}-${string}-${string}-${string}`;
    "x-onplay-signature": string;
};
export declare function serveWebsiteCounter(request: Request, db: WebsiteDb, product: WebsiteProduct): Promise<Response>;
export declare function serveWebsiteSource(request: Request, db: WebsiteDb, product: WebsiteProduct, secret: string): Promise<Response>;
export declare function readWebsiteSnapshot(db: WebsiteDb, from: string, to: string): Promise<import("./commercial.js").MarketingSnapshot>;
/** Native guard must run before calling. Same DTO and calculation as the OnPlay Master. */
export declare function readWebsiteDashboard(db: WebsiteDb, product: WebsiteProduct, period: HubPeriod, channel: "all" | "google_ads" | "meta" | "direct" | "organic" | "unknown"): Promise<PremiumData>;

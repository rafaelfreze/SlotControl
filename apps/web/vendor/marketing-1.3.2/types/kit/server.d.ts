import { type Channel, type HubDashboard, type HubPeriod, type Product, type SourceRequest } from "./types.js";
export declare class HubRequestError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string);
}
export declare function signHubRequest(input: {
    secret: string;
    product: Product;
    method: string;
    path: string;
    body: string;
    now?: number;
    nonce?: string;
}): Record<string, string>;
export declare function verifyHubSignature(request: Request, body: string, secret: string, expectedProduct: Product, now?: number): {
    product: "onplay_fiscal" | "servnexx" | "zelyvara" | "onfood" | "nexxfitpro" | "onplay_ads";
    nonce: string;
    timestamp: number;
};
export declare function readBoundedBody(request: Request, maxBytes?: number): Promise<string>;
export declare function parseSourceRequest(body: string, maxDays?: number): SourceRequest;
/** Caller must still resolve active tenant and source data inside its own product. */
export declare function readExportRequest(request: Request, product: Product, secret?: string): Promise<SourceRequest>;
export declare function hubErrorResponse(error: unknown): Response;
export declare function fetchHubSummary(input: {
    product: Product;
    externalTenant: string;
    period: HubPeriod;
    channel?: Channel | "all";
    clientName?: string;
    hubUrl?: string;
    secret?: string;
    fetcher?: typeof fetch;
}): Promise<HubDashboard>;
export declare function readBoundedResponse(response: Response, maxBytes: number): Promise<string>;
export declare function parseChannel(value: unknown): Channel | "all";

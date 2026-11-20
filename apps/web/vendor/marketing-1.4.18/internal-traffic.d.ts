/** Explicit measurement opt-out for an internal review. This is not authorization. */
export declare const INTERNAL_TRAFFIC_KEY = "onplay:qa";
export declare function internalTrafficRequested(search: string): boolean;
export declare function isInternalTrafficContext(input: {
    search?: string;
    hostname?: string;
    pathname?: string;
    webdriver?: boolean;
    stored?: boolean;
}): boolean;
/** One boolean per tab, no visitor ID/cookie/IP. QA survives client-side navigation. */
export declare function isInternalTraffic(): boolean;
/** Use only on administrative review links; public/share/copy URLs stay clean. */
export declare function internalTrafficUrl(href: string): string;
/** Defense at ingestion for explicit QA requests and same-origin review referrers. */
export declare function isInternalTrafficRequest(request: Request): boolean;

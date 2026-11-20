/** Explicit measurement opt-out for an internal review. This is not authorization. */
export const INTERNAL_TRAFFIC_KEY = "onplay:qa";
let memoryChoice = false;
let memoryWindow;
export function internalTrafficRequested(search) {
    const params = new URLSearchParams(search);
    return params.get("onplay_qa") === "1" || params.has("marketing_debug") ||
        params.get("utm_source") === "codex_validation";
}
export function isInternalTrafficContext(input) {
    return Boolean(input.webdriver || input.stored || internalTrafficRequested(input.search ?? "") ||
        /^(localhost|127\.0\.0\.1|\[?::1\]?)$|\.localhost$/i.test(input.hostname ?? "") ||
        /^\/(master|painel|dashboard|preview|previa)(\/|$)/.test(input.pathname ?? ""));
}
/** One boolean per tab, no visitor ID/cookie/IP. QA survives client-side navigation. */
export function isInternalTraffic() {
    if (typeof window === "undefined" || !window.location)
        return false;
    if (memoryWindow !== window) {
        memoryChoice = false;
        memoryWindow = window;
    }
    const params = new URLSearchParams(window.location.search);
    if (params.get("onplay_qa") === "0") {
        memoryChoice = false;
        try {
            window.sessionStorage.removeItem(INTERNAL_TRAFFIC_KEY);
        }
        catch { /* Memory fallback. */ }
    }
    if (internalTrafficRequested(window.location.search)) {
        memoryChoice = true;
        try {
            window.sessionStorage.setItem(INTERNAL_TRAFFIC_KEY, "1");
        }
        catch { /* Memory fallback. */ }
    }
    let stored = memoryChoice;
    try {
        stored ||= window.sessionStorage.getItem(INTERNAL_TRAFFIC_KEY) === "1";
    }
    catch { /* Memory fallback. */ }
    return isInternalTrafficContext({
        search: window.location.search, hostname: window.location.hostname,
        pathname: window.location.pathname, webdriver: window.navigator?.webdriver, stored,
    });
}
/** Use only on administrative review links; public/share/copy URLs stay clean. */
export function internalTrafficUrl(href) {
    const url = new URL(href, "https://internal.invalid");
    if (!["https:", "http:"].includes(url.protocol))
        return href;
    url.searchParams.set("onplay_qa", "1");
    return /^https?:\/\//i.test(href) ? url.href : `${url.pathname}${url.search}${url.hash}`;
}
/** Defense at ingestion for explicit QA requests and same-origin review referrers. */
export function isInternalTrafficRequest(request) {
    const url = new URL(request.url);
    if (request.headers.get("x-onplay-qa") === "1" ||
        isInternalTrafficContext({ search: url.search, hostname: url.hostname }))
        return true;
    try {
        const referrer = new URL(request.headers.get("referer") ?? "");
        return referrer.origin === url.origin && isInternalTrafficContext({
            search: referrer.search, hostname: referrer.hostname, pathname: referrer.pathname,
        });
    }
    catch {
        return false;
    }
}

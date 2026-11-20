import { isInternalTraffic } from "./internal-traffic.js";
// Weak references disappear with the DOM event. No clock-based suppression of
// legitimate repeated clicks, visitor storage or cross-page identity.
const handledEvents = new WeakMap();
export function claimOperationalEvent(event, scope) {
    const scopes = handledEvents.get(event) ?? new Set();
    if (scopes.has(scope))
        return false;
    scopes.add(scope);
    handledEvents.set(event, scopes);
    return true;
}
/** One ephemeral transport receipt, reused on a single bounded retry. Never a visitor ID. */
export function sendOperational(endpoint, payload) {
    if (isInternalTraffic())
        return;
    const body = JSON.stringify(payload);
    const options = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        credentials: "omit",
        referrerPolicy: "no-referrer",
        keepalive: true,
    };
    const send = async () => {
        if (isInternalTraffic())
            return null;
        try {
            return await fetch(endpoint, options);
        }
        catch {
            return null;
        }
    };
    void send().then((response) => {
        if (response === null || response.status >= 500)
            setTimeout(() => {
                void send();
            }, 700);
    });
}
export function operationalChannel(search, referrer) {
    const p = new URLSearchParams(search), source = (p.get("utm_source") ?? "").toLowerCase(), medium = (p.get("utm_medium") ?? "").toLowerCase();
    let host = "";
    try {
        host = new URL(referrer).hostname;
    }
    catch {
        /* Referrer is optional and never sent. */
    }
    if (/^(meta|facebook|instagram|fb|ig)$/.test(source)) {
        if (/^(paid|cpc|ppc|paid_social)$/.test(medium))
            return "meta";
        // A declared organic social visit is not paid. Keep conflicting click
        // identifiers unknown, just as for the general organic rule below.
        if (medium === "organic" && !["gclid", "gbraid", "wbraid", "fbclid"].some((key) => p.has(key)))
            return "organic";
        return "unknown";
    }
    if (/^(google|google_ads|adwords)$/.test(source) &&
        /^(cpc|ppc|paid|paid_search)$/.test(medium))
        return "google_ads";
    // A click identifier is never read or retained here. Avoid calling such an
    // unclassified arrival organic; only explicit commercial UTMs establish paid.
    if (["gclid", "gbraid", "wbraid", "fbclid"].some((key) => p.has(key)))
        return "unknown";
    if (medium === "organic" || /(^|\.)google\.[a-z.]+$/.test(host))
        return "organic";
    return source || host ? "unknown" : "direct";
}

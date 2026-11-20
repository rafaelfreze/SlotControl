import { isInternalTraffic } from "./internal-traffic.js";
import { observeActiveEngagement } from "./active-engagement.js";
import { ACTIVITY_ACTIONS, activityCampaign, activityV2Path } from "./activity-contract.js";
import { claimOperationalEvent, operationalChannel, sendOperational } from "./operational-transport.js";
import { campaignDigest, isCampaignDigest } from "./campaign-digest.js";
import { ACTIVITY_INACTIVITY_MS, activityDedupeKey, claimActivityDedupe, ensureActivityDedupe, flushActivityDedupe, readActivityDedupe, touchActivityDedupe } from "./activity-dedupe.js";
const contexts = new WeakMap();
const WINDOW_MS = ACTIVITY_INACTIVITY_MS;
/** A data marker describes a verified local handoff, not an arbitrary URL. */
function contactDestination(anchor, href) {
    if (/^tel:\+?[\d(). -]{7,24}$/iu.test(href))
        return "phone";
    try {
        const url = new URL(href, window.location.href);
        if (url.protocol !== "https:" || url.username || url.password)
            return null;
        if (url.hostname === "wa.me" && /^\/[1-9]\d{7,14}\/?$/u.test(url.pathname))
            return "whatsapp";
        if (["api.whatsapp.com", "web.whatsapp.com"].includes(url.hostname) && /^\/send\/?$/u.test(url.pathname)
            && /^[1-9]\d{7,14}$/u.test(url.searchParams.get("phone") ?? ""))
            return "whatsapp";
        const marked = anchor.dataset.marketingContact === "whatsapp" || anchor.dataset.catalogEvent === "whatsapp_click";
        if (marked && url.origin === window.location.origin && ["/contato/whatsapp", "/pedido/whatsapp"].includes(url.pathname))
            return "whatsapp";
    }
    catch { /* No destination, phone or message is retained. */ }
    return null;
}
/** Explicit opaque tracking never replaces existing UTMs; malformed tokens fall back safely. */
function campaignAlias(search) {
    const params = new URLSearchParams(search), opaque = params.get("onplay_campaign") ?? "";
    return /^op_[a-p]{32}$/u.test(opaque) ? opaque : activityCampaign(params.get("utm_campaign"));
}
/** Explicit organic UTMs only. Referrers or isolated click IDs cannot prove organic traffic. */
export function organicSocialNetworkFromUtm(search) {
    if (search.length > 8192)
        return undefined;
    const params = new URLSearchParams(search), sources = params.getAll("utm_source"), media = params.getAll("utm_medium");
    if (sources.length !== 1 || media.length !== 1 || media[0].trim().toLowerCase() !== "organic" || ["gclid", "gbraid", "wbraid", "fbclid"].some(key => params.has(key)))
        return undefined;
    const source = sources[0].trim().toLowerCase();
    return source === "instagram" || source === "ig" ? "instagram" : source === "facebook" || source === "fb" ? "facebook" : source === "google" ? "google" : undefined;
}
/** Anonymous receipts survive revocation; identity and acquisition never do. */
function clearSessionIdentity(storageKey, acquisitionStorageKey) {
    if (!storageKey)
        return;
    try {
        window.sessionStorage.removeItem(storageKey);
        window.sessionStorage.removeItem(storageKey + ":active-at:v2");
        if (acquisitionStorageKey)
            window.sessionStorage.removeItem(acquisitionStorageKey);
    }
    catch { /* In-memory identity is still discarded if storage is unavailable. */ }
}
export function revokeActivitySessions() {
    if (typeof window === "undefined")
        return;
    for (const [key, session] of contexts.get(window) ?? []) {
        flushActivityDedupe(key);
        clearSessionIdentity(session.storageKey, session.acquisitionStorageKey);
    }
    contexts.delete(window);
}
function activitySession(key, consent, storageKey, acquisitionStorageKey) {
    let cache = contexts.get(window);
    if (!cache) {
        cache = new Map();
        contexts.set(window, cache);
    }
    const now = Date.now(), scope = consent === "accepted" && storageKey ? "tab" : "document";
    const prior = cache.get(key), proof = readActivityDedupe(key);
    if (scope === "document")
        clearSessionIdentity(storageKey, acquisitionStorageKey);
    if (prior && (prior.scope === scope || prior.storageBlocked && scope === "tab") && prior.expiresAt > now && proof) {
        // Another observer may have recorded a real gesture; reads themselves never
        // extend the inactivity clock or revive expired action flags.
        prior.expiresAt = proof.activeAt + WINDOW_MS;
        return prior;
    }
    let token = crypto.randomUUID(), resolvedScope = scope, initialAt = proof?.activeAt ?? now, storageBlocked = false;
    if (scope === "tab" && storageKey) {
        try {
            const stored = window.sessionStorage.getItem(storageKey), at = Number(window.sessionStorage.getItem(storageKey + ":active-at:v2"));
            const clockValid = Number.isFinite(at) && at > 0 && at <= now;
            if (stored && /^[a-f0-9-]{36}$/iu.test(stored) && clockValid && (proof || now - at < WINDOW_MS)) {
                token = stored;
                initialAt = proof?.activeAt ?? at;
            }
            window.sessionStorage.setItem(storageKey, token);
            window.sessionStorage.setItem(storageKey + ":active-at:v2", String(initialAt));
        }
        catch {
            resolvedScope = "document";
            token = crypto.randomUUID();
            storageBlocked = true;
        }
    }
    const receipt = ensureActivityDedupe(key, initialAt);
    const session = { token, scope: resolvedScope, expiresAt: receipt.activeAt + WINDOW_MS,
        ...(storageKey ? { storageKey } : {}), ...(acquisitionStorageKey ? { acquisitionStorageKey } : {}), clockWrittenAt: receipt.activeAt, ...(storageBlocked ? { storageBlocked: true } : {}) };
    cache.set(key, session);
    return session;
}
/** One observer for the existing aggregate endpoint. A session token is transient
 * deduplication evidence, HMACed at ingestion; never a persistent visitor ID. */
export function observeActivityV2(options) {
    if (isInternalTraffic())
        return () => undefined;
    const path = activityV2Path(options.pagePath ?? window.location.pathname);
    if (!path)
        return () => undefined;
    const readConsent = () => {
        if (options.getConsent)
            return options.getConsent();
        if (!options.consentKey)
            return "unknown";
        try {
            const value = localStorage.getItem(options.consentKey);
            return ["accepted", "granted"].includes(value ?? "") ? "accepted" : ["declined", "denied"].includes(value ?? "") ? "declined" : "unknown";
        }
        catch {
            return "unknown";
        }
    };
    const acquisitionContextKey = options.endpoint + ":" + (options.slug ?? "");
    const contextKey = activityDedupeKey(options.endpoint, options.slug, options.sessionKey);
    const allowed = () => !isInternalTraffic() && document.visibilityState === "visible";
    const active = () => allowed() && document.hasFocus();
    const root = options.root ?? "body";
    let referrer = document.referrer;
    try {
        if (new URL(referrer).origin === window.location.origin)
            referrer = "";
    }
    catch { /* An absent referrer stays absent. */ }
    // Keep only the sanitized origin for the current consented tab session.
    // Raw click IDs, query strings and referrers are never stored or transmitted.
    const firstAcquisition = () => {
        const channel = operationalChannel(window.location.search, referrer);
        const network = options.attributionEnabled && options.captureOrganicSocialV2 && channel === "organic" ? organicSocialNetworkFromUtm(window.location.search) : undefined;
        return { channel, campaign: options.captureCampaign && !options.captureCampaignDigest ? campaignAlias(window.location.search) : "", ...(network ? { organicSocialNetworkV2: network } : {}) };
    };
    let acquisition;
    let pendingDigest;
    const acquisitionStorageKey = options.sessionKey ? options.sessionKey + ":acquisition:v2:" + encodeURIComponent(acquisitionContextKey) : null;
    const acquisitionFor = (session) => {
        if (session.scope !== "tab" || !acquisitionStorageKey)
            return { token: session.token, channel: "unknown", campaign: "" };
        if (acquisition?.token === session.token)
            return acquisition;
        try {
            const raw = window.sessionStorage.getItem(acquisitionStorageKey);
            const stored = raw ? JSON.parse(raw) : null;
            if (stored?.token === session.token && ["google_ads", "meta", "organic", "direct", "unknown"].includes(String(stored.channel)) && typeof stored.campaign === "string" && activityCampaign(stored.campaign) === stored.campaign) {
                const network = options.attributionEnabled && options.captureOrganicSocialV2 && stored.channel === "organic" && (stored.organicSocialNetworkV2 === "instagram" || stored.organicSocialNetworkV2 === "facebook" || stored.organicSocialNetworkV2 === "google") ? stored.organicSocialNetworkV2 : undefined;
                acquisition = { token: session.token, channel: stored.channel, campaign: options.captureCampaignDigest ? isCampaignDigest(stored.campaign) ? stored.campaign : "" : options.captureCampaign ? stored.campaign : "", ...(network ? { organicSocialNetworkV2: network } : {}) };
                if ((!acquisition.campaign && stored.campaign) || (!network && stored.organicSocialNetworkV2))
                    window.sessionStorage.setItem(acquisitionStorageKey, JSON.stringify(acquisition));
            }
            else {
                acquisition = { token: session.token, ...firstAcquisition() };
                window.sessionStorage.setItem(acquisitionStorageKey, JSON.stringify(acquisition));
            }
        }
        catch {
            acquisition = { token: session.token, ...firstAcquisition() };
        }
        return acquisition;
    };
    const send = (eventName, detail = "", qualification) => {
        if (!allowed())
            return;
        const consent = readConsent(), session = activitySession(contextKey, consent, options.sessionKey, acquisitionStorageKey ?? undefined);
        const acquisition = acquisitionFor(session), { channel, campaign } = acquisition;
        const payload = { version: 2, eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), eventName, pagePath: path, detail,
            ...(options.slug ? { slug: options.slug } : {}), channel: channel === "unknown" ? "other" : channel, campaign,
            device: window.innerWidth < 768 ? "mobile" : window.innerWidth < 1024 ? "tablet" : "desktop", consent,
            identityScope: session.scope, sessionToken: session.token, ...(options.attributionEnabled ? { attributionV1: true } : {}),
            ...(["qualified_session", "contact_intent"].includes(eventName) && options.attributionEnabled && options.captureOrganicSocialV2 && consent === "accepted" && session.scope === "tab" && acquisition.organicSocialNetworkV2 ? { organicSocialNetworkV2: acquisition.organicSocialNetworkV2 } : {}),
            ...(qualification ? { qualification } : {}) };
        const alias = options.captureCampaignDigest && consent === "accepted" && session.scope === "tab" && !campaign && ["google_ads", "meta"].includes(channel)
            ? campaignAlias(window.location.search) : "";
        if (!alias && pendingDigest?.token !== session.token) {
            sendOperational(options.endpoint, payload);
            return;
        }
        // Hash in memory after consent; never save or transmit the raw campaign value.
        if (alias && pendingDigest?.token !== session.token)
            pendingDigest = { token: session.token, value: campaignDigest(alias) };
        void pendingDigest.value.then(digest => {
            if (readConsent() !== "accepted" || contexts.get(window)?.get(contextKey)?.token !== session.token)
                return;
            acquisition.campaign = digest;
            try {
                if (acquisitionStorageKey)
                    window.sessionStorage.setItem(acquisitionStorageKey, JSON.stringify(acquisition));
            }
            catch { /* Keep the in-memory context. */ }
            sendOperational(options.endpoint, { ...payload, campaign: digest });
        }).catch(() => { if (readConsent() === "accepted" && contexts.get(window)?.get(contextKey)?.token === session.token)
            sendOperational(options.endpoint, payload); });
    };
    const currentSession = () => activitySession(contextKey, readConsent(), options.sessionKey, acquisitionStorageKey ?? undefined);
    const qualified = (proof) => {
        if (!allowed())
            return;
        currentSession();
        if (claimActivityDedupe(contextKey, "qualified"))
            send("qualified_session", "", proof);
    };
    const flush = () => {
        flushActivityDedupe(contextKey);
        const receipt = readActivityDedupe(contextKey), session = contexts.get(window)?.get(contextKey);
        if (receipt && session?.scope === "tab" && options.sessionKey && readConsent() === "accepted") {
            try {
                window.sessionStorage.setItem(options.sessionKey + ":active-at:v2", String(receipt.activeAt));
            }
            catch { /* Memory fallback. */ }
        }
    };
    const touch = () => {
        // Expiration is resolved before touching: a new gesture after an idle gap
        // starts fresh flags/token instead of reviving the previous session.
        const prior = contexts.get(window)?.get(contextKey), existing = readActivityDedupe(contextKey);
        const restarted = Boolean(prior && (prior.expiresAt <= Date.now() || !existing) && !existing?.qualified);
        const session = currentSession(), receipt = touchActivityDedupe(contextKey);
        session.expiresAt = receipt.activeAt + WINDOW_MS;
        if (session.scope === "tab" && options.sessionKey && receipt.activeAt - (session.clockWrittenAt ?? 0) >= 1000) {
            try {
                window.sessionStorage.setItem(options.sessionKey + ":active-at:v2", String(receipt.activeAt));
                session.clockWrittenAt = receipt.activeAt;
            }
            catch { /* Memory fallback. */ }
        }
        return restarted;
    };
    let engagement = observeActiveEngagement(qualified, allowed, touch);
    const preferences = (event) => {
        if (event.type === "storage" && event.key && event.key !== options.consentKey)
            return;
        flushActivityDedupe(contextKey);
        acquisition = undefined;
        pendingDigest = undefined;
        clearSessionIdentity(options.sessionKey, acquisitionStorageKey ?? undefined);
        contexts.get(window)?.delete(contextKey);
        // Rotate only identity. The anonymous, finite action receipts preserve
        // suppression across preference changes, refresh and navigation.
        engagement.stop();
        engagement = observeActiveEngagement(qualified, allowed, touch);
    };
    let viewSent = options.sendView === false;
    const view = () => { if (!viewSent && allowed()) {
        viewSent = true;
        send("page_view");
        options.onView?.();
    } };
    const contact = (event, detail) => {
        if (!event.isTrusted || !active())
            return;
        engagement.interact("contact", event);
        currentSession();
        qualified({ activeMs: engagement.activeMs, interaction: "contact" });
        if (claimActivityDedupe(contextKey, detail))
            send("contact_intent", detail, { activeMs: engagement.activeMs, interaction: "contact" });
    };
    const click = (event) => {
        if (!event.isTrusted || !active() || event.type === "auxclick" && event.button !== 1 || !(event.target instanceof Element))
            return;
        if (!claimOperationalEvent(event, contextKey + ":v2"))
            return;
        const anchor = event.target.closest(`${root} a[href]`);
        const action = event.target.closest(`${root} [data-public-access-action],${root} [data-catalog-event]`);
        const name = action?.dataset.publicAccessAction ?? action?.dataset.catalogEvent;
        const details = options.describeClick?.(anchor, action);
        if (name && ACTIVITY_ACTIONS.includes(name))
            send("button_click", details?.buttonDetail ?? name);
        if (anchor) {
            const href = anchor.getAttribute("href") ?? anchor.href;
            const destination = contactDestination(anchor, href);
            if (destination) {
                contact(event, destination);
                send("link_click", destination);
            }
            else {
                engagement.interact("relevant_click", event);
                try {
                    const url = new URL(href, window.location.href);
                    send("link_click", details?.linkDetail ?? (url.hostname === "shopee.com.br" || url.hostname.endsWith(".shopee.com.br") ? "shopee" : url.origin === window.location.origin ? "internal" : "external"));
                }
                catch { /* Invalid href is not a navigation fact. */ }
            }
        }
        else if (event.target.closest(`${root} button,${root} [role="button"],${root} input[type="submit"]`))
            engagement.interact("relevant_click", event);
    };
    const submit = (event) => {
        if (!event.isTrusted || !(event.target instanceof HTMLFormElement) || !active() || !event.target.checkValidity())
            return;
        if (!claimOperationalEvent(event, contextKey + ":v2"))
            return;
        if (event.target.matches(`${root} form[data-public-access-contact="whatsapp"],${root} form[data-marketing-contact="whatsapp"]`))
            contact(event, "whatsapp");
        else if (event.target.matches(`${root} form[data-public-access-contact="form"],${root} form[data-marketing-contact="form"]`))
            contact(event, "form");
        // A form interaction alone is neither an accepted submission nor a lead.
    };
    const stopConfirmedActions = options.observeConfirmedActions?.((event, detail) => {
        if (event.isTrusted && active() && claimOperationalEvent(event, contextKey + ":v2:confirmed:" + detail))
            send("button_click", detail);
    });
    // Preparation is not a contact click. A native async flow confirms a validated
    // handoff using its original trusted user event, never a fabricated event.
    const stopConfirmedContacts = options.observeConfirmedContacts?.((event, detail) => {
        if (!event.isTrusted || !active() || !claimOperationalEvent(event, contextKey + ":v2:handoff:" + detail))
            return;
        contact(event, detail);
        send("link_click", detail);
    });
    view();
    document.addEventListener("visibilitychange", view);
    window.addEventListener("pagehide", flush);
    window.addEventListener("storage", preferences);
    window.addEventListener("onplay:marketing:consent-changed", preferences);
    window.addEventListener("artelaser:analytics-consent-change", preferences);
    if (options.consentEvent)
        window.addEventListener(options.consentEvent, preferences);
    document.addEventListener("click", click, { capture: true });
    document.addEventListener("auxclick", click, { capture: true });
    document.addEventListener("submit", submit, { capture: true });
    return () => { flush(); window.removeEventListener("pagehide", flush); stopConfirmedContacts?.(); stopConfirmedActions?.(); engagement.stop(); document.removeEventListener("visibilitychange", view); document.removeEventListener("click", click, { capture: true }); document.removeEventListener("auxclick", click, { capture: true }); document.removeEventListener("submit", submit, { capture: true }); window.removeEventListener("storage", preferences); window.removeEventListener("onplay:marketing:consent-changed", preferences); window.removeEventListener("artelaser:analytics-consent-change", preferences); if (options.consentEvent)
        window.removeEventListener(options.consentEvent, preferences); };
}

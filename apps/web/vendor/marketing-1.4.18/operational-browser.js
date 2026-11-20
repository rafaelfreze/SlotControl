import { isInternalTraffic } from "./internal-traffic.js";
export { createActiveEngagement, observeActiveEngagement } from "./active-engagement.js";
import { observeActivityV2 } from "./activity-browser.js";
export { observeActivityV2, revokeActivitySessions } from "./activity-browser.js";
import { claimOperationalEvent, operationalChannel, sendOperational } from "./operational-transport.js";
export { claimOperationalEvent, operationalChannel, sendOperational } from "./operational-transport.js";
const placements = new Set([
    "header",
    "hero",
    "inicio",
    "servicos",
    "services",
    "sobre",
    "resultados",
    "trabalhos",
    "contato",
    "contact",
    "final",
    "final_cta",
    "footer",
    "floating",
    "sticky",
    "offer",
    "local",
    "catalog",
]);
/** Attach only on public templates. No storage, tags, identifiers, URL query or message body. */
export function observeOperationalClicks({ endpoint, slug, root = "body", sendView = true, onView, version = 1, consentKey, sessionKey, getConsent, consentEvent, attributionEnabled, captureCampaign, captureCampaignDigest, captureOrganicSocialV2, }) {
    if (version === 2)
        return observeActivityV2({ endpoint, slug, root, sendView, onView, consentKey, sessionKey, getConsent, consentEvent, attributionEnabled, captureCampaign, captureCampaignDigest, captureOrganicSocialV2 });
    if (isInternalTraffic())
        return () => undefined;
    const page = location.pathname === "/" ||
        Boolean(slug &&
            [`/${slug}`, `/p/${slug}`, `/site/${slug}`].includes(location.pathname.replace(/\/$/, "")))
        ? "home"
        : /servic|service/.test(location.pathname)
            ? "services"
            : /contato|contact/.test(location.pathname)
                ? "contact"
                : "other";
    const channel = operationalChannel(location.search, document.referrer);
    const send = (event, placement) => sendOperational(endpoint, {
        version: 1,
        ...(slug ? { slug } : {}),
        eventId: crypto.randomUUID(),
        event,
        placement,
        page,
        channel,
    });
    let viewSent = !sendView;
    const view = () => {
        if (!viewSent && document.visibilityState === "visible") {
            viewSent = true;
            send("page_view", "page");
            onView?.();
        }
    };
    view();
    document.addEventListener("visibilitychange", view);
    const positionOf = (element) => {
        const section = element.closest("[data-marketing-section],section,header,footer,aside");
        const position = element.dataset.marketingCta || element.dataset.marketingSection ||
            section?.getAttribute("data-marketing-section") || section?.id ||
            section?.tagName.toLowerCase() || "other";
        return position === "form" ? "contato" : placements.has(position) ? position : "other";
    };
    const track = (event, action, element) => {
        if (claimOperationalEvent(event, `${endpoint}:${slug ?? ""}:${action}`))
            send(action, positionOf(element));
    };
    const click = (event) => {
        if (event.type === "auxclick" && event.button !== 1)
            return;
        if (!event.isTrusted || !(event.target instanceof Element))
            return;
        const anchor = event.target.closest(`${root} a[href]`);
        if (!anchor)
            return;
        const href = anchor.getAttribute("href") ?? "";
        let action = /^tel:/i.test(href)
            ? "phone_click"
            : null;
        if (!action) {
            try {
                const url = new URL(href, location.href);
                if (url.protocol === "https:" &&
                    ["wa.me", "api.whatsapp.com", "web.whatsapp.com"].includes(url.hostname))
                    action = "whatsapp_click";
            }
            catch {
                /* Not a contact anchor. */
            }
        }
        if (!action && anchor.dataset.marketingContact === "whatsapp")
            action = "whatsapp_click";
        if (action)
            track(event, action, anchor);
    };
    const submit = (event) => {
        if (!event.isTrusted || !(event.target instanceof HTMLFormElement))
            return;
        const form = event.target;
        if (!form.matches(`${root} form[data-marketing-contact="whatsapp"]`) || !form.checkValidity())
            return;
        track(event, "whatsapp_click", form);
    };
    const listenerOptions = { capture: true };
    document.addEventListener("click", click, listenerOptions);
    document.addEventListener("auxclick", click, listenerOptions);
    document.addEventListener("submit", submit, listenerOptions);
    return () => {
        document.removeEventListener("click", click, listenerOptions);
        document.removeEventListener("auxclick", click, listenerOptions);
        document.removeEventListener("submit", submit, listenerOptions);
        document.removeEventListener("visibilitychange", view);
    };
}

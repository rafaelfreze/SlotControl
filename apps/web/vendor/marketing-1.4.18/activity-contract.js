export const ACTIVITY_ACTIONS = ["select_number", "reserve_request", "draw_request", "draw_start", "product_click", "category_click", "search", "add_to_order", "checkout_started", "checkout_order_submit", "whatsapp_order_submit", "shipping_quote", "order_view", "affiliate_registration"];
export const ACTIVITY_V2_EVENTS = ["page_view", "scroll", "engaged", "link_click", "button_click", "qualified_session", "contact_intent"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PRIVATE = /^\/(?:api|auth|master|painel|dashboard|app|login|cadastro|alterar-senha|recuperar-senha|preview|previa)(?:\/|$)/u;
export function activityV2Path(value) {
    return typeof value === "string" && /^\/[A-Za-z0-9/_-]{0,299}$/u.test(value) && !PRIVATE.test(value) && !/\/[a-f0-9]{8}-[a-f0-9-]{27}(?:\/|$)/iu.test(value) ? value : null;
}
export function activityCampaign(value) {
    return typeof value === "string" && value.length <= 80 && /^[\p{L}\p{N} _|.:-]*$/u.test(value) && !/\d{7,}|@|https?:|\b(?:cpf|email|phone)\b/iu.test(value) ? value : "";
}
/** Versioned, minimal envelope. Tenant/site/environment are server decisions. */
export function normalizeActivityV2(raw, now = Date.now(), allowSlug = false, acceptDetail) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return null;
    const v = raw;
    const fields = ["version", "eventId", "occurredAt", "eventName", "pagePath", "detail", "channel", "campaign", "device", "consent", "identityScope", "sessionToken", "qualification", "attributionV1", "organicSocialNetworkV2", ...(allowSlug ? ["slug"] : [])];
    if (Object.keys(v).some(key => !fields.includes(key)) || v.version !== 2 || !UUID.test(String(v.eventId)) || !UUID.test(String(v.sessionToken)))
        return null;
    if (v.attributionV1 !== undefined && v.attributionV1 !== true)
        return null;
    if (v.organicSocialNetworkV2 !== undefined && !["instagram", "facebook", "google"].includes(String(v.organicSocialNetworkV2)))
        return null;
    const pagePath = activityV2Path(v.pagePath);
    if (!pagePath || !ACTIVITY_V2_EVENTS.includes(v.eventName))
        return null;
    if (v.slug !== undefined && (!allowSlug || typeof v.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(v.slug) || v.slug.length > 160))
        return null;
    if (typeof v.occurredAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v.occurredAt))
        return null;
    const occurred = Date.parse(v.occurredAt);
    if (!Number.isFinite(occurred) || occurred > now || occurred < now - 300000)
        return null;
    if (!["tab", "document"].includes(String(v.identityScope)) || !["accepted", "declined", "unknown"].includes(String(v.consent)) || v.identityScope === "tab" && v.consent !== "accepted")
        return null;
    if (!["google_ads", "meta", "organic", "direct", "other"].includes(String(v.channel)) || !["mobile", "tablet", "desktop", "unknown"].includes(String(v.device)))
        return null;
    const eventName = v.eventName, detail = typeof v.detail === "string" ? v.detail : "";
    if (["page_view", "qualified_session"].includes(eventName) && detail !== "")
        return null;
    if (eventName === "contact_intent" && !["whatsapp", "phone", "form"].includes(detail))
        return null;
    if (eventName === "scroll" && !["25", "50", "75", "100"].includes(detail))
        return null;
    if (eventName === "engaged" && !["30s", "60s"].includes(detail))
        return null;
    if (eventName === "button_click" && !ACTIVITY_ACTIONS.includes(detail) && !acceptDetail?.(eventName, detail))
        return null;
    if (eventName === "link_click" && !["whatsapp", "phone", "shopee", "internal", "external", "header", "hero", "offer", "local", "final", "sticky"].includes(detail) && !acceptDetail?.(eventName, detail))
        return null;
    let qualification;
    if (v.qualification !== undefined) {
        const q = v.qualification;
        if (!q || typeof q !== "object" || Array.isArray(q))
            return null;
        const x = q;
        if (Object.keys(x).some(key => !["activeMs", "interaction", "scrollPercent"].includes(key)) || !Number.isInteger(x.activeMs) || Number(x.activeMs) < 0 || Number(x.activeMs) > 86400000 || !["scroll", "relevant_click", "contact"].includes(String(x.interaction)))
            return null;
        if (x.interaction === "scroll" && (typeof x.scrollPercent !== "number" || !Number.isFinite(x.scrollPercent) || x.scrollPercent < 25 || x.scrollPercent > 100))
            return null;
        if (x.scrollPercent !== undefined && (typeof x.scrollPercent !== "number" || !Number.isFinite(x.scrollPercent) || x.scrollPercent < 0 || x.scrollPercent > 100))
            return null;
        qualification = { activeMs: Number(x.activeMs), interaction: x.interaction, ...(x.scrollPercent === undefined ? {} : { scrollPercent: Number(x.scrollPercent) }) };
    }
    if (eventName === "qualified_session" && (!qualification || qualification.interaction !== "contact" && qualification.activeMs < 5000))
        return null;
    if (eventName === "contact_intent" && qualification?.interaction !== "contact")
        return null;
    if (!["qualified_session", "contact_intent"].includes(eventName) && qualification)
        return null;
    return { version: 2, eventId: String(v.eventId), occurredAt: v.occurredAt, eventName, pagePath, detail, channel: v.channel,
        campaign: activityCampaign(v.campaign), device: v.device, consent: v.consent,
        identityScope: v.identityScope, sessionToken: String(v.sessionToken), ...(qualification ? { qualification } : {}), ...(v.slug ? { slug: String(v.slug) } : {}), ...(v.attributionV1 === true ? { attributionV1: true } : {}), ...(v.attributionV1 === true && v.consent === "accepted" && v.identityScope === "tab" && v.channel === "organic" && ["qualified_session", "contact_intent"].includes(eventName) && v.organicSocialNetworkV2 !== undefined ? { organicSocialNetworkV2: v.organicSocialNetworkV2 } : {}) };
}

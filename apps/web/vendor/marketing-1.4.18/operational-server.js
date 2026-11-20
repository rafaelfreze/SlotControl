import { readBoundedBody } from "../marketing-1.3.2/hub-server.mjs";
import { isInternalTrafficRequest } from "./internal-traffic.js";
import { normalizeActivityV2 } from "./activity-contract.js";
export { normalizeActivityV2, ACTIVITY_V2_EVENTS, ACTIVITY_ACTIONS } from "./activity-contract.js";
/** Runtime deployment identity cannot be supplied by the event payload. */
export function isProductionMeasurementEnvironment(env = process.env) {
    return env.NODE_ENV === "production" && env.VERCEL_ENV === "production";
}
const positions = [
    "page",
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
    "other",
];
export function parseOperationalInput(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return null;
    const v = raw;
    if (Object.keys(v).some((k) => ![
        "version",
        "slug",
        "eventId",
        "event",
        "placement",
        "page",
        "channel",
    ].includes(k)) ||
        v.version !== 1 ||
        typeof v.eventId !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v.eventId) ||
        (v.slug !== undefined &&
            (typeof v.slug !== "string" ||
                v.slug.length > 160 ||
                !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v.slug))) ||
        !["page_view", "whatsapp_click", "phone_click"].includes(String(v.event)) ||
        !positions.includes(String(v.placement)) ||
        (v.event === "page_view" && v.placement !== "page") ||
        !["home", "services", "contact", "other"].includes(String(v.page)) ||
        !["google_ads", "meta", "organic", "direct", "unknown"].includes(String(v.channel)))
        return null;
    return v;
}
/** HTTP guard resolves tenant on the server from the published site and verified host. */
export async function serveOperationalRequest(request, resolve, record, routePath = "/api/marketing/operational", recordV2) {
    const headers = { "Cache-Control": "private, no-store" };
    const result = (status) => new Response(null, { status, headers });
    try {
        if (!isProductionMeasurementEnvironment() || isInternalTrafficRequest(request))
            return result(204);
        const url = new URL(request.url);
        if (request.method !== "POST" ||
            url.pathname !== routePath ||
            url.search ||
            !request.headers.get("content-type")?.startsWith("application/json"))
            return result(400);
        let origin;
        try {
            origin = new URL(request.headers.get("origin") ?? "");
        }
        catch {
            return result(403);
        }
        const host = (request.headers.get("host") ?? url.host).toLowerCase();
        if (origin.protocol !== "https:" ||
            origin.host !== host ||
            origin.pathname !== "/" ||
            origin.search ||
            origin.hash ||
            origin.username ||
            origin.password)
            return result(403);
        if (/(bot|crawler|spider|headless|preview|playwright|cypress|lighthouse)/i.test(request.headers.get("user-agent") ?? ""))
            return result(204);
        let raw;
        try {
            raw = JSON.parse(await readBoundedBody(request, 2048));
        }
        catch {
            return result(400);
        }
        if (raw && typeof raw === "object" && raw.version === 2) {
            if (!isProductionMeasurementEnvironment())
                return result(204);
            const v2 = normalizeActivityV2(raw, Date.now(), true);
            if (!v2)
                return result(400);
            const tenant = await resolve(origin.hostname, v2.slug);
            if (!tenant)
                return result(404);
            if (!recordV2)
                return result(503);
            return result(await recordV2(tenant, v2) ? 204 : 429);
        }
        const input = parseOperationalInput(raw);
        if (!input)
            return result(400);
        const tenant = await resolve(origin.hostname, input.slug);
        if (!tenant)
            return result(404);
        return result((await record(tenant, input)) ? 204 : 429);
    }
    catch {
        return result(503);
    }
}

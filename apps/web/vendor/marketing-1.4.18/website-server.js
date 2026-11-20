import { createHash, createHmac, randomUUID, timingSafeEqual, } from "node:crypto";
import { readBoundedBody, HubRequestError } from "../marketing-1.3.2/hub-server.mjs";
import { addDays, emptyDashboard } from "../marketing-1.3.2/kit.mjs";
import { fromSnapshots, validateMarketingSnapshot, } from "./model.js";
import { serveOperationalRequest } from "./operational-server.js";
export const WEBSITE_PRODUCTS = {
    servnexx: {
        label: "ServNexx · site institucional",
        schema: "servnexx",
        hosts: ["www.servnexx.com.br", "servnexx.com.br"],
    },
    zelyvara: {
        label: "Zelyvara · site institucional",
        schema: "zelyvara",
        hosts: ["www.zelyvara.com.br", "zelyvara.com.br"],
    },
    onfood: {
        label: "OnFood · site institucional",
        schema: "onfood",
        hosts: ["onfooddigital.com.br", "www.onfooddigital.com.br"],
    },
    nexxfitpro: {
        label: "NexxFit Pro · site institucional",
        schema: "nexxfitpro",
        hosts: ["nexxfitpro.com.br", "www.nexxfitpro.com.br"],
    },
    onplay_finance: {
        label: "OnPlay Finance · site institucional",
        schema: "onplay_finance",
        hosts: ["on-play-finance.vercel.app"],
    },
    coinops: {
        label: "CoinOps · site institucional",
        schema: "coinops",
        hosts: ["cripto-flax.vercel.app"],
    },
};
export function assertWebsiteBackend(product, url, schema) {
    if (new URL(url ?? "").hostname !== "otdfpmsegjxpqrzisfmi.supabase.co" ||
        schema !== WEBSITE_PRODUCTS[product].schema)
        throw Error("website_identity_mismatch");
}
function canonical(product, path, timestamp, nonce, body) {
    return [
        "onplay-website-aggregate-v1",
        product,
        "POST",
        path,
        timestamp,
        nonce,
        createHash("sha256").update(body).digest("hex"),
    ].join("\n");
}
/** Dedicated aggregate scope; never signs advertising or tenant requests. */
export function signWebsiteRead(product, secret, path, body) {
    if (secret.length < 32 ||
        !Object.hasOwn(WEBSITE_PRODUCTS, product) ||
        !["/api/marketing/platform-source", "/api/marketing-hub/export-v2"].includes(path))
        throw Error("website_read_unconfigured");
    const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomUUID();
    return {
        "content-type": "application/json",
        "x-onplay-website-product": product,
        "x-onplay-timestamp": timestamp,
        "x-onplay-nonce": nonce,
        "x-onplay-signature": createHmac("sha256", secret)
            .update(canonical(product, path, timestamp, nonce, body))
            .digest("hex"),
    };
}
/** Dedicated product HMAC shared by institutional discovery and exact-path v2 reads. */
export function verifyWebsiteReadSignature(request, body, secret, product, path = "/api/marketing/platform-source") {
    const url = new URL(request.url), time = request.headers.get("x-onplay-timestamp") ?? "";
    const nonce = request.headers.get("x-onplay-nonce") ?? "", signature = request.headers.get("x-onplay-signature") ?? "";
    if (!Object.hasOwn(WEBSITE_PRODUCTS, product) || request.method !== "POST" || url.pathname !== path || url.search || secret.length < 32
        || !["/api/marketing/platform-source", "/api/marketing-hub/export-v2"].includes(path)
        || request.headers.get("x-onplay-website-product") !== product || !/^\d{10}$/.test(time)
        || Math.abs(Date.now() / 1000 - Number(time)) > 90 || !/^[a-f0-9-]{36}$/i.test(nonce) || !/^[a-f0-9]{64}$/.test(signature)
        || !timingSafeEqual(createHmac("sha256", secret).update(canonical(product, path, time, nonce, body)).digest(), Buffer.from(signature, "hex")))
        throw new HubRequestError(401, "source_denied");
    return nonce;
}
export async function serveWebsiteCounter(request, db, product, recordV2) {
    return serveOperationalRequest(request, async (host, slug) => !slug &&
        WEBSITE_PRODUCTS[product].hosts.includes(host)
        ? "platform"
        : null, async (_scope, input) => {
        const r = await db.rpc("record_website_count_v1", {
            p_event_id: input.eventId,
            p_event: input.event,
            p_page: input.page,
            p_placement: input.placement,
            p_channel: input.channel,
        });
        if (r.error)
            throw Error("website_unavailable");
        return r.data === true;
    }, "/api/marketing/platform", recordV2);
}
export async function serveWebsiteSource(request, db, product, secret) {
    const headers = { "Cache-Control": "private, no-store" };
    try {
        const url = new URL(request.url);
        if (request.method !== "POST" ||
            url.pathname !== "/api/marketing/platform-source" ||
            url.search ||
            secret.length < 32)
            throw new HubRequestError(403, "source_denied");
        const body = await readBoundedBody(request, 1024);
        const nonce = verifyWebsiteReadSignature(request, body, secret, product);
        const input = JSON.parse(body);
        if (!input ||
            Object.keys(input).some((k) => !["operation", "externalTenant", "from", "to"].includes(k)) ||
            input.externalTenant !== "platform" ||
            !["discover", "export"].includes(String(input.operation)))
            throw new HubRequestError(400, "invalid_scope");
        const claim = await db.rpc("claim_website_read_nonce_v1", {
            p_nonce: nonce,
        });
        if (claim.error || claim.data !== true)
            throw new HubRequestError(409, "source_replay");
        if (input.operation === "discover")
            return Response.json({
                version: 1,
                product,
                tenants: [
                    {
                        externalTenant: "platform",
                        name: WEBSITE_PRODUCTS[product].label,
                        status: "active",
                    },
                ],
                nextCursor: null,
            }, { headers });
        if (typeof input.from !== "string" ||
            typeof input.to !== "string" ||
            !/^\d{4}-\d{2}-\d{2}$/.test(input.from) ||
            !/^\d{4}-\d{2}-\d{2}$/.test(input.to))
            throw new HubRequestError(400, "invalid_range");
        const data = await readWebsiteSnapshot(db, input.from, input.to);
        return Response.json(data, { headers });
    }
    catch (e) {
        return Response.json({ error: e instanceof HubRequestError ? e.code : "source_unavailable" }, { status: e instanceof HubRequestError ? e.status : 503, headers });
    }
}
export async function readWebsiteSnapshot(db, from, to) {
    const r = await db.rpc("get_website_snapshot_v1", { p_from: from, p_to: to });
    if (r.error)
        throw Error("website_unavailable");
    const s = validateMarketingSnapshot(r.data);
    if (s.externalTenant !== "platform" ||
        s.from !== from ||
        s.to !== to ||
        s.timezone !== "America/Campo_Grande")
        throw Error("invalid_website_scope");
    return s;
}
/** Native guard must run before calling. Same DTO and calculation as the OnPlay Master. */
export async function readWebsiteDashboard(db, product, period, channel) {
    const base = emptyDashboard(period, WEBSITE_PRODUCTS[product].label, channel);
    try {
        const parts = [];
        for (let from = period.from; from <= period.to; from = addDays(from, 31)) {
            const to = addDays(from, 30) < period.to ? addDays(from, 30) : period.to;
            parts.push(await readWebsiteSnapshot(db, from, to));
        }
        return fromSnapshots(base, parts);
    }
    catch {
        return {
            ...base,
            quality: "disconnected",
            notice: "Fonte institucional indisponível. Nenhum acesso ou clique foi estimado.",
        };
    }
}

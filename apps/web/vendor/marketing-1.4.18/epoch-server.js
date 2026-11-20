import { verifyWebsiteReadSignature } from "./website-server.js";
import { addDays, emptyDashboard, resolveHubPeriod, dayRange } from "../marketing-1.3.2/kit.mjs";
import { HubRequestError, hubErrorResponse, readBoundedBody, verifyHubSignature } from "../marketing-1.3.2/hub-server.mjs";
import { validateMarketingSnapshot } from "./commercial.js";
const PRODUCTS = ["servnexx", "zelyvara", "onfood", "nexxfitpro", "onplay_finance", "coinops"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const exactKeys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
const timestamp = (value) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/u.test(value) || !Number.isFinite(Date.parse(value)))
        return false;
    // Validate calendar fields while preserving the original microsecond proof.
    return new Date(value).toISOString().slice(0, 23) === value.slice(0, 23);
};
const tenant = (value) => typeof value === "string" && (value === "platform" || UUID.test(value));
const count = (value) => value === null || typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1e12;
const sameEpoch = (a, b) => a.id === b.id && a.effectiveAt === b.effectiveAt && a.instrumentationVersion === b.instrumentationVersion;
/** The epoch metadata is a proof from the product registry, never an optional client hint. */
export function parseMeasurementEpoch(raw) {
    const value = object(raw);
    if (!value || !exactKeys(value, ["id", "effectiveAt", "instrumentationVersion"]) || !UUID.test(String(value.id)) || !timestamp(value.effectiveAt) || value.instrumentationVersion !== 2)
        throw new HubRequestError(503, "measurement_epoch_unavailable");
    return { id: String(value.id), effectiveAt: value.effectiveAt, instrumentationVersion: 2 };
}
export function parseEpochRequest(raw) {
    const value = object(raw);
    if (!value || !exactKeys(value, ["operation", "externalTenant", "from", "to", "epochId", "effectiveAt", "instrumentationVersion"])
        || value.operation !== "snapshot" || !tenant(value.externalTenant) || typeof value.from !== "string" || typeof value.to !== "string"
        || !UUID.test(String(value.epochId)) || !timestamp(value.effectiveAt) || value.instrumentationVersion !== 2)
        throw new HubRequestError(400, "invalid_epoch_request");
    try {
        dayRange(value.from, value.to, 31);
    }
    catch {
        throw new HubRequestError(400, "invalid_range");
    }
    return { operation: "snapshot", externalTenant: value.externalTenant, from: value.from, to: value.to, epochId: String(value.epochId), effectiveAt: value.effectiveAt, instrumentationVersion: 2 };
}
export function validateEpochSnapshot(raw, input) {
    const value = object(raw);
    if (!value)
        throw new HubRequestError(503, "invalid_epoch_snapshot");
    let base;
    try {
        base = validateMarketingSnapshot(raw);
    }
    catch {
        throw new HubRequestError(503, "invalid_epoch_snapshot");
    }
    const epoch = parseMeasurementEpoch(value.measurementEpoch);
    if (base.externalTenant !== input.externalTenant || base.from !== input.from || base.to !== input.to || base.currency !== "BRL"
        || base.timezone !== "America/Campo_Grande" || !sameEpoch(epoch, { id: input.epochId, effectiveAt: input.effectiveAt, instrumentationVersion: 2 }))
        throw new HubRequestError(503, "epoch_scope_mismatch");
    let engagement;
    if (value.engagement !== undefined) {
        const part = object(value.engagement);
        if (!part || !exactKeys(part, ["version", "rawPageviews", "qualifiedSessions", "estimatedVisitors", "contactIntents", "whatsappClicks", "identityScope", "points"])
            || part.version !== 2 || !["document", "tab", "mixed", "unavailable"].includes(String(part.identityScope))
            || !["rawPageviews", "qualifiedSessions", "estimatedVisitors", "contactIntents"].every(key => count(part[key])) || !Array.isArray(part.points)
            || part.points.length > 31)
            throw new HubRequestError(503, "invalid_engagement");
        if (part.whatsappClicks !== undefined && (!count(part.whatsappClicks) || typeof part.whatsappClicks === "number" && (typeof part.contactIntents !== "number" || part.whatsappClicks > part.contactIntents)))
            throw new HubRequestError(503, "invalid_whatsapp_count");
        const epochDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Campo_Grande", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(epoch.effectiveAt));
        const seen = new Set();
        const points = part.points.map(rawPoint => {
            const point = object(rawPoint);
            if (!point || !exactKeys(point, ["date", "pageviews", "qualifiedSessions", "contactIntents", "whatsappClicks"]) || typeof point.date !== "string"
                || point.date < input.from || point.date > input.to || seen.has(point.date)
                || !["pageviews", "qualifiedSessions", "contactIntents"].every(key => count(point[key])))
                throw new HubRequestError(503, "invalid_engagement");
            try {
                dayRange(point.date, point.date, 1);
            }
            catch {
                throw new HubRequestError(503, "invalid_engagement");
            }
            if (point.date < epochDay && ([point.pageviews, point.qualifiedSessions, point.contactIntents].some(value => value !== null) || point.whatsappClicks !== undefined && point.whatsappClicks !== null))
                throw new HubRequestError(503, "pre_epoch_engagement");
            if (point.whatsappClicks !== undefined && (!count(point.whatsappClicks) || typeof point.whatsappClicks === "number" && (typeof point.contactIntents !== "number" || point.whatsappClicks > point.contactIntents)))
                throw new HubRequestError(503, "invalid_whatsapp_count");
            seen.add(point.date);
            return { date: point.date, pageviews: point.pageviews, qualifiedSessions: point.qualifiedSessions, contactIntents: point.contactIntents, ...(point.whatsappClicks !== undefined ? { whatsappClicks: point.whatsappClicks } : {}) };
        });
        if (seen.size !== dayRange(input.from, input.to, 31).length)
            throw new HubRequestError(503, "incomplete_engagement_days");
        for (const [total, key] of [["rawPageviews", "pageviews"], ["qualifiedSessions", "qualifiedSessions"], ["contactIntents", "contactIntents"]]) {
            const observed = points.map(point => point[key]).filter((value) => value !== null);
            if (part[total] !== (observed.length ? observed.reduce((sum, value) => sum + value, 0) : null))
                throw new HubRequestError(503, "inconsistent_engagement_total");
        }
        if (part.whatsappClicks !== undefined) {
            const observed = points.map(p => p.whatsappClicks).filter((v) => typeof v === "number");
            if (part.whatsappClicks !== (observed.length ? observed.reduce((a, b) => a + b, 0) : null) || points.some(p => p.contactIntents !== null && p.whatsappClicks === undefined))
                throw new HubRequestError(503, "inconsistent_whatsapp_total");
        }
        points.sort((a, b) => a.date.localeCompare(b.date));
        // No first-party visitor identifier is part of this operational contract.
        if (part.estimatedVisitors !== null)
            throw new HubRequestError(503, "unsupported_unique_visitors");
        engagement = { version: 2, rawPageviews: part.rawPageviews, qualifiedSessions: part.qualifiedSessions,
            estimatedVisitors: null, contactIntents: part.contactIntents, identityScope: part.identityScope, points, ...(part.whatsappClicks !== undefined ? { whatsappClicks: part.whatsappClicks } : {}) };
    }
    return { ...base, measurementEpoch: epoch, ...(engagement ? { engagement } : {}) };
}
/** Native caller must resolve membership/tenant permissions before invoking this product-local adapter. */
export async function readLocalEpochSnapshot(input, db) {
    if (!PRODUCTS.includes(input.product) || !tenant(input.externalTenant))
        throw new HubRequestError(404, "tenant_unavailable");
    const epochResult = await db.rpc("get_marketing_measurement_epoch_v2", { p_external_tenant: input.externalTenant });
    if (epochResult.error || !epochResult.data)
        throw new HubRequestError(503, "measurement_epoch_unavailable");
    const epoch = parseMeasurementEpoch(epochResult.data);
    const request = parseEpochRequest({ operation: "snapshot", externalTenant: input.externalTenant, from: input.from, to: input.to, epochId: epoch.id, effectiveAt: epoch.effectiveAt, instrumentationVersion: 2 });
    return readProvenEpochSnapshot(request, db);
}
/** Use only with an already-validated request and a backend client fixed to this product schema. */
export async function readProvenEpochSnapshot(input, db) {
    const result = await db.rpc("marketing_measurement_snapshot_v2", {
        p_external_tenant: input.externalTenant, p_from: input.from, p_to: input.to,
        p_epoch_id: input.epochId, p_effective_at: input.effectiveAt, p_instrumentation_version: 2,
    });
    if (result.error || !result.data)
        throw new HubRequestError(503, "measurement_source_unavailable");
    return validateEpochSnapshot(result.data, input);
}
/** V2 has its own signed path and strict epoch DTO. V1 cannot silently satisfy this request. */
export async function serveEpochExport(request, product, db, secret) {
    try {
        const url = new URL(request.url);
        if (!PRODUCTS.includes(product) || request.method !== "POST" || url.pathname !== "/api/marketing-hub/export-v2" || url.search
            || request.headers.get("x-onplay-reader") !== "central" || !request.headers.get("content-type")?.startsWith("application/json"))
            throw new HubRequestError(400, "invalid_request");
        const body = await readBoundedBody(request, 2048);
        if (product === 'onplay_finance' || product === 'coinops')
            verifyWebsiteReadSignature(request, body, secret, product, '/api/marketing-hub/export-v2');
        else
            verifyHubSignature(request, body, secret, product);
        let raw;
        try {
            raw = JSON.parse(body);
        }
        catch {
            throw new HubRequestError(400, "invalid_json");
        }
        const epochOperation = object(raw)?.operation === "epoch";
        const epochInput = object(raw);
        if (epochOperation && (!epochInput || !exactKeys(epochInput, ["operation", "externalTenant"]) || !tenant(epochInput.externalTenant)))
            throw new HubRequestError(400, "invalid_epoch_request");
        const input = epochOperation ? null : parseEpochRequest(raw);
        const requestedTenant = epochOperation ? epochInput.externalTenant : input.externalTenant;
        if ((product === 'onplay_finance' || product === 'coinops') && requestedTenant !== 'platform')
            throw new HubRequestError(400, 'invalid_scope');
        const nonce = request.headers.get("x-onplay-nonce");
        const claimed = await db.rpc("consume_marketing_hub_nonce", { p_nonce: nonce });
        if (claimed.error)
            throw new HubRequestError(503, "source_unavailable");
        if (claimed.data !== true)
            throw new HubRequestError(409, "replayed_request");
        if (epochOperation) {
            const epochResult = await db.rpc("get_marketing_measurement_epoch_v2", { p_external_tenant: epochInput.externalTenant });
            if (epochResult.error || !epochResult.data)
                throw new HubRequestError(503, "measurement_epoch_unavailable");
            return Response.json({ version: 2, product, externalTenant: epochInput.externalTenant, measurementEpoch: parseMeasurementEpoch(epochResult.data) }, { headers: { "Cache-Control": "private, no-store" } });
        }
        const snapshot = await readProvenEpochSnapshot(input, db);
        return Response.json(snapshot, { headers: { "Cache-Control": "private, no-store" } });
    }
    catch (error) {
        return hubErrorResponse(error);
    }
}
/** Calendar default without altering the shared legacy period parser. */
export function monthPeriodSearch(search, now = new Date()) {
    if (search.period)
        return search;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Campo_Grande", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    return { ...search, period: "custom", from: today.slice(0, 7) + "-01", to: today };
}
/** Combine only snapshots proven to belong to the same activation; never bridge v1 history. */
export function mergeEpochEngagement(parts) {
    if (!parts.length)
        throw new HubRequestError(503, "missing_epoch_snapshot");
    const first = parts[0].measurementEpoch;
    if (parts.some(part => !sameEpoch(part.measurementEpoch, first)))
        throw new HubRequestError(503, "incompatible_epochs");
    if (parts.some(part => !part.engagement))
        return { measurementEpoch: first };
    for (let i = 0; i < parts.length; i++) {
        if (parts[i].externalTenant !== parts[0].externalTenant || parts[i].timezone !== parts[0].timezone || (i > 0 && parts[i].from !== addDays(parts[i - 1].to, 1)))
            throw new HubRequestError(503, "incompatible_epoch_scope");
    }
    const observations = parts.map(part => part.engagement);
    // Uncovered chunks remain gaps; sum only the observed post-cutover population.
    const sum = (key) => {
        const values = observations.map(part => part[key]).filter((value) => value !== null);
        return values.length ? values.reduce((total, value) => total + value, 0) : null;
    };
    const scopes = new Set(observations.map(part => part.identityScope).filter(scope => scope !== "unavailable"));
    return { measurementEpoch: first, engagement: { version: 2, rawPageviews: sum("rawPageviews"), qualifiedSessions: sum("qualifiedSessions"), estimatedVisitors: null, contactIntents: sum("contactIntents"),
            whatsappClicks: observations.every(p => p.whatsappClicks !== undefined) ? (observations.some(p => typeof p.whatsappClicks === 'number') ? observations.reduce((n, p) => n + (p.whatsappClicks ?? 0), 0) : null) : null,
            identityScope: scopes.size > 1 || scopes.has("mixed") ? "mixed" : scopes.size ? [...scopes][0] : "unavailable",
            points: observations.flatMap(part => part.points) } };
}
/** New native panels consume only v2. A legacy RPC, paid report or previous cache is never a fallback. */
export async function readEpochDashboard(base, product, externalTenant, db) {
    const blank = emptyDashboard(base.period, base.clientName, "all", "Nova medição aguardando ativação ou confirmação da fonte. O histórico anterior permanece preservado e não é misturado à nova base.");
    try {
        const days = dayRange(base.period.from, base.period.to, 366), parts = [];
        for (let start = 0; start < days.length; start += 31)
            parts.push(await readLocalEpochSnapshot({ product, externalTenant, from: days[start], to: days[Math.min(start + 30, days.length - 1)] }, db));
        const proof = mergeEpochEngagement(parts);
        const observed = proof.engagement;
        return { ...blank, ...proof, quality: observed ? "partial" : "disconnected",
            updatedAt: parts.map(part => part.collectedAt).sort()[0] ?? null,
            metrics: blank.metrics.map(metric => metric.key === "visits" ? { ...metric, value: observed?.rawPageviews ?? null, note: "Pageviews brutos elegíveis v2; não são pessoas nem sessões qualificadas." } : metric.key === "intents" ? { ...metric, value: observed?.contactIntents ?? null, note: "Cliques humanos de contato deduplicados por sessão e ação; não confirmam conversa ou venda." } : { ...metric, value: null, change: null }),
            trend: observed?.points.map(point => ({ date: point.date, visits: point.pageviews, spend: null })) ?? [],
            notice: "Instrumentação v2 após o marco zero. Períodos anteriores ao início da coleta não são reconstruídos; comparações, pessoas únicas e atribuição de venda permanecem indisponíveis sem evidência." };
    }
    catch {
        return { ...blank, quality: "disconnected" };
    }
}
export function resolveEpochPeriod(search, _timezone = "America/Campo_Grande", now = new Date()) {
    const selection = search.period ?? "month", zone = "America/Campo_Grande";
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    if (selection === "month" || selection === "previous_month") {
        const start = today.slice(0, 7) + "-01", to = selection === "previous_month" ? addDays(start, -1) : today;
        const from = selection === "previous_month" ? to.slice(0, 7) + "-01" : start;
        const period = resolveHubPeriod({ period: "custom", from, to }, zone, now);
        return { ...period, selection, label: (selection === "month" ? "Mês atual" : "Mês anterior") + " · " + period.label };
    }
    const period = resolveHubPeriod(search, zone, now);
    return { ...period, selection };
}
export async function recordEpochActivity(db, externalTenant, input) {
    if (!tenant(externalTenant) || input.version !== 2)
        return false;
    const result = await db.rpc("record_marketing_activity_v2", { p_external_tenant: externalTenant, p_input: input });
    if (result.error)
        throw new Error("measurement_source_unavailable");
    return result.data === true;
}

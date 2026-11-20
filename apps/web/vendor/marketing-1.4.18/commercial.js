import { validateMeasurement } from "./measurement.js";
import { addDays, dayInTimezone, dayRange, validateSnapshot } from "../marketing-1.3.2/kit.mjs";
export const COMMERCIAL_TIMEZONE = "America/Campo_Grande";
export const COMMERCIAL_METRICS = ["quotes_requested", "quotes_created", "quotes_approved", "appointments_completed", "orders_completed", "qualified_leads"];
export const commercialNames = {
    quotes_requested: "Orçamentos solicitados", quotes_created: "Orçamentos registrados", quotes_approved: "Orçamentos aprovados",
    appointments_completed: "Atendimentos realizados", orders_completed: "Pedidos concluídos", qualified_leads: "Leads qualificados",
};
/** Optional additive DTO. Unknown fields, identifiers and payloads never cross this boundary. */
export function validateMarketingSnapshot(raw, maxDays = 31) {
    const parsed = validateSnapshot(raw, maxDays);
    const measurement = validateMeasurement(raw.measurement, parsed, maxDays);
    const base = { ...parsed, ...(measurement ? { measurement } : {}) };
    const extra = raw.commercial;
    if (extra === undefined)
        return base;
    if (!extra || typeof extra !== "object" || Array.isArray(extra))
        throw new Error("invalid_commercial_snapshot");
    const s = extra;
    if (s.version !== 1 || s.externalTenant !== base.externalTenant || s.from !== base.from || s.to !== base.to || s.timezone !== COMMERCIAL_TIMEZONE || !Number.isFinite(Date.parse(s.collectedAt)))
        throw new Error("invalid_commercial_scope");
    if (s.temporalNote !== undefined && (typeof s.temporalNote !== "string" || s.temporalNote.length > 600 || /[\u0000-\u001f]/.test(s.temporalNote)))
        throw new Error("invalid_commercial_notice");
    if (!Array.isArray(s.availableMetrics) || new Set(s.availableMetrics).size !== s.availableMetrics.length || s.availableMetrics.some(m => !COMMERCIAL_METRICS.includes(m)) || !s.coverageStart || !s.definitions || !Array.isArray(s.facts) || s.facts.length > maxDays * COMMERCIAL_METRICS.length)
        throw new Error("invalid_commercial_metrics");
    for (const key of s.availableMetrics) {
        if (typeof s.definitions[key] !== "string" || !s.definitions[key].trim() || s.definitions[key].length > 1500 || /[\u0000-\u001f]/.test(s.definitions[key]) || !/^\d{4}-\d{2}-\d{2}$/.test(s.coverageStart[key] ?? ""))
            throw new Error("invalid_commercial_definition");
        dayRange(s.coverageStart[key], s.coverageStart[key], 1);
    }
    const seen = new Set();
    for (const f of s.facts) {
        if (!s.availableMetrics.includes(f.metric) || f.channel !== "all" || !Number.isSafeInteger(f.value) || f.value < 0 || !["partial", "complete"].includes(f.quality) || !/^\d{4}-\d{2}-\d{2}$/.test(f.date) || f.date < s.from || f.date > s.to || f.date < s.coverageStart[f.metric])
            throw new Error("invalid_commercial_fact");
        const key = `${f.metric}:${f.date}`;
        if (seen.has(key))
            throw new Error("duplicate_commercial_fact");
        seen.add(key);
    }
    return { ...base, commercial: {
            version: 1, externalTenant: base.externalTenant, from: base.from, to: base.to, timezone: COMMERCIAL_TIMEZONE, collectedAt: s.collectedAt, ...(s.temporalNote ? { temporalNote: s.temporalNote } : {}),
            availableMetrics: [...s.availableMetrics], coverageStart: Object.fromEntries(s.availableMetrics.map(k => [k, s.coverageStart[k]])),
            definitions: Object.fromEntries(s.availableMetrics.map(k => [k, s.definitions[k]])),
            facts: s.facts.map(f => ({ date: f.date, channel: "all", metric: f.metric, value: f.value, quality: f.quality })),
        } };
}
export function mergeCommercialSnapshots(parts, from, to) {
    if (!parts.length || parts.some(p => !p.commercial))
        return undefined;
    const all = parts.map(p => p.commercial);
    const first = all[0];
    all.forEach((p, i) => { if (p.externalTenant !== first.externalTenant || p.timezone !== first.timezone || (i && p.from !== addDays(all[i - 1].to, 1)))
        throw new Error("incompatible_commercial_snapshots"); });
    const available = first.availableMetrics.filter(m => all.every(p => p.availableMetrics.includes(m) && p.definitions[m] === first.definitions[m]));
    return { ...first, from, to, collectedAt: all.map(p => p.collectedAt).sort()[0], availableMetrics: available,
        coverageStart: Object.fromEntries(available.map(m => [m, all.map(p => p.coverageStart[m]).sort().at(-1)])),
        definitions: Object.fromEntries(available.map(m => [m, first.definitions[m]])),
        facts: all.flatMap(p => p.facts.filter(f => available.includes(f.metric))), };
}
/** No attribution by timing: operational records have no advertising channel. */
export function commercialMetrics(parts, channel, from, to) {
    const snapshot = mergeCommercialSnapshots(parts, from, to);
    const today = snapshot ? [dayInTimezone(new Date(), COMMERCIAL_TIMEZONE), dayInTimezone(snapshot.collectedAt, COMMERCIAL_TIMEZONE)].sort()[0] : null;
    return COMMERCIAL_METRICS.map(key => {
        const available = !!snapshot?.availableMetrics.includes(key) && snapshot.coverageStart[key] <= to;
        const rows = snapshot?.facts.filter(f => f.metric === key) ?? [];
        const partial = !available || snapshot.coverageStart[key] > from || to >= today || rows.some(f => f.quality === "partial");
        const value = available && channel === "all" && (rows.length || !partial) ? rows.reduce((sum, f) => sum + f.value, 0) : null;
        return { key, label: commercialNames[key], value, unit: "count", change: null,
            note: !available ? "Fonte comercial ainda não integrada." : channel !== "all" ? "Origem publicitária não comprovada. Consulte todas as origens." : `${partial ? "Cobertura parcial. " : ""}${snapshot.definitions[key]}` };
    });
}

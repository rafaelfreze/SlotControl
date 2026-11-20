import { measurementValues, MEASUREMENT_METRICS } from "./measurement.js";
export { MEASUREMENT_METRICS, measurementNames, mergeMeasurementSnapshots } from "./measurement.js";
import { addDays, CHANNELS, COUNT_METRICS, dayInTimezone, dayRange, emptyDashboard } from "../marketing-1.3.2/kit.mjs";
import { commercialMetrics, COMMERCIAL_METRICS, commercialNames, validateMarketingSnapshot } from "./commercial.js";
export { COMMERCIAL_TIMEZONE, COMMERCIAL_METRICS, commercialNames, validateMarketingSnapshot, mergeCommercialSnapshots } from "./commercial.js";
export const productNames = { onplay_fiscal: "OnPlay / Arte Laser", servnexx: "ServNexx", zelyvara: "Zelyvara", onfood: "OnFood", nexxfitpro: "NexxFit Pro", onplay_finance: "OnPlay Finance", coinops: "CoinOps" };
export const channelNames = { all: "Todas as origens", google_ads: "Google Ads", meta: "Meta / Instagram", direct: "Direto", organic: "Orgânico", unknown: "Desconhecida" };
export const metricNames = { visits: "Visualizações do site", intents: "Intenções de contato", leads: "Solicitações recebidas", conversations: "Conversas recebidas", appointments: "Agendamentos criados", closures: "Fechamentos", purchases: "Compras confirmadas" };
export function businessMetrics(data) {
    const names = { ...metricNames, ...commercialNames };
    return ["leads", "conversations", "appointments", "closures", "purchases", ...COMMERCIAL_METRICS].map(key => data.metrics.find(m => m.key === key) ?? { key, label: names[key], value: null, unit: "count", change: null, note: "Fonte comercial ainda não integrada." });
}
const day = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + "T12:00:00Z")) && new Date(v + "T12:00:00Z").toISOString().slice(0, 10) === v;
const text = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f]/.test(v);
const number = (v, max = 1e12) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max;
const count = (v) => v === null || number(v, 1e10) && Number.isSafeInteger(v);
export function validCompanyKey(value) {
    return typeof value === "string" && /^(onplay_fiscal:(onplay_marketing|catalog:[0-9a-f-]{36})|(servnexx|zelyvara|onfood|nexxfitpro):(?:[0-9a-f-]{36}|platform)|(onplay_finance|coinops):platform)$/i.test(value);
}
/** Strict DTO boundary: no arbitrary JSON, profile, contact or credential reaches clients. */
export function parseAdReport(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("invalid_report");
    const v = raw;
    if (!validCompanyKey(v.companyKey) || !text(v.id, 80) || !["google_ads", "meta"].includes(String(v.platform)) || !text(v.accountId, 80) || !/^[a-zA-Z0-9_-]+$/.test(String(v.accountId)) || !text(v.campaignId, 100) || !/^[a-zA-Z0-9_-]+$/.test(String(v.campaignId)) || ["all", "total", "account"].includes(String(v.campaignId).toLowerCase()) || !text(v.campaignName, 180) || !day(v.from) || !day(v.to) || v.to < v.from || dayRange(v.from, v.to, 90).length > 90 || v.currency !== "BRL" || !number(v.spendCents) || !Number.isSafeInteger(v.spendCents) || !count(v.impressions) || !count(v.clicks) || !(v.conversions === null || number(v.conversions, 1e9)) || !count(v.qualifiedLeads) || !["complete", "partial"].includes(String(v.coverage)) || !["manual", "official_export", "authenticated_dashboard", "official_api"].includes(String(v.source)) || !text(v.evidence, 1000) || typeof v.notes !== "string" || v.notes.length > 2000 || /[\u0000-\u001f]/.test(v.notes) || typeof v.timezone !== "string" || typeof v.collectedAt !== "string" || !Number.isFinite(Date.parse(v.collectedAt)) || typeof v.createdAt !== "string" || !Number.isFinite(Date.parse(v.createdAt)) || !(v.supersedes === null || text(v.supersedes, 80)))
        throw new Error("invalid_report");
    try {
        new Intl.DateTimeFormat("en", { timeZone: v.timezone });
    }
    catch {
        throw new Error("invalid_timezone");
    }
    if (Date.parse(v.collectedAt) > Date.now() + 300_000 || v.to > dayInTimezone(v.collectedAt, v.timezone) || v.coverage === "complete" && v.to >= addDays(dayInTimezone(v.collectedAt, v.timezone), -1))
        throw new Error("unclosed_report");
    if (v.qualifiedLeads !== null && (!text(v.qualifiedEvidence, 1000)))
        throw new Error("qualification_evidence_required");
    return Object.fromEntries(["id", "companyKey", "platform", "accountId", "campaignId", "campaignName", "from", "to", "timezone", "currency", "spendCents", "impressions", "clicks", "conversions", "qualifiedLeads", "qualifiedEvidence", "coverage", "source", "evidence", "notes", "collectedAt", "createdAt", "supersedes"].map(k => [k, v[k] ?? null]));
}
export function parsePaidData(raw, key, from, to) {
    if (!raw || typeof raw !== "object")
        throw new Error("invalid_reports");
    const v = raw;
    if (v.companyKey !== key || v.from !== from || v.to !== to || !Array.isArray(v.reports) || v.reports.length > 1000)
        throw new Error("invalid_reports_scope");
    const reports = v.reports.map(parseAdReport);
    for (const r of reports)
        if (r.companyKey !== key || r.to < from || r.from > to)
            throw new Error("invalid_reports_scope");
    const seen = new Set();
    for (const r of reports) {
        if (seen.has(r.id))
            throw new Error("duplicate_report");
        seen.add(r.id);
    }
    for (let i = 0; i < reports.length; i++)
        for (let j = i + 1; j < reports.length; j++) {
            const a = reports[i], b = reports[j];
            if (a.platform === b.platform && a.accountId === b.accountId && a.campaignId === b.campaignId && a.from <= b.to && b.from <= a.to)
                throw new Error("overlapping_report");
        }
    return { available: true, reports };
}
export function summarizePaid(paid, from, to, channel) {
    const rows = (paid?.reports ?? []).filter(r => (channel === "all" || channel === r.platform) && r.from >= from && r.to <= to);
    const overlaps = (paid?.reports ?? []).some(r => (channel === "all" || channel === r.platform) && (r.from < from || r.to > to));
    const groups = new Map();
    for (const r of rows) {
        const k = `${r.platform}:${r.accountId}:${r.campaignId}`;
        groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    const complete = !!groups.size && !overlaps && [...groups.values()].every(g => { const s = g.slice().sort((a, b) => a.from.localeCompare(b.from)); return s[0].from === from && s.at(-1).to === to && s.every((r, i) => r.coverage === "complete" && (!i || r.from === addDays(s[i - 1].to, 1))); });
    const total = (key) => rows.length && rows.every(r => r[key] !== null) ? rows.reduce((s, r) => s + r[key], 0) : null;
    // Existing account-level FinOps evidence is a fallback, never added to campaign reports.
    const legacy = rows.length || overlaps ? [] : (paid?.legacySpend ?? []).filter(r => channel === "all" || channel === r.platform);
    const spendCents = rows.length ? total("spendCents") : legacy.length ? legacy.reduce((s, r) => s + r.spendCents, 0) : null, clicks = total("clicks"), conversions = total("conversions");
    return { rows, legacy, complete: complete || legacy.length > 0, overlaps, spend: spendCents === null ? null : spendCents / 100, clicks, conversions, impressions: total("impressions"), qualified: total("qualifiedLeads"), cpc: spendCents !== null && clicks ? spendCents / 100 / clicks : null, cpa: spendCents !== null && conversions ? spendCents / 100 / conversions : null };
}
/** One calculation used by Master and native products. Never counts people from page views. */
export function fromSnapshots(base, inputs) {
    if (!inputs.length)
        return { ...base, quality: "disconnected" };
    const parts = inputs.map(p => validateMarketingSnapshot(p, 90));
    const first = parts[0];
    if (first.from !== base.period.from || parts.at(-1).to !== base.period.to || first.timezone !== base.timezone || first.currency !== base.currency)
        throw new Error("invalid_snapshot_scope");
    parts.forEach((p, i) => { if (p.externalTenant !== first.externalTenant || p.timezone !== first.timezone || p.currency !== first.currency || i > 0 && p.from !== addDays(parts[i - 1].to, 1))
        throw new Error("invalid_snapshot_scope"); });
    const available = first.availableMetrics.filter(m => parts.every(p => p.availableMetrics.includes(m) && p.definitions[m] === first.definitions[m]));
    const coverage = Object.fromEntries(available.map(m => [m, parts.map(p => p.coverageStart[m]).sort().at(-1)]));
    const facts = parts.flatMap(p => p.facts.filter(f => available.includes(f.metric)));
    const today = [dayInTimezone(new Date(), first.timezone), ...parts.map(p => dayInTimezone(p.collectedAt, p.timezone))].sort()[0];
    const partial = (m) => !coverage[m] || coverage[m] > base.period.from || base.period.to >= today || facts.some(f => f.metric === m && f.quality === "partial");
    const observed = (m, ch = base.channel, date) => {
        if (!available.includes(m) || coverage[m] > base.period.to)
            return null;
        const all = facts.filter(f => f.metric === m);
        if (ch !== "all" && (all.some(f => f.channel === "all") || !all.length))
            return null;
        const chosen = all.filter(f => (ch === "all" || f.channel === ch) && (!date || f.date === date));
        const incomplete = date ? date < coverage[m] || date >= today || facts.some(f => f.metric === m && f.date === date && f.quality === "partial") : partial(m);
        return chosen.length ? chosen.reduce((s, f) => s + f.value, 0) : incomplete ? null : 0;
    };
    const measurement = measurementValues(parts, base.channel, base.period.from, base.period.to);
    const metrics = [...COUNT_METRICS.map(m => ({ key: m, label: metricNames[m], value: observed(m), unit: "count", change: null, note: (partial(m) ? "Cobertura parcial. " : "") + (first.definitions[m] ?? "Fonte indisponível.") })), ...base.metrics.filter(m => !COUNT_METRICS.some(key => key === m.key) && !COMMERCIAL_METRICS.some(key => key === m.key) && !MEASUREMENT_METRICS.some(key => key === m.key)).map(m => ({ ...m, value: null, change: null })), ...commercialMetrics(parts, base.channel, base.period.from, base.period.to), ...measurement.metrics];
    const points = dayRange(base.period.from, base.period.to, 90).map(date => ({ date, visits: observed("visits", base.channel, date), intents: observed("intents", base.channel, date), conversations: observed("conversations", base.channel, date) }));
    return { ...base, quality: available.some(partial) ? "partial" : "updated", updatedAt: parts.map(p => p.collectedAt).sort()[0], metrics,
        points, measurementPoints: measurement.points, definitions: first.definitions, partialMetrics: [...COUNT_METRICS.filter(partial), ...metrics.filter(m => m.note.startsWith("Cobertura parcial.") && !COUNT_METRICS.some(k => k === m.key)).map(m => m.key)],
        channels: CHANNELS.filter(ch => base.channel === "all" || base.channel === ch).map(ch => ({ key: ch, visits: observed("visits", ch), leads: observed("leads", ch), conversations: observed("conversations", ch), spend: null, share: null })).filter(c => c.visits !== null),
        funnel: metrics.filter(m => COUNT_METRICS.some(k => k === m.key)).map(m => ({ key: m.key, label: m.label, value: m.value, rate: null, note: m.note })), trend: points.map(p => ({ date: p.date, visits: p.visits, spend: null })),
        notice: ["Resultados do próprio sistema. Visualizações não são pessoas únicas. Cliques são intenções, não conversas ou vendas. Fontes operacionais e publicitárias são exibidas separadamente.", ...new Set(parts.map(p => p.commercial?.temporalNote).filter(Boolean))].join(" ") };
}
export function comparison(current, previous, key) {
    const a = current.metrics.find(m => m.key === key), b = previous?.metrics.find(m => m.key === key);
    if (!a || !b || a.value === null || b.value === null || b.value <= 0 || current.timezone !== previous?.timezone || current.currency !== previous.currency || current.partialMetrics?.includes(key) || previous.partialMetrics?.includes(key) || current.quality !== "updated" || previous.quality !== "updated" || a.note !== b.note)
        return null;
    return (a.value - b.value) / b.value * 100;
}
export function stages(data, product) {
    const available = (key) => data.metrics.find(m => m.key === key)?.value !== null && data.metrics.some(m => m.key === key);
    const keys = product === "onfood" ? ["visits", "intents", "leads", "purchases"] : product === "nexxfitpro" ? ["visits", "leads", "closures", "purchases"] : ["visits", "intents", "conversations", "appointments", "closures", "purchases"];
    return keys.filter(k => k === "visits" || k === "intents" || available(k)).slice(0, 6).map(key => ({ key, label: metricNames[key], value: data.metrics.find(m => m.key === key)?.value ?? null }));
}
export function blankData(period, name, channel) { return emptyDashboard(period, name, channel); }

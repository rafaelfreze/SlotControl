import { addDays, dayInTimezone, dayRange, CHANNELS } from "../marketing-1.3.2/kit.mjs";
export const MEASUREMENT_METRICS = ["operational_whatsapp", "operational_phone", "authorized_intents", "meta_contacts"];
export const measurementNames = { operational_whatsapp: "Cliques WhatsApp agregados", operational_phone: "Cliques em telefone", authorized_intents: "Intenções com medição autorizada", meta_contacts: "Contact recebidos pelo Meta" };
/** Whitelist aggregate facts. Advertising receipts require a real provider source. */
export function validateMeasurement(raw, base, maxDays) {
    if (raw === undefined)
        return undefined;
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("invalid_measurement");
    const s = raw;
    if (s.version !== 1 || s.externalTenant !== base.externalTenant || s.from !== base.from || s.to !== base.to || s.timezone !== "America/Campo_Grande" || !Number.isFinite(Date.parse(s.collectedAt)))
        throw new Error("invalid_measurement_scope");
    if (!Array.isArray(s.availableMetrics) || new Set(s.availableMetrics).size !== s.availableMetrics.length || s.availableMetrics.some(m => !MEASUREMENT_METRICS.includes(m)) || !s.coverageStart || !s.definitions || !Array.isArray(s.facts) || s.facts.length > maxDays * MEASUREMENT_METRICS.length * 6)
        throw new Error("invalid_measurement_metrics");
    for (const key of s.availableMetrics) {
        const date = s.coverageStart[key], text = s.definitions[key];
        if (typeof date !== "string" || typeof text !== "string" || !text.trim() || text.length > 1500 || /[\u0000-\u001f]/.test(text))
            throw new Error("invalid_measurement_definition");
        dayRange(date, date, 1);
    }
    const seen = new Set();
    const facts = s.facts.map(f => { const k = `${f.date}:${f.metric}:${f.channel}`; if (!s.availableMetrics.includes(f.metric) || ![...CHANNELS, "all"].includes(f.channel) || !Number.isSafeInteger(f.value) || f.value < 0 || !["complete", "partial"].includes(f.quality) || f.date < s.from || f.date > s.to || f.date < s.coverageStart[f.metric] || seen.has(k))
        throw new Error("invalid_measurement_fact"); dayRange(f.date, f.date, 1); seen.add(k); return { date: f.date, metric: f.metric, channel: f.channel, value: f.value, quality: f.quality }; });
    for (const metric of s.availableMetrics)
        if (facts.some(f => f.metric === metric && f.channel === "all") && facts.some(f => f.metric === metric && f.channel !== "all"))
            throw new Error("overlapping_measurement_population");
    return { version: 1, externalTenant: base.externalTenant, from: base.from, to: base.to, timezone: s.timezone, collectedAt: s.collectedAt, availableMetrics: [...s.availableMetrics], coverageStart: Object.fromEntries(s.availableMetrics.map(k => [k, s.coverageStart[k]])), definitions: Object.fromEntries(s.availableMetrics.map(k => [k, s.definitions[k]])), facts };
}
export function mergeMeasurementSnapshots(parts, from, to) {
    if (!parts.length || parts.some(p => !p.measurement))
        return undefined;
    const all = parts.map(p => p.measurement), first = all[0];
    all.forEach((p, i) => { if (p.externalTenant !== first.externalTenant || p.timezone !== first.timezone || i && p.from !== addDays(all[i - 1].to, 1))
        throw new Error("incompatible_measurement"); });
    const available = first.availableMetrics.filter(m => all.every(p => p.availableMetrics.includes(m) && p.definitions[m] === first.definitions[m]));
    return { ...first, from, to, collectedAt: all.map(p => p.collectedAt).sort()[0], availableMetrics: available, coverageStart: Object.fromEntries(available.map(m => [m, all.map(p => p.coverageStart[m]).sort().at(-1)])), definitions: Object.fromEntries(available.map(m => [m, first.definitions[m]])), facts: all.flatMap(p => p.facts.filter(f => available.includes(f.metric))) };
}
export function measurementValues(parts, channel, from, to) {
    const s = mergeMeasurementSnapshots(parts, from, to);
    const today = s ? [dayInTimezone(new Date(), s.timezone), dayInTimezone(s.collectedAt, s.timezone)].sort()[0] : "";
    const value = (key, date) => { if (!s?.availableMetrics.includes(key) || s.coverageStart[key] > (date ?? to))
        return null; const all = s.facts.filter(f => f.metric === key); if (channel !== "all" && (!all.length || all.some(f => f.channel === "all")))
        return null; const rows = all.filter(f => (channel === "all" || f.channel === channel) && (!date || f.date === date)); const partial = s.coverageStart[key] > (date ?? from) || (date ?? to) >= today || rows.some(f => f.quality === "partial"); return rows.length ? rows.reduce((n, f) => n + f.value, 0) : partial ? null : 0; };
    const metrics = MEASUREMENT_METRICS.map(key => ({ key, label: measurementNames[key], value: value(key), unit: "count", change: null, note: !s?.availableMetrics.includes(key) ? key === "meta_contacts" ? "Recepção não consultada automaticamente no Meta. Ausência desta fonte não significa zero eventos." : "Fonte operacional específica ainda não integrada." : `${s.coverageStart[key] > from || to >= today || s.facts.some(f => f.metric === key && f.quality === "partial") ? "Cobertura parcial. " : ""}${s.definitions[key]}` }));
    return { metrics, points: dayRange(from, to, 90).map(date => ({ date, whatsapp: value("operational_whatsapp", date), phone: value("operational_phone", date) })) };
}

import { a as validateSnapshot, c as dayRange, h as COUNT_METRICS, o as addDays, p as CHANNELS, s as dayInTimezone } from "./shared-C4pS49Qj.mjs";
//#region node_modules/@onplay/marketing-premium/dist/measurement.js
const MEASUREMENT_METRICS = [
	"operational_whatsapp",
	"operational_phone",
	"authorized_intents",
	"meta_contacts"
];
const measurementNames = {
	operational_whatsapp: "Cliques WhatsApp agregados",
	operational_phone: "Cliques em telefone",
	authorized_intents: "Intenções com medição autorizada",
	meta_contacts: "Contact recebidos pelo Meta"
};
/** Whitelist aggregate facts. Advertising receipts require a real provider source. */
function validateMeasurement(raw, base, maxDays) {
	if (raw === void 0) return void 0;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_measurement");
	const s = raw;
	if (s.version !== 1 || s.externalTenant !== base.externalTenant || s.from !== base.from || s.to !== base.to || s.timezone !== "America/Campo_Grande" || !Number.isFinite(Date.parse(s.collectedAt))) throw new Error("invalid_measurement_scope");
	if (!Array.isArray(s.availableMetrics) || new Set(s.availableMetrics).size !== s.availableMetrics.length || s.availableMetrics.some((m) => !MEASUREMENT_METRICS.includes(m)) || !s.coverageStart || !s.definitions || !Array.isArray(s.facts) || s.facts.length > maxDays * MEASUREMENT_METRICS.length * 6) throw new Error("invalid_measurement_metrics");
	for (const key of s.availableMetrics) {
		const date = s.coverageStart[key], text = s.definitions[key];
		if (typeof date !== "string" || typeof text !== "string" || !text.trim() || text.length > 1500 || /[\u0000-\u001f]/.test(text)) throw new Error("invalid_measurement_definition");
		dayRange(date, date, 1);
	}
	const seen = /* @__PURE__ */ new Set();
	const facts = s.facts.map((f) => {
		const k = `${f.date}:${f.metric}:${f.channel}`;
		if (!s.availableMetrics.includes(f.metric) || ![...CHANNELS, "all"].includes(f.channel) || !Number.isSafeInteger(f.value) || f.value < 0 || !["complete", "partial"].includes(f.quality) || f.date < s.from || f.date > s.to || f.date < s.coverageStart[f.metric] || seen.has(k)) throw new Error("invalid_measurement_fact");
		dayRange(f.date, f.date, 1);
		seen.add(k);
		return {
			date: f.date,
			metric: f.metric,
			channel: f.channel,
			value: f.value,
			quality: f.quality
		};
	});
	for (const metric of s.availableMetrics) if (facts.some((f) => f.metric === metric && f.channel === "all") && facts.some((f) => f.metric === metric && f.channel !== "all")) throw new Error("overlapping_measurement_population");
	return {
		version: 1,
		externalTenant: base.externalTenant,
		from: base.from,
		to: base.to,
		timezone: s.timezone,
		collectedAt: s.collectedAt,
		availableMetrics: [...s.availableMetrics],
		coverageStart: Object.fromEntries(s.availableMetrics.map((k) => [k, s.coverageStart[k]])),
		definitions: Object.fromEntries(s.availableMetrics.map((k) => [k, s.definitions[k]])),
		facts
	};
}
function mergeMeasurementSnapshots(parts, from, to) {
	if (!parts.length || parts.some((p) => !p.measurement)) return void 0;
	const all = parts.map((p) => p.measurement), first = all[0];
	all.forEach((p, i) => {
		if (p.externalTenant !== first.externalTenant || p.timezone !== first.timezone || i && p.from !== addDays(all[i - 1].to, 1)) throw new Error("incompatible_measurement");
	});
	const available = first.availableMetrics.filter((m) => all.every((p) => p.availableMetrics.includes(m) && p.definitions[m] === first.definitions[m]));
	return {
		...first,
		from,
		to,
		collectedAt: all.map((p) => p.collectedAt).sort()[0],
		availableMetrics: available,
		coverageStart: Object.fromEntries(available.map((m) => [m, all.map((p) => p.coverageStart[m]).sort().at(-1)])),
		definitions: Object.fromEntries(available.map((m) => [m, first.definitions[m]])),
		facts: all.flatMap((p) => p.facts.filter((f) => available.includes(f.metric)))
	};
}
function measurementValues(parts, channel, from, to) {
	const s = mergeMeasurementSnapshots(parts, from, to);
	const today = s ? [dayInTimezone(/* @__PURE__ */ new Date(), s.timezone), dayInTimezone(s.collectedAt, s.timezone)].sort()[0] : "";
	const value = (key, date) => {
		if (!s?.availableMetrics.includes(key) || s.coverageStart[key] > (date ?? to)) return null;
		const all = s.facts.filter((f) => f.metric === key);
		if (channel !== "all" && (!all.length || all.some((f) => f.channel === "all"))) return null;
		const rows = all.filter((f) => (channel === "all" || f.channel === channel) && (!date || f.date === date));
		const partial = s.coverageStart[key] > (date ?? from) || (date ?? to) >= today || rows.some((f) => f.quality === "partial");
		return rows.length ? rows.reduce((n, f) => n + f.value, 0) : partial ? null : 0;
	};
	return {
		metrics: MEASUREMENT_METRICS.map((key) => ({
			key,
			label: measurementNames[key],
			value: value(key),
			unit: "count",
			change: null,
			note: !s?.availableMetrics.includes(key) ? key === "meta_contacts" ? "Recepção não consultada automaticamente no Meta. Ausência desta fonte não significa zero eventos." : "Fonte operacional específica ainda não integrada." : `${s.coverageStart[key] > from || to >= today || s.facts.some((f) => f.metric === key && f.quality === "partial") ? "Cobertura parcial. " : ""}${s.definitions[key]}`
		})),
		points: dayRange(from, to, 90).map((date) => ({
			date,
			whatsapp: value("operational_whatsapp", date),
			phone: value("operational_phone", date)
		}))
	};
}
//#endregion
//#region node_modules/@onplay/marketing-premium/dist/commercial.js
const COMMERCIAL_TIMEZONE = "America/Campo_Grande";
const COMMERCIAL_METRICS = [
	"quotes_requested",
	"quotes_created",
	"quotes_approved",
	"appointments_completed",
	"orders_completed",
	"qualified_leads"
];
const commercialNames = {
	quotes_requested: "Orçamentos solicitados",
	quotes_created: "Orçamentos registrados",
	quotes_approved: "Orçamentos aprovados",
	appointments_completed: "Atendimentos realizados",
	orders_completed: "Pedidos concluídos",
	qualified_leads: "Leads qualificados"
};
/** Optional additive DTO. Unknown fields, identifiers and payloads never cross this boundary. */
function validateMarketingSnapshot(raw, maxDays = 31) {
	const parsed = validateSnapshot(raw, maxDays);
	const measurement = validateMeasurement(raw.measurement, parsed, maxDays);
	const base = {
		...parsed,
		...measurement ? { measurement } : {}
	};
	const extra = raw.commercial;
	if (extra === void 0) return base;
	if (!extra || typeof extra !== "object" || Array.isArray(extra)) throw new Error("invalid_commercial_snapshot");
	const s = extra;
	if (s.version !== 1 || s.externalTenant !== base.externalTenant || s.from !== base.from || s.to !== base.to || s.timezone !== "America/Campo_Grande" || !Number.isFinite(Date.parse(s.collectedAt))) throw new Error("invalid_commercial_scope");
	if (s.temporalNote !== void 0 && (typeof s.temporalNote !== "string" || s.temporalNote.length > 600 || /[\u0000-\u001f]/.test(s.temporalNote))) throw new Error("invalid_commercial_notice");
	if (!Array.isArray(s.availableMetrics) || new Set(s.availableMetrics).size !== s.availableMetrics.length || s.availableMetrics.some((m) => !COMMERCIAL_METRICS.includes(m)) || !s.coverageStart || !s.definitions || !Array.isArray(s.facts) || s.facts.length > maxDays * COMMERCIAL_METRICS.length) throw new Error("invalid_commercial_metrics");
	for (const key of s.availableMetrics) {
		if (typeof s.definitions[key] !== "string" || !s.definitions[key].trim() || s.definitions[key].length > 1500 || /[\u0000-\u001f]/.test(s.definitions[key]) || !/^\d{4}-\d{2}-\d{2}$/.test(s.coverageStart[key] ?? "")) throw new Error("invalid_commercial_definition");
		dayRange(s.coverageStart[key], s.coverageStart[key], 1);
	}
	const seen = /* @__PURE__ */ new Set();
	for (const f of s.facts) {
		if (!s.availableMetrics.includes(f.metric) || f.channel !== "all" || !Number.isSafeInteger(f.value) || f.value < 0 || !["partial", "complete"].includes(f.quality) || !/^\d{4}-\d{2}-\d{2}$/.test(f.date) || f.date < s.from || f.date > s.to || f.date < s.coverageStart[f.metric]) throw new Error("invalid_commercial_fact");
		const key = `${f.metric}:${f.date}`;
		if (seen.has(key)) throw new Error("duplicate_commercial_fact");
		seen.add(key);
	}
	return {
		...base,
		commercial: {
			version: 1,
			externalTenant: base.externalTenant,
			from: base.from,
			to: base.to,
			timezone: COMMERCIAL_TIMEZONE,
			collectedAt: s.collectedAt,
			...s.temporalNote ? { temporalNote: s.temporalNote } : {},
			availableMetrics: [...s.availableMetrics],
			coverageStart: Object.fromEntries(s.availableMetrics.map((k) => [k, s.coverageStart[k]])),
			definitions: Object.fromEntries(s.availableMetrics.map((k) => [k, s.definitions[k]])),
			facts: s.facts.map((f) => ({
				date: f.date,
				channel: "all",
				metric: f.metric,
				value: f.value,
				quality: f.quality
			}))
		}
	};
}
function mergeCommercialSnapshots(parts, from, to) {
	if (!parts.length || parts.some((p) => !p.commercial)) return void 0;
	const all = parts.map((p) => p.commercial);
	const first = all[0];
	all.forEach((p, i) => {
		if (p.externalTenant !== first.externalTenant || p.timezone !== first.timezone || i && p.from !== addDays(all[i - 1].to, 1)) throw new Error("incompatible_commercial_snapshots");
	});
	const available = first.availableMetrics.filter((m) => all.every((p) => p.availableMetrics.includes(m) && p.definitions[m] === first.definitions[m]));
	return {
		...first,
		from,
		to,
		collectedAt: all.map((p) => p.collectedAt).sort()[0],
		availableMetrics: available,
		coverageStart: Object.fromEntries(available.map((m) => [m, all.map((p) => p.coverageStart[m]).sort().at(-1)])),
		definitions: Object.fromEntries(available.map((m) => [m, first.definitions[m]])),
		facts: all.flatMap((p) => p.facts.filter((f) => available.includes(f.metric)))
	};
}
/** No attribution by timing: operational records have no advertising channel. */
function commercialMetrics(parts, channel, from, to) {
	const snapshot = mergeCommercialSnapshots(parts, from, to);
	const today = snapshot ? [dayInTimezone(/* @__PURE__ */ new Date(), COMMERCIAL_TIMEZONE), dayInTimezone(snapshot.collectedAt, COMMERCIAL_TIMEZONE)].sort()[0] : null;
	return COMMERCIAL_METRICS.map((key) => {
		const available = !!snapshot?.availableMetrics.includes(key) && snapshot.coverageStart[key] <= to;
		const rows = snapshot?.facts.filter((f) => f.metric === key) ?? [];
		const partial = !available || snapshot.coverageStart[key] > from || to >= today || rows.some((f) => f.quality === "partial");
		const value = available && channel === "all" && (rows.length || !partial) ? rows.reduce((sum, f) => sum + f.value, 0) : null;
		return {
			key,
			label: commercialNames[key],
			value,
			unit: "count",
			change: null,
			note: !available ? "Fonte comercial ainda não integrada." : channel !== "all" ? "Origem publicitária não comprovada. Consulte todas as origens." : `${partial ? "Cobertura parcial. " : ""}${snapshot.definitions[key]}`
		};
	});
}
//#endregion
//#region node_modules/@onplay/marketing-premium/dist/model.js
const productNames = {
	onplay_fiscal: "OnPlay / Arte Laser",
	servnexx: "ServNexx",
	zelyvara: "Zelyvara",
	onfood: "OnFood",
	nexxfitpro: "NexxFit Pro",
	onplay_finance: "OnPlay Finance",
	coinops: "CoinOps"
};
const channelNames = {
	all: "Todas as origens",
	google_ads: "Google Ads",
	meta: "Meta / Instagram",
	direct: "Direto",
	organic: "Orgânico",
	unknown: "Desconhecida"
};
const metricNames = {
	visits: "Visualizações do site",
	intents: "Intenções de contato",
	leads: "Solicitações recebidas",
	conversations: "Conversas recebidas",
	appointments: "Agendamentos criados",
	closures: "Fechamentos",
	purchases: "Compras confirmadas"
};
function businessMetrics(data) {
	const names = {
		...metricNames,
		...commercialNames
	};
	return [
		"leads",
		"conversations",
		"appointments",
		"closures",
		"purchases",
		...COMMERCIAL_METRICS
	].map((key) => data.metrics.find((m) => m.key === key) ?? {
		key,
		label: names[key],
		value: null,
		unit: "count",
		change: null,
		note: "Fonte comercial ainda não integrada."
	});
}
function summarizePaid(paid, from, to, channel) {
	const rows = (paid?.reports ?? []).filter((r) => (channel === "all" || channel === r.platform) && r.from >= from && r.to <= to);
	const overlaps = (paid?.reports ?? []).some((r) => (channel === "all" || channel === r.platform) && (r.from < from || r.to > to));
	const groups = /* @__PURE__ */ new Map();
	for (const r of rows) {
		const k = `${r.platform}:${r.accountId}:${r.campaignId}`;
		groups.set(k, [...groups.get(k) ?? [], r]);
	}
	const complete = !!groups.size && !overlaps && [...groups.values()].every((g) => {
		const s = g.slice().sort((a, b) => a.from.localeCompare(b.from));
		return s[0].from === from && s.at(-1).to === to && s.every((r, i) => r.coverage === "complete" && (!i || r.from === addDays(s[i - 1].to, 1)));
	});
	const total = (key) => rows.length && rows.every((r) => r[key] !== null) ? rows.reduce((s, r) => s + r[key], 0) : null;
	const legacy = rows.length || overlaps ? [] : (paid?.legacySpend ?? []).filter((r) => channel === "all" || channel === r.platform);
	const spendCents = rows.length ? total("spendCents") : legacy.length ? legacy.reduce((s, r) => s + r.spendCents, 0) : null, clicks = total("clicks"), conversions = total("conversions");
	return {
		rows,
		legacy,
		complete: complete || legacy.length > 0,
		overlaps,
		spend: spendCents === null ? null : spendCents / 100,
		clicks,
		conversions,
		impressions: total("impressions"),
		qualified: total("qualifiedLeads"),
		cpc: spendCents !== null && clicks ? spendCents / 100 / clicks : null,
		cpa: spendCents !== null && conversions ? spendCents / 100 / conversions : null
	};
}
/** One calculation used by Master and native products. Never counts people from page views. */
function fromSnapshots(base, inputs) {
	if (!inputs.length) return {
		...base,
		quality: "disconnected"
	};
	const parts = inputs.map((p) => validateMarketingSnapshot(p, 90));
	const first = parts[0];
	if (first.from !== base.period.from || parts.at(-1).to !== base.period.to || first.timezone !== base.timezone || first.currency !== base.currency) throw new Error("invalid_snapshot_scope");
	parts.forEach((p, i) => {
		if (p.externalTenant !== first.externalTenant || p.timezone !== first.timezone || p.currency !== first.currency || i > 0 && p.from !== addDays(parts[i - 1].to, 1)) throw new Error("invalid_snapshot_scope");
	});
	const available = first.availableMetrics.filter((m) => parts.every((p) => p.availableMetrics.includes(m) && p.definitions[m] === first.definitions[m]));
	const coverage = Object.fromEntries(available.map((m) => [m, parts.map((p) => p.coverageStart[m]).sort().at(-1)]));
	const facts = parts.flatMap((p) => p.facts.filter((f) => available.includes(f.metric)));
	const today = [dayInTimezone(/* @__PURE__ */ new Date(), first.timezone), ...parts.map((p) => dayInTimezone(p.collectedAt, p.timezone))].sort()[0];
	const partial = (m) => !coverage[m] || coverage[m] > base.period.from || base.period.to >= today || facts.some((f) => f.metric === m && f.quality === "partial");
	const observed = (m, ch = base.channel, date) => {
		if (!available.includes(m) || coverage[m] > base.period.to) return null;
		const all = facts.filter((f) => f.metric === m);
		if (ch !== "all" && (all.some((f) => f.channel === "all") || !all.length)) return null;
		const chosen = all.filter((f) => (ch === "all" || f.channel === ch) && (!date || f.date === date));
		const incomplete = date ? date < coverage[m] || date >= today || facts.some((f) => f.metric === m && f.date === date && f.quality === "partial") : partial(m);
		return chosen.length ? chosen.reduce((s, f) => s + f.value, 0) : incomplete ? null : 0;
	};
	const measurement = measurementValues(parts, base.channel, base.period.from, base.period.to);
	const metrics = [
		...COUNT_METRICS.map((m) => ({
			key: m,
			label: metricNames[m],
			value: observed(m),
			unit: "count",
			change: null,
			note: (partial(m) ? "Cobertura parcial. " : "") + (first.definitions[m] ?? "Fonte indisponível.")
		})),
		...base.metrics.filter((m) => !COUNT_METRICS.some((key) => key === m.key) && !COMMERCIAL_METRICS.some((key) => key === m.key) && !MEASUREMENT_METRICS.some((key) => key === m.key)).map((m) => ({
			...m,
			value: null,
			change: null
		})),
		...commercialMetrics(parts, base.channel, base.period.from, base.period.to),
		...measurement.metrics
	];
	const points = dayRange(base.period.from, base.period.to, 90).map((date) => ({
		date,
		visits: observed("visits", base.channel, date),
		intents: observed("intents", base.channel, date),
		conversations: observed("conversations", base.channel, date)
	}));
	return {
		...base,
		quality: available.some(partial) ? "partial" : "updated",
		updatedAt: parts.map((p) => p.collectedAt).sort()[0],
		metrics,
		points,
		measurementPoints: measurement.points,
		definitions: first.definitions,
		partialMetrics: [...COUNT_METRICS.filter(partial), ...metrics.filter((m) => m.note.startsWith("Cobertura parcial.") && !COUNT_METRICS.some((k) => k === m.key)).map((m) => m.key)],
		channels: CHANNELS.filter((ch) => base.channel === "all" || base.channel === ch).map((ch) => ({
			key: ch,
			visits: observed("visits", ch),
			leads: observed("leads", ch),
			conversations: observed("conversations", ch),
			spend: null,
			share: null
		})).filter((c) => c.visits !== null),
		funnel: metrics.filter((m) => COUNT_METRICS.some((k) => k === m.key)).map((m) => ({
			key: m.key,
			label: m.label,
			value: m.value,
			rate: null,
			note: m.note
		})),
		trend: points.map((p) => ({
			date: p.date,
			visits: p.visits,
			spend: null
		})),
		notice: ["Resultados do próprio sistema. Visualizações não são pessoas únicas. Cliques são intenções, não conversas ou vendas. Fontes operacionais e publicitárias são exibidas separadamente.", ...new Set(parts.map((p) => p.commercial?.temporalNote).filter(Boolean))].join(" ")
	};
}
function comparison(current, previous, key) {
	const a = current.metrics.find((m) => m.key === key), b = previous?.metrics.find((m) => m.key === key);
	if (!a || !b || a.value === null || b.value === null || b.value <= 0 || current.timezone !== previous?.timezone || current.currency !== previous.currency || current.partialMetrics?.includes(key) || previous.partialMetrics?.includes(key) || current.quality !== "updated" || previous.quality !== "updated" || a.note !== b.note) return null;
	return (a.value - b.value) / b.value * 100;
}
function stages(data, product) {
	const available = (key) => data.metrics.find((m) => m.key === key)?.value !== null && data.metrics.some((m) => m.key === key);
	return (product === "onfood" ? [
		"visits",
		"intents",
		"leads",
		"purchases"
	] : product === "nexxfitpro" ? [
		"visits",
		"leads",
		"closures",
		"purchases"
	] : [
		"visits",
		"intents",
		"conversations",
		"appointments",
		"closures",
		"purchases"
	]).filter((k) => k === "visits" || k === "intents" || available(k)).slice(0, 6).map((key) => ({
		key,
		label: metricNames[key],
		value: data.metrics.find((m) => m.key === key)?.value ?? null
	}));
}
//#endregion
export { metricNames as a, summarizePaid as c, fromSnapshots as i, validateMarketingSnapshot as l, channelNames as n, productNames as o, comparison as r, stages as s, businessMetrics as t, measurementNames as u };

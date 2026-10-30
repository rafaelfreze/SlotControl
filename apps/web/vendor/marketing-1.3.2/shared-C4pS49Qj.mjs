//#region node_modules/@onplay/marketing-kit/dist/types.js
const PRODUCTS = [
	"onplay_fiscal",
	"servnexx",
	"zelyvara",
	"onfood",
	"nexxfitpro",
	"onplay_ads"
];
const CHANNELS = [
	"google_ads",
	"meta",
	"direct",
	"organic",
	"unknown"
];
const CHANNEL_LABELS = {
	google_ads: "Google Ads",
	meta: "Meta Ads",
	direct: "Direto",
	organic: "Orgânico",
	unknown: "Não identificado"
};
const COUNT_METRICS = [
	"visits",
	"intents",
	"leads",
	"conversations",
	"appointments",
	"closures",
	"purchases"
];
//#endregion
//#region node_modules/@onplay/marketing-kit/dist/period.js
function validDay(value) {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function validTimezone(value) {
	try {
		new Intl.DateTimeFormat("en", { timeZone: value }).format();
		return true;
	} catch {
		return false;
	}
}
function dayInTimezone(value, timezone) {
	if (!validTimezone(timezone)) throw new Error("invalid_timezone");
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit"
	}).formatToParts(new Date(value));
	const part = (name) => parts.find((p) => p.type === name).value;
	return `${part("year")}-${part("month")}-${part("day")}`;
}
function addDays(day, days) {
	if (!validDay(day) || !Number.isInteger(days)) throw new Error("invalid_day");
	return new Date(Date.parse(day) + days * 864e5).toISOString().slice(0, 10);
}
function dayRange(from, to, max = 90) {
	if (!validDay(from) || !validDay(to) || to < from) throw new Error("invalid_range");
	const size = (Date.parse(to) - Date.parse(from)) / 864e5 + 1;
	if (size > max) throw new Error("range_too_large");
	return Array.from({ length: size }, (_, i) => addDays(from, i));
}
function resolveHubPeriod(search, timezone = "America/Campo_Grande", now = /* @__PURE__ */ new Date()) {
	const today = dayInTimezone(now, timezone);
	let key = [
		"today",
		"7d",
		"30d",
		"custom"
	].includes(search.period ?? "") ? search.period : "30d";
	let from = key === "today" ? today : addDays(today, key === "7d" ? -6 : -29), to = today, warning;
	if (key === "custom") try {
		dayRange(search.from ?? "", search.to ?? "", 90);
		if (search.to > today) throw new Error();
		from = search.from;
		to = search.to;
	} catch {
		key = "30d";
		warning = "Intervalo inválido. Exibindo os últimos 30 dias; limite de 90 dias até hoje.";
	}
	const length = dayRange(from, to).length, previousTo = addDays(from, -1), previousFrom = addDays(from, -length);
	const display = (day) => day.split("-").reverse().join("/");
	return {
		key,
		from,
		to,
		previousFrom,
		previousTo,
		timezone,
		label: `${display(from)} – ${display(to)}`,
		warning
	};
}
/** Midnight in an IANA zone, including DST; no assumption of a fixed UTC offset. */
function startOfLocalDay(day, timezone) {
	if (!validDay(day) || !validTimezone(timezone)) throw new Error("invalid_day");
	const wall = Date.parse(day + "T00:00:00Z");
	let epoch = wall;
	for (let i = 0; i < 4; i++) {
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hourCycle: "h23"
		}).formatToParts(new Date(epoch));
		const v = (t) => Number(parts.find((p) => p.type === t).value);
		const represented = Date.UTC(v("year"), v("month") - 1, v("day"), v("hour"), v("minute"), v("second"));
		const next = epoch + wall - represented;
		if (next === epoch) return new Date(epoch).toISOString();
		epoch = next;
	}
	if (dayInTimezone(new Date(epoch), timezone) !== day) throw new Error("unsupported_day_boundary");
	return new Date(epoch).toISOString();
}
//#endregion
//#region node_modules/@onplay/marketing-kit/dist/metrics.js
const metricLabels = {
	visits: "Visitas ao site",
	intents: "Intenções de contato",
	leads: "Leads recebidos",
	conversations: "Conversas",
	appointments: "Agendamentos",
	closures: "Fechamentos",
	purchases: "Compras confirmadas"
};
function reliableRatio(numerator, denominator, compatible) {
	return compatible && numerator !== null && denominator !== null && Number.isFinite(numerator) && Number.isFinite(denominator) && numerator >= 0 && denominator > 0 ? numerator / denominator : null;
}
function validateSnapshot(input, maxDays = 31) {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_snapshot");
	const s = input;
	if (s.version !== 1 || typeof s.externalTenant !== "string" || s.externalTenant.length < 1 || s.externalTenant.length > 200 || /[\u0000-\u001f]/.test(s.externalTenant) || typeof s.timezone !== "string" || !validTimezone(s.timezone) || typeof s.currency !== "string" || !/^([A-Z]{3})$/.test(s.currency) || typeof s.collectedAt !== "string" || !Number.isFinite(Date.parse(s.collectedAt))) throw new Error("invalid_snapshot_identity");
	const dates = dayRange(s.from, s.to, maxDays);
	if (!Array.isArray(s.availableMetrics) || new Set(s.availableMetrics).size !== s.availableMetrics.length || s.availableMetrics.some((m) => !COUNT_METRICS.includes(m))) throw new Error("invalid_snapshot_metrics");
	if (!s.coverageStart || typeof s.coverageStart !== "object" || Array.isArray(s.coverageStart) || !s.definitions || typeof s.definitions !== "object" || Array.isArray(s.definitions) || Object.entries(s.coverageStart).some(([k, v]) => !COUNT_METRICS.includes(k) || !validDay(v))) throw new Error("invalid_snapshot_coverage");
	if (!Array.isArray(s.facts) || s.facts.length > 1e4) throw new Error("invalid_snapshot_size");
	const keys = /* @__PURE__ */ new Set();
	for (const f of s.facts) {
		if (!f || typeof f !== "object") throw new Error("invalid_snapshot_fact");
		if (!validDay(f.date) || f.date < s.from || f.date > s.to || ![...CHANNELS, "all"].includes(f.channel) || !s.availableMetrics.includes(f.metric) || !Number.isSafeInteger(f.value) || f.value < 0 || ![
			"page_views",
			"sessions",
			"events",
			"entities"
		].includes(f.population) || ![
			"first_party",
			"utm",
			"unattributed"
		].includes(f.attribution) || !["complete", "partial"].includes(f.quality)) throw new Error("invalid_snapshot_fact");
		const key = `${f.date}|${f.channel}|${f.metric}`;
		if (keys.has(key)) throw new Error("duplicate_snapshot_fact");
		keys.add(key);
	}
	for (const metric of s.availableMetrics) {
		if (typeof s.definitions[metric] !== "string" || s.definitions[metric].length > 800 || !s.coverageStart[metric]) throw new Error("missing_metric_definition");
		for (const date of dates) {
			const facts = s.facts.filter((f) => f.date === date && f.metric === metric);
			if (facts.some((f) => f.channel === "all") && facts.some((f) => f.channel !== "all")) throw new Error("overlapping_snapshot_totals");
		}
	}
	return {
		version: 1,
		externalTenant: s.externalTenant,
		from: s.from,
		to: s.to,
		timezone: s.timezone,
		currency: s.currency,
		collectedAt: s.collectedAt,
		availableMetrics: [...s.availableMetrics],
		coverageStart: Object.fromEntries(s.availableMetrics.map((m) => [m, s.coverageStart[m]])),
		definitions: Object.fromEntries(s.availableMetrics.map((m) => [m, s.definitions[m]])),
		facts: s.facts.map((f) => ({
			date: f.date,
			channel: f.channel,
			metric: f.metric,
			value: f.value,
			population: f.population,
			attribution: f.attribution,
			quality: f.quality
		}))
	};
}
function emptyDashboard(period, name = "Central de Marketing", channel = "all", notice = "Nenhuma conta de anúncios conectada ainda.") {
	const m = (key, label, unit, mobile = false) => ({
		key,
		label,
		value: null,
		unit,
		mobile,
		lowerIsBetter: key === "cpl" || key === "cpa",
		note: "Fonte ainda não integrada para este cliente."
	});
	return {
		version: 1,
		clientName: name,
		currency: "BRL",
		timezone: period.timezone,
		period,
		channel,
		quality: "empty",
		updatedAt: null,
		notice,
		metrics: [
			m("investment", "Investimento total", "currency"),
			m("google_ads", "Google Ads", "currency"),
			m("meta", "Meta Ads", "currency"),
			m("visits", "Visitas ao site", "count", true),
			m("intents", "Intenções de contato", "count"),
			m("leads", "Leads recebidos", "count"),
			m("conversations", "Conversas", "count", true),
			m("appointments", "Agendamentos", "count", true),
			m("closures", "Fechamentos", "count"),
			m("cpl", "Custo por lead", "currency", true),
			m("cpa", "Custo por cliente", "currency"),
			m("conversion", "Taxa de conversão", "percent")
		],
		channels: [],
		funnel: [
			"visits",
			"intents",
			"conversations",
			"appointments",
			"closures"
		].map((key) => ({
			key,
			label: metricLabels[key],
			value: null,
			rate: null,
			note: "Etapa ainda não integrada."
		})),
		campaigns: [],
		trend: [],
		integrations: [],
		insight: {
			title: "Conecte as fontes deste cliente",
			detail: "O painel exibirá dados reais depois da vinculação e sincronização."
		}
	};
}
/** One chosen product link per view. Do not sum CRM populations across products. */
function applySourceSnapshot(dashboard, snapshot) {
	snapshot = validateSnapshot(snapshot, 90);
	const { from, to } = dashboard.period, selected = dashboard.channel;
	if (snapshot.timezone !== dashboard.timezone || snapshot.currency !== dashboard.currency) return {
		...dashboard,
		quality: "partial",
		notice: "Fuso ou moeda da fonte diverge do cliente. Os totais não foram combinados."
	};
	const covers = snapshot.from <= from && snapshot.to >= to;
	const total = (metric, channel) => {
		if (!covers || !snapshot.availableMetrics.includes(metric) || !snapshot.coverageStart[metric] || snapshot.coverageStart[metric] > from) return null;
		const rows = snapshot.facts.filter((f) => f.metric === metric && f.date >= from && f.date <= to);
		if (rows.some((f) => f.quality !== "complete")) return null;
		if (channel !== "all" && (rows.some((f) => f.channel === "all") || !rows.some((f) => f.channel !== "all"))) return null;
		return rows.filter((f) => channel === "all" || f.channel === channel).reduce((sum, f) => sum + f.value, 0);
	};
	const metrics = dashboard.metrics.map((m) => COUNT_METRICS.includes(m.key) ? {
		...m,
		value: total(m.key, selected),
		note: snapshot.definitions[m.key] ?? "Não integrado"
	} : m);
	const visits = total("visits", selected);
	const channels = CHANNELS.filter((c) => selected === "all" || c === selected).map((key) => ({
		key,
		visits: total("visits", key),
		leads: total("leads", key),
		conversations: total("conversations", key),
		spend: dashboard.channels.find((c) => c.key === key)?.spend ?? null,
		share: reliableRatio(total("visits", key), visits, true)
	})).filter((c) => c.visits !== null || c.leads !== null || c.spend !== null);
	const leader = [...channels].filter((c) => (c.visits ?? 0) > 0).sort((a, b) => (b.visits ?? 0) - (a.visits ?? 0))[0];
	const insight = leader ? {
		title: `${CHANNEL_LABELS[leader.key]} lidera as visitas medidas`,
		detail: `${leader.visits?.toLocaleString("pt-BR")} visitas no período. Avalie conversas e resultados comerciais antes de mudar a verba.`
	} : dashboard.insight;
	const partial = !covers || snapshot.availableMetrics.some((m) => snapshot.coverageStart[m] > from) || snapshot.facts.some((f) => f.quality === "partial");
	const sourceAvailable = snapshot.availableMetrics.length > 0;
	return {
		...dashboard,
		metrics,
		channels,
		insight,
		quality: partial ? "partial" : sourceAvailable && dashboard.quality === "empty" ? "updated" : dashboard.quality,
		updatedAt: snapshot.collectedAt,
		notice: partial ? "A cobertura da fonte é parcial neste intervalo. Valores sem cobertura completa permanecem indisponíveis." : sourceAvailable ? null : dashboard.notice,
		funnel: dashboard.funnel.map((f) => ({
			...f,
			value: total(f.key, selected),
			rate: null,
			note: snapshot.definitions[f.key] ?? "Etapa não integrada."
		})),
		trend: dayRange(from, to).map((date) => {
			const rows = snapshot.facts.filter((f) => f.metric === "visits" && f.date === date);
			return {
				date,
				visits: date >= snapshot.from && date <= snapshot.to && snapshot.availableMetrics.includes("visits") && snapshot.coverageStart.visits <= date && !rows.some((f) => f.quality === "partial" || selected !== "all" && f.channel === "all") ? rows.filter((f) => selected === "all" || f.channel === selected).reduce((sum, f) => sum + f.value, 0) : null,
				spend: dashboard.trend.find((p) => p.date === date)?.spend ?? null
			};
		})
	};
}
//#endregion
export { validateSnapshot as a, dayRange as c, validDay as d, validTimezone as f, PRODUCTS as g, COUNT_METRICS as h, reliableRatio as i, resolveHubPeriod as l, CHANNEL_LABELS as m, emptyDashboard as n, addDays as o, CHANNELS as p, metricLabels as r, dayInTimezone as s, applySourceSnapshot as t, startOfLocalDay as u };

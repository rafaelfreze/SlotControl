import { n as emptyDashboard, o as addDays } from "./shared-C4pS49Qj.mjs";
import { HubRequestError, readBoundedBody } from "./hub-server.mjs";
import { i as fromSnapshots, l as validateMarketingSnapshot } from "./shared-BDbViiFo.mjs";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
//#region node_modules/@onplay/marketing-premium/dist/operational-server.js
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
	"other"
];
function parseOperationalInput(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const v = raw;
	if (Object.keys(v).some((k) => ![
		"version",
		"slug",
		"eventId",
		"event",
		"placement",
		"page",
		"channel"
	].includes(k)) || v.version !== 1 || typeof v.eventId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v.eventId) || v.slug !== void 0 && (typeof v.slug !== "string" || v.slug.length > 160 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v.slug)) || ![
		"page_view",
		"whatsapp_click",
		"phone_click"
	].includes(String(v.event)) || !positions.includes(String(v.placement)) || v.event === "page_view" && v.placement !== "page" || ![
		"home",
		"services",
		"contact",
		"other"
	].includes(String(v.page)) || ![
		"google_ads",
		"meta",
		"organic",
		"direct",
		"unknown"
	].includes(String(v.channel))) return null;
	return v;
}
/** HTTP guard resolves tenant on the server from the published site and verified host. */
async function serveOperationalRequest(request, resolve, record, routePath = "/api/marketing/operational") {
	const headers = { "Cache-Control": "private, no-store" };
	const result = (status) => new Response(null, {
		status,
		headers
	});
	try {
		const url = new URL(request.url);
		if (request.method !== "POST" || url.pathname !== routePath || url.search || !request.headers.get("content-type")?.startsWith("application/json")) return result(400);
		let origin;
		try {
			origin = new URL(request.headers.get("origin") ?? "");
		} catch {
			return result(403);
		}
		const host = (request.headers.get("host") ?? url.host).toLowerCase();
		if (origin.protocol !== "https:" || origin.host !== host || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) return result(403);
		if (/(bot|crawler|spider|headless)/i.test(request.headers.get("user-agent") ?? "")) return result(204);
		let raw;
		try {
			raw = JSON.parse(await readBoundedBody(request, 1024));
		} catch {
			return result(400);
		}
		const input = parseOperationalInput(raw);
		if (!input) return result(400);
		const tenant = await resolve(origin.hostname, input.slug);
		if (!tenant) return result(404);
		return result(await record(tenant, input) ? 204 : 429);
	} catch {
		return result(503);
	}
}
//#endregion
//#region node_modules/@onplay/marketing-premium/dist/website-server.js
const WEBSITE_PRODUCTS = {
	servnexx: {
		label: "ServNexx · site institucional",
		schema: "servnexx",
		hosts: ["www.servnexx.com.br", "servnexx.com.br"]
	},
	zelyvara: {
		label: "Zelyvara · site institucional",
		schema: "zelyvara",
		hosts: ["www.zelyvara.com.br", "zelyvara.com.br"]
	},
	onfood: {
		label: "OnFood · site institucional",
		schema: "onfood",
		hosts: ["onfooddigital.com.br", "www.onfooddigital.com.br"]
	},
	nexxfitpro: {
		label: "NexxFit Pro · site institucional",
		schema: "nexxfitpro",
		hosts: ["nexxfitpro.com.br", "www.nexxfitpro.com.br"]
	},
	onplay_finance: {
		label: "OnPlay Finance · site institucional",
		schema: "onplay_finance",
		hosts: ["on-play-finance.vercel.app"]
	},
	coinops: {
		label: "CoinOps · site institucional",
		schema: "coinops",
		hosts: ["cripto-flax.vercel.app"]
	}
};
function assertWebsiteBackend(product, url, schema) {
	if (new URL(url ?? "").hostname !== "otdfpmsegjxpqrzisfmi.supabase.co" || schema !== WEBSITE_PRODUCTS[product].schema) throw Error("website_identity_mismatch");
}
function canonical(product, path, timestamp, nonce, body) {
	return [
		"onplay-website-aggregate-v1",
		product,
		"POST",
		path,
		timestamp,
		nonce,
		createHash("sha256").update(body).digest("hex")
	].join("\n");
}
/** Dedicated aggregate scope; never signs advertising or tenant requests. */
function signWebsiteRead(product, secret, path, body) {
	if (secret.length < 32 || !Object.hasOwn(WEBSITE_PRODUCTS, product) || path !== "/api/marketing/platform-source") throw Error("website_read_unconfigured");
	const timestamp = String(Math.floor(Date.now() / 1e3)), nonce = randomUUID();
	return {
		"content-type": "application/json",
		"x-onplay-website-product": product,
		"x-onplay-timestamp": timestamp,
		"x-onplay-nonce": nonce,
		"x-onplay-signature": createHmac("sha256", secret).update(canonical(product, path, timestamp, nonce, body)).digest("hex")
	};
}
async function serveWebsiteCounter(request, db, product) {
	return serveOperationalRequest(request, async (host, slug) => !slug && WEBSITE_PRODUCTS[product].hosts.includes(host) ? "platform" : null, async (_scope, input) => {
		const r = await db.rpc("record_website_count_v1", {
			p_event_id: input.eventId,
			p_event: input.event,
			p_page: input.page,
			p_placement: input.placement,
			p_channel: input.channel
		});
		if (r.error) throw Error("website_unavailable");
		return r.data === true;
	}, "/api/marketing/platform");
}
async function serveWebsiteSource(request, db, product, secret) {
	const headers = { "Cache-Control": "private, no-store" };
	try {
		const url = new URL(request.url);
		if (request.method !== "POST" || url.pathname !== "/api/marketing/platform-source" || url.search || secret.length < 32) throw new HubRequestError(403, "source_denied");
		const body = await readBoundedBody(request, 1024), time = request.headers.get("x-onplay-timestamp") ?? "", nonce = request.headers.get("x-onplay-nonce") ?? "", signature = request.headers.get("x-onplay-signature") ?? "";
		if (request.headers.get("x-onplay-website-product") !== product || !/^\d{10}$/.test(time) || Math.abs(Date.now() / 1e3 - Number(time)) > 90 || !/^[a-f0-9-]{36}$/i.test(nonce) || !/^[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(createHmac("sha256", secret).update(canonical(product, url.pathname, time, nonce, body)).digest(), Buffer.from(signature, "hex"))) throw new HubRequestError(401, "source_denied");
		const input = JSON.parse(body);
		if (!input || Object.keys(input).some((k) => ![
			"operation",
			"externalTenant",
			"from",
			"to"
		].includes(k)) || input.externalTenant !== "platform" || !["discover", "export"].includes(String(input.operation))) throw new HubRequestError(400, "invalid_scope");
		const claim = await db.rpc("claim_website_read_nonce_v1", { p_nonce: nonce });
		if (claim.error || claim.data !== true) throw new HubRequestError(409, "source_replay");
		if (input.operation === "discover") return Response.json({
			version: 1,
			product,
			tenants: [{
				externalTenant: "platform",
				name: WEBSITE_PRODUCTS[product].label,
				status: "active"
			}],
			nextCursor: null
		}, { headers });
		if (typeof input.from !== "string" || typeof input.to !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.from) || !/^\d{4}-\d{2}-\d{2}$/.test(input.to)) throw new HubRequestError(400, "invalid_range");
		const data = await readWebsiteSnapshot(db, input.from, input.to);
		return Response.json(data, { headers });
	} catch (e) {
		return Response.json({ error: e instanceof HubRequestError ? e.code : "source_unavailable" }, {
			status: e instanceof HubRequestError ? e.status : 503,
			headers
		});
	}
}
async function readWebsiteSnapshot(db, from, to) {
	const r = await db.rpc("get_website_snapshot_v1", {
		p_from: from,
		p_to: to
	});
	if (r.error) throw Error("website_unavailable");
	const s = validateMarketingSnapshot(r.data);
	if (s.externalTenant !== "platform" || s.from !== from || s.to !== to || s.timezone !== "America/Campo_Grande") throw Error("invalid_website_scope");
	return s;
}
/** Native guard must run before calling. Same DTO and calculation as the OnPlay Master. */
async function readWebsiteDashboard(db, product, period, channel) {
	const base = emptyDashboard(period, WEBSITE_PRODUCTS[product].label, channel);
	try {
		const parts = [];
		for (let from = period.from; from <= period.to; from = addDays(from, 31)) {
			const to = addDays(from, 30) < period.to ? addDays(from, 30) : period.to;
			parts.push(await readWebsiteSnapshot(db, from, to));
		}
		return fromSnapshots(base, parts);
	} catch {
		return {
			...base,
			quality: "disconnected",
			notice: "Fonte institucional indisponível. Nenhum acesso ou clique foi estimado."
		};
	}
}
//#endregion
export { WEBSITE_PRODUCTS, assertWebsiteBackend, readWebsiteDashboard, readWebsiteSnapshot, serveWebsiteCounter, serveWebsiteSource, signWebsiteRead };

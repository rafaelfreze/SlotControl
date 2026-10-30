import { c as dayRange, g as PRODUCTS, n as emptyDashboard, p as CHANNELS } from "./shared-C4pS49Qj.mjs";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
//#region node_modules/@onplay/marketing-kit/dist/server.js
var HubRequestError = class extends Error {
	status;
	code;
	constructor(status, code) {
		super(code);
		this.status = status;
		this.code = code;
	}
};
const sha = (body) => createHash("sha256").update(body).digest("hex");
function canonical(product, method, path, timestamp, nonce, body) {
	return [
		"onplay-marketing-v1",
		product,
		method.toUpperCase(),
		path,
		timestamp,
		nonce,
		sha(body)
	].join("\n");
}
function signHubRequest(input) {
	if (input.secret.length < 32 || !PRODUCTS.includes(input.product)) throw new HubRequestError(503, "integration_unconfigured");
	const timestamp = String(Math.floor((input.now ?? Date.now()) / 1e3)), nonce = input.nonce ?? randomUUID();
	const signature = createHmac("sha256", input.secret).update(canonical(input.product, input.method, input.path, timestamp, nonce, input.body)).digest("hex");
	return {
		"content-type": "application/json",
		"x-onplay-product": input.product,
		"x-onplay-timestamp": timestamp,
		"x-onplay-nonce": nonce,
		"x-onplay-signature": signature
	};
}
function verifyHubSignature(request, body, secret, expectedProduct, now = Date.now()) {
	if (secret.length < 32) throw new HubRequestError(503, "integration_unconfigured");
	const product = request.headers.get("x-onplay-product"), timestamp = request.headers.get("x-onplay-timestamp") ?? "", nonce = request.headers.get("x-onplay-nonce") ?? "", signature = request.headers.get("x-onplay-signature") ?? "";
	const url = new URL(request.url);
	if (product !== expectedProduct || !/^\d{10,11}$/.test(timestamp) || Math.abs(now / 1e3 - Number(timestamp)) > 90 || !/^[a-zA-Z0-9-]{16,64}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature) || url.search) throw new HubRequestError(401, "invalid_signature");
	const expected = createHmac("sha256", secret).update(canonical(product, request.method, url.pathname, timestamp, nonce, body)).digest();
	if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) throw new HubRequestError(401, "invalid_signature");
	return {
		product: expectedProduct,
		nonce,
		timestamp: Number(timestamp)
	};
}
async function readBoundedBody(request, maxBytes = 8192) {
	if (Number(request.headers.get("content-length") ?? 0) > maxBytes) throw new HubRequestError(413, "payload_too_large");
	const reader = request.body?.getReader();
	if (!reader) return "";
	const chunks = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				await reader.cancel();
				throw new HubRequestError(413, "payload_too_large");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks).toString("utf8");
}
function parseSourceRequest(body, maxDays = 31) {
	let input;
	try {
		input = JSON.parse(body);
	} catch {
		throw new HubRequestError(400, "invalid_json");
	}
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new HubRequestError(400, "invalid_request");
	const row = input;
	if (typeof row.externalTenant !== "string" || row.externalTenant.length < 1 || row.externalTenant.length > 200 || /[\u0000-\u001f]/.test(row.externalTenant) || typeof row.from !== "string" || typeof row.to !== "string") throw new HubRequestError(400, "invalid_request");
	try {
		dayRange(row.from, row.to, maxDays);
	} catch {
		throw new HubRequestError(400, "invalid_range");
	}
	return {
		externalTenant: row.externalTenant,
		from: row.from,
		to: row.to
	};
}
/** Caller must still resolve active tenant and source data inside its own product. */
async function readExportRequest(request, product, secret = process.env.MARKETING_HUB_SECRET ?? "") {
	if (request.method !== "POST" || new URL(request.url).pathname !== "/api/marketing-hub/export") throw new HubRequestError(404, "not_found");
	const body = await readBoundedBody(request);
	verifyHubSignature(request, body, secret, product);
	return parseSourceRequest(body);
}
function hubErrorResponse(error) {
	const status = error instanceof HubRequestError ? error.status : 503;
	return Response.json({ error: error instanceof HubRequestError ? error.code : "source_unavailable" }, {
		status,
		headers: { "Cache-Control": "private, no-store" }
	});
}
async function fetchHubSummary(input) {
	const channel = input.channel ?? "all", fallback = emptyDashboard(input.period, input.clientName ?? "Central de Marketing", channel);
	const secret = input.secret ?? process.env.MARKETING_HUB_SECRET ?? "", origin = input.hubUrl ?? process.env.MARKETING_HUB_URL ?? "";
	if (!origin || secret.length < 32) return {
		...fallback,
		quality: "disconnected",
		notice: "A Central está disponível. A vinculação ao Marketing Data Hub ainda não foi configurada."
	};
	try {
		const base = new URL(origin);
		if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/" || base.search || base.hash) throw new Error("invalid_origin");
		const path = "/api/marketing-hub/v1/summary", body = JSON.stringify({
			externalTenant: input.externalTenant,
			from: input.period.from,
			to: input.period.to,
			channel
		});
		const result = await (input.fetcher ?? fetch)(new URL(path, base), {
			method: "POST",
			headers: signHubRequest({
				secret,
				product: input.product,
				method: "POST",
				path,
				body
			}),
			body,
			cache: "no-store",
			redirect: "error",
			signal: AbortSignal.timeout(1e4)
		});
		if (result.status === 404) return fallback;
		if (!result.ok) throw new Error("hub_unavailable");
		const text = await readBoundedResponse(result, 1e6);
		const data = JSON.parse(text);
		if (data.version !== 1 || !Array.isArray(data.metrics) || !Array.isArray(data.channels) || !Array.isArray(data.funnel) || !Array.isArray(data.campaigns) || data.period.from !== input.period.from || data.period.to !== input.period.to || data.channel !== channel) throw new Error("invalid_hub_response");
		return {
			...data,
			period: {
				...input.period,
				timezone: data.timezone
			}
		};
	} catch {
		return {
			...fallback,
			quality: "disconnected",
			notice: "A sincronização está temporariamente indisponível. Nenhum valor foi estimado."
		};
	}
}
async function readBoundedResponse(response, maxBytes) {
	if (Number(response.headers.get("content-length") ?? 0) > maxBytes) throw new HubRequestError(502, "response_too_large");
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks = [];
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) {
				await reader.cancel();
				throw new HubRequestError(502, "response_too_large");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks).toString("utf8");
}
function parseChannel(value) {
	return CHANNELS.includes(value) ? value : "all";
}
//#endregion
export { HubRequestError, fetchHubSummary, hubErrorResponse, parseChannel, parseSourceRequest, readBoundedBody, readBoundedResponse, readExportRequest, signHubRequest, verifyHubSignature };

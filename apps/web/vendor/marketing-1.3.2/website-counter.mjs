"use client";
"use client";
import { useEffect, useRef } from "react";
//#region node_modules/@onplay/marketing-premium/dist/operational-browser.js
/** One ephemeral transport receipt, reused on a single bounded retry. Never a visitor ID. */
function sendOperational(endpoint, payload) {
	const options = {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
		credentials: "omit",
		referrerPolicy: "no-referrer",
		keepalive: true
	};
	const send = async () => {
		try {
			return await fetch(endpoint, options);
		} catch {
			return null;
		}
	};
	send().then((response) => {
		if (response === null || response.status >= 500) setTimeout(() => {
			send();
		}, 700);
	});
}
function operationalChannel(search, referrer) {
	const p = new URLSearchParams(search), source = (p.get("utm_source") ?? "").toLowerCase(), medium = (p.get("utm_medium") ?? "").toLowerCase();
	let host = "";
	try {
		host = new URL(referrer).hostname;
	} catch {}
	if (/^(meta|facebook|instagram|fb|ig)$/.test(source)) return /^(paid|cpc|ppc|paid_social)$/.test(medium) ? "meta" : "unknown";
	if (/^(google|google_ads|adwords)$/.test(source) && /^(cpc|ppc|paid|paid_search)$/.test(medium)) return "google_ads";
	if ([
		"gclid",
		"gbraid",
		"wbraid"
	].some((key) => p.has(key))) return "unknown";
	if (medium === "organic" || /(^|\.)google\.[a-z.]+$/.test(host)) return "organic";
	return source || host ? "unknown" : "direct";
}
const placements = /* @__PURE__ */ new Set([
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
	"catalog"
]);
/** Attach only on public templates. No storage, tags, identifiers, URL query or message body. */
function observeOperationalClicks({ endpoint, slug, root = "body", sendView = true, onView }) {
	const page = location.pathname === "/" || Boolean(slug && [
		`/${slug}`,
		`/p/${slug}`,
		`/site/${slug}`
	].includes(location.pathname.replace(/\/$/, ""))) ? "home" : /servic|service/.test(location.pathname) ? "services" : /contato|contact/.test(location.pathname) ? "contact" : "other";
	const channel = operationalChannel(location.search, document.referrer);
	const send = (event, placement) => sendOperational(endpoint, {
		version: 1,
		...slug ? { slug } : {},
		eventId: crypto.randomUUID(),
		event,
		placement,
		page,
		channel
	});
	let viewSent = !sendView;
	const view = () => {
		if (!viewSent && document.visibilityState === "visible") {
			viewSent = true;
			send("page_view", "page");
			onView?.();
		}
	};
	view();
	document.addEventListener("visibilitychange", view);
	let previous = null;
	const click = (event) => {
		if (event.type === "auxclick" && event.button !== 1) return;
		if (!event.isTrusted || !(event.target instanceof Element)) return;
		const anchor = event.target.closest(`${root} a[href]`);
		if (!anchor) return;
		const href = anchor.getAttribute("href") ?? "";
		let action = /^tel:/i.test(href) ? "phone_click" : null;
		if (!action) try {
			const url = new URL(href, location.href);
			if (url.protocol === "https:" && [
				"wa.me",
				"api.whatsapp.com",
				"web.whatsapp.com"
			].includes(url.hostname)) action = "whatsapp_click";
		} catch {}
		if (!action) return;
		const now = performance.now();
		if (previous?.target === anchor && now - previous.at < 1200) return;
		previous = {
			target: anchor,
			at: now
		};
		const section = anchor.closest("[data-marketing-section],section,header,footer");
		const position = anchor.dataset.marketingCta || anchor.dataset.marketingSection || section?.getAttribute("data-marketing-section") || section?.id || section?.tagName.toLowerCase() || "other";
		send(action, placements.has(position) ? position : "other");
	};
	document.addEventListener("click", click, true);
	document.addEventListener("auxclick", click, true);
	return () => {
		document.removeEventListener("click", click, true);
		document.removeEventListener("auxclick", click, true);
		document.removeEventListener("visibilitychange", view);
	};
}
//#endregion
//#region node_modules/@onplay/marketing-premium/dist/website-counter.js
/** Institutional public templates only. No optional tag or visitor storage. */
function WebsiteCounter({ preview = false, navigationKey = "" }) {
	const page = useRef(null);
	useEffect(() => {
		if (preview || navigator.webdriver || location.protocol !== "https:" || new URLSearchParams(location.search).has("marketing_debug")) return;
		if (/^\/(api|auth|login|cadastro|master|painel|dashboard|app|automacao|meu-coinops|alterar-senha|recuperar-senha)(\/|$)/.test(location.pathname)) return;
		const sendView = page.current !== location.pathname;
		const pathname = location.pathname;
		return observeOperationalClicks({
			endpoint: "/api/marketing/platform",
			sendView,
			onView: () => {
				page.current = pathname;
			}
		});
	}, [preview, navigationKey]);
	return null;
}
//#endregion
export { WebsiteCounter };

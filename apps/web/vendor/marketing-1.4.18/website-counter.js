"use client";
import { useEffect, useRef } from "react";
import { observeOperationalClicks } from "./operational-browser.js";
import { isInternalTraffic } from "./internal-traffic.js";
/** Institutional public templates only. No optional tag or visitor storage. */
export function WebsiteCounter({ preview = false, navigationKey = "", version = 1, }) {
    const page = useRef(null);
    useEffect(() => {
        if (preview ||
            isInternalTraffic() ||
            navigator.webdriver ||
            location.protocol !== "https:" ||
            new URLSearchParams(location.search).has("marketing_debug"))
            return;
        if (/^\/(api|auth|login|cadastro|master|painel|dashboard|app|automacao|meu-coinops|alterar-senha|recuperar-senha)(\/|$)/.test(location.pathname))
            return;
        const sendView = page.current !== location.pathname;
        const pathname = location.pathname;
        return observeOperationalClicks({
            endpoint: "/api/marketing/platform",
            version,
            sendView,
            onView: () => {
                page.current = pathname;
            },
        });
    }, [preview, navigationKey, version]);
    return null;
}

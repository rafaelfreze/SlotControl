/** Local, anonymous event receipts. No identity, attribution or payload is kept
 * here or sent to the server; the clock is only a 30-minute inactivity limit. */
export const ACTIVITY_INACTIVITY_MS = 30 * 60000;
const CLOCK_WRITE_MS = 1000;
const receipts = new WeakMap();
const fields = ["version", "activeAt", "qualified", "whatsapp", "phone", "form"];
export function activityDedupeKey(endpoint, slug = "", sessionKey = "") {
    return "onplay:activity:dedupe:v1:" + encodeURIComponent(JSON.stringify([endpoint, slug, sessionKey]));
}
function valid(value, now) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const receipt = value;
    return Object.keys(receipt).length === fields.length && Object.keys(receipt).every(key => fields.includes(key))
        && receipt.version === 1 && Number.isFinite(receipt.activeAt) && receipt.activeAt > 0
        && receipt.activeAt <= now && now - receipt.activeAt < ACTIVITY_INACTIVITY_MS
        && [receipt.qualified, receipt.whatsapp, receipt.phone, receipt.form].every(value => typeof value === "boolean");
}
function memory() {
    let store = receipts.get(window);
    if (!store) {
        store = new Map();
        receipts.set(window, store);
    }
    return store;
}
/** Reads and OR-merges receipts before every claim. Reading never renews time. */
export function readActivityDedupe(key) {
    const now = Date.now(), store = memory(), cached = store.get(key);
    const local = cached && valid(cached.receipt, now) ? cached.receipt : undefined;
    let stored;
    try {
        const raw = window.sessionStorage.getItem(key);
        if (raw !== null) {
            const parsed = JSON.parse(raw);
            if (valid(parsed, now))
                stored = parsed;
            else
                window.sessionStorage.removeItem(key);
        }
    }
    catch { /* A missing/corrupt/blocked store cannot block contact. */ }
    if (!local && !stored) {
        store.delete(key);
        return undefined;
    }
    const receipt = local && stored ? {
        version: 1, activeAt: Math.max(local.activeAt, stored.activeAt),
        qualified: local.qualified || stored.qualified, whatsapp: local.whatsapp || stored.whatsapp,
        phone: local.phone || stored.phone, form: local.form || stored.form,
    } : { ...(local ?? stored) };
    store.set(key, { receipt, writtenAt: cached?.writtenAt ?? stored?.activeAt ?? -Infinity });
    return receipt;
}
function save(key, receipt, force) {
    const store = memory(), previous = store.get(key), now = Date.now();
    const due = force || !previous || now - previous.writtenAt >= CLOCK_WRITE_MS;
    store.set(key, { receipt, writtenAt: due ? now : previous.writtenAt });
    if (due) {
        try {
            window.sessionStorage.setItem(key, JSON.stringify(receipt));
        }
        catch { /* In-document memory fallback. */ }
    }
    return receipt;
}
/** Only the first observed page/gesture starts a missing receipt. Existing
 * navigation and refresh retain the last real activity, without extending it. */
export function ensureActivityDedupe(key, initialAt = Date.now()) {
    const prior = readActivityDedupe(key);
    if (prior)
        return prior;
    const now = Date.now();
    return save(key, {
        version: 1, activeAt: Number.isFinite(initialAt) && initialAt > 0 && initialAt <= now && now - initialAt < ACTIVITY_INACTIVITY_MS ? initialAt : now,
        qualified: false, whatsapp: false, phone: false, form: false,
    }, true);
}
/** Called only after the existing engagement observer validates a real gesture. */
export function touchActivityDedupe(key) {
    const receipt = ensureActivityDedupe(key);
    return save(key, { ...receipt, activeAt: Date.now() }, false);
}
/** Synchronous claim precedes network work, including the bounded retry. */
export function claimActivityDedupe(key, flag) {
    const receipt = ensureActivityDedupe(key);
    if (receipt[flag])
        return false;
    save(key, { ...receipt, [flag]: true }, true);
    return true;
}
/** Flush the last gesture clock, never the time of pagehide/unmount itself. */
export function flushActivityDedupe(key) {
    const receipt = readActivityDedupe(key);
    if (receipt)
        save(key, receipt, true);
}

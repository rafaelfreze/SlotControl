export function createActiveEngagement(now = 0) {
    let sampledAt = now, wasActive = false, activeMs = 0;
    let interaction = null, scrollPercent;
    let delivered = false;
    const proof = () => {
        if (delivered || !interaction || interaction !== "contact" && activeMs < 5000)
            return null;
        delivered = true;
        return { activeMs: Math.floor(activeMs), interaction, ...(scrollPercent === undefined ? {} : { scrollPercent }) };
    };
    return {
        sample(at, active) {
            const elapsed = at - sampledAt;
            // A suspended/throttled process cannot turn an arbitrary wall-clock gap
            // into active time. Foreground samples are deliberately conservative.
            if (active && wasActive && elapsed >= 0 && elapsed <= 1500)
                activeMs += elapsed;
            sampledAt = at;
            wasActive = active;
            return active ? proof() : null;
        },
        interact(kind, trusted, active, percent) {
            if (!trusted || !active || kind === "scroll" && (!Number.isFinite(percent) || percent < 25 || percent > 100))
                return null;
            interaction = kind;
            if (kind === "scroll")
                scrollPercent = percent;
            return proof();
        },
        get activeMs() { return Math.floor(activeMs); },
    };
}
/** Scroll events can be trusted even after scrollTo(). Require a recent real
 * wheel/touch/scroll-key gesture as well; click handlers call interact directly. */
export function observeActiveEngagement(onQualified, allowed, onActivity) {
    const clock = () => performance.now();
    let state = createActiveEngagement(clock());
    let gestureAt = -Infinity;
    const activity = () => { if (onActivity?.())
        state = createActiveEngagement(clock()); };
    const active = () => allowed() && document.visibilityState === "visible" && document.hasFocus();
    const emit = (proof) => { if (proof && allowed())
        onQualified(proof); };
    const sample = () => { emit(state.sample(clock(), active())); };
    const gesture = (event) => {
        if (!event.isTrusted || !active())
            return;
        if (event.type === "keydown") {
            const key = event;
            if (key.altKey || key.ctrlKey || key.metaKey || !["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "].includes(key.key))
                return;
            if (key.target instanceof Element && key.target.closest('input,textarea,select,[contenteditable="true"]'))
                return;
        }
        activity();
        gestureAt = clock();
    };
    const scroll = (event) => {
        if (!event.isTrusted || clock() - gestureAt > 1500)
            return;
        const scrollable = document.documentElement.scrollHeight - window.innerHeight;
        if (scrollable <= 0)
            return;
        sample();
        emit(state.interact("scroll", true, active(), Math.max(0, Math.min(100, window.scrollY / scrollable * 100))));
    };
    sample();
    const timer = window.setInterval(sample, 1000);
    const options = { passive: true, capture: false };
    window.addEventListener("wheel", gesture, options);
    window.addEventListener("touchmove", gesture, options);
    document.addEventListener("keydown", gesture);
    window.addEventListener("scroll", scroll, options);
    window.addEventListener("focus", sample);
    window.addEventListener("blur", sample);
    document.addEventListener("visibilitychange", sample);
    return {
        interact(kind, event) { if (event.isTrusted && active())
            activity(); sample(); emit(state.interact(kind, event.isTrusted, active())); },
        get activeMs() { return state.activeMs; },
        stop() {
            window.clearInterval(timer);
            window.removeEventListener("wheel", gesture, options);
            window.removeEventListener("touchmove", gesture, options);
            document.removeEventListener("keydown", gesture);
            window.removeEventListener("scroll", scroll, options);
            window.removeEventListener("focus", sample);
            window.removeEventListener("blur", sample);
            document.removeEventListener("visibilitychange", sample);
        },
    };
}

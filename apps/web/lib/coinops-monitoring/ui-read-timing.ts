/** Low-volume, allowlisted timing metadata only: never SQL, account IDs or payloads. */
export function uiReadTimer(module: string, now: () => number = () => performance.now()) {
  const started = now();
  let previous = started;
  const stages: Record<string, number> = {};
  return {
    stage(name: string) { const current = now(); stages[name] = Math.round(current - previous); previous = current; },
    finish() {
      const duration_ms = Math.round(now() - started);
      if (duration_ms >= 1_500 || Math.random() < 0.02)
        console.info("COINOPS_UI_READ_TIMING", { module, duration_ms, stages });
      return { duration_ms, stages };
    },
  };
}

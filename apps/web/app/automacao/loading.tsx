import "./premium-automation.css";

/** Stream the operational shell while authenticated reads complete. This
 * fallback contains no account data and never reports a guessed LIVE state. */
export default function AutomationLoading() {
  return <main className="px-app px-loading" aria-busy="true">
    <header className="px-topbar">
      <div className="px-brand"><strong>CoinOps</strong><small>Automação</small></div>
      <span role="status">Carregando dados operacionais…</span>
    </header>
    <div className="px-loading-bar" aria-hidden="true" />
    <div className="px-loading-hero px-panel" aria-hidden="true">
      <div className="px-loading-line" /><div className="px-loading-line" />
    </div>
    <div className="px-loading-grid" aria-hidden="true">
      <div className="px-panel" /><div className="px-panel" /><div className="px-panel" />
    </div>
  </main>;
}

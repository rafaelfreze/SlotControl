import type { AssetHealthAsset, AssetHealthCadence, AssetHealthCategory, AssetMetric, AssetMetricStatus } from "./types";

type FetchLike = typeof fetch;
type Source = AssetMetric["source"];
type MetricInput = Omit<AssetMetric, "asset" | "source" | "fetchedAt" | "metricAt" | "ttlSeconds" | "confidence" | "cadence"> & {
  metricAt?: string | null; confidence?: AssetMetric["confidence"] };

const SOURCES = {
  mempool: { id: "mempool-space", name: "mempool.space", url: "https://mempool.space/docs/api/rest" },
  blockstream: { id: "blockstream", name: "Blockstream Explorer", url: "https://github.com/Blockstream/esplora/blob/master/API.md" },
  binance: { id: "binance-spot", name: "Binance Spot Market Data", url: "https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/market" },
  solanaRpc: { id: "solana-mainnet-rpc", name: "Solana Mainnet RPC", url: "https://solana.com/docs/rpc", independenceGroup: "solana-official" },
  solanaStatus: { id: "solana-status", name: "Solana Status", url: "https://status.solana.com", independenceGroup: "solana-official" },
  githubBitcoin: { id: "github-bitcoin-core", name: "Bitcoin Core GitHub", url: "https://github.com/bitcoin/bitcoin" },
  githubAgave: { id: "github-agave", name: "Agave GitHub", url: "https://github.com/anza-xyz/agave" },
  githubFiredancer: { id: "github-firedancer", name: "Firedancer GitHub", url: "https://github.com/firedancer-io/firedancer" },
  defillama: { id: "defillama", name: "DefiLlama", url: "https://defillama.com/chain/Solana" },
} satisfies Record<string, Source>;

const GROUP_TTL: Record<AssetHealthCadence, number> = { FAST: 2 * 60 * 60, STRUCTURAL: 12 * 60 * 60, DEVELOPMENT: 48 * 60 * 60 };

async function json(fetcher: FetchLike, url: string, init?: RequestInit) {
  const response = await fetcher(url, { ...init, cache: "no-store", headers: { accept: "application/json",
    "user-agent": "CoinOps-Asset-Health/1.0", ...init?.headers }, signal: AbortSignal.timeout(9_000) });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return response.json() as Promise<unknown>;
}

function metric(asset: AssetHealthAsset, cadence: AssetHealthCadence, source: Source, now: Date, input: MetricInput): AssetMetric {
  return { ...input, asset, cadence, source, fetchedAt: now.toISOString(), observedAt: now.toISOString(),
    metricAt: input.metricAt === undefined ? now.toISOString() : input.metricAt,
    ttlSeconds: GROUP_TTL[cadence], confidence: input.confidence ?? "HIGH", indicatorClass: input.indicatorClass ?? "PRIMARY" };
}
function unavailable(asset: AssetHealthAsset, cadence: AssetHealthCadence, source: Source, now: Date,
  key: string, label: string, category: AssetHealthCategory, error: unknown): AssetMetric {
  const code = error instanceof Error ? error.message.replace(/[^A-Z0-9_]/gi, "_").slice(0, 80) : "SOURCE_FAILED";
  return metric(asset, cadence, source, now, { key, label, category, value: null, unit: null,
    status: "SOURCE_UNAVAILABLE", reason: `${label}: fonte temporariamente indisponível; nenhuma conclusão estrutural foi inferida.`,
    confidence: "LOW", errorCode: code, metricAt: null });
}
function finite(value: unknown) {
  if (value === null || value === undefined || typeof value === "boolean" || value === "") return null;
  const number = Number(value); return Number.isFinite(number) ? number : null;
}
function status(value: number, warning: (value: number) => boolean, critical: (value: number) => boolean): AssetMetricStatus {
  return critical(value) ? "CRITICAL" : warning(value) ? "WARNING" : "HEALTHY";
}
const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

async function binanceMarket(asset: AssetHealthAsset, now: Date, fetcher: FetchLike): Promise<AssetMetric[]> {
  const symbol = `${asset}USDT`, source = SOURCES.binance, cadence = "FAST" as const;
  try {
    const [tickerRaw, depthRaw] = await Promise.all([
      json(fetcher, `https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${symbol}`),
      json(fetcher, `https://data-api.binance.vision/api/v3/depth?symbol=${symbol}&limit=20`),
    ]);
    const ticker = tickerRaw as Record<string, unknown>, depth = depthRaw as { bids?: unknown[][]; asks?: unknown[][] };
    const quoteVolume = finite(ticker.quoteVolume);
    const bid = finite(depth.bids?.[0]?.[0]), ask = finite(depth.asks?.[0]?.[0]);
    if (quoteVolume === null || quoteVolume < 0 || !bid || !ask || ask < bid) throw new Error("INVALID_MARKET_DATA");
    const spreadPct = (ask - bid) / ((ask + bid) / 2) * 100;
    const minHealthy = asset === "BTC" ? 100_000_000 : 20_000_000;
    const minWarning = asset === "BTC" ? 25_000_000 : 5_000_000;
    return [
      metric(asset, cadence, source, now, { key: "market_quote_volume_24h", label: "Volume Spot 24h", category: "LIQUIDITY",
        value: quoteVolume, unit: "USDT", status: status(quoteVolume, (v) => v < minHealthy, (v) => v < minWarning),
        reason: quoteVolume >= minHealthy ? `Volume Spot 24h observado em ${symbol}.` : `Volume Spot 24h de ${symbol} abaixo do patamar conservador acompanhado.` }),
      metric(asset, cadence, source, now, { key: "market_spread", label: "Spread do livro", category: "LIQUIDITY",
        value: spreadPct, unit: "%", status: status(spreadPct, (v) => v > .1, (v) => v > .5),
        reason: spreadPct <= .1 ? `Spread de topo de livro de ${symbol} permanece estreito.` : `Spread de topo de livro de ${symbol} está ampliado.` }),
    ];
  } catch (error) {
    return [unavailable(asset, cadence, source, now, "market_quote_volume_24h", "Volume Spot 24h", "LIQUIDITY", error),
      unavailable(asset, cadence, source, now, "market_spread", "Spread do livro", "LIQUIDITY", error)];
  }
}

async function btcFast(now: Date, fetcher: FetchLike): Promise<AssetMetric[]> {
  const source = SOURCES.mempool, cadence = "FAST" as const;
  try {
    const [blocksRaw, mempoolRaw] = await Promise.all([
      json(fetcher, "https://mempool.space/api/blocks"), json(fetcher, "https://mempool.space/api/mempool"),
    ]);
    const blocks = (Array.isArray(blocksRaw) ? blocksRaw : []) as Array<{ timestamp?: number; height?: number }>;
    const mempool = mempoolRaw as Record<string, unknown>;
    const timestamps = blocks.map((row) => finite(row.timestamp)).filter((value): value is number => value !== null);
    if (timestamps.length < 5 || timestamps.some((time) => time <= 0 || time > now.getTime() / 1000 + 7200)) throw new Error("INVALID_BLOCK_DATA");
    const intervals = timestamps.slice(0, -1).map((value, index) => Math.max(0, value - timestamps[index + 1]) / 60);
    const blockMinutes = average(intervals), tipAgeMinutes = Math.max(0, now.getTime() / 1000 - timestamps[0]) / 60;
    return [
      metric("BTC", cadence, source, now, { key: "block_interval", label: "Intervalo entre blocos", category: "NETWORK",
        value: blockMinutes, unit: "min", status: status(blockMinutes, (v) => v > 20, (v) => v > 35),
        reason: blockMinutes <= 20 ? `Blocos recentes com intervalo médio de ${blockMinutes.toFixed(1)} min.` : `Intervalo médio recente entre blocos subiu para ${blockMinutes.toFixed(1)} min.` , metricAt: new Date(timestamps[0] * 1000).toISOString() }),
      metric("BTC", cadence, source, now, { key: "tip_age", label: "Produção do bloco mais recente", category: "NETWORK",
        value: tipAgeMinutes, unit: "min", status: status(tipAgeMinutes, (v) => v > 30, (v) => v > 60),
        reason: tipAgeMinutes <= 30 ? `Bloco mais recente observado há ${tipAgeMinutes.toFixed(1)} min.` : `Nenhum novo bloco observado há ${tipAgeMinutes.toFixed(1)} min.`, metricAt: new Date(timestamps[0] * 1000).toISOString() }),
      metric("BTC", cadence, source, now, { key: "mempool_backlog", label: "Mempool", category: "NETWORK", indicatorClass: "COMPLEMENTARY_PROXY",
        value: { transactions: finite(mempool.count), vsize: finite(mempool.vsize) }, unit: null, status: "HEALTHY",
        contextOnly: true, reason: "Mempool observada como contexto; congestionamento isolado não é risco estrutural." }),
    ];
  } catch (error) {
    return [unavailable("BTC", cadence, source, now, "block_interval", "Intervalo entre blocos", "NETWORK", error),
      unavailable("BTC", cadence, source, now, "tip_age", "Produção do bloco mais recente", "NETWORK", error),
      unavailable("BTC", cadence, source, now, "mempool_backlog", "Mempool", "NETWORK", error)];
  }
}

async function btcStructural(now: Date, fetcher: FetchLike): Promise<AssetMetric[]> {
  const source = SOURCES.mempool, cadence = "STRUCTURAL" as const;
  try {
    const [hashRaw, poolsRaw] = await Promise.all([
      json(fetcher, "https://mempool.space/api/v1/mining/hashrate/1m"),
      json(fetcher, "https://mempool.space/api/v1/mining/pools/1m"),
    ]);
    const hash = hashRaw as { currentHashrate?: number; currentDifficulty?: number; hashrates?: Array<{ avgHashrate?: number; timestamp?: number }> };
    const history = (hash.hashrates ?? []).map((row) => finite(row.avgHashrate)).filter((value): value is number => value !== null && value > 0);
    const current = finite(hash.currentHashrate), difficulty = finite(hash.currentDifficulty);
    const latestHistoryAt = Math.max(...(hash.hashrates ?? []).map((row) => finite(row.timestamp) ?? 0));
    if (!current || !difficulty || history.length < 7 || !latestHistoryAt) throw new Error("INVALID_MINING_DATA");
    if (now.getTime() / 1000 - latestHistoryAt > 3 * 86400) throw new Error("MINING_HISTORY_STALE");
    const ratio = current / average(history.slice(0, Math.max(7, history.length - 1)));
    const poolRows = Array.isArray(poolsRaw) ? poolsRaw : (poolsRaw as { pools?: unknown[] }).pools ?? [];
    const shares = (poolRows as Array<Record<string, unknown>>).map((row) => finite(row.blockCount)).filter((v): v is number => v !== null && v >= 0);
    const topShare = shares.length ? Math.max(...shares) / (shares.reduce((sum, value) => sum + value, 0) || 1) : null;
    return [
      metric("BTC", cadence, source, now, { key: "hashrate_trend", label: "Hashrate", category: "SECURITY", value: { current, ratio30d: ratio }, unit: "H/s",
        status: status(ratio, (v) => v < .7, (v) => v < .5), reason: ratio >= .7 ? "Hashrate atual permanece dentro da faixa mensal acompanhada." : `Hashrate caiu para ${(ratio * 100).toFixed(1)}% da referência mensal.` }),
      metric("BTC", cadence, source, now, { key: "difficulty", label: "Dificuldade de mineração", category: "SECURITY", value: difficulty, unit: null,
        status: difficulty > 0 ? "HEALTHY" : "CRITICAL", reason: difficulty > 0 ? "Dificuldade de mineração válida e ativa." : "Dificuldade de mineração inválida." }),
      topShare === null ? unavailable("BTC", cadence, source, now, "mining_concentration", "Concentração de mineração", "SECURITY", new Error("POOL_SHARE_UNAVAILABLE"))
        : metric("BTC", cadence, source, now, { key: "mining_concentration", label: "Concentração de mineração (proxy)", category: "SECURITY", value: topShare * 100, unit: "%", indicatorClass: "COMPLEMENTARY_PROXY",
          status: status(topShare, (v) => v > .5, (v) => v > .65), reason: `Maior pool responde por ${(topShare * 100).toFixed(1)}% dos blocos identificados no mês; aproximação de concentração, não controle dos mineradores.`, confidence: "MEDIUM" }),
    ];
  } catch (error) {
    return [unavailable("BTC", cadence, source, now, "hashrate_trend", "Hashrate", "SECURITY", error),
      unavailable("BTC", cadence, source, now, "difficulty", "Dificuldade de mineração", "SECURITY", error),
      unavailable("BTC", cadence, source, now, "mining_concentration", "Concentração de mineração", "SECURITY", error)];
  }
}

async function btcIndependentTip(now: Date, fetcher: FetchLike): Promise<AssetMetric[]> {
  const source = SOURCES.blockstream;
  try {
    const raw = await json(fetcher, "https://blockstream.info/api/blocks") as Array<{ timestamp?: number; height?: number }>;
    const timestamp = finite(raw[0]?.timestamp);
    if (!timestamp || timestamp > now.getTime() / 1000 + 7200) throw new Error("INVALID_BLOCKSTREAM_TIP");
    const minutes = Math.max(0, now.getTime() / 1000 - timestamp) / 60;
    return [metric("BTC", "FAST", source, now, { key: "tip_age", label: "Produção confirmada por explorer independente", category: "NETWORK",
      value: minutes, unit: "min", metricAt: new Date(timestamp * 1000).toISOString(),
      status: status(minutes, (value) => value > 30, (value) => value > 60), reason: `Blockstream observa último bloco há ${minutes.toFixed(1)} min.` })];
  } catch (error) { return [unavailable("BTC", "FAST", source, now, "tip_age", "Produção confirmada por explorer independente", "NETWORK", error)]; }
}

async function githubDevelopment(asset: AssetHealthAsset, repo: string, source: Source, key: string, now: Date, fetcher: FetchLike) {
  const cadence = "DEVELOPMENT" as const;
  try {
    const [commitRaw, releaseRaw] = await Promise.all([
      json(fetcher, `https://api.github.com/repos/${repo}/commits?per_page=1`),
      json(fetcher, `https://api.github.com/repos/${repo}/releases/latest`).catch(() => null),
    ]);
    const commit = (Array.isArray(commitRaw) ? commitRaw[0] : null) as { commit?: { committer?: { date?: string } } } | null;
    const release = releaseRaw as { published_at?: string; tag_name?: string } | null;
    const commitAt = commit?.commit?.committer?.date, releaseAt = release?.published_at;
    if (!commitAt || !Number.isFinite(Date.parse(commitAt))) throw new Error("INVALID_GITHUB_DATA");
    const ageDays = (now.getTime() - Date.parse(commitAt)) / 86_400_000;
    return [metric(asset, cadence, source, now, { key, label: `${source.name} ativo`, category: "DEVELOPMENT",
      value: { lastCommitAt: commitAt, latestRelease: release?.tag_name ?? null, releaseAt: releaseAt ?? null,
        releaseCollectionStatus: release ? "OK" : "SOURCE_UNAVAILABLE" }, unit: null,
      status: status(ageDays, (v) => v > 90, (v) => v > 180), metricAt: commitAt,
      reason: ageDays <= 90 ? `Desenvolvimento observado há ${Math.max(0, Math.floor(ageDays))} dias.` : `Último commit observado há ${Math.floor(ageDays)} dias.` })];
  } catch (error) { return [unavailable(asset, cadence, source, now, key, `${source.name} ativo`, "DEVELOPMENT", error)]; }
}

async function solanaRpc(now: Date, fetcher: FetchLike, cadence: "FAST" | "STRUCTURAL"): Promise<AssetMetric[]> {
  const source = SOURCES.solanaRpc;
  const methods = cadence === "FAST" ? ["getHealth", "getEpochInfo", "getRecentPerformanceSamples"] : ["getVoteAccounts"];
  try {
    const body = methods.map((method, index) => ({ jsonrpc: "2.0", id: index + 1, method,
      params: method === "getRecentPerformanceSamples" ? [5] : method === "getEpochInfo" ? [{ commitment: "finalized" }] : [] }));
    const raw = await json(fetcher, "https://api.mainnet-beta.solana.com", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const responses = new Map((Array.isArray(raw) ? raw : [raw]).map((row) => [(row as { id: number }).id, row as { result?: unknown; error?: unknown }]));
    if (cadence === "FAST") {
      const health = responses.get(1), epoch = responses.get(2)?.result as Record<string, unknown> | undefined;
      const samples = responses.get(3)?.result as Array<Record<string, unknown>> | undefined;
      if (health?.result !== "ok" || !epoch || !samples?.length) throw new Error("SOLANA_RPC_INCOMPLETE");
      if (samples.some((row) => !finite(row.samplePeriodSecs) || !finite(row.numSlots) || finite(row.numNonVoteTransactions) === null)) throw new Error("SOLANA_SAMPLES_INCOMPLETE");
      const secondsPerSlot = average(samples.map((row) => Number(row.samplePeriodSecs) / Number(row.numSlots)));
      const tps = average(samples.map((row) => Number(row.numNonVoteTransactions) / Number(row.samplePeriodSecs)));
      const blockTime = await json(fetcher, "https://api.mainnet-beta.solana.com", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "getBlockTime", params: [epoch.absoluteSlot] }) }).catch(() => null) as { result?: number } | null;
      const reportedTimestamp = finite(blockTime?.result);
      const tipTimestamp = reportedTimestamp && reportedTimestamp <= now.getTime() / 1000 + 120 ? reportedTimestamp : null;
      const tipAgeMinutes = tipTimestamp ? Math.max(0, now.getTime() / 1000 - tipTimestamp) / 60 : null;
      return [
        metric("SOL", cadence, source, now, { key: "rpc_health", label: "Saúde RPC da rede", category: "NETWORK", value: "ok", unit: null,
          status: "HEALTHY", reason: "O nó RPC oficial está sincronizado com o cluster; isso não prova sozinho disponibilidade de toda a rede." }),
        metric("SOL", cadence, source, now, { key: "slot_performance", label: "Produção de slots", category: "NETWORK", value: secondsPerSlot, unit: "s/slot",
          status: status(secondsPerSlot, (v) => v > 1, (v) => v > 3), reason: secondsPerSlot <= 1 ? `Produção recente em ${secondsPerSlot.toFixed(2)} s/slot.` : `Produção recente desacelerou para ${secondsPerSlot.toFixed(2)} s/slot.` }),
      metric("SOL", cadence, source, now, { key: "network_activity", label: "Atividade processada", category: "ECOSYSTEM", value: tps, unit: "tx/s", indicatorClass: "COMPLEMENTARY_PROXY",
          status: tps > 0 ? "HEALTHY" : "WARNING", reason: tps > 0 ? `Amostras RPC registraram ${tps.toFixed(0)} transações não-voto/s; atividade não equivale a usuários ou valor econômico.` : "Amostras RPC não registraram atividade não-voto." }),
        tipAgeMinutes === null ? unavailable("SOL", cadence, source, now, "finalized_block_age", "Bloco finalizado mais recente", "NETWORK", new Error("BLOCK_TIME_UNAVAILABLE"))
          : metric("SOL", cadence, source, now, { key: "finalized_block_age", label: "Bloco finalizado mais recente", category: "NETWORK", value: tipAgeMinutes,
            metricAt: new Date(tipTimestamp! * 1000).toISOString(), unit: "min", status: status(tipAgeMinutes, (value) => value > 2, (value) => value > 15),
            reason: `RPC informa bloco finalizado há ${tipAgeMinutes.toFixed(2)} min; status oficial complementa esta observação.` }),
      ];
    }
    const votes = responses.get(1)?.result as { current?: Array<Record<string, unknown>>; delinquent?: Array<Record<string, unknown>> } | undefined;
    if (!votes || !Array.isArray(votes.current) || !votes.current.length || !Array.isArray(votes.delinquent)) throw new Error("SOLANA_VOTES_INCOMPLETE");
    const current = votes.current ?? [], delinquent = votes.delinquent ?? [];
    const stakes = current.map((row) => finite(row.activatedStake)).filter((value): value is number => value !== null && value > 0).sort((a, b) => b - a);
    const delinquentStake = delinquent.reduce((sum, row) => sum + (finite(row.activatedStake) ?? 0), 0), totalStake = stakes.reduce((a, b) => a + b, 0) + delinquentStake;
    let cumulative = 0, nakamoto = 0;
    for (const stake of stakes) { cumulative += stake; nakamoto++; if (cumulative >= totalStake / 3) break; }
    if (!totalStake || !stakes.length) throw new Error("SOLANA_STAKE_INCOMPLETE");
    const delinquentRatio = delinquentStake / totalStake;
    return [
      metric("SOL", cadence, source, now, { key: "active_validators", label: "Validadores ativos", category: "SECURITY", value: current.length, unit: "validadores",
        status: status(current.length, (v) => v < 500, (v) => v < 200), reason: `${current.length} contas de voto ativas observadas; limiares de acompanhamento: 500 (atenção) e 200 (crítico).` }),
      metric("SOL", cadence, source, now, { key: "delinquent_stake", label: "Stake delinquent", category: "SECURITY", value: delinquentRatio * 100, unit: "%",
        status: status(delinquentRatio, (v) => v > .1, (v) => v > .25), reason: delinquentRatio <= .1 ? `Stake delinquent em ${(delinquentRatio * 100).toFixed(2)}%.` : `Stake delinquent subiu para ${(delinquentRatio * 100).toFixed(2)}%.` }),
      metric("SOL", cadence, source, now, { key: "vote_account_superminority_proxy", label: "Concentração por contas de voto (proxy)", category: "SECURITY", value: nakamoto, unit: "contas de voto", indicatorClass: "COMPLEMENTARY_PROXY",
        status: status(nakamoto, (v) => v < 20, (v) => v < 10), reason: `${nakamoto} contas de voto acumulam 1/3 do stake observado. Proxy sem agrupamento por operador; não é coeficiente Nakamoto oficial.`, confidence: "MEDIUM" }),
    ];
  } catch (error) {
    return cadence === "FAST"
      ? [unavailable("SOL", cadence, source, now, "rpc_health", "Saúde RPC da rede", "NETWORK", error), unavailable("SOL", cadence, source, now, "slot_performance", "Produção de slots", "NETWORK", error), unavailable("SOL", cadence, source, now, "network_activity", "Atividade processada", "ECOSYSTEM", error), unavailable("SOL", cadence, source, now, "finalized_block_age", "Bloco finalizado mais recente", "NETWORK", error)]
      : [unavailable("SOL", cadence, source, now, "active_validators", "Validadores ativos", "SECURITY", error), unavailable("SOL", cadence, source, now, "delinquent_stake", "Stake delinquent", "SECURITY", error),
        { ...unavailable("SOL", cadence, source, now, "vote_account_superminority_proxy", "Concentração por contas de voto (proxy)", "SECURITY", error), indicatorClass: "COMPLEMENTARY_PROXY" }];
  }
}

async function solanaStatus(now: Date, fetcher: FetchLike): Promise<AssetMetric[]> {
  const source = SOURCES.solanaStatus, cadence = "FAST" as const;
  try {
    const raw = await json(fetcher, "https://status.solana.com/api/v2/summary.json") as { status?: { indicator?: string; description?: string }; incidents?: Array<{ name?: string; shortlink?: string; started_at?: string; impact?: string }>; page?: { updated_at?: string } };
    const indicator = raw.status?.indicator ?? "unknown", incidents = raw.incidents?.length ?? 0;
    if (!["none", "minor", "major", "critical"].includes(indicator)) throw new Error("UNKNOWN_STATUS_INDICATOR");
    const metricStatus: AssetMetricStatus = indicator === "none" ? "HEALTHY" : ["major", "critical"].includes(indicator) ? "CRITICAL" : "WARNING";
    return [metric("SOL", cadence, source, now, { key: "official_network_status", label: "Status oficial da rede", category: "NETWORK", indicatorClass: "CRITICAL",
      value: { indicator, incidents, description: raw.status?.description ?? null,
        events: (raw.incidents ?? []).slice(0, 8).map((item) => ({ title: item.name, url: item.shortlink, startedAt: item.started_at, impact: item.impact })) }, unit: null, status: metricStatus,
      metricAt: raw.page?.updated_at ?? now.toISOString(), reason: indicator === "none" ? "Status oficial informa operação normal." : `Status oficial informa ${indicator}; outage isolado gera atenção, não risco estrutural automático.` })];
  } catch (error) { return [unavailable("SOL", cadence, source, now, "official_network_status", "Status oficial da rede", "NETWORK", error)]; }
}

async function solanaEconomicActivity(now: Date, fetcher: FetchLike): Promise<AssetMetric[]> {
  const source = SOURCES.defillama, cadence = "STRUCTURAL" as const;
  const result: AssetMetric[] = [];
  const [stableResult, dexResult] = await Promise.allSettled([
    json(fetcher, "https://stablecoins.llama.fi/stablecoincharts/Solana"),
    json(fetcher, "https://api.llama.fi/overview/dexs/Solana?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true"),
  ]);
  try {
    if (stableResult.status === "rejected") throw stableResult.reason;
    const rows = (stableResult.value as Array<{ date?: string; totalCirculatingUSD?: Record<string, number> }>)
      .filter((row) => finite(row.date) !== null && row.totalCirculatingUSD)
      .sort((a, b) => Number(a.date) - Number(b.date));
    const latest = rows.at(-1), baseline = rows.filter((row) => Number(row.date) <= Number(latest?.date) - 30 * 86400).at(-1);
    const total = (row: typeof latest) => row ? Object.values(row.totalCirculatingUSD ?? {}).reduce((sum, value) => sum + (finite(value) ?? 0), 0) : null;
    const current = total(latest), reference = total(baseline);
    if (!latest || current === null || !reference) throw new Error("STABLECOIN_HISTORY_INCOMPLETE");
    const ratio = current / reference, metricAt = new Date(Number(latest.date) * 1000).toISOString();
    if (now.getTime() - Date.parse(metricAt) > 3 * 86400_000) throw new Error("STABLECOIN_HISTORY_STALE");
    result.push(metric("SOL", cadence, source, now, { key: "stablecoin_supply_trend", label: "Oferta de stablecoins no ecossistema", category: "ECOSYSTEM",
      value: { currentUsd: current, reference30dUsd: reference, ratio30d: ratio }, unit: "USD", metricAt, confidence: "MEDIUM",
      status: status(ratio, (value) => value < .7, (value) => value < .4),
      reason: `Oferta de stablecoins em ${(ratio * 100).toFixed(1)}% de 30 dias atrás. Migrações e metodologia podem afetar a medida; exige outras evidências para risco estrutural.` }));
  } catch (error) { result.push(unavailable("SOL", cadence, source, now, "stablecoin_supply_trend", "Oferta de stablecoins no ecossistema", "ECOSYSTEM", error)); }
  try {
    if (dexResult.status === "rejected") throw dexResult.reason;
    const dex = dexResult.value as { total24h?: number; total30d?: number; total60dto30d?: number };
    if (finite(dex.total24h) === null) throw new Error("DEX_VOLUME_INCOMPLETE");
    result.push(metric("SOL", cadence, source, now, { key: "dex_volume", label: "Volume DEX", category: "ECOSYSTEM",
      value: { total24hUsd: finite(dex.total24h), total30dUsd: finite(dex.total30d), previous30dUsd: finite(dex.total60dto30d) },
      unit: "USD", contextOnly: true, indicatorClass: "COMPLEMENTARY_PROXY", status: "HEALTHY", confidence: "MEDIUM",
      reason: "Volume DEX em USD exibido como contexto; atividade pode incluir bots, volume artificial e efeito de preço. Não classifica risco isoladamente." }));
  } catch (error) { result.push({ ...unavailable("SOL", cadence, source, now, "dex_volume", "Volume DEX", "ECOSYSTEM", error), contextOnly: true }); }
  return result;
}

function optionalCoverage(now: Date): AssetMetric[] {
  return [
    { ...unavailable("SOL", "STRUCTURAL", SOURCES.solanaRpc, now, "client_diversity", "Diversidade de clientes por stake", "SECURITY", new Error("VERIFIED_CLIENT_STAKE_DATASET_UNAVAILABLE")),
      optional: true, reason: "Agave e Firedancer são acompanhados por desenvolvimento, mas participação por stake/operador não está disponível nesta integração; não inferida a partir de versões RPC." },
    ...(["BTC", "SOL"] as const).map((asset) => ({ ...unavailable(asset, "DEVELOPMENT", asset === "BTC" ? SOURCES.githubBitcoin : SOURCES.githubAgave,
      now, "confirmed_security_advisories", "Vulnerabilidades críticas confirmadas", "SECURITY", new Error("COMPREHENSIVE_SECURITY_FEED_UNAVAILABLE")), optional: true,
      reason: "Não há feed automatizado completo de vulnerabilidades críticas integrado. Ausência de coleta não comprova ausência de vulnerabilidade." })),
  ];
}

async function solanaEcosystem(now: Date, fetcher: FetchLike): Promise<AssetMetric[]> {
  const source = SOURCES.defillama, cadence = "STRUCTURAL" as const;
  try {
    const chains = await json(fetcher, "https://api.llama.fi/v2/chains") as Array<Record<string, unknown>>;
    const solana = chains.find((row) => row.name === "Solana");
    const tvl = finite(solana?.tvl);
    if (tvl === null) throw new Error("SOLANA_TVL_UNAVAILABLE");
    return [metric("SOL", cadence, source, now, { key: "ecosystem_tvl", label: "TVL do ecossistema", category: "ECOSYSTEM", value: tvl, unit: "USD",
      status: "HEALTHY", contextOnly: true, indicatorClass: "COMPLEMENTARY_PROXY", confidence: "MEDIUM", reason: "TVL em USD é contexto, não sinal de risco: variação de preço e dupla contagem metodológica podem afetá-la. Tendência ajustada por preço ainda indisponível." })];
  } catch (error) { return [unavailable("SOL", cadence, source, now, "ecosystem_tvl", "TVL do ecossistema", "ECOSYSTEM", error)]; }
}

export async function collectAssetHealthMetrics(cadences: AssetHealthCadence[], now = new Date(), fetcher: FetchLike = fetch) {
  const tasks: Array<Promise<AssetMetric[]>> = [];
  if (cadences.includes("FAST")) tasks.push(btcFast(now, fetcher), btcIndependentTip(now, fetcher), binanceMarket("BTC", now, fetcher), solanaRpc(now, fetcher, "FAST"), solanaStatus(now, fetcher), binanceMarket("SOL", now, fetcher));
  if (cadences.includes("STRUCTURAL")) tasks.push(btcStructural(now, fetcher), solanaRpc(now, fetcher, "STRUCTURAL"), solanaEcosystem(now, fetcher), solanaEconomicActivity(now, fetcher));
  if (cadences.includes("DEVELOPMENT")) tasks.push(
    githubDevelopment("BTC", "bitcoin/bitcoin", SOURCES.githubBitcoin, "bitcoin_core_development", now, fetcher),
    githubDevelopment("SOL", "anza-xyz/agave", SOURCES.githubAgave, "agave_development", now, fetcher),
    githubDevelopment("SOL", "firedancer-io/firedancer", SOURCES.githubFiredancer, "firedancer_development", now, fetcher));
  return [...(await Promise.all(tasks)).flat(), ...optionalCoverage(now).filter((item) => cadences.includes(item.cadence))];
}

export const ASSET_HEALTH_SOURCES = SOURCES;

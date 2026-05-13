import { isHistoryEnabled, queryFxHistory, queryQuoteHistory } from "../util/persistence.js";

/**
 * fx_history — return Sera /fx/rate observations logged by this MCP since `since_hours_ago`.
 * Sera doesn't publish OHLC. Every fx_rate call this MCP serves is logged when
 * SERA_HISTORY_DB is set, so over time the MCP becomes its own price feed.
 */
export async function fxHistory(args: { base: string; quote: string; since_hours_ago?: number }) {
  if (!isHistoryEnabled()) {
    return {
      enabled: false,
      hint: "Set SERA_HISTORY_DB=/path/to/sera-history.db on the server to enable persistent FX logging.",
      observations: [],
    };
  }
  const hours = args.since_hours_ago ?? 24;
  const sinceTs = Math.floor(Date.now() / 1000) - hours * 3600;
  const rows = queryFxHistory(args.base, args.quote, sinceTs);
  return {
    enabled: true,
    pair: `${args.base.toUpperCase()}/${args.quote.toUpperCase()}`,
    since_hours_ago: hours,
    observation_count: rows.length,
    observations: rows,
  };
}

/**
 * volatility — basic stats over the same fx_history window. Annualized vol
 * uses sqrt(periods_per_year * variance) on log returns.
 */
export async function fxVolatility(args: {
  base: string;
  quote: string;
  since_hours_ago?: number;
}) {
  if (!isHistoryEnabled()) {
    return { enabled: false, hint: "Set SERA_HISTORY_DB to enable." };
  }
  const hours = args.since_hours_ago ?? 24;
  const sinceTs = Math.floor(Date.now() / 1000) - hours * 3600;
  const rows = queryFxHistory(args.base, args.quote, sinceTs);
  if (rows.length < 3) {
    return {
      enabled: true,
      pair: `${args.base.toUpperCase()}/${args.quote.toUpperCase()}`,
      observation_count: rows.length,
      hint: "Need at least 3 observations for stats. Wait for more agent traffic or lower since_hours_ago threshold.",
    };
  }
  const rates = rows.map((r) => r.rate);
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  const variance = rates.reduce((a, b) => a + (b - mean) ** 2, 0) / rates.length;
  const std = Math.sqrt(variance);
  const min = Math.min(...rates);
  const max = Math.max(...rates);

  // Log returns for annualized vol (assumes observations are roughly evenly spaced).
  const logRets: number[] = [];
  for (let i = 1; i < rates.length; i++) {
    if (rates[i - 1] > 0) logRets.push(Math.log(rates[i] / rates[i - 1]));
  }
  const meanRet = logRets.reduce((a, b) => a + b, 0) / Math.max(1, logRets.length);
  const varRet = logRets.reduce((a, b) => a + (b - meanRet) ** 2, 0) / Math.max(1, logRets.length);
  const stdRet = Math.sqrt(varRet);
  const elapsedHours = (rows[rows.length - 1].ts - rows[0].ts) / 3600;
  const obsPerHour = elapsedHours > 0 ? rows.length / elapsedHours : 0;
  const annualizedVol = stdRet * Math.sqrt(obsPerHour * 24 * 365);

  return {
    enabled: true,
    pair: `${args.base.toUpperCase()}/${args.quote.toUpperCase()}`,
    window_hours: hours,
    observation_count: rows.length,
    stats: {
      mean,
      stdev: std,
      min,
      max,
      range_bps: mean > 0 ? Math.round(((max - min) / mean) * 10_000) : null,
      annualized_volatility_estimate: annualizedVol,
    },
    note: "Annualized vol assumes evenly-spaced observations. Treat as rough — Sera traffic isn't uniform.",
  };
}

/**
 * corridor_pnl — for a given pair, what would the agent have realized vs current
 * rate by holding the long side over the window? Pure mark-to-market thought experiment;
 * doesn't account for actual swap costs.
 */
export async function corridorPnl(args: { base: string; quote: string; since_hours_ago?: number }) {
  if (!isHistoryEnabled()) {
    return { enabled: false, hint: "Set SERA_HISTORY_DB to enable." };
  }
  const hours = args.since_hours_ago ?? 24;
  const sinceTs = Math.floor(Date.now() / 1000) - hours * 3600;
  const rows = queryFxHistory(args.base, args.quote, sinceTs);
  if (rows.length < 2) {
    return {
      enabled: true,
      pair: `${args.base.toUpperCase()}/${args.quote.toUpperCase()}`,
      observation_count: rows.length,
      hint: "Need at least 2 observations.",
    };
  }
  const first = rows[0];
  const last = rows[rows.length - 1];
  const drift = last.rate - first.rate;
  const driftBps = first.rate > 0 ? Math.round((drift / first.rate) * 10_000) : 0;

  const quoteRows = queryQuoteHistory(args.base, args.quote, sinceTs);
  return {
    enabled: true,
    pair: `${args.base.toUpperCase()}/${args.quote.toUpperCase()}`,
    window_hours: hours,
    fx_observation_count: rows.length,
    quote_observation_count: quoteRows.length,
    first_rate: first.rate,
    last_rate: last.rate,
    drift_absolute: drift,
    drift_bps: driftBps,
    interpretation:
      driftBps > 0
        ? `Holding ${args.base.toUpperCase()} would have appreciated ~${driftBps}bps vs ${args.quote.toUpperCase()} over the window.`
        : driftBps < 0
        ? `Holding ${args.base.toUpperCase()} would have depreciated ~${Math.abs(driftBps)}bps vs ${args.quote.toUpperCase()} over the window.`
        : "Flat over the window.",
  };
}

import type { AppContext } from "../config.js";
import { resolveToken } from "../sera/tokens.js";
import { scanMarkets } from "./scan.js";
import { getMultiSourceMid } from "../util/external_fx.js";

/**
 * find_deals — single-call deal scanner. Combines:
 *   1. scan_markets (fan out quotes to find quotable corridors)
 *   2. compare each quotable rate against multi-source external mid
 *   3. filter for actual price advantage
 *
 * Direction semantics:
 *   - sera_above (executable rate > external mid) = good for SELLING base
 *   - sera_below                                  = good for BUYING base
 *
 * Defaults: min_deviation_bps=25 (matches the Deals web tool's threshold).
 */
export async function findDeals(
  ctx: AppContext,
  args: {
    pairs?: Array<{ base: string; quote: string }>;
    notional_per_quote?: number;
    max_pairs?: number;
    max_concurrency?: number;
    only_policy_allowed?: boolean;
    min_deviation_bps?: number;
    gas_mode?: "receive_less" | "pay_more";
    use_multi_source?: boolean; // false = Sera /fx/rate as benchmark; true = external median
  },
) {
  const minDev = args.min_deviation_bps ?? 25;
  const useMulti = args.use_multi_source ?? true;

  const scan = await scanMarkets(ctx, {
    pairs: args.pairs,
    notional_per_quote: args.notional_per_quote,
    max_pairs: args.max_pairs,
    max_concurrency: args.max_concurrency,
    only_policy_allowed: args.only_policy_allowed,
    gas_mode: args.gas_mode,
  });

  // For each quotable corridor, fetch external mid and compute deviation.
  const enriched = await Promise.all(
    (scan.quotable as Array<any>).map(async (q) => {
      const [baseSym, quoteSym] = q.pair.split("/");
      try {
        const baseTok = await resolveToken(ctx.sera, baseSym);
        const quoteTok = await resolveToken(ctx.sera, quoteSym);
        const baseFiat = (baseTok.fiat_currency ?? "USD").toUpperCase();
        const quoteFiat = (quoteTok.fiat_currency ?? "USD").toUpperCase();

        let benchmark: number | null = null;
        let benchmarkSource: string | null = null;
        let benchmarkAsOf: string | undefined;
        if (useMulti) {
          const m = await getMultiSourceMid(baseFiat, quoteFiat);
          benchmark = m.median;
          benchmarkSource = `median(${m.sources.filter((s) => s.rate != null).length} sources)`;
          benchmarkAsOf = m.sources.find((s) => s.as_of)?.as_of;
        } else {
          const r = await ctx.sera.getFxRate(baseFiat, quoteFiat);
          const n = Number(r.rate);
          if (Number.isFinite(n) && n > 0) {
            benchmark = n;
            benchmarkSource = "sera_fx_rate";
          }
        }

        if (benchmark == null) {
          return { ...q, benchmark: null, deviation_bps: null, status_label: "no_benchmark" };
        }

        const deviation = (q.rate - benchmark) / benchmark;
        const devBps = Math.round(deviation * 10_000);
        let label = "fair";
        if (devBps >= minDev) label = "good_sell";
        else if (devBps <= -minDev) label = "good_buy";

        return {
          ...q,
          base_fiat: baseFiat,
          quote_fiat: quoteFiat,
          benchmark,
          benchmark_source: benchmarkSource,
          benchmark_as_of: benchmarkAsOf,
          deviation_bps: devBps,
          status_label: label,
        };
      } catch (e: any) {
        return { ...q, benchmark: null, deviation_bps: null, error: e?.message ?? String(e) };
      }
    }),
  );

  const goodSell = enriched.filter((e) => e.status_label === "good_sell");
  const goodBuy = enriched.filter((e) => e.status_label === "good_buy");
  goodSell.sort((a, b) => (b.deviation_bps ?? 0) - (a.deviation_bps ?? 0));
  goodBuy.sort((a, b) => (a.deviation_bps ?? 0) - (b.deviation_bps ?? 0));

  return {
    summary: {
      ...scan.summary,
      benchmark_kind: useMulti ? "external_multi_source_median" : "sera_fx_rate",
      min_deviation_bps: minDev,
      good_sell_count: goodSell.length,
      good_buy_count: goodBuy.length,
      fair_count: enriched.filter((e) => e.status_label === "fair").length,
      no_benchmark_count: enriched.filter((e) => e.status_label === "no_benchmark").length,
    },
    good_sell: goodSell,
    good_buy: goodBuy,
    fair: enriched.filter((e) => e.status_label === "fair"),
    skipped: scan.skipped,
    note:
      "good_sell = Sera quote > benchmark (favorable for selling base for quote). " +
      "good_buy = Sera quote < benchmark (favorable for buying base with quote). " +
      "Sera mainnet has shown systematic ~100-200bps downward bias vs external mid — set min_deviation_bps generously.",
  };
}

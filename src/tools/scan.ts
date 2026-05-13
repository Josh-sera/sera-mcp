import type { AppContext } from "../config.js";
import { resolveToken, toRawAmount, fromRawAmount } from "../sera/tokens.js";
import { SeraApiError } from "../sera/client.js";
import { createLimit } from "../util/limit.js";

const SIMULATE_OWNER = "0x000000000000000000000000000000000000dEaD";

interface PairSpec {
  base: string; // symbol or address
  quote: string;
}

/**
 * scan_markets — fan out parallel /swap/quote probes across many pairs to surface
 * which corridors are quotable right now and at what executable rate. Built for
 * the deal-scanner pattern: one tool call instead of N round-trips from the agent.
 */
export async function scanMarkets(
  ctx: AppContext,
  args: {
    pairs?: PairSpec[];                // explicit list
    notional_per_quote?: number;       // human amount in `from`-units
    max_pairs?: number;                // safety cap when enumerating from /markets
    max_concurrency?: number;
    only_policy_allowed?: boolean;     // restrict to policy whitelist
    gas_mode?: "receive_less" | "pay_more";
  },
) {
  const notional = args.notional_per_quote ?? 100;
  const maxConcurrency = Math.max(1, Math.min(args.max_concurrency ?? 8, 25));
  const maxPairs = Math.max(1, Math.min(args.max_pairs ?? 50, 500));
  const gasMode = args.gas_mode ?? "receive_less";

  // Resolve the pair list. If unspecified, enumerate from /markets and (optionally)
  // restrict to whitelisted symbols so we don't blast through the catalog by default.
  let pairs: PairSpec[] = args.pairs ?? [];
  let totalAvailable = pairs.length;
  let truncated = false;
  if (!args.pairs) {
    const { markets } = await ctx.sera.getMarkets();
    const allowed = ctx.policy.config.allowedSymbols;
    const filtered = (args.only_policy_allowed ?? true) && allowed.length
      ? markets.filter(
          (m: any) =>
            allowed.includes((m.base_symbol ?? "").toUpperCase()) &&
            allowed.includes((m.quote_symbol ?? "").toUpperCase()),
        )
      : markets;
    totalAvailable = filtered.length;
    if (filtered.length > maxPairs) truncated = true;
    pairs = filtered.slice(0, maxPairs).map((m: any) => ({
      base: m.base_symbol ?? m.base_address,
      quote: m.quote_symbol ?? m.quote_address,
    }));
  }

  const limit = createLimit(maxConcurrency);

  const results = await Promise.all(
    pairs.map((p) =>
      limit(async () => {
        try {
          const fromTok = await resolveToken(ctx.sera, p.base);
          const toTok = await resolveToken(ctx.sera, p.quote);
          const t = await ctx.sera.getSystemTime();
          const expiration = Number(t.timestamp) + 60;
          const rawAmount = toRawAmount(notional, fromTok.decimals);
          const quote = await ctx.sera.postSwapQuote({
            from_token: fromTok.address,
            to_token: toTok.address,
            from_amount: rawAmount,
            owner_address: SIMULATE_OWNER,
            recipient: SIMULATE_OWNER,
            expiration,
            gas_mode: gasMode,
          });
          const inputHuman = fromRawAmount(quote.route_params.maxInputAmount, fromTok.decimals);
          const outputHuman = fromRawAmount(quote.route_params.minOutputAmount, toTok.decimals);
          const rate = Number(outputHuman) / Number(inputHuman);
          return {
            pair: `${fromTok.symbol}/${toTok.symbol}`,
            status: "quotable" as const,
            input_human: inputHuman,
            min_output_human: outputHuman,
            rate,
            gas_mode: gasMode,
          };
        } catch (e: any) {
          const code = e instanceof SeraApiError ? (e.errorCode ?? "error") : "error";
          return {
            pair: `${String(p.base)}/${String(p.quote)}`,
            status: "skipped" as const,
            reason: code,
            error: e?.message ?? String(e),
          };
        }
      }),
    ),
  );

  const quotable = results.filter((r) => r.status === "quotable");
  const skipped = results.filter((r) => r.status === "skipped");
  const reasonCounts: Record<string, number> = {};
  for (const r of skipped) {
    const k = (r as any).reason ?? "error";
    reasonCounts[k] = (reasonCounts[k] ?? 0) + 1;
  }

  return {
    summary: {
      pairs_tried: pairs.length,
      total_available: totalAvailable,
      truncated,
      quotable_count: quotable.length,
      skipped_count: skipped.length,
      skip_reasons: reasonCounts,
      notional_per_quote: notional,
      gas_mode: gasMode,
      max_concurrency: maxConcurrency,
    },
    quotable,
    skipped,
  };
}

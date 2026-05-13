import type { AppContext } from "../config.js";
import { resolveToken } from "../sera/tokens.js";
import { getMultiSourceMid } from "../util/external_fx.js";

const DEFAULT_LADDER_BPS = [5, 10, 15, 25, 50, 100, 200];

const LADDER_NOTES: Record<number, string> = {
  5: "Very tight — fills fast, thin margin",
  10: "Tight — institutional zone",
  15: "Sweet spot for most FX/stablecoin",
  25: "Standard maker spread",
  50: "Wide — slower fills, thinner books",
  100: "1% — only fills if book is thin/desperate",
  200: "2% — usually unfilled in liquid pairs",
};

/**
 * maker_quote_ladder — given a pair, notional, mid, and role, return the
 * earnings table at multiple spread levels. Mirrors the Spread Calculator's
 * ladder so an agent can answer "what would I earn at 15bps on 30k?" with
 * one tool call.
 *
 * Mid resolution priority:
 *   1. args.mid (caller-provided, exact)
 *   2. args.mid_source = 'multi_source' → median of Frankfurter/open.er-api/exchangerate.host
 *   3. args.mid_source = 'sera' → sera.get_fx_rate
 *   4. default: multi_source (matches the calc's "fiat sanity check" UX)
 */
export async function makerQuoteLadder(
  ctx: AppContext,
  args: {
    base: string;                              // e.g. 'USDT' or 'USD'
    quote: string;                             // e.g. 'JPYC' or 'JPY'
    notional: number;                          // amount in the SELL leg
    role?: "maker_sell_base" | "maker_buy_base"; // default maker_sell_base
    mid?: number;
    mid_source?: "multi_source" | "sera";
    spreads_bps?: number[];
  },
) {
  const role = args.role ?? "maker_sell_base";
  const spreads = (args.spreads_bps && args.spreads_bps.length > 0
    ? args.spreads_bps
    : DEFAULT_LADDER_BPS
  ).filter((s) => Number.isFinite(s) && s > 0);

  // Resolve to fiat codes (so we can hit external sources cleanly).
  const baseTok = await resolveToken(ctx.sera, args.base);
  const quoteTok = await resolveToken(ctx.sera, args.quote);
  const baseFiat = (baseTok.fiat_currency ?? "USD").toUpperCase();
  const quoteFiat = (quoteTok.fiat_currency ?? "USD").toUpperCase();

  // Mid.
  let mid: number | null = args.mid ?? null;
  let midSource: string = "user_provided";
  let midDetail: any = null;
  if (mid == null) {
    const src = args.mid_source ?? "multi_source";
    if (src === "sera") {
      const r = await ctx.sera.getFxRate(baseFiat, quoteFiat);
      mid = Number(r.rate);
      midSource = "sera_fx_rate";
      midDetail = r;
    } else {
      const m = await getMultiSourceMid(baseFiat, quoteFiat);
      mid = m.median;
      midSource = `multi_source_median (${m.sources.filter((s) => s.rate != null).length}/3 ok)`;
      midDetail = m;
    }
  }
  if (!Number.isFinite(mid as number) || (mid as number) <= 0) {
    throw new Error("Could not resolve a usable mid. Pass `mid` explicitly.");
  }
  const M = mid as number;

  const ladder = spreads.map((bps) => {
    const fraction = bps / 10_000;
    // maker_sell_base: maker quotes BELOW mid (gives less quote per base sold to taker).
    // maker_buy_base: maker quotes ABOVE mid in same units (asks for more quote per base bought).
    const sign = role === "maker_sell_base" ? -1 : +1;
    const quotePrice = M * (1 + sign * fraction);
    const deltaPrice = quotePrice - M;
    // Earnings in the SELL-leg unit: spread × notional. For maker_sell_base, sell-leg = base.
    const earnedInSellLeg = args.notional * fraction;
    return {
      spread_bps: bps,
      quote_price: quotePrice,
      delta_price: deltaPrice,
      earned: earnedInSellLeg,
      pct: bps / 100,
      note: LADDER_NOTES[bps] ?? null,
    };
  });

  // Quick reference numbers: 1bp / 10bp / 1% of price, and per-bp earnings on this size.
  const reference = {
    one_pct_of_price: M * 0.01,
    ten_bps_of_price: M * 0.001,
    one_bp_of_price: M * 0.0001,
    earned_per_bp_at_size: args.notional / 10_000,
    earned_per_10bps_at_size: args.notional / 1_000,
    earned_per_pct_at_size: args.notional / 100,
  };

  return {
    pair: `${args.base.toUpperCase()}/${args.quote.toUpperCase()}`,
    base_fiat: baseFiat,
    quote_fiat: quoteFiat,
    role,
    notional: args.notional,
    mid: M,
    mid_source: midSource,
    mid_detail: midDetail,
    ladder,
    reference,
    interpretation:
      role === "maker_sell_base"
        ? "You sell base, deliver quote. Your quote sits BELOW mid — you give out less quote, keep the difference (earnings shown in BASE units)."
        : "You buy base, deliver quote. Your quote sits ABOVE mid — you ask for more quote, keep the difference (earnings shown in BASE units).",
  };
}

/**
 * multi_source_mid — median FX mid across 3 free providers (Frankfurter, open.er-api,
 * exchangerate.host). Used by the spread calculator's "fiat sanity check" today.
 * Inputs accept ISO fiat OR Sera token symbols.
 */
export async function multiSourceMid(
  ctx: AppContext,
  args: { base: string; quote: string },
) {
  const baseFiat = await toFiat(ctx, args.base);
  const quoteFiat = await toFiat(ctx, args.quote);
  return getMultiSourceMid(baseFiat, quoteFiat);
}

async function toFiat(ctx: AppContext, ref: string): Promise<string> {
  const upper = ref.trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(upper)) return upper;
  const t = await resolveToken(ctx.sera, ref);
  return (t.fiat_currency ?? "USD").toUpperCase();
}

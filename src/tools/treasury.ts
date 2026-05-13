import type { AppContext } from "../config.js";
import { getTokensCached, resolveToken, fromRawAmount } from "../sera/tokens.js";
import { getQuote } from "./core.js";

/**
 * treasury_value — fetch balances for one or more wallets, value each balance
 * in `target_currency` (e.g. SGD), and report a portfolio total. Aggregates
 * across multiple addresses so an agent can answer "what's the SGD value of
 * my whole stablecoin treasury?"
 *
 * Requires SERA_API_KEY/SECRET to read balances.
 */
export async function treasuryValue(
  ctx: AppContext,
  args: {
    owner_addresses: string[];
    target_currency?: string; // default 'USD'
    include_zero?: boolean;
  },
) {
  const target = (args.target_currency ?? "USD").toUpperCase();
  const includeZero = args.include_zero ?? false;
  const tokens = await getTokensCached(ctx.sera);

  const wallets: Array<{
    address: string;
    rows: Array<{ symbol: string; fiat: string; balance: number; rate_to_target: number; value: number }>;
    error?: string;
  }> = [];

  for (const addr of args.owner_addresses) {
    try {
      const r = await ctx.sera.getBalances(addr);
      const enriched: Array<any> = [];
      for (const b of r.balances) {
        const tokInfo = tokens.find((t) => t.symbol.toUpperCase() === b.symbol.toUpperCase());
        const fiat = (tokInfo?.fiat_currency ?? "USD").toUpperCase();
        const wallet = Number(fromRawAmount(b.wallet_balance, b.decimals));
        const vaultAvail = Number(fromRawAmount(b.vault_available, b.decimals));
        const total = wallet + vaultAvail;
        if (!includeZero && total === 0) continue;
        let rateToTarget = 1;
        if (fiat !== target) {
          try {
            const fx = await ctx.sera.getFxRate(fiat, target);
            const n = Number(fx.rate);
            if (Number.isFinite(n) && n > 0) rateToTarget = n;
          } catch {
            rateToTarget = NaN;
          }
        }
        enriched.push({
          symbol: b.symbol,
          fiat,
          balance: total,
          wallet,
          vault_available: vaultAvail,
          rate_to_target: rateToTarget,
          value: Number.isFinite(rateToTarget) ? total * rateToTarget : null,
        });
      }
      wallets.push({ address: addr, rows: enriched });
    } catch (e: any) {
      wallets.push({ address: addr, rows: [], error: e?.message ?? String(e) });
    }
  }

  const totalValue = wallets.reduce((sum, w) => {
    return sum + w.rows.reduce((s, r) => s + (Number.isFinite(r.value) ? r.value : 0), 0);
  }, 0);

  // Currency exposure breakdown.
  const exposure: Record<string, number> = {};
  for (const w of wallets) {
    for (const r of w.rows) {
      const v = Number.isFinite(r.value) ? r.value : 0;
      exposure[r.fiat] = (exposure[r.fiat] ?? 0) + v;
    }
  }
  const exposureBreakdown = Object.entries(exposure)
    .map(([fiat, value]) => ({
      fiat,
      value_in_target: value,
      pct: totalValue > 0 ? (value / totalValue) * 100 : 0,
    }))
    .sort((a, b) => b.value_in_target - a.value_in_target);

  return {
    target_currency: target,
    total_value: totalValue,
    wallets,
    exposure_breakdown: exposureBreakdown,
  };
}

/**
 * exposure_report — slimmer cousin of treasury_value: just the currency mix.
 * Useful pre-trade ("am I over-exposed to MYR?") without dumping every line item.
 */
export async function exposureReport(
  ctx: AppContext,
  args: { owner_addresses: string[]; target_currency?: string },
) {
  const r = await treasuryValue(ctx, { ...args, include_zero: false });
  return {
    target_currency: r.target_currency,
    total_value: r.total_value,
    exposure: r.exposure_breakdown,
  };
}

/**
 * rebalance_plan — given target weights (by fiat), current balances, and a
 * target currency for valuation, emit a list of swaps needed to rebalance.
 *
 * Pure planner — does NOT execute. Each suggested trade can be fed into get_quote.
 */
export async function rebalancePlan(
  ctx: AppContext,
  args: {
    owner_addresses: string[];
    target_weights: Record<string, number>; // fiat -> weight (any positive numbers; normalized)
    target_currency?: string;
    min_trade_value?: number; // skip trades smaller than this in target_currency
  },
) {
  const target = (args.target_currency ?? "USD").toUpperCase();
  const minTrade = args.min_trade_value ?? 10;

  const summary = await treasuryValue(ctx, {
    owner_addresses: args.owner_addresses,
    target_currency: target,
    include_zero: false,
  });

  const totalValue = summary.total_value;
  if (totalValue <= 0) {
    return {
      target_currency: target,
      total_value: 0,
      hint: "No positive-value balances found.",
      trades: [],
    };
  }

  // Normalize target weights.
  const weightSum = Object.values(args.target_weights).reduce((a, b) => a + Number(b || 0), 0);
  if (weightSum <= 0) throw new Error("target_weights must sum to >0");
  const normalized: Record<string, number> = {};
  for (const [fiat, w] of Object.entries(args.target_weights)) {
    normalized[fiat.toUpperCase()] = Number(w) / weightSum;
  }

  // Compute drift per fiat (current - target).
  const currentByFiat: Record<string, number> = {};
  for (const e of summary.exposure_breakdown) currentByFiat[e.fiat] = e.value_in_target;
  const fiats = new Set([...Object.keys(currentByFiat), ...Object.keys(normalized)]);

  const drift: Array<{ fiat: string; current: number; target: number; delta: number }> = [];
  for (const f of fiats) {
    const current = currentByFiat[f] ?? 0;
    const targetVal = (normalized[f] ?? 0) * totalValue;
    drift.push({ fiat: f, current, target: targetVal, delta: current - targetVal });
  }

  // Sources: positive delta (overweight). Sinks: negative delta (underweight).
  const sources = drift.filter((d) => d.delta > minTrade).sort((a, b) => b.delta - a.delta);
  const sinks = drift.filter((d) => d.delta < -minTrade).sort((a, b) => a.delta - b.delta);

  // Greedy match: drain biggest source into biggest sink until exhausted.
  const trades: Array<{
    from_fiat: string;
    to_fiat: string;
    value_in_target: number;
    note: string;
  }> = [];
  let i = 0, j = 0;
  while (i < sources.length && j < sinks.length) {
    const src = sources[i];
    const snk = sinks[j];
    const move = Math.min(src.delta, -snk.delta);
    if (move > minTrade) {
      trades.push({
        from_fiat: src.fiat,
        to_fiat: snk.fiat,
        value_in_target: move,
        note: `Move ${move.toFixed(2)} ${target}-equivalent from ${src.fiat} into ${snk.fiat}.`,
      });
    }
    src.delta -= move;
    snk.delta += move;
    if (src.delta <= minTrade) i++;
    if (-snk.delta <= minTrade) j++;
  }

  return {
    target_currency: target,
    total_value: totalValue,
    target_weights_normalized: normalized,
    drift,
    trades,
    next_step:
      "For each trade, pick a source token in from_fiat, sink token in to_fiat, then call sera.get_quote with the target value scaled to from-token units.",
  };
}

/**
 * pay_invoice — "I owe X of currency Y to address Z. Given my source assets,
 * what's the cheapest path?" Fans out quote_recipient_amount across each
 * candidate source and ranks by cost.
 */
export async function payInvoice(
  ctx: AppContext,
  args: {
    owner_address: string;
    recipient: string;
    amount: number;
    target_currency: string;       // 'SGD', 'MYR', etc.
    source_symbols: string[];      // ['USDC', 'USDT', 'EURC', ...]
    target_symbol?: string;        // default: pick first stablecoin matching target_currency
  },
) {
  const tokens = await getTokensCached(ctx.sera);
  const targetFiat = args.target_currency.toUpperCase();
  // Resolve target symbol (token to send).
  let targetSym = args.target_symbol;
  if (!targetSym) {
    const candidates = tokens.filter((t) => (t.fiat_currency ?? "").toUpperCase() === targetFiat);
    if (candidates.length === 0) {
      throw new Error(`No stablecoin found for fiat ${targetFiat} in token registry.`);
    }
    // Prefer policy-allowed
    const allowed = ctx.policy.config.allowedSymbols;
    targetSym =
      candidates.find((t) => allowed.includes(t.symbol.toUpperCase()))?.symbol ?? candidates[0].symbol;
  }

  const ranked: Array<{
    source_symbol: string;
    estimated_input: number | null;
    error?: string;
  }> = [];

  for (const src of args.source_symbols) {
    try {
      // Use a quote at the target output amount scaled via FX rate. Mirror logic of
      // quote_recipient_amount but inline so we can rank without execution path.
      const fromTok = await resolveToken(ctx.sera, src);
      const toTok = await resolveToken(ctx.sera, targetSym);
      const fromFiat = (fromTok.fiat_currency ?? "USD").toUpperCase();
      const toFiat = (toTok.fiat_currency ?? "USD").toUpperCase();
      let estIn = args.amount;
      if (fromFiat !== toFiat) {
        const fx = await ctx.sera.getFxRate(fromFiat, toFiat);
        const r = Number(fx.rate);
        if (Number.isFinite(r) && r > 0) estIn = args.amount / r;
      }
      estIn *= 1.005; // slight headroom
      const probe = await getQuote(ctx, {
        from: src,
        to: targetSym,
        amount: estIn,
        owner_address: args.owner_address,
        recipient: args.recipient,
        gas_mode: "pay_more",
      });
      const minOut = Number(probe.human.min_output);
      const scaled = minOut > 0 ? (estIn * args.amount) / minOut * 1.002 : estIn;
      ranked.push({ source_symbol: src, estimated_input: scaled });
    } catch (e: any) {
      ranked.push({ source_symbol: src, estimated_input: null, error: e?.message ?? String(e) });
    }
  }

  // Compare via estimated input * USD value of source. We'll use FX rate to USD for ranking.
  const enriched = await Promise.all(
    ranked.map(async (r) => {
      if (r.estimated_input == null) return { ...r, usd_cost: null };
      try {
        const tok = tokens.find((t) => t.symbol.toUpperCase() === r.source_symbol.toUpperCase());
        const fiat = (tok?.fiat_currency ?? "USD").toUpperCase();
        let toUsd = 1;
        if (fiat !== "USD") {
          const fx = await ctx.sera.getFxRate(fiat, "USD");
          const n = Number(fx.rate);
          if (Number.isFinite(n) && n > 0) toUsd = n;
        }
        return { ...r, usd_cost: r.estimated_input * toUsd };
      } catch {
        return { ...r, usd_cost: null };
      }
    }),
  );
  const sorted = enriched
    .filter((r) => r.usd_cost != null)
    .sort((a, b) => (a.usd_cost as number) - (b.usd_cost as number));

  return {
    invoice: {
      recipient: args.recipient,
      amount: args.amount,
      target_currency: targetFiat,
      target_symbol: targetSym,
    },
    ranked: sorted,
    failed: enriched.filter((r) => r.usd_cost == null),
    cheapest: sorted[0] ?? null,
  };
}

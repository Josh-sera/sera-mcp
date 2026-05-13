import type { AppContext } from "../config.js";
import { resolveToken, toRawAmount, fromRawAmount } from "../sera/tokens.js";
import { SeraApiError } from "../sera/client.js";
import { createLimit } from "../util/limit.js";

const SIMULATE_OWNER = "0x000000000000000000000000000000000000dEaD";

/**
 * market_health — answer "is this pair quotable RIGHT NOW?" without consuming
 * a quote UUID's worth of state. Fires a single $1 simulate quote and reports
 * status: quotable / no_liquidity / error / unknown_pair. Cheaper than letting
 * agents probe with full quotes when they only need a yes/no.
 */
export async function marketHealth(
  ctx: AppContext,
  args: { from: string; to: string; gas_mode?: "receive_less" | "pay_more" },
) {
  const gasMode = args.gas_mode ?? "receive_less";
  let fromTok, toTok;
  try {
    fromTok = await resolveToken(ctx.sera, args.from);
    toTok = await resolveToken(ctx.sera, args.to);
  } catch (e: any) {
    return {
      pair: `${args.from}/${args.to}`,
      status: "unknown_pair" as const,
      reason: e?.message ?? String(e),
    };
  }
  try {
    const t = await ctx.sera.getSystemTime();
    const expiration = Number(t.timestamp) + 60;
    const probeAmount = 1; // human units; smallest meaningful probe
    const rawAmount = toRawAmount(probeAmount, fromTok.decimals);
    const quote = await ctx.sera.postSwapQuote({
      from_token: fromTok.address,
      to_token: toTok.address,
      from_amount: rawAmount,
      owner_address: SIMULATE_OWNER,
      recipient: SIMULATE_OWNER,
      expiration,
      gas_mode: gasMode,
    });
    const out = Number(fromRawAmount(quote.route_params.minOutputAmount, toTok.decimals));
    return {
      pair: `${fromTok.symbol}/${toTok.symbol}`,
      status: "quotable" as const,
      probe_input: probeAmount,
      probe_output: out,
      probe_rate: out / probeAmount,
      gas_mode: gasMode,
    };
  } catch (e: any) {
    if (e instanceof SeraApiError) {
      return {
        pair: `${fromTok.symbol}/${toTok.symbol}`,
        status: e.errorCode === "no_liquidity" ? ("no_liquidity" as const) : ("error" as const),
        reason: e.errorCode ?? "error",
        upstream: e.message,
      };
    }
    return {
      pair: `${fromTok.symbol}/${toTok.symbol}`,
      status: "error" as const,
      reason: e?.message ?? String(e),
    };
  }
}

/**
 * fx_quote_diff — for a corridor, return both Sera's reference /fx/rate AND
 * the executable rate from a real quote, plus the deviation in bps. Surfaces
 * the bid/ask premium an agent would actually pay vs the displayed reference.
 *
 * Common pre-trade pattern: "is this corridor's executable rate close enough
 * to the reference that I should size a real swap?"
 */
export async function fxQuoteDiff(
  ctx: AppContext,
  args: {
    from: string;
    to: string;
    notional?: number;
    gas_mode?: "receive_less" | "pay_more";
  },
) {
  const fromTok = await resolveToken(ctx.sera, args.from);
  const toTok = await resolveToken(ctx.sera, args.to);
  const fromFiat = (fromTok.fiat_currency ?? "USD").toUpperCase();
  const toFiat = (toTok.fiat_currency ?? "USD").toUpperCase();
  const notional = args.notional ?? 100;
  const gasMode = args.gas_mode ?? "receive_less";

  // Reference rate from /fx/rate (cached).
  let referenceRate: number | null = null;
  let referenceErr: string | undefined;
  try {
    const r = await ctx.sera.getFxRate(fromFiat, toFiat);
    const n = Number(r.rate);
    if (Number.isFinite(n) && n > 0) referenceRate = n;
  } catch (e: any) {
    referenceErr = e?.message ?? String(e);
  }

  // Executable quote at notional.
  let executableRate: number | null = null;
  let executableOutput: number | null = null;
  let executableErr: string | undefined;
  try {
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
    executableOutput = Number(fromRawAmount(quote.route_params.minOutputAmount, toTok.decimals));
    executableRate = executableOutput / notional;
  } catch (e: any) {
    if (e instanceof SeraApiError) {
      executableErr = `${e.status}${e.errorCode ? ` (${e.errorCode})` : ""}: ${e.message}`;
    } else {
      executableErr = e?.message ?? String(e);
    }
  }

  let deviationBps: number | null = null;
  if (referenceRate && executableRate) {
    deviationBps = Math.round(((executableRate - referenceRate) / referenceRate) * 10_000);
  }

  return {
    pair: `${fromTok.symbol}/${toTok.symbol}`,
    fiat_pair: `${fromFiat}/${toFiat}`,
    notional,
    reference_rate: referenceRate,
    reference_error: referenceErr,
    executable_rate: executableRate,
    executable_output: executableOutput,
    executable_error: executableErr,
    deviation_bps: deviationBps,
    gas_mode: gasMode,
    interpretation:
      deviationBps == null
        ? "Could not compute deviation — see errors."
        : deviationBps < 0
        ? `Executable rate is ${Math.abs(deviationBps)}bps WORSE than reference. Typical bid/ask drag.`
        : deviationBps > 0
        ? `Executable rate is ${deviationBps}bps BETTER than reference — investigate before sizing.`
        : "Executable rate matches reference.",
  };
}

/**
 * compare_corridors — given a target output (currency + amount), rank possible
 * source currencies by USD-equivalent cost. Different from pay_invoice in that
 * it doesn't require a recipient — purely "what's the cheapest source currency
 * to deliver X target?" Useful for treasury planning.
 */
export async function compareCorridors(
  ctx: AppContext,
  args: {
    target: string;          // ISO fiat or token symbol
    target_amount: number;
    sources: string[];       // candidate token symbols
    max_concurrency?: number;
    gas_mode?: "receive_less" | "pay_more";
  },
) {
  const targetTok = await resolveToken(ctx.sera, args.target);
  const targetFiat = (targetTok.fiat_currency ?? "USD").toUpperCase();
  const gasMode = args.gas_mode ?? "pay_more"; // default pay_more — caller wants exact target out

  const limit = createLimit(Math.max(1, Math.min(args.max_concurrency ?? 5, 10)));

  const results = await Promise.all(
    args.sources.map((src) =>
      limit(async () => {
        try {
          const fromTok = await resolveToken(ctx.sera, src);
          const fromFiat = (fromTok.fiat_currency ?? "USD").toUpperCase();

          // Estimate input via /fx/rate.
          let estIn = args.target_amount;
          if (fromFiat !== targetFiat) {
            try {
              const r = await ctx.sera.getFxRate(fromFiat, targetFiat);
              const rate = Number(r.rate);
              if (Number.isFinite(rate) && rate > 0) estIn = args.target_amount / rate;
            } catch {
              // proceed with target_amount as a placeholder; the quote will tell us reality
            }
          }
          estIn *= 1.005; // headroom

          const t = await ctx.sera.getSystemTime();
          const expiration = Number(t.timestamp) + 60;
          const rawAmount = toRawAmount(estIn, fromTok.decimals);
          const quote = await ctx.sera.postSwapQuote({
            from_token: fromTok.address,
            to_token: targetTok.address,
            from_amount: rawAmount,
            owner_address: SIMULATE_OWNER,
            recipient: SIMULATE_OWNER,
            expiration,
            gas_mode: gasMode,
          });
          const minOut = Number(
            fromRawAmount(quote.route_params.minOutputAmount, targetTok.decimals),
          );
          if (minOut <= 0) {
            return {
              source: src,
              status: "error" as const,
              reason: "min_output_zero",
            };
          }
          // Scale to deliver exactly target_amount.
          const requiredIn = (estIn * args.target_amount) / minOut;

          // Convert requiredIn to USD-equivalent for ranking.
          let usdCost: number | null = null;
          if (fromFiat === "USD") usdCost = requiredIn;
          else {
            try {
              const fx = await ctx.sera.getFxRate(fromFiat, "USD");
              const n = Number(fx.rate);
              if (Number.isFinite(n) && n > 0) usdCost = requiredIn * n;
            } catch {}
          }

          return {
            source: src,
            source_fiat: fromFiat,
            status: "ok" as const,
            estimated_input: requiredIn,
            usd_cost: usdCost,
          };
        } catch (e: any) {
          const code = e instanceof SeraApiError ? (e.errorCode ?? "error") : "error";
          return {
            source: src,
            status: "error" as const,
            reason: code,
            error: e?.message ?? String(e),
          };
        }
      }),
    ),
  );

  const ok = results.filter((r) => r.status === "ok") as Array<any>;
  const errors = results.filter((r) => r.status === "error");
  ok.sort((a, b) => {
    const au = typeof a.usd_cost === "number" ? a.usd_cost : Number.POSITIVE_INFINITY;
    const bu = typeof b.usd_cost === "number" ? b.usd_cost : Number.POSITIVE_INFINITY;
    return au - bu;
  });

  return {
    target: { symbol: targetTok.symbol, fiat: targetFiat, amount: args.target_amount },
    gas_mode: gasMode,
    ranked: ok,
    failed: errors,
    cheapest: ok[0] ?? null,
    summary: {
      sources_tried: args.sources.length,
      ok_count: ok.length,
      error_count: errors.length,
    },
  };
}

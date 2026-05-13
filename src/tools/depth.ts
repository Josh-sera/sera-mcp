import type { AppContext } from "../config.js";
import { resolveToken, toRawAmount, fromRawAmount } from "../sera/tokens.js";
import { SeraApiError } from "../sera/client.js";
import { createLimit } from "../util/limit.js";

const SIMULATE_OWNER = "0x000000000000000000000000000000000000dEaD";

/**
 * probe_depth — quote a corridor at a ladder of sizes to characterize price impact.
 * Use the returned slope to make sizing decisions ("I can do 10k at -8bps but 100k
 * crosses -45bps") without trial-and-error swap calls.
 */
export async function probeDepth(
  ctx: AppContext,
  args: {
    from: string;
    to: string;
    sizes?: number[];        // human amounts
    gas_mode?: "receive_less" | "pay_more";
    max_concurrency?: number;
  },
) {
  const fromTok = await resolveToken(ctx.sera, args.from);
  const toTok = await resolveToken(ctx.sera, args.to);
  const sizes = (args.sizes && args.sizes.length > 0 ? args.sizes : [100, 1_000, 10_000, 100_000])
    .filter((s) => Number.isFinite(s) && s > 0)
    .sort((a, b) => a - b);
  const gasMode = args.gas_mode ?? "receive_less";
  const limit = createLimit(Math.max(1, Math.min(args.max_concurrency ?? 4, 10)));

  const results = await Promise.all(
    sizes.map((size) =>
      limit(async () => {
        try {
          const t = await ctx.sera.getSystemTime();
          const expiration = Number(t.timestamp) + 60;
          const rawAmount = toRawAmount(size, fromTok.decimals);
          const quote = await ctx.sera.postSwapQuote({
            from_token: fromTok.address,
            to_token: toTok.address,
            from_amount: rawAmount,
            owner_address: SIMULATE_OWNER,
            recipient: SIMULATE_OWNER,
            expiration,
            gas_mode: gasMode,
          });
          const outputHuman = Number(fromRawAmount(quote.route_params.minOutputAmount, toTok.decimals));
          return { size, status: "ok" as const, output: outputHuman, rate: outputHuman / size };
        } catch (e: any) {
          const code = e instanceof SeraApiError ? (e.errorCode ?? "error") : "error";
          return { size, status: "error" as const, reason: code, error: e?.message ?? String(e) };
        }
      }),
    ),
  );

  const successful = results.filter((r) => r.status === "ok") as Array<{
    size: number;
    rate: number;
  }>;

  // Reference rate = the smallest successful probe (mid-ish). Compute price impact bps
  // for each subsequent size relative to the smallest.
  let priceImpact: Array<{ size: number; impact_bps: number }> = [];
  if (successful.length >= 1) {
    const ref = successful[0].rate;
    priceImpact = successful.map((r) => ({
      size: r.size,
      impact_bps: Math.round(((r.rate - ref) / ref) * 10_000),
    }));
  }

  return {
    pair: `${fromTok.symbol}/${toTok.symbol}`,
    gas_mode: gasMode,
    quotes: results,
    price_impact: priceImpact,
    notes: priceImpact.length
      ? `Reference rate from smallest probe (${successful[0].size}). Negative impact_bps = worse rate at that size.`
      : "No size returned a quote — corridor is dry.",
  };
}

/**
 * round_trip_cost — what does it cost to swap A->B and back B->A? This is the
 * cost of holding inventory for a maker. Spread floor for any market-making bot.
 */
export async function roundTripCost(
  ctx: AppContext,
  args: {
    from: string;
    to: string;
    amount: number;
    gas_mode?: "receive_less" | "pay_more";
  },
) {
  const fromTok = await resolveToken(ctx.sera, args.from);
  const toTok = await resolveToken(ctx.sera, args.to);
  const gasMode = args.gas_mode ?? "receive_less";

  const t = await ctx.sera.getSystemTime();
  const exp = () => Number(t.timestamp) + 60;

  // Outbound: from -> to.
  const outQuote = await safeQuote(ctx, fromTok, toTok, args.amount, exp(), gasMode);
  if (outQuote.error) {
    return { pair: `${fromTok.symbol}/${toTok.symbol}`, error: outQuote.error };
  }
  const outHuman = Number(fromRawAmount(outQuote.value!.route_params.minOutputAmount, toTok.decimals));

  // Return: to -> from at the output amount we just got.
  const backQuote = await safeQuote(ctx, toTok, fromTok, outHuman, exp(), gasMode);
  if (backQuote.error) {
    return {
      pair: `${fromTok.symbol}/${toTok.symbol}`,
      outbound: { amount: args.amount, output: outHuman },
      return_error: backQuote.error,
    };
  }
  const recoveredHuman = Number(fromRawAmount(backQuote.value!.route_params.minOutputAmount, fromTok.decimals));

  const lossAbsolute = args.amount - recoveredHuman;
  const lossBps = args.amount > 0 ? Math.round((lossAbsolute / args.amount) * 10_000) : 0;

  return {
    pair: `${fromTok.symbol}/${toTok.symbol}`,
    gas_mode: gasMode,
    outbound: { input: args.amount, output: outHuman },
    return: { input: outHuman, output: recoveredHuman },
    round_trip_loss_human: lossAbsolute,
    round_trip_loss_bps: lossBps,
    interpretation:
      lossBps > 0
        ? `A maker quoting this pair needs at least ~${lossBps}bps spread to break even on inventory hedge.`
        : "Round-trip is positive — likely an arbitrage hint, but verify against fresh quotes before sizing.",
  };
}

/**
 * infer_book — Sera doesn't expose an order book. Probe quotes at log-spaced sizes
 * in BOTH directions to construct a synthetic ladder. Lets agents see "where the
 * book is" without needing the protocol to publish it.
 */
export async function inferBook(
  ctx: AppContext,
  args: {
    base: string;
    quote: string;
    sizes?: number[];
    gas_mode?: "receive_less" | "pay_more";
  },
) {
  const baseTok = await resolveToken(ctx.sera, args.base);
  const quoteTok = await resolveToken(ctx.sera, args.quote);
  const sizes = (args.sizes && args.sizes.length > 0
    ? args.sizes
    : [100, 1_000, 10_000, 100_000, 1_000_000]).sort((a, b) => a - b);

  // Bid side: someone selling base for quote. Probe base -> quote at increasing base sizes.
  // Ask side: someone selling quote for base. Probe quote -> base at increasing quote sizes.
  const [bids, asks] = await Promise.all([
    probeDepth(ctx, { from: args.base, to: args.quote, sizes, gas_mode: args.gas_mode }),
    probeDepth(ctx, { from: args.quote, to: args.base, sizes, gas_mode: args.gas_mode }),
  ]);

  const bidLadder = (bids.quotes as any[])
    .filter((q) => q.status === "ok")
    .map((q) => ({ size_base: q.size, price: q.rate, output_quote: q.output }));
  const askLadder = (asks.quotes as any[])
    .filter((q) => q.status === "ok")
    .map((q) => {
      // ask price = quote_in / base_out. price expressed as "1 base = X quote".
      const baseOut = q.output;
      const askPrice = q.size / baseOut;
      return { size_quote: q.size, price: askPrice, base_out: baseOut };
    });

  const bestBid = bidLadder[0]?.price;
  const bestAsk = askLadder[0]?.price;
  let spreadBps: number | null = null;
  if (bestBid && bestAsk && bestBid > 0) {
    const mid = (bestBid + bestAsk) / 2;
    spreadBps = Math.round(((bestAsk - bestBid) / mid) * 10_000);
  }

  return {
    pair: `${baseTok.symbol}/${quoteTok.symbol}`,
    best_bid: bestBid ?? null,
    best_ask: bestAsk ?? null,
    spread_bps: spreadBps,
    bids: bidLadder,
    asks: askLadder,
    notes:
      "Synthetic book inferred from quote probes. Each row consumed a quote UUID — " +
      "do not execute against these prices directly; re-quote for live execution.",
  };
}

async function safeQuote(
  ctx: AppContext,
  fromTok: { address: string; decimals: number; symbol: string },
  toTok: { address: string; decimals: number; symbol: string },
  amount: number,
  expiration: number,
  gasMode: "receive_less" | "pay_more",
): Promise<{ value?: { route_params: { minOutputAmount: string; maxInputAmount: string } }; error?: string }> {
  try {
    const raw = toRawAmount(amount, fromTok.decimals);
    const q = await ctx.sera.postSwapQuote({
      from_token: fromTok.address,
      to_token: toTok.address,
      from_amount: raw,
      owner_address: SIMULATE_OWNER,
      recipient: SIMULATE_OWNER,
      expiration,
      gas_mode: gasMode,
    });
    return { value: q as any };
  } catch (e: any) {
    if (e instanceof SeraApiError) {
      return { error: `${e.status}${e.errorCode ? ` (${e.errorCode})` : ""}: ${e.message}` };
    }
    return { error: e?.message ?? String(e) };
  }
}

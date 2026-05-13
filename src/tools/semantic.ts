import type { AppContext } from "../config.js";
import { getQuote, executeSwap } from "./core.js";
import { resolveToken, fromRawAmount } from "../sera/tokens.js";

/**
 * convert_and_send — quote + execute in one call. Only succeeds when the
 * server is in 'local' signer mode (otherwise execution requires a wallet sig).
 */
export async function convertAndSend(
  ctx: AppContext,
  args: {
    from: string;
    to: string;
    amount: string | number;
    owner_address: string;
    recipient: string;
    gas_mode: "receive_less" | "pay_more";
  },
) {
  if (ctx.signer.mode !== "local") {
    throw new Error(
      "convert_and_send requires SERA_SIGNER_MODE=local. " +
        "Otherwise use get_quote → sign route_params externally → execute_swap.",
    );
  }
  const quote = await getQuote(ctx, { ...args, recipient: args.recipient });
  const exec = await executeSwap(ctx, { uuid: quote.uuid, route_params: quote.route_params });
  return { quote, execution: exec };
}

/**
 * quote_recipient_amount — "the recipient wants X of currency C; how much of
 * my source currency do I need to send?" Strategy: probe with /fx/rate to
 * size an input estimate, get a real quote, then iterate once to tighten.
 */
export async function quoteRecipientAmount(
  ctx: AppContext,
  args: {
    from: string;
    to: string;
    recipient_amount: string | number;
    owner_address: string;
    recipient?: string;
  },
) {
  const fromTok = await resolveToken(ctx.sera, args.from);
  const toTok = await resolveToken(ctx.sera, args.to);
  const targetOut = Number(args.recipient_amount);
  if (!Number.isFinite(targetOut) || targetOut <= 0) {
    throw new Error(`invalid recipient_amount: ${args.recipient_amount}`);
  }

  // Step 1: estimate input via FX rate (from -> to fiat).
  const baseFiat = fromTok.fiat_currency ?? "USD";
  const quoteFiat = toTok.fiat_currency ?? "USD";
  let rateFromTo = 1;
  if (baseFiat !== quoteFiat) {
    try {
      const r = await ctx.sera.getFxRate(baseFiat, quoteFiat);
      const n = Number(r.rate);
      if (Number.isFinite(n) && n > 0) rateFromTo = n;
    } catch {
      // Fall through with rateFromTo=1 and let the quote correct it.
    }
  }
  let estIn = targetOut / rateFromTo;
  estIn *= 1.005; // small headroom for fees/slippage

  // Step 2: get a real quote at that input.
  const quote = await getQuote(ctx, {
    from: args.from,
    to: args.to,
    amount: estIn,
    owner_address: args.owner_address,
    recipient: args.recipient ?? args.owner_address,
    gas_mode: "pay_more", // user is asking "what will it cost me to deliver X"
  });

  const minOutHuman = Number(
    fromRawAmount(quote.route_params.minOutputAmount, toTok.decimals),
  );

  // Step 3: scale input so min_output meets the target.
  let scaled = estIn;
  if (minOutHuman > 0) {
    scaled = (estIn * targetOut) / minOutHuman;
    scaled *= 1.002; // tiny buffer
  }

  // Step 4: re-quote at scaled input.
  const tightened = await getQuote(ctx, {
    from: args.from,
    to: args.to,
    amount: scaled,
    owner_address: args.owner_address,
    recipient: args.recipient ?? args.owner_address,
    gas_mode: "pay_more",
  });

  return {
    estimated_input_human: scaled,
    quote: tightened,
    target_recipient_amount: targetOut,
  };
}

/**
 * find_cheapest_settlement_path — compare gas modes and (where possible) two
 * intermediate routings to help an agent pick the most efficient path before
 * committing to a signature.
 */
export async function findCheapestPath(
  ctx: AppContext,
  args: { from: string; to: string; amount: string | number; owner_address: string },
) {
  const candidates: Array<{ label: string; gas_mode: "receive_less" | "pay_more" }> = [
    { label: "direct/receive_less", gas_mode: "receive_less" },
    { label: "direct/pay_more", gas_mode: "pay_more" },
  ];

  const results = await Promise.allSettled(
    candidates.map((c) =>
      getQuote(ctx, {
        from: args.from,
        to: args.to,
        amount: args.amount,
        owner_address: args.owner_address,
        gas_mode: c.gas_mode,
      }).then((q) => ({ label: c.label, quote: q })),
    ),
  );

  const ranked = results
    .map((r, i) => {
      if (r.status !== "fulfilled") {
        return { label: candidates[i].label, error: (r.reason as Error).message };
      }
      const q = r.value.quote;
      return {
        label: r.value.label,
        uuid: q.uuid,
        input: q.human.input,
        min_output: q.human.min_output,
        fee_breakdown: q.fee_breakdown,
      };
    })
    // sort fulfilled by highest min_output ascending = best first; errors last.
    .sort((a: any, b: any) => {
      const am = a.min_output ? Number(a.min_output) : -Infinity;
      const bm = b.min_output ? Number(b.min_output) : -Infinity;
      return bm - am;
    });

  return { ranked };
}

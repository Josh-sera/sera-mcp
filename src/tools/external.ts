import type { AppContext } from "../config.js";
import { getFrankfurterRate } from "../util/external_fx.js";
import { resolveToken } from "../sera/tokens.js";

/**
 * compare_to_external_fx — fetch a neutral external FX mid (Frankfurter / ECB)
 * and diff against Sera's /fx/rate. Surfaces the systematic bias I observed
 * (Sera mid runs ~150-300bps below external mid for several pairs).
 *
 * Inputs accept either fiat ISO codes ('USD', 'SGD') OR token symbols
 * ('USDC', 'XSGD') — symbols are resolved to their fiat tag.
 */
export async function compareToExternalFx(
  ctx: AppContext,
  args: { base: string; quote: string },
) {
  // Resolve to a fiat code if a token symbol was passed.
  const baseFiat = await toFiat(ctx, args.base);
  const quoteFiat = await toFiat(ctx, args.quote);

  const [seraR, extR] = await Promise.all([
    safe(() => ctx.sera.getFxRate(baseFiat, quoteFiat).then((r) => Number(r.rate))),
    safe(() => getFrankfurterRate(baseFiat, quoteFiat).then((r) => r.rate)),
  ]);

  const sera = seraR.value;
  const external = extR.value;
  const externalDate = (await safe(() => getFrankfurterRate(baseFiat, quoteFiat))).value?.as_of;

  let deviationBps: number | null = null;
  let direction: "sera_above" | "sera_below" | "inline" | null = null;
  if (typeof sera === "number" && typeof external === "number" && external > 0) {
    const dev = (sera - external) / external;
    deviationBps = Math.round(dev * 10_000);
    direction = Math.abs(deviationBps) < 5 ? "inline" : deviationBps > 0 ? "sera_above" : "sera_below";
  }

  return {
    pair: `${baseFiat}/${quoteFiat}`,
    sera_rate: sera ?? null,
    sera_error: seraR.error,
    external: external == null ? null : {
      source: "frankfurter",
      rate: external,
      as_of: externalDate,
    },
    external_error: extR.error,
    deviation_bps: deviationBps,
    direction,
    note:
      "Frankfurter publishes ECB reference rates daily (16:00 CET) — not real-time. " +
      "Use this for bias detection across many pairs, not for execution decisions.",
  };
}

async function toFiat(ctx: AppContext, ref: string): Promise<string> {
  const upper = ref.trim().toUpperCase();
  // 3-letter ISO -> assume already a fiat code.
  if (/^[A-Z]{3}$/.test(upper)) return upper;
  const tok = await resolveToken(ctx.sera, ref);
  return (tok.fiat_currency ?? "USD").toUpperCase();
}

async function safe<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: string }> {
  try {
    return { value: await fn() };
  } catch (e: any) {
    return { error: e?.message ?? String(e) };
  }
}

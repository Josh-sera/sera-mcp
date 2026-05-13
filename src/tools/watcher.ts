import type { AppContext } from "../config.js";
import { resolveToken, toRawAmount, fromRawAmount } from "../sera/tokens.js";
import { SeraApiError } from "../sera/client.js";

const SIMULATE_OWNER = "0x000000000000000000000000000000000000dEaD";

/**
 * limit_watcher — patient quote. Sera doesn't offer native limit orders, so we
 * poll /swap/quote on a fixed budget. The watcher returns either:
 *
 *   { hit: true,  quote: ... }     — target met within budget; caller can re-quote with their wallet to execute
 *   { hit: false, last_rate: ... } — budget exhausted; agent decides whether to extend
 *
 * Side: 'sell_from' (rate >= target) or 'buy_from' (rate <= target). Picked
 * based on whether the user wants the rate to rise or fall before they trade.
 *
 * Budget caveats: this BLOCKS the MCP call. Defaults are conservative
 * (5 attempts × 6s = ~30s). For longer watches, run multiple sequential calls
 * or wait for v0.4 subscriptions.
 */
export async function limitWatcher(
  ctx: AppContext,
  args: {
    from: string;
    to: string;
    amount: number;
    target_rate: number;
    side: "sell_from" | "buy_from";
    max_attempts?: number;     // default 5
    interval_seconds?: number; // default 6
    gas_mode?: "receive_less" | "pay_more";
  },
) {
  const fromTok = await resolveToken(ctx.sera, args.from);
  const toTok = await resolveToken(ctx.sera, args.to);
  const maxAttempts = Math.max(1, Math.min(args.max_attempts ?? 5, 30));
  const interval = Math.max(1, Math.min(args.interval_seconds ?? 6, 60));
  const gasMode = args.gas_mode ?? "receive_less";

  const probes: Array<{
    attempt: number;
    ts: number;
    rate?: number;
    output?: number;
    error?: string;
  }> = [];
  let hit = false;
  let lastRate: number | undefined;
  let hittingProbeIndex: number | null = null;

  for (let i = 0; i < maxAttempts; i++) {
    const attempt = i + 1;
    const ts = Math.floor(Date.now() / 1000);
    try {
      const t = await ctx.sera.getSystemTime();
      const expiration = Number(t.timestamp) + 60;
      const rawAmount = toRawAmount(args.amount, fromTok.decimals);
      const quote = await ctx.sera.postSwapQuote({
        from_token: fromTok.address,
        to_token: toTok.address,
        from_amount: rawAmount,
        owner_address: SIMULATE_OWNER,
        recipient: SIMULATE_OWNER,
        expiration,
        gas_mode: gasMode,
      });
      const output = Number(fromRawAmount(quote.route_params.minOutputAmount, toTok.decimals));
      const rate = output / args.amount;
      lastRate = rate;
      probes.push({ attempt, ts, rate, output });
      if (
        (args.side === "sell_from" && rate >= args.target_rate) ||
        (args.side === "buy_from" && rate <= args.target_rate)
      ) {
        hit = true;
        hittingProbeIndex = probes.length - 1;
        break;
      }
    } catch (e: any) {
      const code = e instanceof SeraApiError ? (e.errorCode ?? "error") : "error";
      probes.push({ attempt, ts, error: code });
    }
    if (i < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, interval * 1000));
    }
  }

  return {
    pair: `${fromTok.symbol}/${toTok.symbol}`,
    side: args.side,
    target_rate: args.target_rate,
    amount: args.amount,
    attempts: probes.length,
    interval_seconds: interval,
    hit,
    last_rate: lastRate ?? null,
    hit_probe: hittingProbeIndex != null ? probes[hittingProbeIndex] : null,
    probes,
    next_step: hit
      ? "Target met. Re-quote with your wallet's owner_address (no simulate flag) and execute_swap promptly — these probes used the burn address, the live quote UUID will be different."
      : "Budget exhausted. Extend by calling limit_watcher again, or set a tighter target_rate.",
  };
}

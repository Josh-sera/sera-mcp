import type { AppContext } from "../config.js";
import type { SwapQuoteRequest } from "../sera/types.js";
import { getTokensCached, resolveToken, toRawAmount, fromRawAmount } from "../sera/tokens.js";
import { SeraApiError } from "../sera/client.js";
import { recordQuote } from "../util/persistence.js";
import { registerQuote, lookupQuote, routeParamsMatch } from "../util/quote_registry.js";

// ---- list_currencies ----
export async function listCurrencies(ctx: AppContext, args: { fiat?: string }) {
  const tokens = await getTokensCached(ctx.sera);
  const filtered = args.fiat
    ? tokens.filter((t) => (t.fiat_currency ?? "").toUpperCase() === args.fiat!.toUpperCase())
    : tokens;
  const allowed = ctx.policy.config.allowedSymbols;
  return {
    count: filtered.length,
    policy_allowed_symbols: allowed.length ? allowed : "all",
    tokens: filtered.map((t) => ({
      symbol: t.symbol,
      fiat_currency: t.fiat_currency,
      address: t.address,
      decimals: t.decimals,
      policy_allowed:
        allowed.length === 0 || allowed.includes(t.symbol.toUpperCase()),
    })),
  };
}

// ---- get_markets ----
export async function getMarkets(ctx: AppContext) {
  const { markets } = await ctx.sera.getMarkets();
  return { count: markets.length, markets };
}

// ---- get_fx_rate ----
export async function getFxRate(
  ctx: AppContext,
  args: { base: string; quote: string },
) {
  return ctx.sera.getFxRate(args.base.toUpperCase(), args.quote.toUpperCase());
}

// ---- get_balances ----
export async function getBalances(ctx: AppContext, args: { owner_address: string }) {
  const r = await ctx.sera.getBalances(args.owner_address);
  return {
    owner_address: args.owner_address,
    balances: r.balances.map((b) => ({
      symbol: b.symbol,
      wallet: fromRawAmount(b.wallet_balance, b.decimals),
      vault_available: fromRawAmount(b.vault_available, b.decimals),
      vault_frozen: fromRawAmount(b.vault_frozen, b.decimals),
      raw: b,
    })),
  };
}

// ---- get_quote ----
export interface QuoteArgs {
  from: string;
  to: string;
  amount: string | number;
  owner_address?: string;
  recipient?: string;
  gas_mode: "receive_less" | "pay_more";
  expiration_seconds?: number;
  simulate?: boolean;
}

const SIMULATE_OWNER = "0x000000000000000000000000000000000000dEaD";

export async function getQuote(ctx: AppContext, args: QuoteArgs) {
  const fromTok = await resolveToken(ctx.sera, args.from, ["USDC", "XSGD", "MYRT"]);
  const toTok = await resolveToken(ctx.sera, args.to, ["USDC", "XSGD", "MYRT"]);

  // simulate=true uses a stable burn address so agents can probe without owning a wallet.
  // Anything that can return route_params can reach this — execution path is separately
  // gated, so this is read-side only.
  const ownerAddress =
    args.simulate ? SIMULATE_OWNER : (args.owner_address ?? SIMULATE_OWNER);
  if (!args.simulate && !args.owner_address) {
    // Surfaced as a gentle error rather than silently substituting — keeps execution-track
    // semantics explicit while still allowing simulate=true to skip the check.
    throw new Error("owner_address is required for non-simulated quotes; pass simulate=true to probe with the burn address.");
  }

  // Policy gates
  const s1 = ctx.policy.checkSymbol(fromTok);
  if (!s1.ok) throw new Error(`policy: ${s1.reason}`);
  const s2 = ctx.policy.checkSymbol(toTok);
  if (!s2.ok) throw new Error(`policy: ${s2.reason}`);

  const recipient = args.recipient ?? ownerAddress;
  const rec = ctx.policy.checkRecipient(recipient);
  if (!rec.ok) throw new Error(`policy: ${rec.reason}`);

  const humanAmount = Number(args.amount);
  if (!Number.isFinite(humanAmount) || humanAmount <= 0)
    throw new Error(`invalid amount: ${args.amount}`);
  const not = await ctx.policy.checkNotional(fromTok, humanAmount);
  if (!not.ok) throw new Error(`policy: ${not.reason}`);

  // Build /swap/quote request
  const rawAmount = toRawAmount(args.amount, fromTok.decimals);
  // Anchor expiration to server clock to avoid skew rejection.
  let now: number;
  try {
    const t = await ctx.sera.getSystemTime();
    now = Number(t.timestamp);
  } catch {
    now = Math.floor(Date.now() / 1000);
  }
  // Bound the requested TTL to [30, POLICY_MAX_EXPIRATION_SECONDS]. Stops a
  // caller from getting an executable intent with an extended signing window.
  const requestedTtl = args.expiration_seconds ?? ctx.policy.config.defaultExpirationSeconds;
  const ttl = Math.min(Math.max(30, requestedTtl), ctx.policy.config.maxExpirationSeconds);
  const expiration = now + ttl;

  const body: SwapQuoteRequest = {
    from_token: fromTok.address,
    to_token: toTok.address,
    from_amount: rawAmount,
    owner_address: ownerAddress,
    recipient,
    expiration,
    gas_mode: args.gas_mode,
  };

  try {
    const quote = await ctx.sera.postSwapQuote(body);

    // outputToleranceBps LOWERS the signed minOutputAmount below Sera's quoted
    // minimum. Default 0 — only loosens when an operator explicitly opts in.
    // Capped at 500bps (5%) at config-load time. Both upstream and adjusted
    // values are returned so callers can see the difference.
    const upstreamMinOutputRaw: string = quote.route_params?.minOutputAmount ?? "0";
    let route_params = quote.route_params;
    if (ctx.policy.config.outputToleranceBps > 0 && route_params?.minOutputAmount) {
      const min = BigInt(route_params.minOutputAmount);
      const adjusted = (min * BigInt(10_000 - ctx.policy.config.outputToleranceBps)) / 10_000n;
      route_params = { ...route_params, minOutputAmount: adjusted.toString() };
    }

    const inputHuman = fromRawAmount(route_params.maxInputAmount, fromTok.decimals);
    const minOutHuman = fromRawAmount(route_params.minOutputAmount, toTok.decimals);
    const upstreamMinOutHuman = fromRawAmount(upstreamMinOutputRaw, toTok.decimals);

    // Persist for fx_history / volatility / corridor_pnl tools.
    recordQuote({
      from_symbol: fromTok.symbol,
      to_symbol: toTok.symbol,
      from_amount_human: Number(inputHuman),
      min_output_human: Number(minOutHuman),
      gas_mode: args.gas_mode,
      owner_address: args.simulate ? undefined : args.owner_address,
    });

    // Compute USD notional now (we have the input token + amount handy) and register
    // the quote for execute_swap to verify against. Both bind execute_swap to a quote
    // we actually issued and let us enforce the daily volume cap server-side.
    const inputUsdNotional = await tryComputeUsdNotional(ctx, fromTok, Number(inputHuman));
    if (!args.simulate && quote.uuid) {
      registerQuote(quote.uuid, route_params as Record<string, any>, expiration, inputUsdNotional ?? undefined);
    }

    return {
      uuid: quote.uuid,
      route_params,
      fee_breakdown: quote.fee_breakdown,
      expires_at: quote.expires_at,
      from: { symbol: fromTok.symbol, address: fromTok.address, decimals: fromTok.decimals },
      to: { symbol: toTok.symbol, address: toTok.address, decimals: toTok.decimals },
      human: {
        input: inputHuman,
        min_output: minOutHuman,
        upstream_min_output: upstreamMinOutHuman,
        output_tolerance_bps: ctx.policy.config.outputToleranceBps,
      },
      effective_expiration_seconds: ttl,
      simulated: !!args.simulate,
      estimated_usd_notional: inputUsdNotional,
      raw_response: quote,
    };
  } catch (err) {
    if (err instanceof SeraApiError) {
      throw new Error(`sera ${err.status}${err.errorCode ? ` (${err.errorCode})` : ""}: ${err.message}`);
    }
    throw err;
  }
}

// ---- prepare_swap (alias of get_quote — kept distinct for clarity in agent prompts) ----
export const prepareSwap = getQuote;

// ---- execute_swap ----
export async function executeSwap(
  ctx: AppContext,
  args: { uuid: string; signature?: string; route_params?: Record<string, any> },
) {
  // Hard refusal: dry-run mode always wins.
  const dr = ctx.policy.checkDryRun();
  if (!dr.ok) throw new Error(`policy: ${dr.reason}`);
  if (ctx.signer.mode === "readonly") {
    throw new Error("Signer is in 'readonly' mode. Execution disabled.");
  }

  // ---- Resolve canonical route_params (uuid binding) ----
  // We trust either:
  //   - the registry entry from a get_quote we issued, OR
  //   - the caller's route_params IFF they match what we registered.
  // In external mode, an unknown uuid is allowed to pass through (the user may
  // have quoted via another client); the upstream signature is the security
  // boundary there. In local mode, an unknown uuid is REFUSED — we won't
  // EIP-712-sign route_params we never saw.
  const registered = lookupQuote(args.uuid);
  let canonical: Record<string, any> | undefined;
  if (registered) {
    if (args.route_params) {
      const m = routeParamsMatch(registered.route_params, args.route_params);
      if (!m.ok) {
        throw new Error(
          `route_params mismatch for uuid ${args.uuid}: field "${m.field}" registered=${m.registered} candidate=${m.candidate}. ` +
            "Refusing — re-quote and submit unmodified route_params.",
        );
      }
    }
    canonical = registered.route_params;
  } else if (ctx.signer.mode === "local") {
    throw new Error(
      `local signer refusing uuid ${args.uuid}: not found in this server's quote registry (expired, never issued by this MCP, or restarted). ` +
        "Re-quote via sera.get_quote on this server before executing.",
    );
  } else {
    canonical = args.route_params;
  }

  // ---- Daily volume gate (server-derived USD, not caller-supplied) ----
  let usdNotional = registered?.estimated_usd_notional ?? null;
  if (usdNotional == null && canonical) {
    usdNotional = await usdFromRouteParams(ctx, canonical);
  }
  if (ctx.policy.config.dailyVolumeCapUsd > 0) {
    if (usdNotional == null) {
      throw new Error(
        "policy: daily volume cap is enabled but server cannot derive USD notional for this swap (uuid not in registry and route_params missing/unknown token). Re-quote via this MCP first.",
      );
    }
    const dv = ctx.policy.checkDailyVolume(usdNotional);
    if (!dv.ok) throw new Error(`policy: ${dv.reason}`);
  }

  // ---- Sign + submit ----
  let signature = args.signature;
  if (!signature) {
    if (ctx.signer.mode !== "local") {
      throw new Error(
        "No signature provided. Sign route_params via EIP-712 in your wallet and resubmit, " +
          "or set SERA_SIGNER_MODE=local on the server.",
      );
    }
    if (!canonical) {
      throw new Error("In 'local' signer mode the canonical route_params could not be resolved.");
    }
    const cfg = await ctx.sera.getConfig();
    const domain = {
      name: "Sera",
      version: "1",
      chainId: cfg.chain_id,
      verifyingContract: cfg.sera_address,
    };
    const signed = await ctx.signer.signIntent(canonical as any, domain);
    signature = signed.signature;
  }

  try {
    const res = await ctx.sera.postSwap({ uuid: args.uuid, signature });
    if (res.success && usdNotional && usdNotional > 0) {
      ctx.policy.recordExecutedNotional(usdNotional);
    }
    return { ...res, server_estimated_usd_notional: usdNotional };
  } catch (err) {
    if (err instanceof SeraApiError) {
      throw new Error(
        `sera ${err.status}${err.errorCode ? ` (${err.errorCode})` : ""}: ${err.message}`,
      );
    }
    throw err;
  }
}

// ---- Internal: USD notional helpers ----

async function tryComputeUsdNotional(
  ctx: AppContext,
  inputToken: { decimals: number; fiat_currency?: string; symbol: string },
  humanInput: number,
): Promise<number | null> {
  if (!Number.isFinite(humanInput) || humanInput <= 0) return null;
  const fiat = (inputToken.fiat_currency ?? "USD").toUpperCase();
  if (fiat === "USD") return humanInput;
  try {
    const r = await ctx.sera.getFxRate(fiat, "USD");
    const n = Number(r.rate);
    if (Number.isFinite(n) && n > 0) return humanInput * n;
  } catch {
    // fall through
  }
  return null;
}

/**
 * Server-derived USD notional from a SeraIntent. Used at execute time when the
 * registry entry doesn't already carry one (e.g. external-signer agents that
 * quoted off-server and submitted route_params here).
 */
async function usdFromRouteParams(
  ctx: AppContext,
  route_params: Record<string, any>,
): Promise<number | null> {
  try {
    const inputAddr = String(route_params.inputToken ?? "").toLowerCase();
    if (!/^0x[0-9a-fA-F]{40}$/.test(inputAddr)) return null;
    const tokens = await getTokensCached(ctx.sera);
    const tok = tokens.find((t) => t.address.toLowerCase() === inputAddr);
    if (!tok) return null;
    const raw = String(route_params.maxInputAmount ?? "");
    if (!/^\d+$/.test(raw)) return null;
    const human = Number(fromRawAmount(raw, tok.decimals));
    return tryComputeUsdNotional(ctx, tok, human);
  } catch {
    return null;
  }
}

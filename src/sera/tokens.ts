import type { SeraClient } from "./client.js";
import type { SeraToken } from "./types.js";
import { guessFiatFromSymbol } from "../policy/policy.js";

let cache: { at: number; tokens: SeraToken[] } | undefined;
const TTL_MS = 60_000;

export async function getTokensCached(sera: SeraClient): Promise<SeraToken[]> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.tokens;
  const { tokens } = await sera.getTokens();
  // Normalize: ensure fiat_currency present.
  const enriched = tokens.map((t) => ({
    ...t,
    fiat_currency: t.fiat_currency ?? guessFiatFromSymbol(t.symbol),
  }));
  cache = { at: now, tokens: enriched };
  return enriched;
}

/**
 * Resolve a human-friendly token reference into a registered SeraToken.
 * Accepts:
 *   - exact symbol ("USDC", "XSGD")
 *   - lowercase ERC-20 address
 *   - fiat tag with a preferred stablecoin ("USD" -> first USD-pegged token)
 */
export async function resolveToken(
  sera: SeraClient,
  ref: string,
  preferredSymbols?: string[],
): Promise<SeraToken> {
  const tokens = await getTokensCached(sera);
  const trimmed = ref.trim();

  // Address match
  if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    const lower = trimmed.toLowerCase();
    const hit = tokens.find((t) => t.address.toLowerCase() === lower);
    if (hit) return hit;
    throw new Error(`Token address ${trimmed} not found in /tokens registry`);
  }

  const upper = trimmed.toUpperCase();

  // Exact symbol match
  const bySymbol = tokens.find((t) => t.symbol.toUpperCase() === upper);
  if (bySymbol) return bySymbol;

  // Fiat-currency match (e.g. "USD" -> pick preferred stablecoin)
  const fiatMatches = tokens.filter(
    (t) => (t.fiat_currency ?? "").toUpperCase() === upper,
  );
  if (fiatMatches.length > 0) {
    if (preferredSymbols) {
      for (const pref of preferredSymbols) {
        const p = fiatMatches.find((t) => t.symbol.toUpperCase() === pref.toUpperCase());
        if (p) return p;
      }
    }
    return fiatMatches[0];
  }

  throw new Error(
    `Could not resolve "${ref}" to a Sera token. Try a symbol (e.g. USDC), an ERC-20 address, ` +
      `or a fiat code (e.g. SGD).`,
  );
}

export function toRawAmount(human: number | string, decimals: number): string {
  const s = typeof human === "string" ? human : String(human);
  if (!/^-?\d*(\.\d+)?$/.test(s)) throw new Error(`Invalid amount: ${human}`);
  const negative = s.startsWith("-");
  const abs = negative ? s.slice(1) : s;
  const [intPart, fracPart = ""] = abs.split(".");
  const fracPadded = (fracPart + "0".repeat(decimals)).slice(0, decimals);
  const combined = (intPart + fracPadded).replace(/^0+(?=\d)/, "") || "0";
  return negative ? `-${combined}` : combined;
}

export function fromRawAmount(raw: string, decimals: number): string {
  const negative = raw.startsWith("-");
  const abs = negative ? raw.slice(1) : raw;
  const padded = abs.padStart(decimals + 1, "0");
  const intPart = padded.slice(0, padded.length - decimals).replace(/^0+(?=\d)/, "") || "0";
  const fracPart = padded.slice(padded.length - decimals).replace(/0+$/, "");
  const out = fracPart ? `${intPart}.${fracPart}` : intPart;
  return negative ? `-${out}` : out;
}

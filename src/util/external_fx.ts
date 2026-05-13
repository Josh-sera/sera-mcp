/**
 * External FX references. Three independent free sources so an agent can take
 * a median and detect "is this rate real or is one source out of step?"
 *
 *   - Frankfurter — ECB published rates. Daily update at 16:00 CET. ISO 4217.
 *   - open.er-api — free tier of ExchangeRate-API. Updates ~daily. Broad currency support.
 *   - exchangerate.host — free aggregator. Real-time-ish.
 */
import { request } from "undici";
import { TtlCache } from "./cache.js";

const cache = new TtlCache<{ rate: number; as_of?: string }>(5 * 60_000);

export type ExternalFxSource = "frankfurter" | "open_er_api" | "exchangerate_host";

export interface ExternalFxRate {
  source: ExternalFxSource;
  base: string;
  quote: string;
  rate: number;
  as_of?: string;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await request(url, { method: "GET" });
  const text = await res.body.text();
  if (res.statusCode !== 200) {
    throw new Error(`${url} -> ${res.statusCode}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text) as T;
}

export async function getFrankfurterRate(base: string, quote: string): Promise<ExternalFxRate> {
  const b = base.toUpperCase();
  const q = quote.toUpperCase();
  if (b === q) return { source: "frankfurter", base: b, quote: q, rate: 1, as_of: "n/a" };
  const cached = await cache.get(`fr:${b}/${q}`, async () => {
    const body = await fetchJson<{ date: string; rates: Record<string, number> }>(
      `https://api.frankfurter.dev/v1/latest?base=${b}&symbols=${q}`,
    );
    const rate = body.rates?.[q];
    if (typeof rate !== "number") throw new Error(`frankfurter: no rate for ${q}`);
    return { rate, as_of: body.date };
  });
  return { source: "frankfurter", base: b, quote: q, rate: cached.rate, as_of: cached.as_of };
}

export async function getOpenErApiRate(base: string, quote: string): Promise<ExternalFxRate> {
  const b = base.toUpperCase();
  const q = quote.toUpperCase();
  if (b === q) return { source: "open_er_api", base: b, quote: q, rate: 1, as_of: "n/a" };
  // open.er-api returns ALL rates from a base; cache the whole bundle.
  const cached = await cache.get(`oe:${b}`, async () => {
    const body = await fetchJson<{ rates: Record<string, number>; time_last_update_utc?: string }>(
      `https://open.er-api.com/v6/latest/${b}`,
    );
    return { rate: 0, as_of: body.time_last_update_utc, _all: body.rates } as any;
  });
  const all = (cached as any)._all as Record<string, number>;
  const rate = all?.[q];
  if (typeof rate !== "number") throw new Error(`open_er_api: no rate for ${q}`);
  return { source: "open_er_api", base: b, quote: q, rate, as_of: cached.as_of };
}

export async function getExchangerateHostRate(
  base: string,
  quote: string,
): Promise<ExternalFxRate> {
  const b = base.toUpperCase();
  const q = quote.toUpperCase();
  if (b === q) return { source: "exchangerate_host", base: b, quote: q, rate: 1, as_of: "n/a" };
  const cached = await cache.get(`xh:${b}/${q}`, async () => {
    const body = await fetchJson<{ rates: Record<string, number>; date: string }>(
      `https://api.exchangerate.host/latest?base=${b}&symbols=${q}`,
    );
    const rate = body.rates?.[q];
    if (typeof rate !== "number") throw new Error(`exchangerate_host: no rate for ${q}`);
    return { rate, as_of: body.date };
  });
  return { source: "exchangerate_host", base: b, quote: q, rate: cached.rate, as_of: cached.as_of };
}

/**
 * Hit all configured external sources in parallel; return per-source results,
 * median, and spread (max-min) in bps. Resilient: a failed source doesn't tank the call.
 */
export async function getMultiSourceMid(
  base: string,
  quote: string,
): Promise<{
  base: string;
  quote: string;
  sources: Array<{ source: ExternalFxSource; rate: number | null; as_of?: string; error?: string }>;
  median: number | null;
  range_bps: number | null;
}> {
  const fns: Array<{ source: ExternalFxSource; fn: () => Promise<ExternalFxRate> }> = [
    { source: "frankfurter", fn: () => getFrankfurterRate(base, quote) },
    { source: "open_er_api", fn: () => getOpenErApiRate(base, quote) },
    { source: "exchangerate_host", fn: () => getExchangerateHostRate(base, quote) },
  ];
  const settled = await Promise.allSettled(fns.map((f) => f.fn()));
  const sources = settled.map((s, i) => {
    if (s.status === "fulfilled") {
      return { source: fns[i].source, rate: s.value.rate, as_of: s.value.as_of };
    }
    return {
      source: fns[i].source,
      rate: null,
      error: s.reason?.message ?? String(s.reason),
    };
  });
  const rates = sources.map((s) => s.rate).filter((r): r is number => typeof r === "number" && r > 0);
  let median: number | null = null;
  let rangeBps: number | null = null;
  if (rates.length) {
    const sorted = [...rates].sort((a, b) => a - b);
    median =
      sorted.length % 2 === 1
        ? sorted[(sorted.length - 1) / 2]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    if (median > 0) rangeBps = Math.round(((sorted[sorted.length - 1] - sorted[0]) / median) * 10_000);
  }
  return {
    base: base.toUpperCase(),
    quote: quote.toUpperCase(),
    sources,
    median,
    range_bps: rangeBps,
  };
}

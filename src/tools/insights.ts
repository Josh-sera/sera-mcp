import type { AppContext } from "../config.js";

/**
 * spread_radar — pure-FX consistency check that needs no liquidity. Two signals:
 *
 *   1. Pair asymmetry. Sera's /fx/rate returns different numbers for (A,B) vs
 *      (B,A). Their product should be ~1.0; deviation = implied bid/ask spread.
 *   2. Triangular consistency. For (A,B,C), rate(A,B) * rate(B,C) * rate(C,A)
 *      should be ~1.0. Deviation surfaces pricing-source drift across legs.
 *
 * Useful as a depth/integrity monitor for treasury reporting and as a
 * pre-flight check before sizing inverse-amount payments.
 */
export async function spreadRadar(
  ctx: AppContext,
  args: {
    currencies?: string[];
    spread_alert_bps?: number;
    triangular_alert_bps?: number;
    include_triangles?: boolean;
  },
) {
  const currencies = (args.currencies && args.currencies.length >= 2
    ? args.currencies
    : ["USD", "SGD", "MYR", "EUR", "GBP", "JPY"]
  ).map((c) => c.toUpperCase());

  // Defaults calibrated to Sera's observed baseline: pair asymmetry runs
  // ~80-200bps in normal conditions, triangular drift ~150-280bps. Defaults
  // are set to flag only material outliers. Override per call to tighten.
  const spreadAlertBps = args.spread_alert_bps ?? 150;
  const triangularAlertBps = args.triangular_alert_bps ?? 150;
  const includeTriangles = args.include_triangles ?? true;

  // Fetch every ordered pair once and cache. n=6 -> 30 calls.
  const cache = new Map<string, number>();
  const errors: Array<{ pair: string; error: string }> = [];

  const ordered: Array<[string, string]> = [];
  for (const a of currencies) {
    for (const b of currencies) {
      if (a !== b) ordered.push([a, b]);
    }
  }

  await Promise.all(
    ordered.map(async ([a, b]) => {
      try {
        const r = await ctx.sera.getFxRate(a, b);
        const n = Number(r.rate);
        if (Number.isFinite(n) && n > 0) cache.set(`${a}/${b}`, n);
        else errors.push({ pair: `${a}/${b}`, error: `non-numeric rate: ${r.rate}` });
      } catch (e: any) {
        errors.push({ pair: `${a}/${b}`, error: e?.message ?? String(e) });
      }
    }),
  );

  // ---- Pair asymmetry ----
  const spreads: Array<{
    pair: string;
    rate_ab: number;
    rate_ba: number;
    implied_inverse: number;
    spread_bps: number;
    flagged: boolean;
  }> = [];
  const seenPairs = new Set<string>();
  for (const a of currencies) {
    for (const b of currencies) {
      if (a >= b) continue;
      const key = `${a}|${b}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      const rAb = cache.get(`${a}/${b}`);
      const rBa = cache.get(`${b}/${a}`);
      if (rAb === undefined || rBa === undefined) continue;
      const product = rAb * rBa;
      const spreadBps = Math.round(Math.abs(1 - product) * 10_000);
      spreads.push({
        pair: `${a}/${b}`,
        rate_ab: rAb,
        rate_ba: rBa,
        implied_inverse: 1 / rAb,
        spread_bps: spreadBps,
        flagged: spreadBps >= spreadAlertBps,
      });
    }
  }
  spreads.sort((x, y) => y.spread_bps - x.spread_bps);

  // ---- Triangular consistency ----
  const triangles: Array<{
    legs: [string, string, string];
    product: number;
    deviation_bps: number;
    flagged: boolean;
  }> = [];
  if (includeTriangles) {
    for (let i = 0; i < currencies.length; i++) {
      for (let j = i + 1; j < currencies.length; j++) {
        for (let k = j + 1; k < currencies.length; k++) {
          const a = currencies[i], b = currencies[j], c = currencies[k];
          const r1 = cache.get(`${a}/${b}`);
          const r2 = cache.get(`${b}/${c}`);
          const r3 = cache.get(`${c}/${a}`);
          if (r1 === undefined || r2 === undefined || r3 === undefined) continue;
          const product = r1 * r2 * r3;
          const devBps = Math.round((product - 1) * 10_000);
          triangles.push({
            legs: [a, b, c],
            product,
            deviation_bps: devBps,
            flagged: Math.abs(devBps) >= triangularAlertBps,
          });
        }
      }
    }
    triangles.sort((x, y) => Math.abs(y.deviation_bps) - Math.abs(x.deviation_bps));
  }

  const alerts: Array<{ kind: string; subject: string; bps: number }> = [];
  for (const s of spreads) if (s.flagged) {
    alerts.push({ kind: "asymmetric_pair", subject: s.pair, bps: s.spread_bps });
  }
  for (const t of triangles) if (t.flagged) {
    alerts.push({
      kind: "triangular_drift",
      subject: `${t.legs[0]}->${t.legs[1]}->${t.legs[2]}`,
      bps: t.deviation_bps,
    });
  }

  return {
    currencies,
    thresholds: { spread_alert_bps: spreadAlertBps, triangular_alert_bps: triangularAlertBps },
    summary: {
      pairs_checked: spreads.length,
      triangles_checked: triangles.length,
      alerts: alerts.length,
      worst_pair_bps: spreads[0]?.spread_bps ?? null,
      worst_triangle_bps: triangles[0]?.deviation_bps ?? null,
    },
    spreads,
    triangles,
    alerts,
    errors,
  };
}

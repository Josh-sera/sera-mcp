import type { AppContext } from "../config.js";
import { isHistoryEnabled } from "../util/persistence.js";

/**
 * doctor — health and configuration self-check. Surfaces every thing an operator
 * needs to know in one call: API reachability, network mismatch, signer mode,
 * policy summary, persistence state.
 */
export async function doctor(ctx: AppContext) {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  // 1. /health round-trip
  try {
    const h = await ctx.sera.getHealth();
    checks.push({ name: "sera_health", ok: h.status === "healthy", detail: `status=${h.status}` });
  } catch (e: any) {
    checks.push({ name: "sera_health", ok: false, detail: e?.message ?? String(e) });
  }

  // 2. /config + network sanity
  try {
    const cfg = await ctx.sera.getConfig();
    const expected = ctx.cfg.network === "mainnet" ? 1 : 11155111;
    const networkOk = cfg.chain_id === expected;
    checks.push({
      name: "network_sanity",
      ok: networkOk,
      detail: networkOk
        ? `chain_id=${cfg.chain_id} matches SERA_NETWORK=${ctx.cfg.network}`
        : `MISMATCH: SERA_NETWORK=${ctx.cfg.network} but /config returned chain_id=${cfg.chain_id}`,
    });
  } catch (e: any) {
    checks.push({ name: "network_sanity", ok: false, detail: e?.message ?? String(e) });
  }

  // 3. /tokens loadable
  try {
    const t = await ctx.sera.getTokens();
    checks.push({ name: "tokens_registry", ok: t.tokens.length > 0, detail: `${t.tokens.length} tokens loaded` });
  } catch (e: any) {
    checks.push({ name: "tokens_registry", ok: false, detail: e?.message ?? String(e) });
  }

  // 4. Signer mode
  checks.push({
    name: "signer_mode",
    ok: true,
    detail:
      ctx.signer.mode === "external"
        ? "external (server holds no key — agents must sign EIP-712 separately)"
        : ctx.signer.mode === "local"
        ? "LOCAL (server signs and submits — make sure SIGNER_PRIVATE_KEY is funded and scoped)"
        : "readonly (execution disabled)",
  });

  // 5. Policy summary — surface every parsed value so operators can audit
  const p = ctx.policy.config;
  checks.push({
    name: "policy",
    ok: true,
    detail:
      `symbols=${p.allowedSymbols.length || "all"}, ` +
      `recipients=${p.allowedRecipients.length || "any"}, ` +
      `max_notional_usd=${p.maxNotionalUsd || "none"}, ` +
      `daily_volume_cap_usd=${p.dailyVolumeCapUsd || "none"}, ` +
      `default_expiration_s=${p.defaultExpirationSeconds}, ` +
      `max_expiration_s=${p.maxExpirationSeconds}, ` +
      `output_tolerance_bps=${p.outputToleranceBps}, ` +
      `dry_run=${p.dryRun}, ` +
      `volume_persistent=${p.persistentDailyVolume}`,
  });

  // 6. History persistence + privacy posture
  checks.push({
    name: "history_persistence",
    ok: true,
    detail: isHistoryEnabled()
      ? `enabled (SERA_HISTORY_DB set, owner_hash=${p.historyHashOwner})`
      : "disabled (set SERA_HISTORY_DB to enable)",
  });

  return {
    network_label: ctx.cfg.network,
    base_url: ctx.cfg.baseUrl,
    overall_ok: checks.every((c) => c.ok),
    checks,
  };
}

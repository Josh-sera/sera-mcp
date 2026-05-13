import type { SeraClient } from "../sera/client.js";
import type { SeraToken } from "../sera/types.js";
import { recordExecutedNotional, rolling24hVolumeUsd } from "../util/persistence.js";

export interface PolicyConfig {
  allowedSymbols: string[];          // empty = allow all
  allowedRecipients: string[];       // empty = allow any (lowercased addresses)
  maxNotionalUsd: number;            // 0 = no cap (per-tx)
  dailyVolumeCapUsd: number;         // 0 = no cap (rolling 24h)
  defaultExpirationSeconds: number;
  maxExpirationSeconds: number;      // hard ceiling on caller-requested expiration
  outputToleranceBps: number;        // bps to LOWER minOutputAmount (was confusingly extraSlippageBps)
  dryRun: boolean;                   // true = refuse all execute calls regardless of signer mode
  historyHashOwner: boolean;         // true = SHA-256 owner_address before logging (privacy)
  persistentDailyVolume: boolean;    // true = persist volume to SQLite (cross-restart enforcement)
}

export interface PolicyDecision {
  ok: boolean;
  reason?: string;
}

// Pre-baked policy bundles. Useful as POLICY_PRESET=<name> shorthand.
export const PRESETS: Record<string, Partial<PolicyConfig> & { allowedSymbols: string[] }> = {
  // Conservative agent default — read paths only matter most.
  "starter": {
    allowedSymbols: ["USDC", "USDT"],
    maxNotionalUsd: 1_000,
    dailyVolumeCapUsd: 5_000,
    outputToleranceBps: 0,
  },
  // Standard whitelist tuned to Sera's most-traded fiats.
  "standard": {
    allowedSymbols: ["USDC", "USDT", "XSGD", "JPYC", "MYRT", "TGBP", "EURC"],
    maxNotionalUsd: 5_000,
    dailyVolumeCapUsd: 50_000,
    outputToleranceBps: 0,
  },
  // SG-retail-flavored: only SGD-pairing stables.
  "sg-retail": {
    allowedSymbols: ["USDC", "USDT", "XSGD"],
    maxNotionalUsd: 2_000,
    dailyVolumeCapUsd: 10_000,
    outputToleranceBps: 0,
  },
  // No ceilings — for internal dogfood / tests. Don't ship this.
  "open": {
    allowedSymbols: [],
    maxNotionalUsd: 0,
    dailyVolumeCapUsd: 0,
    outputToleranceBps: 0,
  },
};

export class PolicyEngine {
  // In-memory shadow of the daily volume window. Used as fallback when SQLite
  // is unavailable. Authoritative source is the persistence layer when enabled.
  private readonly memoryNotionals: Array<{ ts: number; usd: number }> = [];

  constructor(
    private readonly cfg: PolicyConfig,
    private readonly sera: SeraClient,
  ) {}

  get config(): Readonly<PolicyConfig> {
    return this.cfg;
  }

  recordExecutedNotional(usd: number, signerKey?: string): void {
    if (this.cfg.persistentDailyVolume) {
      try {
        recordExecutedNotional(usd, signerKey ?? "default");
        return;
      } catch {
        // fall through to memory
      }
    }
    this.memoryNotionals.push({ ts: Date.now(), usd });
    const cutoff = Date.now() - 24 * 3600 * 1000;
    while (this.memoryNotionals.length && this.memoryNotionals[0].ts < cutoff) {
      this.memoryNotionals.shift();
    }
  }

  rolling24hVolumeUsd(signerKey?: string): number {
    if (this.cfg.persistentDailyVolume) {
      try {
        return rolling24hVolumeUsd(signerKey ?? "default");
      } catch {
        // fall through
      }
    }
    const cutoff = Date.now() - 24 * 3600 * 1000;
    return this.memoryNotionals.filter((e) => e.ts >= cutoff).reduce((s, e) => s + e.usd, 0);
  }

  checkDailyVolume(addUsd: number, signerKey?: string): PolicyDecision {
    if (!this.cfg.dailyVolumeCapUsd) return { ok: true };
    const projected = this.rolling24hVolumeUsd(signerKey) + addUsd;
    if (projected > this.cfg.dailyVolumeCapUsd) {
      return {
        ok: false,
        reason: `daily volume cap: rolling 24h projected $${projected.toFixed(2)} exceeds POLICY_DAILY_VOLUME_CAP_USD ($${this.cfg.dailyVolumeCapUsd})`,
      };
    }
    return { ok: true };
  }

  checkDryRun(): PolicyDecision {
    if (this.cfg.dryRun) {
      return {
        ok: false,
        reason: "POLICY_DRY_RUN=true — execution refused regardless of signer mode. Unset to enable.",
      };
    }
    return { ok: true };
  }

  checkSymbol(token: SeraToken): PolicyDecision {
    if (this.cfg.allowedSymbols.length === 0) return { ok: true };
    return this.cfg.allowedSymbols.includes(token.symbol.toUpperCase())
      ? { ok: true }
      : { ok: false, reason: `symbol ${token.symbol} not in POLICY_ALLOWED_SYMBOLS` };
  }

  checkRecipient(recipient: string): PolicyDecision {
    if (this.cfg.allowedRecipients.length === 0) return { ok: true };
    const lower = recipient.toLowerCase();
    return this.cfg.allowedRecipients.includes(lower)
      ? { ok: true }
      : { ok: false, reason: `recipient ${recipient} not in POLICY_ALLOWED_RECIPIENTS` };
  }

  /**
   * Estimate the USD notional of a swap input and verify it's within policy.
   * Uses Sera's /fx/rate when the input token isn't already USD-pegged.
   */
  async checkNotional(token: SeraToken, humanAmount: number): Promise<PolicyDecision> {
    if (!this.cfg.maxNotionalUsd) return { ok: true };
    let usdValue = humanAmount;
    const fiat = (token.fiat_currency ?? guessFiatFromSymbol(token.symbol)).toUpperCase();
    if (fiat !== "USD") {
      try {
        const rate = await this.sera.getFxRate(fiat, "USD");
        const r = Number(rate.rate);
        if (Number.isFinite(r)) usdValue = humanAmount * r;
      } catch {
        return {
          ok: false,
          reason: `unable to price ${fiat} in USD via /fx/rate; refusing to bypass notional cap`,
        };
      }
    }
    if (usdValue > this.cfg.maxNotionalUsd) {
      return {
        ok: false,
        reason: `swap notional ~$${usdValue.toFixed(2)} exceeds POLICY_MAX_NOTIONAL_USD ($${this.cfg.maxNotionalUsd})`,
      };
    }
    return { ok: true };
  }
}

const SYMBOL_TO_FIAT: Record<string, string> = {
  USDC: "USD", USDT: "USD",
  EURC: "EUR", EURT: "EUR",
  TGBP: "GBP", GBPC: "GBP",
  XSGD: "SGD",
  JPYC: "JPY",
  MYRT: "MYR",
  IDRT: "IDR",
  BRZ: "BRL", BRLV: "BRL",
  AUDD: "AUD", AUDF: "AUD", AUDM: "AUD", AUDX: "AUD",
  CADC: "CAD", QCAD: "CAD",
  CHFAU: "CHF", VCHF: "CHF",
  AEDZ: "AED",
  WARS: "ARS",
  WCLP: "CLP",
  WCOP: "COP",
  WPEN: "PEN",
  AXCNH: "CNH",
  CNGN: "NGN",
  NZDD: "NZD",
  MXNB: "MXN", MXNT: "MXN",
  ITRY: "TRY", TRYB: "TRY",
  ZARP: "ZAR",
};

export function guessFiatFromSymbol(symbol: string): string {
  return SYMBOL_TO_FIAT[symbol.toUpperCase()] ?? "USD";
}

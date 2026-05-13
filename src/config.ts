import { createSigner, type Signer, type SignerMode } from "./signer/signer.js";
import { SeraClient } from "./sera/client.js";
import { PolicyEngine, PRESETS, type PolicyConfig } from "./policy/policy.js";
import { log } from "./util/logger.js";
import { envString, envBool, envNumber, envList, isHostInSeraFamily } from "./util/env.js";

export interface AppConfig {
  network: "mainnet" | "sepolia";
  baseUrl: string;
  signerMode: SignerMode;
}

export interface AppContext {
  cfg: AppConfig;
  sera: SeraClient;
  signer: Signer;
  policy: PolicyEngine;
}

/**
 * Sera's production URLs are hardcoded by network. We do NOT read SERA_BASE_URL
 * by default — that env var would be too easy to slip into a malicious install
 * snippet. A user picks `SERA_NETWORK=mainnet` or `sepolia` and gets the
 * canonical URL for that network. Period.
 *
 * Override path requires THREE env vars (deliberately friction-heavy):
 *   SERA_BASE_URL_ALLOW_CUSTOM=true
 *   SERA_BASE_URL=https://your-host/api/v1
 *   (and if your host is not under sera.cx) SERA_BASE_URL_ALLOW_NON_SERA=true
 *
 * The third gate stops a single env override from redirecting traffic to a
 * fully-attacker-controlled host: even with ALLOW_CUSTOM, only *.sera.cx is
 * accepted unless ALLOW_NON_SERA is also set.
 */
const NETWORK_URLS: Record<"mainnet" | "sepolia", string> = {
  mainnet: "https://api.sera.cx/api/v1",
  sepolia: "https://api-sepolia.sera.cx/api/v1",
};

function resolveBaseUrl(network: "mainnet" | "sepolia"): string {
  const allowCustom = envBool("SERA_BASE_URL_ALLOW_CUSTOM", false);
  const allowNonSera = envBool("SERA_BASE_URL_ALLOW_NON_SERA", false);
  const customRaw = envString("SERA_BASE_URL");

  if (customRaw && !allowCustom) {
    log.warn(
      "SERA_BASE_URL set but SERA_BASE_URL_ALLOW_CUSTOM is not 'true' — IGNORING. Using canonical URL for this network.",
      { ignored: customRaw, used: NETWORK_URLS[network] },
    );
    return NETWORK_URLS[network];
  }
  if (customRaw && allowCustom) {
    let parsed: URL;
    try {
      parsed = new URL(customRaw);
    } catch {
      throw new Error(`SERA_BASE_URL is not a valid URL: ${customRaw}`);
    }
    if (parsed.protocol !== "https:") {
      throw new Error(`SERA_BASE_URL must use https:// (got ${parsed.protocol})`);
    }
    if (!isHostInSeraFamily(parsed.hostname) && !allowNonSera) {
      throw new Error(
        `SERA_BASE_URL host "${parsed.hostname}" is not under sera.cx. ` +
          `Set SERA_BASE_URL_ALLOW_NON_SERA=true to override (only safe if you control the host).`,
      );
    }
    const normalized = customRaw.replace(/\/+$/, "");
    log.warn("SERA_BASE_URL override ENABLED", {
      base_url: normalized,
      non_sera_allowed: allowNonSera,
      risk:
        "Every API key, wallet signature, and route_params response will trust this host. " +
        "Only safe for Sera-internal dev against your own staging.",
    });
    return normalized;
  }
  return NETWORK_URLS[network];
}

export function loadConfig(): AppContext {
  const networkRaw = (envString("SERA_NETWORK", "mainnet") ?? "mainnet").toLowerCase();
  if (networkRaw !== "mainnet" && networkRaw !== "sepolia") {
    throw new Error(`SERA_NETWORK must be 'mainnet' or 'sepolia' (got '${networkRaw}')`);
  }
  const network = networkRaw as "mainnet" | "sepolia";
  const baseUrl = resolveBaseUrl(network);
  const signerModeRaw = (envString("SERA_SIGNER_MODE", "external") ?? "external") as SignerMode;
  if (!["external", "local", "readonly"].includes(signerModeRaw)) {
    throw new Error(`SERA_SIGNER_MODE must be external|local|readonly (got '${signerModeRaw}')`);
  }
  const signerMode = signerModeRaw;

  const sera = new SeraClient({
    baseUrl,
    apiKey: envString("SERA_API_KEY"),
    apiSecret: envString("SERA_API_SECRET"),
  });

  const signer = createSigner(signerMode, envString("SIGNER_PRIVATE_KEY"));

  // Optional preset short-hand: POLICY_PRESET=standard / sg-retail / starter / open.
  // Explicit env vars override preset values when both are set.
  const presetName = envString("POLICY_PRESET")?.toLowerCase();
  const preset = presetName ? PRESETS[presetName] : undefined;
  if (presetName && !preset) {
    log.warn("POLICY_PRESET unknown, ignoring", { name: presetName, available: Object.keys(PRESETS) });
  }

  const envSymbols = envList("POLICY_ALLOWED_SYMBOLS");
  const policyCfg: PolicyConfig = {
    allowedSymbols: (envSymbols.length ? envSymbols : preset?.allowedSymbols ?? []).map((s) =>
      s.toUpperCase(),
    ),
    allowedRecipients: envList("POLICY_ALLOWED_RECIPIENTS").map((s) => s.toLowerCase()),
    maxNotionalUsd: envNumber("POLICY_MAX_NOTIONAL_USD", preset?.maxNotionalUsd ?? 0, { min: 0, max: 10_000_000 }),
    dailyVolumeCapUsd: envNumber("POLICY_DAILY_VOLUME_CAP_USD", preset?.dailyVolumeCapUsd ?? 0, { min: 0, max: 100_000_000 }),
    defaultExpirationSeconds: envNumber("POLICY_DEFAULT_EXPIRATION_SECONDS", 120, { min: 30, max: 600, integer: true }),
    maxExpirationSeconds: envNumber("POLICY_MAX_EXPIRATION_SECONDS", 600, { min: 30, max: 3600, integer: true }),
    // outputToleranceBps: how many bps to LOWER minOutputAmount below Sera's
    // returned value. Default 0 — only loosen when explicitly opted into.
    // Hard-capped at 500bps (5%) to prevent silently signing intents that
    // settle at near-zero output.
    outputToleranceBps: envNumber("POLICY_OUTPUT_TOLERANCE_BPS", preset?.outputToleranceBps ?? 0, { min: 0, max: 500, integer: true }),
    dryRun: envBool("POLICY_DRY_RUN", false),
    historyHashOwner: envBool("SERA_HISTORY_HASH_OWNER", true),
    persistentDailyVolume: envBool("POLICY_PERSIST_DAILY_VOLUME", true),
  };

  const policy = new PolicyEngine(policyCfg, sera);

  return {
    cfg: { network, baseUrl, signerMode },
    sera,
    signer,
    policy,
  };
}

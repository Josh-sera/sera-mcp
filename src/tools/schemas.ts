import { z } from "zod";

// ─── Reusable validators ────────────────────────────────────────────────────
// Tighten the boundary so prompt-injection or malformed agent calls don't reach
// the handlers. Each validator has a hard upper length to bound logging cost.

const EvmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be 0x-prefixed 40-hex EVM address");
const FiatCode = z.string().regex(/^[A-Za-z]{3}$/, "must be a 3-letter fiat code").transform((s) => s.toUpperCase());
const TokenSymbol = z.string().regex(/^[A-Za-z][A-Za-z0-9]{1,11}$/, "must be a 2-12 char token symbol");
const Uuid = z.string().regex(/^[0-9a-fA-F-]{8,80}$/, "must be a uuid");
const HexSignature = z.string().regex(/^0x[0-9a-fA-F]{8,520}$/, "must be 0x-prefixed hex (signature)").max(520);
const DecimalAmount = z.union([
  z.number().positive().finite(),
  z.string().regex(/^\d+(\.\d+)?$/, "must be a non-negative decimal").max(40),
]);

// CurrencyRef accepts symbol, address, or fiat — bounded length, no exotic chars.
const CurrencyRef = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9]{2,12}$|^0x[0-9a-fA-F]{40}$/, "must be a token symbol, fiat code, or 0x address")
  .describe("Symbol (USDC), ERC-20 address, or fiat code (e.g. SGD).");

export const ListCurrenciesInput = z.object({
  fiat: z
    .string()
    .optional()
    .describe("Optional 3-letter fiat code filter (e.g. 'USD'). Returns only stablecoins of that fiat."),
});

export const GetMarketsInput = z.object({});

export const GetFxRateInput = z.object({
  base: FiatCode.describe("Base ISO currency code (e.g. 'GBP')."),
  quote: FiatCode.describe("Quote ISO currency code (e.g. 'USD')."),
});

export const GetBalancesInput = z.object({
  owner_address: EvmAddress.describe("0x… wallet address to query. Requires API key auth."),
});

export const GetQuoteInput = z.object({
  from: CurrencyRef,
  to: CurrencyRef,
  amount: DecimalAmount.describe("Human amount in `from` units (e.g. '100' = 100 USDC)."),
  owner_address: EvmAddress
    .optional()
    .describe("Wallet that will fund the swap (becomes Intent.taker). Required unless simulate=true."),
  recipient: EvmAddress.optional().describe("Where output tokens should land. Defaults to owner_address."),
  gas_mode: z.enum(["receive_less", "pay_more"]).default("receive_less"),
  expiration_seconds: z
    .number()
    .int()
    .positive()
    .max(3600)
    .optional()
    .describe("Quote validity window. Bounded by POLICY_MAX_EXPIRATION_SECONDS at handler time."),
  simulate: z
    .boolean()
    .optional()
    .describe(
      "If true, use the burn address as owner — for read-only price/depth probing. The returned route_params can NOT be executed.",
    ),
});

export const PrepareSwapInput = GetQuoteInput.extend({});

export const ExecuteSwapInput = z.object({
  uuid: Uuid.describe("Quote UUID returned by get_quote / prepare_swap."),
  signature: HexSignature
    .optional()
    .describe(
      "Hex EIP-712 signature over `route_params`. Required when signer mode is 'external'. " +
        "In 'local' mode the server signs and this can be omitted.",
    ),
  route_params: z
    .record(z.any())
    .optional()
    .describe(
      "Optional. If provided, must EXACTLY match what this MCP returned for the uuid (refused on mismatch). " +
        "In external mode the upstream signature is the security boundary; in local mode the server-side registry binding is enforced.",
    ),
});

export const ConvertAndSendInput = z.object({
  from: CurrencyRef,
  to: CurrencyRef,
  amount: DecimalAmount,
  owner_address: EvmAddress,
  recipient: EvmAddress.describe("Final destination address for the output token."),
  gas_mode: z.enum(["receive_less", "pay_more"]).default("receive_less"),
});

export const QuoteRecipientAmountInput = z.object({
  from: CurrencyRef.describe("Token you're paying with."),
  to: CurrencyRef.describe("Currency the recipient should receive."),
  recipient_amount: z
    .union([z.string(), z.number()])
    .describe("How much the recipient should end up with, in `to` human units."),
  owner_address: z.string(),
  recipient: z.string().optional(),
});

export const FindCheapestPathInput = z.object({
  from: CurrencyRef,
  to: CurrencyRef,
  amount: z.union([z.string(), z.number()]),
  owner_address: z.string(),
});

export const ScanMarketsInput = z.object({
  pairs: z
    .array(z.object({ base: z.string(), quote: z.string() }))
    .optional()
    .describe("Explicit list of pairs. If omitted, enumerates from /markets and applies max_pairs."),
  notional_per_quote: z
    .number()
    .positive()
    .optional()
    .describe("Human amount in `from` units used for each probe. Default 100."),
  max_pairs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Cap on pairs scanned when no explicit list is given. Default 50."),
  max_concurrency: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Bounded parallelism. Default 8 — keep below 25 to be polite."),
  only_policy_allowed: z
    .boolean()
    .optional()
    .describe("If true (default), restrict enumeration to symbols in POLICY_ALLOWED_SYMBOLS."),
  gas_mode: z.enum(["receive_less", "pay_more"]).optional(),
});

export const CompareToExternalFxInput = z.object({
  base: z.string().describe("ISO fiat (e.g. 'USD') OR a Sera token symbol (e.g. 'USDC')."),
  quote: z.string().describe("ISO fiat (e.g. 'SGD') OR a Sera token symbol (e.g. 'XSGD')."),
});

export const ProbeDepthInput = z.object({
  from: CurrencyRef,
  to: CurrencyRef,
  sizes: z
    .array(z.number().positive())
    .optional()
    .describe("Human input sizes to probe. Default [100, 1000, 10000, 100000]."),
  gas_mode: z.enum(["receive_less", "pay_more"]).optional(),
  max_concurrency: z.number().int().positive().optional(),
});

export const RoundTripCostInput = z.object({
  from: CurrencyRef,
  to: CurrencyRef,
  amount: z.number().positive().describe("Human amount in `from` units."),
  gas_mode: z.enum(["receive_less", "pay_more"]).optional(),
});

export const InferBookInput = z.object({
  base: CurrencyRef,
  quote: CurrencyRef,
  sizes: z
    .array(z.number().positive())
    .optional()
    .describe("Probe sizes (in respective input currency). Default log-spaced 100→1M."),
  gas_mode: z.enum(["receive_less", "pay_more"]).optional(),
});

export const FxHistoryInput = z.object({
  base: z.string(),
  quote: z.string(),
  since_hours_ago: z.number().positive().optional().describe("Default 24."),
});

export const TreasuryValueInput = z.object({
  owner_addresses: z.array(z.string()).min(1).describe("One or more 0x... wallets to aggregate."),
  target_currency: z.string().optional().describe("ISO fiat to value in. Default 'USD'."),
  include_zero: z.boolean().optional().describe("Include zero-balance lines. Default false."),
});

export const ExposureReportInput = TreasuryValueInput.pick({ owner_addresses: true, target_currency: true });

export const RebalancePlanInput = z.object({
  owner_addresses: z.array(z.string()).min(1),
  target_weights: z
    .record(z.number().nonnegative())
    .describe("Map of fiat code → weight, e.g. { USD: 50, SGD: 30, MYR: 20 }. Normalized internally."),
  target_currency: z.string().optional(),
  min_trade_value: z
    .number()
    .nonnegative()
    .optional()
    .describe("Skip suggested trades below this value (in target_currency). Default 10."),
});

export const PayInvoiceInput = z.object({
  owner_address: z.string(),
  recipient: z.string(),
  amount: z.number().positive().describe("Recipient should receive exactly this in `target_currency` units."),
  target_currency: z.string().describe("ISO fiat the recipient wants (e.g. 'SGD')."),
  source_symbols: z.array(z.string()).min(1).describe("Stablecoins available to spend (e.g. ['USDC','USDT','EURC'])."),
  target_symbol: z.string().optional().describe("Specific output token; defaults to a stablecoin matching target_currency."),
});

export const DoctorInput = z.object({});

export const FindDealsInput = z.object({
  pairs: z
    .array(z.object({ base: z.string(), quote: z.string() }))
    .optional()
    .describe("Explicit pair list. If omitted, enumerates from /markets and applies max_pairs."),
  notional_per_quote: z.number().positive().optional(),
  max_pairs: z.number().int().positive().optional(),
  max_concurrency: z.number().int().positive().optional(),
  only_policy_allowed: z.boolean().optional(),
  min_deviation_bps: z
    .number()
    .nonnegative()
    .optional()
    .describe("Minimum |deviation| from benchmark to count as a deal. Default 25."),
  gas_mode: z.enum(["receive_less", "pay_more"]).optional(),
  use_multi_source: z
    .boolean()
    .optional()
    .describe(
      "True (default): benchmark = median of 3 external FX sources. False: benchmark = sera.get_fx_rate.",
    ),
});

export const MakerQuoteLadderInput = z.object({
  base: CurrencyRef,
  quote: CurrencyRef,
  notional: z.number().positive().describe("Amount in the SELL leg."),
  role: z
    .enum(["maker_sell_base", "maker_buy_base"])
    .optional()
    .describe("Are you selling base for quote, or buying base with quote? Default sell."),
  mid: z.number().positive().optional().describe("Override the mid. If omitted, fetched per mid_source."),
  mid_source: z
    .enum(["multi_source", "sera"])
    .optional()
    .describe("multi_source = median of external sources (default). sera = sera.get_fx_rate."),
  spreads_bps: z
    .array(z.number().positive())
    .optional()
    .describe("Spreads to ladder. Default [5, 10, 15, 25, 50, 100, 200]."),
});

export const MultiSourceMidInput = z.object({
  base: z.string().describe("ISO fiat or Sera token symbol."),
  quote: z.string().describe("ISO fiat or Sera token symbol."),
});

export const LimitWatcherInput = z.object({
  from: CurrencyRef,
  to: CurrencyRef,
  amount: z.number().positive(),
  target_rate: z
    .number()
    .positive()
    .describe("Threshold (output_per_input) at which the watcher should fire."),
  side: z
    .enum(["sell_from", "buy_from"])
    .describe(
      "sell_from = wait until rate >= target (best when selling 'from'). buy_from = wait until rate <= target.",
    ),
  max_attempts: z.number().int().positive().max(30).optional().describe("Default 5; capped at 30."),
  interval_seconds: z
    .number()
    .int()
    .positive()
    .max(60)
    .optional()
    .describe("Sleep between attempts. Default 6, capped at 60."),
  gas_mode: z.enum(["receive_less", "pay_more"]).optional(),
});

export const SettlementStatusInput = z.object({
  trade_id: z.string().optional(),
  uuid: z.string().optional(),
  owner_address: z.string().optional(),
  status: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

export const MarketHealthInput = z.object({
  from: CurrencyRef,
  to: CurrencyRef,
  gas_mode: z.enum(["receive_less", "pay_more"]).optional(),
});

export const FxQuoteDiffInput = z.object({
  from: CurrencyRef,
  to: CurrencyRef,
  notional: z
    .number()
    .positive()
    .optional()
    .describe("Amount used for the executable probe. Default 100."),
  gas_mode: z.enum(["receive_less", "pay_more"]).optional(),
});

export const CompareCorridorsInput = z.object({
  target: CurrencyRef.describe("Output currency or token to deliver."),
  target_amount: z.number().positive().describe("Exact amount of `target` to deliver."),
  sources: z.array(z.string()).min(1).describe("Candidate source token symbols to compare."),
  max_concurrency: z.number().int().positive().max(10).optional(),
  gas_mode: z.enum(["receive_less", "pay_more"]).optional(),
});

export const SpreadRadarInput = z.object({
  currencies: z
    .array(z.string())
    .optional()
    .describe(
      "List of ISO fiat codes to scan (e.g. ['USD','SGD','MYR']). Defaults to USD/SGD/MYR/EUR/GBP/JPY.",
    ),
  spread_alert_bps: z
    .number()
    .nonnegative()
    .optional()
    .describe("Flag pairs whose forward*reverse rate deviates from 1.0 by ≥ this many bps. Default 50."),
  triangular_alert_bps: z
    .number()
    .nonnegative()
    .optional()
    .describe("Flag triangles whose round-trip product deviates from 1.0 by ≥ this many bps. Default 50."),
  include_triangles: z
    .boolean()
    .optional()
    .describe("Set false to skip triangular checks (cheaper, only n*(n-1) calls). Default true."),
});

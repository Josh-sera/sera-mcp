#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "./util/zod-to-json.js";

import { loadConfig } from "./config.js";
import {
  CompareCorridorsInput,
  CompareToExternalFxInput,
  ConvertAndSendInput,
  DoctorInput,
  ExecuteSwapInput,
  ExposureReportInput,
  FindCheapestPathInput,
  FindDealsInput,
  FxHistoryInput,
  FxQuoteDiffInput,
  GetBalancesInput,
  GetFxRateInput,
  GetMarketsInput,
  GetQuoteInput,
  InferBookInput,
  LimitWatcherInput,
  ListCurrenciesInput,
  MakerQuoteLadderInput,
  MarketHealthInput,
  MultiSourceMidInput,
  PayInvoiceInput,
  PrepareSwapInput,
  ProbeDepthInput,
  QuoteRecipientAmountInput,
  RebalancePlanInput,
  RoundTripCostInput,
  ScanMarketsInput,
  SettlementStatusInput,
  SpreadRadarInput,
  TreasuryValueInput,
} from "./tools/schemas.js";
import {
  executeSwap,
  getBalances,
  getFxRate,
  getMarkets,
  getQuote,
  listCurrencies,
  prepareSwap,
} from "./tools/core.js";
import {
  convertAndSend,
  findCheapestPath,
  quoteRecipientAmount,
} from "./tools/semantic.js";
import { spreadRadar } from "./tools/insights.js";
import { scanMarkets } from "./tools/scan.js";
import { compareToExternalFx } from "./tools/external.js";
import { probeDepth, roundTripCost, inferBook } from "./tools/depth.js";
import { fxHistory, fxVolatility, corridorPnl } from "./tools/history.js";
import { treasuryValue, exposureReport, rebalancePlan, payInvoice } from "./tools/treasury.js";
import { doctor } from "./tools/admin.js";
import { findDeals } from "./tools/deals.js";
import { makerQuoteLadder, multiSourceMid } from "./tools/maker.js";
import { limitWatcher } from "./tools/watcher.js";
import { settlementStatus } from "./tools/settlement.js";
import { marketHealth, fxQuoteDiff, compareCorridors } from "./tools/health_corridors.js";
import { listResources, readResource } from "./resources.js";
import { listPrompts, getPrompt } from "./prompts.js";
import { log } from "./util/logger.js";

const ctx = loadConfig();

const TOOLS = [
  // ---- Discovery ----
  {
    name: "sera.list_currencies",
    description:
      "List supported stablecoins from Sera's live token registry. Use this before any swap to discover symbols, fiat tags, addresses, and decimals. Optionally filter by fiat (e.g. fiat='SGD'). Cached 5min server-side.",
    schema: ListCurrenciesInput,
    handler: (args: any) => listCurrencies(ctx, args ?? {}),
  },
  {
    name: "sera.get_markets",
    description:
      "List the active trading-pair catalog from /markets. NOTE: pair existence ≠ tradeable now — use sera.scan_markets to find what's actually quotable. Cached 10min server-side.",
    schema: GetMarketsInput,
    handler: () => getMarkets(ctx),
  },
  // ---- Pricing ----
  {
    name: "sera.get_fx_rate",
    description:
      "Sera's reference FX rate between two ISO currency codes (e.g. base='SGD', quote='USD'). Has measurable bid/ask asymmetry — for execution price, always use sera.get_quote. To detect Sera vs market bias, pair with sera.compare_to_external_fx. Cached 60s server-side.",
    schema: GetFxRateInput,
    handler: (args: any) => getFxRate(ctx, args),
  },
  {
    name: "sera.compare_to_external_fx",
    description:
      "Diff Sera's /fx/rate against Frankfurter (ECB published mid). Surfaces systematic pricing bias. Inputs accept ISO fiat codes ('USD','SGD') OR Sera token symbols ('USDC','XSGD'). Note: Frankfurter updates daily, not real-time.",
    schema: CompareToExternalFxInput,
    handler: (args: any) => compareToExternalFx(ctx, args),
  },
  {
    name: "sera.spread_radar",
    description:
      "Liquidity-free FX consistency monitor across a currency basket. Flags forward/reverse pair asymmetry and triangular drift. Useful as a pre-trade integrity check or to detect upstream pricing-source drift. Defaults: 150bps thresholds, USD/SGD/MYR/EUR/GBP/JPY basket.",
    schema: SpreadRadarInput,
    handler: (args: any) => spreadRadar(ctx, args ?? {}),
  },
  // ---- Liquidity probing ----
  {
    name: "sera.scan_markets",
    description:
      "Fan out parallel /swap/quote probes across many pairs. Built for the deal-scanner pattern: one tool call instead of N round-trips. Default: 50 pairs, 8 concurrent, $100 notional, restricted to POLICY_ALLOWED_SYMBOLS. Reports quotable rate per pair and skip reasons (no_liquidity etc.).",
    schema: ScanMarketsInput,
    handler: (args: any) => scanMarkets(ctx, args ?? {}),
  },
  {
    name: "sera.find_deals",
    description:
      "End-to-end deal scanner: scan_markets + per-pair external mid comparison + filter ≥ min_deviation_bps. Returns ranked good_sell / good_buy / fair lists. Default benchmark = median of 3 free external FX sources (Frankfurter / open.er-api / exchangerate.host). Use_multi_source:false to compare against Sera's own /fx/rate instead.",
    schema: FindDealsInput,
    handler: (args: any) => findDeals(ctx, args ?? {}),
  },
  {
    name: "sera.maker_quote_ladder",
    description:
      "Spread-ladder calculator for makers. Given a pair, notional, and (optional) mid, returns earnings at 5/10/15/25/50/100/200 bps. Mid auto-fetched from multi-source median by default. Mirrors the Sera Spread Calculator UX as a single tool call.",
    schema: MakerQuoteLadderInput,
    handler: (args: any) => makerQuoteLadder(ctx, args),
  },
  {
    name: "sera.multi_source_mid",
    description:
      "Median FX mid across 3 free external sources (Frankfurter / open.er-api / exchangerate.host). Per-source rate, median, range_bps. Inputs accept ISO fiat ('USD') or Sera token symbol ('USDC'). Resilient to a single source being down.",
    schema: MultiSourceMidInput,
    handler: (args: any) => multiSourceMid(ctx, args),
  },
  {
    name: "sera.probe_depth",
    description:
      "Quote one corridor at a ladder of sizes to characterize price impact. Returns price-impact bps relative to the smallest probe. Use before sizing a real trade. Default sizes: [100, 1000, 10000, 100000].",
    schema: ProbeDepthInput,
    handler: (args: any) => probeDepth(ctx, args),
  },
  {
    name: "sera.round_trip_cost",
    description:
      "Cost of A→B→A in bps. The spread floor a maker on this pair needs to cover their hedge. Returns absolute loss + bps interpretation.",
    schema: RoundTripCostInput,
    handler: (args: any) => roundTripCost(ctx, args),
  },
  {
    name: "sera.infer_book",
    description:
      "Synthetic order book for a pair Sera doesn't publish a book for. Probes both directions at log-spaced sizes and constructs bid/ask ladders + a synthetic spread. Use for visualizing depth, not for execution.",
    schema: InferBookInput,
    handler: (args: any) => inferBook(ctx, args),
  },
  {
    name: "sera.market_health",
    description:
      "Quick yes/no on whether a corridor is quotable right now. Fires a single $1 simulate quote and returns one of: quotable, no_liquidity, unknown_pair, error. Cheaper than burning a full quote when you only need pre-flight gating.",
    schema: MarketHealthInput,
    handler: (args: any) => marketHealth(ctx, args),
  },
  {
    name: "sera.fx_quote_diff",
    description:
      "Compare Sera's reference /fx/rate against the executable rate from a real quote at a chosen notional. Returns deviation in bps so an agent can decide if the displayed mid is close enough to the executable price to size a real swap.",
    schema: FxQuoteDiffInput,
    handler: (args: any) => fxQuoteDiff(ctx, args),
  },
  {
    name: "sera.compare_corridors",
    description:
      "Given a target output (currency + amount), rank candidate source currencies by USD-equivalent cost. Treasury planning: 'I need to deliver 5,000 SGD — which of my source assets does it cheapest?'",
    schema: CompareCorridorsInput,
    handler: (args: any) => compareCorridors(ctx, args),
  },
  // ---- Quote & execute ----
  {
    name: "sera.get_quote",
    description:
      "Single-use Sera swap quote. Returns route_params (EIP-712 Intent) for the agent to sign + uuid + fee breakdown. Pass simulate:true to probe with the burn address (no execution possible). Enforces server policy (whitelist, recipient, max notional, slippage). Quotes embed gas via gas_mode.",
    schema: GetQuoteInput,
    handler: (args: any) => getQuote(ctx, args),
  },
  {
    name: "sera.prepare_swap",
    description:
      "Alias of get_quote intended for execution-track flows. Same policy gates apply. Use this name in agent prompts when intent is clearly 'about to execute' vs 'just price discovery'.",
    schema: PrepareSwapInput,
    handler: (args: any) => prepareSwap(ctx, args),
  },
  {
    name: "sera.execute_swap",
    description:
      "Submit a signed swap quote (uuid + EIP-712 signature) to Sera. External signer mode: agent provides signature. Local mode: server signs route_params. Quotes are single-use — handle QUOTE_STALE/410 by re-quoting. Gated by POLICY_DRY_RUN and POLICY_DAILY_VOLUME_CAP_USD when set.",
    schema: ExecuteSwapInput,
    handler: (args: any) => executeSwap(ctx, args),
  },
  {
    name: "sera.convert_and_send",
    description:
      "High-level: quote A→B and deliver to recipient in one call. Requires SERA_SIGNER_MODE=local. For external signer, use get_quote → wallet sign → execute_swap.",
    schema: ConvertAndSendInput,
    handler: (args: any) => convertAndSend(ctx, args),
  },
  {
    name: "sera.quote_recipient_amount",
    description:
      "Inverse: 'I want them to receive exactly X of currency B — what do I send of currency A?' Uses /fx/rate then two real quotes to tighten. Does NOT execute.",
    schema: QuoteRecipientAmountInput,
    handler: (args: any) => quoteRecipientAmount(ctx, args),
  },
  {
    name: "sera.find_cheapest_settlement_path",
    description:
      "Compare gas-mode candidates (receive_less vs pay_more) for one A→B and rank by min_output. Use for planning; each candidate consumes its own UUID.",
    schema: FindCheapestPathInput,
    handler: (args: any) => findCheapestPath(ctx, args),
  },
  {
    name: "sera.limit_watcher",
    description:
      "Patient quote: poll /swap/quote on a fixed budget until target_rate hit (or budget exhausted). Sera has no native limit orders — this is a poor-man's version. Default 5 attempts × 6s = ~30s blocking. Returns hit:true with last quote OR hit:false with probe history.",
    schema: LimitWatcherInput,
    handler: (args: any) => limitWatcher(ctx, args),
  },
  {
    name: "sera.settlement_status",
    description:
      "Query Sera /orders for trade history or a specific trade. Filter by trade_id, uuid, owner_address, status, limit. Requires SERA_API_KEY/SERA_API_SECRET — surfaces a clear gate when missing.",
    schema: SettlementStatusInput,
    handler: (args: any) => settlementStatus(ctx, args ?? {}),
  },
  // ---- Treasury (require API key for balances) ----
  {
    name: "sera.get_balances",
    description:
      "Wallet + Vault balances for a wallet. Requires SERA_API_KEY/SERA_API_SECRET on the server. Output is normalized to human amounts.",
    schema: GetBalancesInput,
    handler: (args: any) => getBalances(ctx, args),
  },
  {
    name: "sera.treasury_value",
    description:
      "Aggregate balances across one or more wallets and value the portfolio in target_currency. Returns per-wallet rows + currency exposure breakdown. Requires SERA_API_KEY.",
    schema: TreasuryValueInput,
    handler: (args: any) => treasuryValue(ctx, args),
  },
  {
    name: "sera.exposure_report",
    description:
      "Slimmer cousin of treasury_value: just the currency mix and total. Use pre-trade ('am I over-exposed to MYR?').",
    schema: ExposureReportInput,
    handler: (args: any) => exposureReport(ctx, args),
  },
  {
    name: "sera.rebalance_plan",
    description:
      "Given target weights (by fiat code) and current balances, emit a list of suggested swaps to rebalance. PURE PLANNER — does not execute. Each suggested trade can be fed into get_quote.",
    schema: RebalancePlanInput,
    handler: (args: any) => rebalancePlan(ctx, args),
  },
  {
    name: "sera.pay_invoice",
    description:
      "'I owe X of currency Y to address Z — given my source assets, what's the cheapest path?' Fans out across each candidate source and ranks by USD-equivalent cost.",
    schema: PayInvoiceInput,
    handler: (args: any) => payInvoice(ctx, args),
  },
  // ---- History (requires SERA_HISTORY_DB) ----
  {
    name: "sera.fx_history",
    description:
      "Sera /fx/rate observations logged by THIS MCP since since_hours_ago. Requires SERA_HISTORY_DB env to be set. Sera doesn't publish OHLC — over time, the MCP becomes its own price feed.",
    schema: FxHistoryInput,
    handler: (args: any) => fxHistory(args),
  },
  {
    name: "sera.fx_volatility",
    description:
      "Stats over fx_history window: mean, stdev, range_bps, annualized vol estimate. Requires SERA_HISTORY_DB.",
    schema: FxHistoryInput,
    handler: (args: any) => fxVolatility(args),
  },
  {
    name: "sera.corridor_pnl",
    description:
      "What would holding the long side of this pair have realized over the window? Mark-to-market based on logged Sera /fx/rate; doesn't include swap costs. Requires SERA_HISTORY_DB.",
    schema: FxHistoryInput,
    handler: (args: any) => corridorPnl(args),
  },
  // ---- Admin ----
  {
    name: "sera.doctor",
    description:
      "One-call self-check: API health, network sanity, signer mode, policy summary, persistence state. Use for quick 'is everything wired right' debugging.",
    schema: DoctorInput,
    handler: () => doctor(ctx),
  },
];

const server = new Server(
  {
    name: "sera-mcp",
    version: "0.4.0",
  },
  {
    capabilities: { tools: {}, resources: {}, prompts: {} },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.schema),
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS.find((t) => t.name === req.params.name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
    };
  }
  try {
    const parsed = tool.schema.parse(req.params.arguments ?? {});
    const t0 = Date.now();
    const result = await tool.handler(parsed);
    log.debug("tool ok", { tool: tool.name, ms: Date.now() - t0 });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err: any) {
    log.warn("tool error", { tool: tool.name, error: err?.message ?? String(err) });
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Error in ${tool.name}: ${err?.message ?? String(err)}`,
        },
      ],
    };
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: listResources(),
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const r = await readResource(ctx, req.params.uri);
  return { contents: [r] };
});

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: listPrompts(),
}));

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const p = getPrompt(req.params.name, (req.params.arguments ?? {}) as Record<string, string>);
  return p;
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is fine for status — stdout is reserved for the MCP transport.
  try {
    const cfg = await ctx.sera.getConfig();
    const chainId = Number(cfg.chain_id);
    const expected = ctx.cfg.network === "mainnet" ? 1 : 11155111;
    if (Number.isFinite(chainId) && chainId !== expected) {
      log.warn("network label mismatch", {
        SERA_NETWORK: ctx.cfg.network,
        chain_id: chainId,
        expected,
      });
    }
  } catch (e: any) {
    log.warn("config probe failed", { error: e?.message ?? String(e) });
  }
  log.info("sera-mcp ready", {
    version: "0.4.0",
    network: ctx.cfg.network,
    base_url: ctx.cfg.baseUrl,
    signer: ctx.cfg.signerMode,
    tools: TOOLS.length,
    history: process.env.SERA_HISTORY_DB ? "enabled" : "disabled",
  });
}

main().catch((err) => {
  log.error("fatal", { error: err?.stack ?? String(err) });
  process.exit(1);
});

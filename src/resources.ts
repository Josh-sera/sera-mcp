import type { AppContext } from "./config.js";
import { getTokensCached } from "./sera/tokens.js";

/**
 * MCP resources are read-only handles hosts can subscribe to or read directly.
 * Useful for "I want to know what's available" questions without burning tool budget.
 *
 * URIs follow sera://<topic> convention.
 */

export interface ResourceDescriptor {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface ResourceContents {
  uri: string;
  mimeType: string;
  text: string;
}

export function listResources(): ResourceDescriptor[] {
  return [
    {
      uri: "sera://currencies",
      name: "Sera supported currencies",
      description: "Live token registry from /tokens, including symbol, fiat tag, address, decimals.",
      mimeType: "application/json",
    },
    {
      uri: "sera://markets",
      name: "Sera trading pairs",
      description: "Active trading pair catalog from /markets.",
      mimeType: "application/json",
    },
    {
      uri: "sera://config",
      name: "Sera protocol config",
      description: "chain_id, sera_address, vault_address, sor_address.",
      mimeType: "application/json",
    },
    {
      uri: "sera://help/tools",
      name: "Tool reference",
      description: "Names + descriptions of every sera.* tool.",
      mimeType: "text/markdown",
    },
    {
      uri: "sera://help/quickstart",
      name: "Quickstart",
      description: "Five common agent patterns with example tool calls.",
      mimeType: "text/markdown",
    },
  ];
}

export async function readResource(ctx: AppContext, uri: string): Promise<ResourceContents> {
  switch (uri) {
    case "sera://currencies": {
      const tokens = await getTokensCached(ctx.sera);
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify({ count: tokens.length, tokens }, null, 2),
      };
    }
    case "sera://markets": {
      const m = await ctx.sera.getMarkets();
      return { uri, mimeType: "application/json", text: JSON.stringify(m, null, 2) };
    }
    case "sera://config": {
      const c = await ctx.sera.getConfig();
      return { uri, mimeType: "application/json", text: JSON.stringify(c, null, 2) };
    }
    case "sera://help/tools": {
      return { uri, mimeType: "text/markdown", text: TOOLS_HELP };
    }
    case "sera://help/quickstart": {
      return { uri, mimeType: "text/markdown", text: QUICKSTART };
    }
    default:
      throw new Error(`Unknown resource: ${uri}`);
  }
}

const TOOLS_HELP = `# sera.* tool reference (32 tools)

## Discovery
- **sera.list_currencies** — registry of supported stablecoins (filterable by fiat).
- **sera.get_markets** — pair catalog. "Pair exists" ≠ "tradeable now"; check via scan_markets.

## Pricing & analytics (no liquidity needed)
- **sera.get_fx_rate** — Sera's reference FX. Has bid/ask asymmetry; pair with compare_to_external_fx.
- **sera.compare_to_external_fx** — Sera vs Frankfurter (ECB) mid. Detects pricing-source bias.
- **sera.multi_source_mid** — median FX mid across 3 free sources (Frankfurter / open.er-api / exchangerate.host) with range_bps.
- **sera.spread_radar** — pair asymmetry + triangular drift across a basket. Pre-flight integrity check.

## Liquidity probing
- **sera.scan_markets** — fan out probes across many pairs. Built for the deal-scanner pattern.
- **sera.find_deals** — scan + external mid comparison + filter ≥X bps. Native deal scanner in one call.
- **sera.probe_depth** — quote at a size ladder; price-impact curve for one corridor.
- **sera.round_trip_cost** — A→B→A cost in bps. Maker spread floor.
- **sera.infer_book** — synthetic order book inferred from probes in both directions.

## Quote & execute
- **sera.get_quote / sera.prepare_swap** — single-use quote + EIP-712 Intent. Pass simulate=true to probe with no wallet.
- **sera.execute_swap** — submit signed quote. uuid binding + server-derived USD notional enforced.
- **sera.convert_and_send** — quote+execute in one call (local signer mode only).
- **sera.quote_recipient_amount** — inverse: "send recipient exactly X of currency Y; what's the input?"
- **sera.find_cheapest_settlement_path** — compare gas modes for one corridor.
- **sera.limit_watcher** — patient quote: poll until target_rate hit or budget exhausted.

## Maker
- **sera.maker_quote_ladder** — earnings table at 5/10/15/25/50/100/200 bps for a given pair + notional.

## Treasury (require SERA_API_KEY)
- **sera.get_balances** — wallet + Vault balances.
- **sera.treasury_value** — aggregate balances across N wallets, valued in target currency.
- **sera.exposure_report** — currency-mix breakdown only.
- **sera.rebalance_plan** — given target weights, emit suggested trades (planner only).
- **sera.pay_invoice** — "I owe X in currency Y; cheapest source asset to pay it?"

## Settlement (requires SERA_API_KEY)
- **sera.settlement_status** — query Sera /orders for trade history or specific trade.

## History (requires SERA_HISTORY_DB)
- **sera.fx_history / sera.fx_volatility / sera.corridor_pnl** — series + stats from logged calls.

## Admin
- **sera.doctor** — health, config sanity, signer mode, policy summary, persistence state in one call.
`;

const QUICKSTART = `# Sera MCP — quickstart

## 1. "What can Sera do?"
\`\`\`
sera.list_currencies(fiat: "SGD")
sera.doctor()
\`\`\`

## 2. "Find me deals right now"
\`\`\`
sera.scan_markets(notional_per_quote: 100, max_pairs: 20)
\`\`\`
Then for each quotable result: \`sera.compare_to_external_fx({base, quote})\` to filter for actual deviations from market mid.

## 3. "Quote an FX without a wallet"
\`\`\`
sera.get_quote(from: "USDC", to: "XSGD", amount: 100, simulate: true)
\`\`\`

## 4. "Pay someone exactly 5,000 MYR using my USDC"
\`\`\`
sera.pay_invoice(
  owner_address: "0x...",
  recipient:    "0x...",
  amount: 5000,
  target_currency: "MYR",
  source_symbols: ["USDC", "USDT", "EURC"]
)
\`\`\`

## 5. "Treasury health"
\`\`\`
sera.treasury_value(owner_addresses: ["0x...", "0x..."], target_currency: "SGD")
sera.exposure_report(owner_addresses: ["0x..."])
sera.rebalance_plan(owner_addresses: ["0x..."], target_weights: {USD:40, SGD:30, MYR:20, EUR:10})
\`\`\`

## 6. "Is Sera's price source consistent?"
\`\`\`
sera.spread_radar(currencies: ["USD","SGD","MYR","EUR","GBP","JPY"])
\`\`\`

## Tips
- All read endpoints are 60s-cached server-side — fan out without throttling concerns.
- Quotes are single-use UUIDs. Re-quote on QUOTE_STALE/410.
- Set \`SERA_HISTORY_DB=/path/to/file.db\` to unlock fx_history / fx_volatility / corridor_pnl.
- \`POLICY_PRESET=standard\` is a sensible default. Override individual fields with \`POLICY_*\` env vars.
`;

/**
 * MCP prompts — canned templates hosts surface as slash commands. Each returns
 * a list of messages the host injects into its conversation.
 *
 * SECURITY NOTE: every interpolated arg is run through `src/util/sanitize.ts`
 * before substitution. Free-form text would let a caller inject instructions
 * into the LLM message body — every prompt arg therefore has a strict shape
 * (number, address, fiat code, symbol list, etc.) and the helpers throw on miss.
 * If you add a new prompt arg, validate it.
 */
import {
  safeAddress,
  safeAddressList,
  safeFiat,
  safeFiatList,
  safeNumber,
  safeSymbolList,
} from "./util/sanitize.js";

export interface PromptDescriptor {
  name: string;
  description: string;
  arguments?: Array<{ name: string; description: string; required?: boolean }>;
}

export interface PromptMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
}

export function listPrompts(): PromptDescriptor[] {
  return [
    {
      name: "sera.deal_scan",
      description: "Find pairs where Sera's executable rate beats external mid by >X bps right now.",
      arguments: [
        { name: "min_deviation_bps", description: "Minimum positive deviation to surface (e.g. 25)." },
        { name: "notional", description: "Probe size per pair (default 100)." },
      ],
    },
    {
      name: "sera.treasury_brief",
      description: "Snapshot of treasury value + currency exposure across one or more wallets.",
      arguments: [
        { name: "addresses", description: "Comma-separated 0x... wallets.", required: true },
        { name: "target_currency", description: "Reporting currency. Default 'USD'." },
      ],
    },
    {
      name: "sera.invoice_optimizer",
      description: "Given a payable in a target fiat, pick the cheapest source asset to pay it with.",
      arguments: [
        { name: "amount", description: "Payable amount.", required: true },
        { name: "target_currency", description: "Fiat the recipient wants (SGD, MYR, ...).", required: true },
        { name: "recipient", description: "0x recipient address.", required: true },
        { name: "owner", description: "Your 0x wallet.", required: true },
        { name: "sources", description: "Comma-separated source symbols (USDC,USDT,EURC,...)." },
      ],
    },
    {
      name: "sera.fx_integrity_check",
      description: "Run spread_radar + compare_to_external_fx across a basket; surface only real outliers.",
      arguments: [
        { name: "currencies", description: "Comma-separated ISO codes. Default USD,SGD,MYR,EUR,GBP,JPY." },
      ],
    },
  ];
}

export function getPrompt(
  name: string,
  args: Record<string, string> = {},
): { description: string; messages: PromptMessage[] } {
  switch (name) {
    case "sera.deal_scan": {
      const min = safeNumber("min_deviation_bps", args.min_deviation_bps, 25);
      const notional = safeNumber("notional", args.notional, 100);
      return {
        description: "Sera deal scan",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Scan Sera markets for actual deals right now. Steps:\n` +
                `1. Call sera.scan_markets(notional_per_quote: ${notional}, max_pairs: 50) to find quotable corridors.\n` +
                `2. For each quotable pair, call sera.compare_to_external_fx({base, quote}) to compare against ECB mid.\n` +
                `3. Filter for deviations >= ${min}bps in Sera's favor (sera_above for buy-side, sera_below for sell-side).\n` +
                `4. Report a ranked list with pair, Sera rate, external mid, deviation_bps, and which direction is the deal.\n` +
                `5. Note Sera's known systematic ~150-300bps downward bias in /fx/rate so users don't confuse bias with opportunity.`,
            },
          },
        ],
      };
    }
    case "sera.treasury_brief": {
      const addrs = safeAddressList("addresses", args.addresses);
      const ccy = safeFiat("target_currency", args.target_currency, "USD");
      const addrList = addrs.map((a) => `"${a}"`).join(", ");
      return {
        description: "Treasury brief",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Produce a treasury brief for ${addrs.length} wallet(s).\n\n` +
                `1. Call sera.treasury_value(owner_addresses: [${addrList}], target_currency: "${ccy}").\n` +
                `2. Summarize: total value in ${ccy}, top 3 currency exposures with %, any wallets with errors.\n` +
                `3. Flag if any single fiat exposure >70% (concentration risk) or <5% targets (drift).\n` +
                `4. Suggest a sera.rebalance_plan call with sensible default weights if the user wants to act.`,
            },
          },
        ],
      };
    }
    case "sera.invoice_optimizer": {
      const amount = safeNumber("amount", args.amount);
      const targetCcy = safeFiat("target_currency", args.target_currency);
      const recipient = safeAddress("recipient", args.recipient);
      const owner = safeAddress("owner", args.owner);
      const sources = safeSymbolList(
        "sources",
        args.sources,
        ["USDC", "USDT", "EURC", "XSGD", "JPYC", "MYRT", "TGBP"],
      );
      const sourceList = sources.map((s) => `"${s}"`).join(", ");
      return {
        description: "Invoice optimizer",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Plan the cheapest way to pay this invoice:\n` +
                `- amount: ${amount}\n` +
                `- target_currency: ${targetCcy}\n` +
                `- recipient: ${recipient}\n` +
                `- owner: ${owner}\n` +
                `- sources: [${sourceList}]\n\n` +
                `1. Call sera.pay_invoice with the parameters above.\n` +
                `2. Present the cheapest source, runner-up, and any sources that failed (with reason).\n` +
                `3. If cheapest succeeds: hand the user the exact sera.get_quote call to execute (with simulate:false and the source symbol).`,
            },
          },
        ],
      };
    }
    case "sera.fx_integrity_check": {
      const ccys = safeFiatList("currencies", args.currencies, ["USD", "SGD", "MYR", "EUR", "GBP", "JPY"]);
      const ccyList = ccys.map((c) => `"${c}"`).join(", ");
      return {
        description: "FX integrity check",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Check Sera FX consistency across [${ccys.join(",")}].\n\n` +
                `1. Call sera.spread_radar(currencies: [${ccyList}], spread_alert_bps: 100, triangular_alert_bps: 100).\n` +
                `2. For each flagged pair, also call sera.compare_to_external_fx to confirm deviation is real (not just Sera bid/ask).\n` +
                `3. Summarize: which pairs/triangles are most off, and where the deviation likely originates (Sera rate side vs ECB).\n` +
                `4. End with a short note on whether any of these would be actionable as a trade vs just a metric.`,
            },
          },
        ],
      };
    }
    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
}

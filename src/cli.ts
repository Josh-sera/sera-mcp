#!/usr/bin/env node
/**
 * sera CLI — terminal-first access to Sera's multi-currency settlement.
 *
 * Wraps the same tool handlers the MCP server uses, so anything an AI agent
 * can do via sera.* tools, you can do via `sera <command>` from a shell.
 *
 * Built for:
 *   - Cron jobs and CI scripts that don't want an LLM in the loop
 *   - Operational debugging without spinning up an agent host
 *   - Power users who prefer terminal commands over chat interfaces
 *
 * Examples:
 *   sera doctor
 *   sera list-currencies --fiat SGD
 *   sera fx USD SGD
 *   sera quote USDC XSGD 100 --simulate
 *   sera scan --max-pairs 20
 *   sera deals --min-bps 25
 *   sera spread-radar USD,SGD,MYR,EUR,GBP,JPY
 *   sera market-health USDC XSGD
 *   sera ladder USDT JPYC 30000
 *
 * --json on any command returns raw JSON for piping into jq / scripts.
 */

import { loadConfig } from "./config.js";
import { listCurrencies, getMarkets, getFxRate, getQuote } from "./tools/core.js";
import { spreadRadar } from "./tools/insights.js";
import { scanMarkets } from "./tools/scan.js";
import { compareToExternalFx } from "./tools/external.js";
import { probeDepth, roundTripCost } from "./tools/depth.js";
import { findDeals } from "./tools/deals.js";
import { makerQuoteLadder, multiSourceMid } from "./tools/maker.js";
import { marketHealth, fxQuoteDiff } from "./tools/health_corridors.js";
import { doctor } from "./tools/admin.js";

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function printResult(result: unknown, jsonMode: boolean): void {
  if (jsonMode) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  // Pretty-print: still JSON, but with light formatting for human reading.
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

function fail(msg: string, code = 1): never {
  process.stderr.write("error: " + msg + "\n");
  process.exit(code);
}

const HELP = `sera — multi-currency settlement CLI (powered by the Sera MCP)

Usage:
  sera <command> [args] [--json]

Commands:
  doctor                                   Self-check: API, network, signer, policy
  list-currencies [--fiat SGD]             List supported stablecoins (filter by fiat)
  markets                                  List active trading-pair catalog
  fx <base> <quote>                        Sera reference FX rate (e.g. fx USD SGD)
  multi-mid <base> <quote>                 Median FX mid across 3 external sources
  compare-fx <base> <quote>                Diff Sera vs Frankfurter (ECB) mid
  spread-radar [USD,SGD,MYR,...]           Pair asymmetry + triangular drift report
  market-health <from> <to>                Quick yes/no on whether a pair is quotable
  fx-diff <from> <to> [--notional 100]     Sera reference vs executable rate diff
  quote <from> <to> <amount> [--simulate]  Get a swap quote (route_params + uuid)
  scan [--max-pairs 20] [--notional 100]   Probe many pairs in parallel
  deals [--min-bps 25] [--max-pairs 50]    Scan + diff vs external mid + filter
  depth <from> <to> [--sizes 100,1k,10k]   Price-impact ladder for one corridor
  rt-cost <from> <to> <amount>             Round-trip A→B→A cost in bps
  ladder <base> <quote> <notional>         Maker spread ladder (5/10/15/25/50/100 bps)

Global flags:
  --json                                   Return raw JSON instead of pretty-printed
  --help, -h                               Show this help

Environment (override defaults):
  SERA_NETWORK=mainnet|sepolia
  POLICY_PRESET=starter|standard|sg-retail|open
  SERA_API_KEY, SERA_API_SECRET            (for treasury / settlement tools)
  SERA_HISTORY_DB=/path/to/log.db          (enables fx_history / volatility)
  LOG_LEVEL=warn                           (default 'warn' to keep CLI output clean)

Examples:
  sera doctor
  sera fx USD SGD --json | jq .rate
  sera quote USDC XSGD 100 --simulate
  sera deals --min-bps 30 --max-pairs 30
  sera ladder USDT JPYC 30000
`;

function parseSizes(raw: string | boolean | undefined): number[] | undefined {
  if (typeof raw !== "string") return undefined;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .map((s) => {
      if (s.endsWith("k")) return Number(s.slice(0, -1)) * 1_000;
      if (s.endsWith("m")) return Number(s.slice(0, -1)) * 1_000_000;
      return Number(s);
    })
    .filter((n) => Number.isFinite(n) && n > 0);
}

async function main(): Promise<void> {
  // Default to quiet logs for CLI use; callers can override via env.
  if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = "warn";

  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const command = argv[0];
  const { positional, flags } = parseArgs(argv.slice(1));
  const json = !!flags.json;

  const ctx = loadConfig();

  try {
    switch (command) {
      case "doctor": {
        printResult(await doctor(ctx), json);
        break;
      }

      case "list-currencies":
      case "tokens": {
        printResult(
          await listCurrencies(ctx, { fiat: flags.fiat as string | undefined }),
          json,
        );
        break;
      }

      case "markets": {
        printResult(await getMarkets(ctx), json);
        break;
      }

      case "fx": {
        const [base, quote] = positional;
        if (!base || !quote) fail("usage: sera fx <base> <quote>");
        printResult(await getFxRate(ctx, { base, quote }), json);
        break;
      }

      case "multi-mid": {
        const [base, quote] = positional;
        if (!base || !quote) fail("usage: sera multi-mid <base> <quote>");
        printResult(await multiSourceMid(ctx, { base, quote }), json);
        break;
      }

      case "compare-fx": {
        const [base, quote] = positional;
        if (!base || !quote) fail("usage: sera compare-fx <base> <quote>");
        printResult(await compareToExternalFx(ctx, { base, quote }), json);
        break;
      }

      case "spread-radar":
      case "radar": {
        const list = positional[0];
        const currencies = list ? list.split(",").map((c) => c.trim().toUpperCase()) : undefined;
        printResult(
          await spreadRadar(ctx, {
            currencies,
            spread_alert_bps: flags["spread-bps"] ? Number(flags["spread-bps"]) : undefined,
            triangular_alert_bps: flags["tri-bps"] ? Number(flags["tri-bps"]) : undefined,
          }),
          json,
        );
        break;
      }

      case "market-health":
      case "health": {
        const [from, to] = positional;
        if (!from || !to) fail("usage: sera market-health <from> <to>");
        printResult(await marketHealth(ctx, { from, to }), json);
        break;
      }

      case "fx-diff": {
        const [from, to] = positional;
        if (!from || !to) fail("usage: sera fx-diff <from> <to> [--notional 100]");
        printResult(
          await fxQuoteDiff(ctx, {
            from,
            to,
            notional: flags.notional ? Number(flags.notional) : undefined,
          }),
          json,
        );
        break;
      }

      case "quote": {
        const [from, to, amount] = positional;
        if (!from || !to || !amount) fail("usage: sera quote <from> <to> <amount> [--simulate]");
        printResult(
          await getQuote(ctx, {
            from,
            to,
            amount: Number(amount),
            owner_address: (flags.owner as string) ?? undefined,
            recipient: (flags.recipient as string) ?? undefined,
            gas_mode: ((flags["gas-mode"] as string) ?? "receive_less") as any,
            simulate: !!flags.simulate,
          }),
          json,
        );
        break;
      }

      case "scan": {
        printResult(
          await scanMarkets(ctx, {
            max_pairs: flags["max-pairs"] ? Number(flags["max-pairs"]) : undefined,
            notional_per_quote: flags.notional ? Number(flags.notional) : undefined,
            max_concurrency: flags.concurrency ? Number(flags.concurrency) : undefined,
            only_policy_allowed: flags.all ? false : undefined,
          }),
          json,
        );
        break;
      }

      case "deals": {
        printResult(
          await findDeals(ctx, {
            min_deviation_bps: flags["min-bps"] ? Number(flags["min-bps"]) : undefined,
            max_pairs: flags["max-pairs"] ? Number(flags["max-pairs"]) : undefined,
            notional_per_quote: flags.notional ? Number(flags.notional) : undefined,
            use_multi_source: flags["sera-mid"] ? false : undefined,
          }),
          json,
        );
        break;
      }

      case "depth": {
        const [from, to] = positional;
        if (!from || !to) fail("usage: sera depth <from> <to> [--sizes 100,1k,10k]");
        printResult(
          await probeDepth(ctx, {
            from,
            to,
            sizes: parseSizes(flags.sizes),
            gas_mode: ((flags["gas-mode"] as string) ?? "receive_less") as any,
          }),
          json,
        );
        break;
      }

      case "rt-cost":
      case "round-trip": {
        const [from, to, amount] = positional;
        if (!from || !to || !amount) fail("usage: sera rt-cost <from> <to> <amount>");
        printResult(
          await roundTripCost(ctx, { from, to, amount: Number(amount) }),
          json,
        );
        break;
      }

      case "ladder": {
        const [base, quote, notional] = positional;
        if (!base || !quote || !notional)
          fail("usage: sera ladder <base> <quote> <notional> [--mid 157.50] [--role maker_buy_base]");
        printResult(
          await makerQuoteLadder(ctx, {
            base,
            quote,
            notional: Number(notional),
            mid: flags.mid ? Number(flags.mid) : undefined,
            mid_source: flags["mid-source"] as any,
            role: flags.role as any,
          }),
          json,
        );
        break;
      }

      default: {
        fail(`unknown command: ${command}\nrun 'sera --help' for usage`);
      }
    }
  } catch (e: any) {
    fail(e?.message ?? String(e));
  }
}

main();

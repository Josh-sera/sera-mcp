# sera-mcp

A Model Context Protocol server that turns any agent into a multi-currency agent by exposing [Sera Protocol](https://docs.sera.cx) — stablecoin FX settlement — as one standard tool layer. 32 tools, 5 resources, 4 slash-prompt templates. Works with Claude Code, Claude Desktop, Cursor, OpenAI Agents SDK, **OpenClaw**, **Hermes**, **NanoClaw**, and any other MCP-compatible host.

**Site: [josh-sera.github.io/sera-agents](https://josh-sera.github.io/sera-agents/)** · **Suite: [Josh-sera/sera-agents](https://github.com/Josh-sera/sera-agents)**

This package also ships a `sera` CLI for cron jobs, CI scripts, and ops debugging — see [CLI section](#cli) below.

## What you get

**32 tools across 9 categories:**

| Category | Tools |
|---|---|
| Discovery | `list_currencies`, `get_markets` |
| Pricing & analytics | `get_fx_rate`, `compare_to_external_fx`, `multi_source_mid`, `spread_radar` |
| Liquidity probing | `scan_markets`, `find_deals`, `probe_depth`, `round_trip_cost`, `infer_book` |
| Quote & execute | `get_quote`, `prepare_swap`, `execute_swap`, `convert_and_send`, `quote_recipient_amount`, `find_cheapest_settlement_path`, `limit_watcher` |
| Maker | `maker_quote_ladder` |
| Treasury | `get_balances`, `treasury_value`, `exposure_report`, `rebalance_plan`, `pay_invoice` |
| Settlement | `settlement_status` |
| History | `fx_history`, `fx_volatility`, `corridor_pnl` |
| Admin | `doctor` |

**5 resources** (`sera://currencies`, `sera://markets`, `sera://config`, `sera://help/tools`, `sera://help/quickstart`) — hosts can browse without burning tool-call budget.

**4 slash-prompt templates** for common workflows: `sera.deal_scan`, `sera.treasury_brief`, `sera.invoice_optimizer`, `sera.fx_integrity_check`.

## Install

```bash
git clone <this-repo>
cd sera-mcp
npm install
npm run build
```

Requires Node 18.17+. Default install needs **zero env vars** — sensible defaults are baked in.

## Wire it in

### Claude Code (one line)

```bash
claude mcp add sera --scope user \
  --env SERA_NETWORK=mainnet \
  --env POLICY_PRESET=standard \
  -- node /absolute/path/to/sera-mcp/dist/index.js
```

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sera": {
      "command": "node",
      "args": ["/absolute/path/to/sera-mcp/dist/index.js"],
      "env": {
        "SERA_NETWORK": "mainnet",
        "POLICY_PRESET": "standard"
      }
    }
  }
}
```

### Cursor

Settings → MCP → add a stdio server pointing at `node /absolute/path/to/sera-mcp/dist/index.js` with the same env.

### Any MCP client over stdio

```bash
SERA_NETWORK=mainnet POLICY_PRESET=standard node dist/index.js
```

Speaks MCP over stdio. The server prints structured JSON status to stderr; stdout is reserved for the protocol.

## Verify install

In a new agent session, ask:

```
Call sera.doctor()
```

Returns a one-shot self-check: API health, network sanity, signer mode, policy summary, persistence state. If everything is green you're wired correctly.

## Configure

Most installs need nothing. Override via env:

### Network

| Variable | Default | Effect |
|---|---|---|
| `SERA_NETWORK` | `mainnet` | `mainnet` → `https://api.sera.cx/api/v1`. `sepolia` → `https://api-sepolia.sera.cx/api/v1`. URLs are hardcoded; you cannot redirect them via env. |

### Signer

| Mode | What happens |
|---|---|
| `external` (default) | Server **never** signs. `get_quote` returns `route_params`; your wallet signs externally; `execute_swap` accepts the signature. Safe for distribution. |
| `local` | Server holds `SIGNER_PRIVATE_KEY` and signs in-process. Enables `convert_and_send`. **Only use on a trusted server with a wallet you've intentionally funded.** |
| `readonly` | All execution tools refuse. Discovery + analytics only. |

### Policy presets

Pre-baked bundles. Pick one with `POLICY_PRESET=`:

| Preset | Symbols | Per-tx cap | Daily cap | Slippage |
|---|---|---|---|---|
| `starter` | USDC, USDT | $1,000 | $5,000 | 25 bps |
| `standard` (recommended) | USDC, USDT, XSGD, JPYC, MYRT, TGBP, EURC | $5,000 | $50,000 | 10 bps |
| `sg-retail` | USDC, USDT, XSGD | $2,000 | $10,000 | 15 bps |
| `open` | (none) | (none) | (none) | 0 | **Don't ship this.** |

Override individual fields by setting the matching env (`POLICY_MAX_NOTIONAL_USD`, `POLICY_DAILY_VOLUME_CAP_USD`, `POLICY_ALLOWED_SYMBOLS`, etc.). Each override beats the preset.

### Other

| Variable | Effect |
|---|---|
| `POLICY_DRY_RUN=true` | All `execute_swap` calls refuse, regardless of signer mode. Paper-trading mode. |
| `SERA_HISTORY_DB=/path/to/file.db` | Enables `fx_history`, `fx_volatility`, `corridor_pnl`. SQLite log of every fx_rate + quote call this MCP serves. |
| `LOG_LEVEL` | `trace` \| `debug` \| `info` (default) \| `warn` \| `error`. Structured JSON to stderr. |
| `SERA_API_KEY` + `SERA_API_SECRET` | Required for `get_balances`, `treasury_value`, `exposure_report`, `rebalance_plan`, `pay_invoice`, `settlement_status`. |

See `.env.example` for the full list with comments.

## Security model

Built for distribution. Every layer assumes the install instructions might be hostile.

- **Hardcoded base URLs**: `SERA_BASE_URL` is ignored by default. Overrides require a separately-named env (`SERA_BASE_URL_ALLOW_CUSTOM=true`) and emit a loud boot warning. A malicious install snippet can't redirect API traffic by setting one env var.
- **No redirects**: undici `maxRedirections: 0`. Even a sera.cx subdomain can't 301 us elsewhere.
- **Quote registry**: every `get_quote` registers `{uuid → frozen route_params}`. `execute_swap` refuses unknown uuids in local-signer mode (won't sign arbitrary intents) and refuses route_params mismatches in any mode.
- **Server-derived notional**: daily volume cap is computed from `route_params.maxInputAmount` × token's USD value. Caller cannot lie about it.
- **Prompt arg sanitization**: every prompt template arg is type-validated (address regex, fiat regex, numeric regex, symbol-list regex) before substitution into LLM context. Newline/SQL/instruction injections are rejected.
- **Policy gates**: symbol whitelist, recipient whitelist, per-tx notional cap, rolling 24h volume cap, dry-run kill-switch.
- **Signer modes**: server defaults to `external` and holds no key.
- **Caching**: read-only endpoints have TTL caches with in-flight de-dupe. Quotes never cached.
- **Logging**: structured JSON to stderr; never to stdout (which is reserved for MCP transport).

Run `sera.doctor` in any agent session for a live posture check.

## Execution flow (external signer)

1. Agent calls `sera.get_quote` with `from`, `to`, `amount`, `owner_address` (or `simulate: true` to probe with the burn address).
2. MCP validates the request against policy and calls Sera `POST /swap/quote`.
3. MCP returns `uuid` + `route_params` (the exact EIP-712 `Intent` struct) + caches the binding.
4. Wallet signs `route_params` under the Sera EIP-712 domain:
   ```js
   const domain = { name: 'Sera', version: '1', chainId, verifyingContract: seraAddress };
   const types = { Intent: [
     { name: 'taker', type: 'address' },
     { name: 'inputToken', type: 'address' },
     { name: 'outputToken', type: 'address' },
     { name: 'maxInputAmount', type: 'uint256' },
     { name: 'minOutputAmount', type: 'uint256' },
     { name: 'recipient', type: 'address' },
     { name: 'initialDepositAmount', type: 'uint256' },
     { name: 'uuid', type: 'uint256' },
     { name: 'deadline', type: 'uint48' },
   ]};
   const sig = await signer.signTypedData(domain, types, route_params);
   ```
5. Agent calls `sera.execute_swap` with `{ uuid, signature }`.

Quotes are single-use. On `QUOTE_STALE` / 410, re-quote — do not retry the same `uuid`.

## Architecture

```
┌────────┐    sera.get_quote        ┌───────────────┐     POST /swap/quote     ┌──────┐
│ Agent  │ ───────────────────────▶ │  sera-mcp     │ ───────────────────────▶ │ Sera │
│        │                          │ (cache+policy │                          │  API │
│        │ ◀── route_params + uuid  │  +registry)   │ ◀──── uuid + route       │      │
└────────┘                          └───────────────┘                          └──────┘
     │  sign route_params (EIP-712)
     ▼
 wallet / external signer
     │  signature
     ▼
sera.execute_swap (uuid + sig) ──▶ sera-mcp ──▶ POST /swap ──▶ Sera ──▶ on-chain settlement
                                       │
                                       └─ enforces uuid binding, daily cap, dry-run
```

Source layout:

```
src/
├── index.ts                    MCP server entrypoint, tool/resource/prompt registration
├── config.ts                   env loading, hardcoded URL allowlist, AppContext
├── resources.ts                MCP resources (sera://...)
├── prompts.ts                  slash-prompt templates with arg sanitization
├── sera/
│   ├── client.ts               REST client + TTL cache wrapper
│   ├── tokens.ts               token resolver, decimals math
│   └── types.ts
├── signer/signer.ts            EIP-712 signer (external | local | readonly)
├── policy/policy.ts            whitelist, caps, presets, dry-run, daily volume gate
├── tools/                      29 tool handlers
└── util/
    ├── cache.ts                TTL cache + in-flight de-dupe
    ├── limit.ts                bounded-concurrency runner
    ├── external_fx.ts          Frankfurter / open.er-api / exchangerate.host clients
    ├── persistence.ts          optional SQLite log
    ├── logger.ts               structured stderr JSON
    ├── quote_registry.ts       uuid → route_params binding
    └── sanitize.ts             prompt arg validators
```

## Roadmap

- **Subscriptions** — push deal alerts instead of polling. MCP spec supports it; needs server-side subscriber state.
- **Multi-hop SOR explorer** — for pairs with no direct corridor, plan via intermediate fiats.
- **Address risk screening** — sanctions / OFAC hooks (needs an external provider).
- **Approval/allowance manager** — `sera.approval_status` for ERC-20 approvals to the Sera vault.
- **Per-tool rate limits** — defend against polling-loop DoS on the upstream quote engine.

## CLI

This package ships a `sera` CLI alongside the MCP server. Same code, same Sera plumbing — just a different entry point for shell scripts and ops use.

```bash
# After build, either run directly:
node dist/cli.js doctor

# Or install globally for the `sera` command:
npm install -g .          # from this directory
# Or:
npm link                  # development convenience

sera doctor
sera fx USD SGD
sera quote USDC XSGD 100 --simulate
sera deals --min-bps 25 --json | jq
sera ladder USDT JPYC 30000
sera spread-radar USD,SGD,MYR,EUR,GBP,JPY
```

Run `sera --help` for the full command reference.

Built for:
- **Cron jobs / CI** — automated FX dumps, daily deal summaries, alerting
- **Ops debugging** — Sera engineering checking quote behavior without an agent
- **Power users** — terminal-first people who don't want an LLM in the loop

The CLI uses the same handlers as the MCP server so anything an agent can do via `sera.*` tools, the CLI exposes as a command. See [`src/cli.ts`](src/cli.ts).

Add `--json` to any command to get raw JSON for piping into `jq` / scripts.

## License

MIT

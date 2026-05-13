// Types mirror Sera's public REST API documented at docs.sera.cx.
// Keep these conservative — Sera evolves quickly; treat unknown fields as opaque.

export interface SeraToken {
  symbol: string;
  address: string;
  decimals: number;
  fiat_currency?: string; // e.g. "USD", "SGD", "MYR" — when Sera tags it
  name?: string;
}

export interface SeraMarket {
  base_token: string;       // address
  quote_token: string;      // address
  base_symbol: string;
  quote_symbol: string;
  display_pair: string;     // e.g. "XSGD/USDC"
}

export type GasMode = "receive_less" | "pay_more";

export interface SwapQuoteRequest {
  from_token: string;
  to_token: string;
  from_amount: string;       // raw token units
  owner_address: string;
  recipient: string;
  expiration: number;        // unix seconds
  gas_mode: GasMode;
}

// EIP-712 Intent struct (Sera SOR).
// Signed under: domain { name: "Sera", version: "1", chainId, verifyingContract: sera_address }
export interface SeraIntent {
  taker: string;
  inputToken: string;
  outputToken: string;
  maxInputAmount: string;    // uint256 as decimal string
  minOutputAmount: string;
  recipient: string;
  initialDepositAmount: string;
  uuid: string;              // uint256 as decimal string
  deadline: number;          // uint48
}

export interface SwapQuoteResponse {
  uuid: string;
  route_params: SeraIntent;
  fee_breakdown?: {
    gas_cost_usd?: string;
    gas_cost_from_token?: string;
  };
  expires_at: number;
  // Sera may include richer route preview / price info; pass through opaque.
  [k: string]: unknown;
}

export interface SwapExecuteRequest {
  uuid: string;
  signature: string;
}

export interface SwapExecuteResponse {
  success: boolean;
  trade_id?: string;
  [k: string]: unknown;
}

export interface BalanceRow {
  symbol: string;
  address: string;
  decimals: number;
  wallet_balance: string;     // raw uint256
  vault_available: string;
  vault_frozen: string;
}

export interface BalancesResponse {
  balances: BalanceRow[];
}

export interface FxRateResponse {
  base: string;
  quote: string;
  rate: string;
  change_24h?: string;
  source?: string;
}

export interface SeraConfig {
  chain_id: number;
  sera_address: string;
  vault_address: string;
  sor_address: string;
  [k: string]: unknown;
}

export interface SeraErrorBody {
  detail?: string | { detail?: string; error_code?: string };
}

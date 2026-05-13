import type { AppContext } from "../config.js";
import { SeraApiError } from "../sera/client.js";

/**
 * settlement_status — query Sera's /orders endpoint for trade history / a
 * specific trade. Requires SERA_API_KEY/SECRET. Without auth the endpoint
 * returns 401; this tool surfaces a clear error so agents know what's missing.
 *
 * The exact filter shape Sera accepts varies by version; we pass through
 * whatever the caller provides. Common ones to try:
 *   - owner_address
 *   - trade_id
 *   - uuid
 *   - status
 *   - limit
 */
export async function settlementStatus(
  ctx: AppContext,
  args: {
    trade_id?: string;
    uuid?: string;
    owner_address?: string;
    status?: string;
    limit?: number;
  },
) {
  // Pre-flight: surface an actionable error when API key isn't wired.
  // (We can't introspect SeraClient internals, but a 401 from the call is the
  // canonical signal — wrap it into a clear message.)
  const filters: Record<string, string | number> = {};
  if (args.trade_id) filters.trade_id = args.trade_id;
  if (args.uuid) filters.uuid = args.uuid;
  if (args.owner_address) filters.owner_address = args.owner_address;
  if (args.status) filters.status = args.status;
  if (args.limit) filters.limit = args.limit;

  try {
    const r = await ctx.sera.getOrders(filters);
    return {
      filters_used: filters,
      result: r,
      note:
        "Pass-through from /orders. Sera response shape isn't normalized here — agents should inspect fields directly.",
    };
  } catch (e: any) {
    if (e instanceof SeraApiError && e.status === 401) {
      throw new Error(
        "settlement_status requires SERA_API_KEY + SERA_API_SECRET on the MCP server. " +
          "Re-register the MCP with these env vars set.",
      );
    }
    if (e instanceof SeraApiError) {
      throw new Error(
        `sera ${e.status}${e.errorCode ? ` (${e.errorCode})` : ""}: ${e.message}`,
      );
    }
    throw e;
  }
}

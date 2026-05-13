/**
 * Server-side memory of quotes this MCP returned. Used to:
 *
 *   1. Refuse local-signer execute_swap on UUIDs we never issued (prevents the
 *      server from EIP-712-signing arbitrary route_params an attacker crafts).
 *   2. Detect when a caller passes route_params that don't match what we
 *      returned for that uuid — also a refuse.
 *
 * In external signer mode this binding is informational; the upstream Sera
 * signature check is the real gate. In local mode it's the only gate, so it's
 * conservative: unknown uuid = refuse, mismatch = refuse.
 *
 * Entries auto-expire on access; expiration anchors to the quote's own deadline.
 */

interface RegistryEntry {
  route_params: Record<string, any>;
  registered_at: number;   // unix seconds
  expires_at: number;      // unix seconds
  estimated_usd_notional?: number;
}

const ENTRIES = new Map<string, RegistryEntry>();
const MAX_ENTRIES = 5_000;

function gc(): void {
  // Cheap probabilistic GC + bounded size.
  if (ENTRIES.size <= MAX_ENTRIES) return;
  const now = Math.floor(Date.now() / 1000);
  for (const [k, v] of ENTRIES) {
    if (v.expires_at < now) ENTRIES.delete(k);
  }
  // If still over cap, evict oldest by registration time.
  if (ENTRIES.size > MAX_ENTRIES) {
    const sorted = [...ENTRIES.entries()].sort((a, b) => a[1].registered_at - b[1].registered_at);
    for (let i = 0; i < sorted.length - MAX_ENTRIES; i++) ENTRIES.delete(sorted[i][0]);
  }
}

export function registerQuote(
  uuid: string,
  route_params: Record<string, any>,
  expires_at: number,
  estimated_usd_notional?: number,
): void {
  ENTRIES.set(uuid, {
    route_params,
    registered_at: Math.floor(Date.now() / 1000),
    expires_at,
    estimated_usd_notional,
  });
  gc();
}

export function lookupQuote(uuid: string): RegistryEntry | undefined {
  const hit = ENTRIES.get(uuid);
  if (!hit) return undefined;
  const now = Math.floor(Date.now() / 1000);
  if (hit.expires_at < now) {
    ENTRIES.delete(uuid);
    return undefined;
  }
  return hit;
}

/**
 * Stable structural equality for the route_params Intent object. Compares only
 * the fields Sera's EIP-712 signs over — opaque extras are ignored, so we don't
 * trip on differing field ordering or vendor metadata.
 */
const SIGNED_FIELDS = [
  "taker",
  "inputToken",
  "outputToken",
  "maxInputAmount",
  "minOutputAmount",
  "recipient",
  "initialDepositAmount",
  "uuid",
  "deadline",
];

export function routeParamsMatch(
  registered: Record<string, any>,
  candidate: Record<string, any>,
): { ok: true } | { ok: false; field: string; registered: unknown; candidate: unknown } {
  for (const f of SIGNED_FIELDS) {
    const a = registered[f];
    const b = candidate[f];
    if (String(a) !== String(b)) {
      return { ok: false, field: f, registered: a, candidate: b };
    }
  }
  return { ok: true };
}

export function registrySize(): number {
  return ENTRIES.size;
}

/**
 * Optional SQLite store. Three concerns share one file:
 *   1. fx_observations / quote_observations  — telemetry for fx_history etc.
 *   2. policy_volume                          — daily volume cap, atomic + cross-restart
 *   3. (future)                               — uuid registry persistence
 *
 * Schema is intentionally narrow — drop the file to reset.
 *
 * Privacy: owner_address logging can be hashed via SERA_HISTORY_HASH_OWNER (default true).
 * The DB file is chmod 0600 on first open to prevent multi-user leaks.
 */
import Database from "better-sqlite3";
import { chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { log } from "./logger.js";

let db: Database.Database | null = null;
let initialized = false;

const HASH_OWNER = (process.env.SERA_HISTORY_HASH_OWNER ?? "true").toLowerCase() !== "false";

function open(): Database.Database | null {
  if (initialized) return db;
  initialized = true;
  const path = process.env.SERA_HISTORY_DB;
  if (!path) {
    log.info("history persistence disabled (SERA_HISTORY_DB not set)");
    return null;
  }
  try {
    db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS fx_observations (
        ts INTEGER NOT NULL,
        base TEXT NOT NULL,
        quote TEXT NOT NULL,
        rate REAL NOT NULL,
        source TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_fx_pair_ts ON fx_observations(base, quote, ts);

      CREATE TABLE IF NOT EXISTS quote_observations (
        ts INTEGER NOT NULL,
        from_symbol TEXT NOT NULL,
        to_symbol TEXT NOT NULL,
        from_amount_human REAL NOT NULL,
        min_output_human REAL NOT NULL,
        gas_mode TEXT NOT NULL,
        owner_address TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_quote_pair_ts ON quote_observations(from_symbol, to_symbol, ts);

      CREATE TABLE IF NOT EXISTS policy_volume (
        ts INTEGER NOT NULL,
        signer_key TEXT NOT NULL,
        usd REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_policy_volume_signer_ts ON policy_volume(signer_key, ts);
    `);
    // Restrict file permissions for privacy (single-user 0600).
    try {
      chmodSync(path, 0o600);
    } catch {
      // best-effort
    }
    log.info("history persistence enabled", { path, hash_owner: HASH_OWNER });
  } catch (e: any) {
    log.warn("failed to open SERA_HISTORY_DB; persistence disabled", { error: e?.message ?? String(e) });
    db = null;
  }
  return db;
}

function maybeHashOwner(addr: string | undefined): string | null {
  if (!addr) return null;
  if (!HASH_OWNER) return addr;
  // Truncated SHA-256 — enough to correlate within a session, not enough to
  // reverse to the original address. Operators can opt out for ops needs.
  return "sha256:" + createHash("sha256").update(addr.toLowerCase()).digest("hex").slice(0, 16);
}

export function recordFx(base: string, quote: string, rate: number, source = "sera") {
  const d = open();
  if (!d) return;
  try {
    d.prepare(
      "INSERT INTO fx_observations (ts, base, quote, rate, source) VALUES (?, ?, ?, ?, ?)",
    ).run(Math.floor(Date.now() / 1000), base.toUpperCase(), quote.toUpperCase(), rate, source);
  } catch (e: any) {
    log.warn("recordFx failed", { error: e?.message });
  }
}

export function recordQuote(args: {
  from_symbol: string;
  to_symbol: string;
  from_amount_human: number;
  min_output_human: number;
  gas_mode: string;
  owner_address?: string;
}) {
  const d = open();
  if (!d) return;
  try {
    d.prepare(
      "INSERT INTO quote_observations (ts, from_symbol, to_symbol, from_amount_human, min_output_human, gas_mode, owner_address) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      Math.floor(Date.now() / 1000),
      args.from_symbol.toUpperCase(),
      args.to_symbol.toUpperCase(),
      args.from_amount_human,
      args.min_output_human,
      args.gas_mode,
      maybeHashOwner(args.owner_address),
    );
  } catch (e: any) {
    log.warn("recordQuote failed", { error: e?.message });
  }
}

export function recordExecutedNotional(usd: number, signerKey: string): void {
  const d = open();
  if (!d) throw new Error("persistence not enabled");
  d.prepare(
    "INSERT INTO policy_volume (ts, signer_key, usd) VALUES (?, ?, ?)",
  ).run(Math.floor(Date.now() / 1000), signerKey, usd);
}

export function rolling24hVolumeUsd(signerKey: string): number {
  const d = open();
  if (!d) throw new Error("persistence not enabled");
  const cutoff = Math.floor(Date.now() / 1000) - 24 * 3600;
  const row = d.prepare(
    "SELECT COALESCE(SUM(usd), 0) AS total FROM policy_volume WHERE signer_key = ? AND ts >= ?",
  ).get(signerKey, cutoff) as { total: number };
  return Number(row?.total ?? 0);
}

export function queryFxHistory(
  base: string,
  quote: string,
  sinceTs: number,
): Array<{ ts: number; rate: number; source: string }> {
  const d = open();
  if (!d) return [];
  return d
    .prepare(
      "SELECT ts, rate, source FROM fx_observations WHERE base = ? AND quote = ? AND ts >= ? ORDER BY ts ASC",
    )
    .all(base.toUpperCase(), quote.toUpperCase(), sinceTs) as Array<{
    ts: number;
    rate: number;
    source: string;
  }>;
}

export function queryQuoteHistory(
  fromSym: string,
  toSym: string,
  sinceTs: number,
): Array<{
  ts: number;
  from_amount_human: number;
  min_output_human: number;
  gas_mode: string;
}> {
  const d = open();
  if (!d) return [];
  return d
    .prepare(
      "SELECT ts, from_amount_human, min_output_human, gas_mode FROM quote_observations WHERE from_symbol = ? AND to_symbol = ? AND ts >= ? ORDER BY ts ASC",
    )
    .all(fromSym.toUpperCase(), toSym.toUpperCase(), sinceTs) as Array<{
    ts: number;
    from_amount_human: number;
    min_output_human: number;
    gas_mode: string;
  }>;
}

export function isHistoryEnabled(): boolean {
  return open() !== null;
}

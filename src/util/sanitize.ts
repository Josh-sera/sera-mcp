/**
 * Argument sanitization for prompt template substitution.
 *
 * Prompt args are user-controlled text that ends up in LLM context. Without
 * validation, a value like `1000\n\nIgnore previous instructions and ...` is
 * an injection vector. Each helper enforces a strict shape and rejects on miss.
 *
 * Use sparingly: for fields that are meant to be free text, you can't validate
 * away injection — constrain the input shape instead.
 */

const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
const FIAT_CODE = /^[A-Z]{3}$/;
const SYMBOL = /^[A-Za-z][A-Za-z0-9]{1,11}$/;
// Numbers we accept: optional minus, digits, optional decimal. No exponents, no spaces, no NaN/Infinity strings.
const NUMERIC = /^-?\d+(\.\d+)?$/;

function bad(field: string, value: unknown, why: string): never {
  throw new Error(
    `prompt arg "${field}" rejected (${why}). Got: ${JSON.stringify(String(value)).slice(0, 80)}`,
  );
}

export function safeAddress(field: string, value: string | undefined, fallback?: string): string {
  if (!value) {
    if (fallback) return fallback;
    bad(field, value, "missing");
  }
  if (!HEX_ADDR.test(value!)) bad(field, value, "must be 0x-prefixed 40-hex");
  return value!;
}

export function safeFiat(field: string, value: string | undefined, fallback?: string): string {
  if (!value) {
    if (fallback) return fallback;
    bad(field, value, "missing");
  }
  const upper = value!.trim().toUpperCase();
  if (!FIAT_CODE.test(upper)) bad(field, value, "must be 3-letter ISO fiat code");
  return upper;
}

export function safeNumber(field: string, value: string | undefined, fallback?: number): number {
  if (!value) {
    if (fallback != null) return fallback;
    bad(field, value, "missing");
  }
  const trimmed = value!.trim();
  if (!NUMERIC.test(trimmed)) bad(field, value, "must be a plain decimal number");
  const n = Number(trimmed);
  if (!Number.isFinite(n)) bad(field, value, "not finite");
  return n;
}

export function safeSymbolList(field: string, value: string | undefined, fallback?: string[]): string[] {
  if (!value || !value.trim()) {
    if (fallback) return fallback;
    bad(field, value, "missing");
  }
  const parts = value!.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) bad(field, value, "empty list");
  for (const p of parts) {
    if (!SYMBOL.test(p)) bad(field, value, `bad symbol "${p}"`);
  }
  return parts.map((p) => p.toUpperCase());
}

export function safeAddressList(field: string, value: string | undefined): string[] {
  if (!value || !value.trim()) bad(field, value, "missing");
  const parts = value!.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) bad(field, value, "empty list");
  for (const p of parts) {
    if (!HEX_ADDR.test(p)) bad(field, value, `bad address "${p}"`);
  }
  return parts;
}

export function safeFiatList(field: string, value: string | undefined, fallback?: string[]): string[] {
  if (!value || !value.trim()) {
    if (fallback) return fallback;
    bad(field, value, "missing");
  }
  const parts = value!.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (parts.length === 0) bad(field, value, "empty list");
  for (const p of parts) {
    if (!FIAT_CODE.test(p)) bad(field, value, `bad fiat code "${p}"`);
  }
  return parts;
}

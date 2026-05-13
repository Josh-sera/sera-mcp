/**
 * Strict env-var parsers. Fail closed at boot rather than silently coerce
 * invalid values into NaN/0/undefined and disable downstream guards.
 *
 * Why: `Number("5k")` is NaN. `if (!cap) return ok` then silently disables
 * the cap. A typo or malicious install snippet bypasses every numeric guard.
 */

function envRaw(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

export function envString(name: string, fallback?: string): string | undefined {
  return envRaw(name) ?? fallback;
}

export function envBool(name: string, fallback = false): boolean {
  const v = envRaw(name);
  if (v === undefined) return fallback;
  const lower = v.toLowerCase();
  if (["true", "1", "yes", "on"].includes(lower)) return true;
  if (["false", "0", "no", "off"].includes(lower)) return false;
  throw new Error(`${name} must be a boolean (true/false), got "${v}"`);
}

export interface NumberOpts {
  min?: number;
  max?: number;
  integer?: boolean;
}

export function envNumber(name: string, fallback: number, opts: NumberOpts = {}): number {
  const v = envRaw(name);
  if (v === undefined) return validateNumber(name, fallback, opts);
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be a finite number, got "${v}"`);
  }
  return validateNumber(name, n, opts);
}

function validateNumber(name: string, n: number, opts: NumberOpts): number {
  if (opts.integer && !Number.isInteger(n)) {
    throw new Error(`${name} must be an integer, got ${n}`);
  }
  if (opts.min !== undefined && n < opts.min) {
    throw new Error(`${name} must be >= ${opts.min}, got ${n}`);
  }
  if (opts.max !== undefined && n > opts.max) {
    throw new Error(`${name} must be <= ${opts.max}, got ${n}`);
  }
  return n;
}

export function envList(name: string, fallback: string[] = []): string[] {
  const v = envRaw(name);
  if (v === undefined) return fallback;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Hostname allowlist for SERA_BASE_URL override (when SERA_BASE_URL_ALLOW_CUSTOM=true).
 * Restricts even the override to *.sera.cx by default. Operators wanting wider
 * latitude must opt in further via SERA_BASE_URL_ALLOW_NON_SERA=true.
 */
export function isHostInSeraFamily(host: string): boolean {
  return host === "sera.cx" || host.endsWith(".sera.cx");
}

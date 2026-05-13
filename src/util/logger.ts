/**
 * Structured stderr logger. stdout is reserved for MCP transport — never write there.
 * Levels filtered by LOG_LEVEL env (trace|debug|info|warn|error). Default: info.
 * Each line is single-line JSON for easy ingestion.
 */
const LEVELS = ["trace", "debug", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

const envLevel = (process.env.LOG_LEVEL ?? "info").toLowerCase();
const minIdx = Math.max(0, LEVELS.indexOf(envLevel as Level));

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (LEVELS.indexOf(level) < minIdx) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...(fields ?? {}),
  });
  process.stderr.write(line + "\n");
}

export const log = {
  trace: (msg: string, fields?: Record<string, unknown>) => emit("trace", msg, fields),
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};

type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function envLevel(): Level {
  const raw = (process.env.ZEN_MCP_LOG ?? "info").toLowerCase();
  if (raw in order) return raw as Level;
  return "info";
}

const min = order[envLevel()];

function emit(level: Level, message: string, fields?: Record<string, unknown>): void {
  if (order[level] < min) return;
  const entry = { ts: new Date().toISOString(), level, message, ...fields };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit("debug", m, f),
  info: (m: string, f?: Record<string, unknown>) => emit("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => emit("error", m, f),
};

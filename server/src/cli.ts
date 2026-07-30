import { DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT } from "@zen-mcp/shared";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ServerOptions {
  host: string;
  port: number;
  tokenPath: string;
  container: string | null;
}

function defaultTokenPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "zen-mcp", "auth.token");
}

export function parseArgs(argv: string[]): ServerOptions {
  let host = process.env.ZEN_MCP_HOST ?? DEFAULT_DAEMON_HOST;
  let port = process.env.ZEN_MCP_PORT
    ? Number.parseInt(process.env.ZEN_MCP_PORT, 10)
    : DEFAULT_DAEMON_PORT;
  let tokenPath = process.env.ZEN_MCP_TOKEN_FILE ?? defaultTokenPath();
  let container: string | null = process.env.ZEN_MCP_CONTAINER ?? null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--host" && argv[i + 1]) {
      host = argv[++i] ?? host;
    } else if (arg === "--port" && argv[i + 1]) {
      port = Number.parseInt(argv[++i] ?? "", 10);
    } else if (arg === "--token-file" && argv[i + 1]) {
      tokenPath = argv[++i] ?? tokenPath;
    } else if (arg === "--container" && argv[i + 1]) {
      container = argv[++i] ?? null;
    }
  }

  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid port: ${port}`);
  }
  return { host, port, tokenPath, container };
}

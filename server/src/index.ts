#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { type ContainersListResult, Methods } from "@zen-ext-mcp/shared";
import { parseArgs } from "./cli.js";
import { DaemonClient, RpcError } from "./daemon-client.js";
import {
  formatAvailableContainers,
  resolveContainerByName,
} from "./container.js";
import { type ScopeRef, registerTools } from "./tools.js";

const SERVER_NAME = "zen-ext-mcp";
const SERVER_VERSION = "0.0.3";

function logStderr(msg: string, fields?: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), source: "server", message: msg, ...fields };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

function readToken(path: string): string {
  return readFileSync(path, "utf8").trim();
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const token = readToken(opts.tokenPath);
  const url = `ws://${opts.host}:${opts.port}`;

  const daemon = new DaemonClient({
    url,
    token,
    containerScope: opts.container,
  });
  await daemon.connect();
  logStderr("connected to daemon", { url, container: opts.container });

  const scope: ScopeRef = { current: null };
  if (opts.container) {
    const result = await daemon.call<ContainersListResult>(Methods.ContainersList);
    try {
      scope.current = resolveContainerByName(result.containers, opts.container);
      logStderr("container scope resolved", {
        name: scope.current.name,
        cookieStoreId: scope.current.cookieStoreId,
      });
    } catch (err) {
      logStderr("container scope error", {
        err: (err as Error).message,
        available: formatAvailableContainers(result.containers),
      });
      throw err;
    }
  }

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, daemon, scope, {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    daemonUrl: url,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logStderr("mcp server ready", { name: SERVER_NAME, version: SERVER_VERSION });

  const cleanup = async () => {
    daemon.close();
    await server.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void cleanup());
  process.on("SIGINT", () => void cleanup());
  process.stdin.on("end", () => void cleanup());
  process.stdin.on("close", () => void cleanup());
}

main().catch((err) => {
  if (err instanceof RpcError) {
    logStderr("rpc error", { code: err.code, message: err.message });
  } else {
    logStderr("fatal", { err: (err as Error).message });
  }
  process.exit(1);
});

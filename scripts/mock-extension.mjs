#!/usr/bin/env node
import { WebSocket } from "ws";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const url = process.env.ZEN_EXT_MCP_URL ?? "ws://127.0.0.1:8766";
const tokenPath =
  process.env.ZEN_EXT_MCP_TOKEN_FILE ??
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "zen-extension-mcp", "auth.token");
const token = readFileSync(tokenPath, "utf8").trim();

const FIXTURE_CONTAINERS = [
  { cookieStoreId: "firefox-container-1", name: "Personal", color: "blue", icon: "fingerprint" },
  { cookieStoreId: "firefox-container-2", name: "Work", color: "orange", icon: "briefcase" },
  { cookieStoreId: "firefox-container-3", name: "Geek", color: "yellow", icon: "circle" },
  { cookieStoreId: "firefox-container-4", name: "Buildersbuddy", color: "green", icon: "tree" },
  { cookieStoreId: "firefox-container-5", name: "Artist Advisory", color: "pink", icon: "vacation" },
  { cookieStoreId: "firefox-container-6", name: "CXVentures", color: "purple", icon: "briefcase" },
];

const ws = new WebSocket(url);

ws.on("open", () => {
  ws.send(
    JSON.stringify({
      type: "hello",
      protocolVersion: 1,
      role: "extension",
      token,
    }),
  );
});

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString("utf8"));
  if (msg.type === "welcome") {
    console.error("[mock-extension] welcome", msg.serverId);
    return;
  }
  if (msg.type === "unauthorized") {
    console.error("[mock-extension] unauthorized:", msg.reason);
    process.exit(1);
  }
  if (msg.type === "ping") {
    ws.send(JSON.stringify({ type: "pong", ts: msg.ts }));
    return;
  }
  if (msg.type === "request") {
    if (msg.method === "containers.list") {
      ws.send(
        JSON.stringify({
          type: "response",
          id: msg.id,
          result: { containers: FIXTURE_CONTAINERS },
        }),
      );
      return;
    }
    ws.send(
      JSON.stringify({
        type: "response",
        id: msg.id,
        error: { code: -32601, message: `mock has no handler for ${msg.method}` },
      }),
    );
  }
});

ws.on("close", () => {
  console.error("[mock-extension] closed");
  process.exit(0);
});

ws.on("error", (err) => {
  console.error("[mock-extension] error", err.message);
  process.exit(1);
});

process.on("SIGTERM", () => ws.close());
process.on("SIGINT", () => ws.close());

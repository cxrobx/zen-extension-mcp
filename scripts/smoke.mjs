#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const TEST_PORT = "18766";
// Without an explicit --nav-db the daemon opens the real store in
// ~/.config/zen-extension-mcp/nav-memory, so a smoke run would write notes
// alongside the live daemon already writing that same file.
const scratch = mkdtempSync(join(tmpdir(), "zen-smoke-"));

function spawnLogged(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], ...opts });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${name}] ${chunk}`);
  });
  return child;
}

function expectPipeJson(child, predicate, timeoutMs = 5000) {
  return new Promise((resolveP, rejectP) => {
    let buf = "";
    const onChunk = (chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (predicate(parsed)) {
          child.stdout.off("data", onChunk);
          clearTimeout(timer);
          resolveP(parsed);
          return;
        }
      }
    };
    child.stdout.on("data", onChunk);
    const timer = setTimeout(() => {
      child.stdout.off("data", onChunk);
      rejectP(new Error(`timeout waiting for predicate; buffer: ${buf}`));
    }, timeoutMs);
  });
}

async function main() {
  const daemon = spawnLogged("daemon", "node", [
    resolve(root, "daemon/dist/index.js"),
    "--port",
    TEST_PORT,
    "--nav-db",
    join(scratch, "nav-memory"),
  ]);
  await sleep(500);

  const server = spawnLogged("mcp", "node", [
    resolve(root, "server/dist/index.js"),
    "--port",
    TEST_PORT,
  ], { env: { ...process.env, ZEN_EXT_MCP_NAV_MEMORY: "0" } });
  await sleep(500);

  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0.0.1" },
    },
  };
  server.stdin.write(JSON.stringify(initialize) + "\n");
  const initResp = await expectPipeJson(server, (m) => m.id === 1);
  console.error("[smoke] initialize ok:", JSON.stringify(initResp.result?.serverInfo ?? {}));

  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  server.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_containers", arguments: {} },
    }) + "\n",
  );
  await sleep(500);
  const mock = spawnLogged("mock-ext", "node", [resolve(here, "mock-extension.mjs")], {
    env: { ...process.env, ZEN_EXT_MCP_URL: `ws://127.0.0.1:${TEST_PORT}` },
  });
  const callResp = await expectPipeJson(server, (m) => m.id === 2, 5000);

  const text = callResp.result?.content?.[0]?.text ?? "";
  console.error("[smoke] list_containers result:");
  console.error(text);

  const expected = ["Personal", "Work", "Geek", "Buildersbuddy", "Artist Advisory", "CXVentures"];
  const missing = expected.filter((name) => !text.includes(name));
  if (missing.length > 0) {
    throw new Error(`missing containers in response: ${missing.join(", ")}`);
  }

  mock.kill("SIGTERM");
  await sleep(500);

  server.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_containers", arguments: {} },
    }) + "\n",
  );
  const disconnectedResp = await expectPipeJson(server, (m) => m.id === 3, 7000);
  const disconnectedText = disconnectedResp.result?.content?.[0]?.text ?? "";
  if (!disconnectedResp.result?.isError || !disconnectedText.includes("extension not connected")) {
    throw new Error(`expected queued request to fail after grace window, got: ${disconnectedText}`);
  }
  console.error("[smoke] disconnected grace failure ok");

  console.error("[smoke] PASS");

  server.kill("SIGTERM");
  daemon.kill("SIGTERM");
  await sleep(200);
  rmSync(scratch, { recursive: true, force: true });
  process.exit(0);
}

main().catch((err) => {
  console.error("[smoke] FAIL:", err.message);
  rmSync(scratch, { recursive: true, force: true });
  process.exit(1);
});

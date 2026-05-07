#!/usr/bin/env node
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function spawnLogged(name, cmd, args) {
  const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
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
      rejectP(new Error(`timeout: ${buf}`));
    }, timeoutMs);
  });
}

async function main() {
  const server = spawnLogged("mcp", "node", [
    resolve(root, "server/dist/index.js"),
    "--port",
    "8766",
  ]);
  await sleep(500);

  server.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "probe", version: "0.0.1" },
      },
    }) + "\n",
  );
  await expectPipeJson(server, (m) => m.id === 1);
  server.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
  );

  server.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_containers", arguments: {} },
    }) + "\n",
  );
  const callResp = await expectPipeJson(server, (m) => m.id === 2);
  const text = callResp.result?.content?.[0]?.text ?? "";
  console.log("\n=== containers from your live Zen ===");
  console.log(text);
  console.log("=====================================\n");

  server.kill("SIGTERM");
  await sleep(200);
  process.exit(0);
}

main().catch((err) => {
  console.error("[probe] FAIL:", err.message);
  process.exit(1);
});

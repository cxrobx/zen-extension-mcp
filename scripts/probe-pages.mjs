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

class McpClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.buf = "";
    this.pending = new Map();
    child.stdout.on("data", (chunk) => this.onData(chunk));
  }
  onData(chunk) {
    this.buf += chunk.toString("utf8");
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed.id !== undefined && this.pending.has(parsed.id)) {
        const { resolve } = this.pending.get(parsed.id);
        this.pending.delete(parsed.id);
        resolve(parsed);
      }
    }
  }
  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolveP, rejectP) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectP(new Error(`timeout: ${method}`));
      }, 10000);
      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolveP(msg);
        },
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  async callTool(name, args) {
    const r = await this.send("tools/call", { name, arguments: args ?? {} });
    if (r.error) throw new Error(`${name}: ${r.error.message}`);
    const text = r.result?.content?.[0]?.text ?? "";
    if (r.result?.isError) throw new Error(`${name}: ${text}`);
    return text;
  }
}

function step(label, body) {
  console.log(`\n--- ${label} ---`);
  return body();
}

async function main() {
  const server = spawnLogged("mcp", "node", [
    resolve(root, "server/dist/index.js"),
    "--port",
    "8766",
  ]);
  await sleep(400);
  const mcp = new McpClient(server);

  await mcp.send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "probe-pages", version: "0.0.1" },
  });
  mcp.notify("notifications/initialized");

  const baseline = await step("baseline list_pages", () => mcp.callTool("list_pages"));
  console.log(baseline);

  await step("new_page_in_container CXVentures -> example.com/cx", async () => {
    console.log(
      await mcp.callTool("new_page_in_container", {
        name: "CXVentures",
        url: "https://example.com/cx",
      }),
    );
  });

  await sleep(500);

  const afterCreate = await step("list_pages after create", () => mcp.callTool("list_pages"));
  console.log(afterCreate);

  const cxLine = afterCreate.split("\n").find((l) => l.includes("example.com/cx"));
  if (!cxLine) throw new Error("could not find new CX tab in list");
  const cxIdxMatch = cxLine.match(/\[(\d+)\]/);
  if (!cxIdxMatch) throw new Error(`could not parse pageIdx from: ${cxLine}`);
  const cxIdx = Number.parseInt(cxIdxMatch[1], 10);
  console.log(`> resolved CX tab to pageIdx ${cxIdx}`);

  await step(`navigate_page idx=${cxIdx} -> example.com/cx-2`, async () => {
    console.log(
      await mcp.callTool("navigate_page", { pageIdx: cxIdx, url: "https://example.com/cx-2" }),
    );
  });
  await sleep(500);

  await step("set_default_container Geek", async () => {
    console.log(await mcp.callTool("set_default_container", { name: "Geek" }));
  });

  await step("new_page (default Geek) -> example.com/geek", async () => {
    console.log(await mcp.callTool("new_page", { url: "https://example.com/geek" }));
  });
  await sleep(500);

  const beforeClose = await step("list_pages before close", () => mcp.callTool("list_pages"));
  console.log(beforeClose);

  const cleanup = beforeClose
    .split("\n")
    .filter((l) => /example\.com\/(cx-2|geek)/.test(l))
    .map((l) => Number.parseInt(l.match(/\[(\d+)\]/)?.[1] ?? "-1", 10))
    .filter((n) => n >= 0)
    .sort((a, b) => b - a);

  for (const idx of cleanup) {
    await step(`close_page idx=${idx}`, async () => {
      console.log(await mcp.callTool("close_page", { pageIdx: idx }));
    });
  }

  const finalList = await step("final list_pages", () => mcp.callTool("list_pages"));
  console.log(finalList);

  console.log("\n[probe-pages] PASS");
  server.kill("SIGTERM");
  await sleep(200);
  process.exit(0);
}

main().catch((err) => {
  console.error("[probe-pages] FAIL:", err.message);
  process.exit(1);
});

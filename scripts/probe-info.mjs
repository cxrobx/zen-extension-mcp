#!/usr/bin/env node
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function spawnLogged(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], ...opts });
  child.stderr.on("data", (chunk) => process.stderr.write(`[${name}] ${chunk}`));
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
      try { parsed = JSON.parse(line); } catch { continue; }
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
      const timer = setTimeout(() => { this.pending.delete(id); rejectP(new Error(`timeout: ${method}`)); }, 10000);
      this.pending.set(id, { resolve: (msg) => { clearTimeout(timer); resolveP(msg); } });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  async callTool(name, args) {
    const r = await this.send("tools/call", { name, arguments: args ?? {} });
    if (r.error) throw new Error(`${name}: ${r.error.message}`);
    const text = r.result?.content?.find?.((c) => c.type === "text")?.text ?? "";
    if (r.result?.isError) throw new Error(`${name}: ${text}`);
    return text;
  }
}

async function run(args, label) {
  const proc = spawnLogged("mcp", "node", [resolve(root, "server/dist/index.js"), ...args], { env: { ...process.env, ZEN_EXT_MCP_NAV_MEMORY: "0" } });
  await sleep(400);
  const mcp = new McpClient(proc);
  await mcp.send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "probe-info", version: "0.0.1" },
  });
  mcp.notify("notifications/initialized");
  console.log(`\n--- ${label} ---`);
  console.log(await mcp.callTool("get_firefox_info"));
  proc.kill("SIGTERM");
  await sleep(200);
}

await run(["--port", "8766"], "no scope");
await run(["--port", "8766", "--container", "CXVentures"], "scoped CXVentures");
console.log("\n[probe-info] PASS");
process.exit(0);

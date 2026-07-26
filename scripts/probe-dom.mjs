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
      }, 15000);
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
    const text = r.result?.content?.find?.((c) => c.type === "text")?.text ?? "";
    if (r.result?.isError) throw new Error(`${name}: ${text}`);
    return { text, content: r.result?.content ?? [] };
  }
}

function step(label, body) {
  console.log(`\n--- ${label} ---`);
  return body();
}

async function main() {
  const targetUrl = "https://example.com/";

  const server = spawnLogged(
    "mcp",
    "node",
    [resolve(root, "server/dist/index.js"), "--port", "8766"],
    { env: { ...process.env, ZEN_EXT_MCP_NAV_MEMORY: "0" } },
  );
  await sleep(400);
  const mcp = new McpClient(server);

  await mcp.send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "probe-dom", version: "0.0.1" },
  });
  mcp.notify("notifications/initialized");

  const created = await step(`new_page -> ${targetUrl}`, async () => {
    const r = await mcp.callTool("new_page", { url: targetUrl });
    console.log(r.text);
    return r.text;
  });
  await sleep(2000);

  const list = await step("list_pages (find new tab)", async () => {
    const r = await mcp.callTool("list_pages");
    console.log(r.text.split("\n").filter((l) => l.includes("example.com")).join("\n"));
    return r.text;
  });
  const line = list.split("\n").find((l) => l.includes("example.com") && !l.includes("/cx") && !l.includes("/geek"));
  if (!line) throw new Error("could not find example.com tab");
  const idx = Number.parseInt(line.match(/\[(\d+)\]/)?.[1] ?? "-1", 10);
  if (idx < 0) throw new Error(`could not parse pageIdx from: ${line}`);
  console.log(`> using pageIdx=${idx}`);

  await step("select_page (focus the new tab)", async () => {
    console.log((await mcp.callTool("select_page", { pageIdx: idx })).text);
  });
  await sleep(500);

  await step("take_snapshot", async () => {
    const r = await mcp.callTool("take_snapshot", { pageIdx: idx });
    console.log(r.text.split("\n").slice(0, 20).join("\n"));
    console.log("...(truncated for display)");
  });

  await step("evaluate_script (return document.title)", async () => {
    const r = await mcp.callTool("evaluate_script", {
      pageIdx: idx,
      code: "return document.title;",
    });
    console.log(r.text);
    if (!r.text.toLowerCase().includes("example")) {
      throw new Error(`expected example in title, got: ${r.text}`);
    }
  });

  await step("evaluate_script (return text of h1)", async () => {
    const r = await mcp.callTool("evaluate_script", {
      pageIdx: idx,
      code: "return document.querySelector('h1')?.textContent ?? null;",
    });
    console.log(r.text);
  });

  const snapshot = await step("take_snapshot again (refresh UIDs)", async () => {
    const r = await mcp.callTool("take_snapshot", { pageIdx: idx });
    return r.text;
  });
  const linkLine = snapshot.split("\n").find((l) => /^\s*a#/.test(l));
  if (linkLine) {
    const linkUid = linkLine.match(/a#([^\s]+)/)?.[1];
    if (linkUid) {
      console.log(`\n> first <a> uid: ${linkUid}`);
      await step(`resolve_uid_to_selector ${linkUid}`, async () => {
        console.log((await mcp.callTool("resolve_uid_to_selector", { pageIdx: idx, uid: linkUid })).text);
      });
    }
  }

  const shot = await step("screenshot_page", async () => {
    const r = await mcp.callTool("screenshot_page", { pageIdx: idx });
    const img = r.content.find((c) => c.type === "image");
    if (!img) throw new Error("no image content returned");
    return img.data.length;
  });
  console.log(`> screenshot base64 length: ${shot} bytes`);

  await step(`close_page idx=${idx}`, async () => {
    console.log((await mcp.callTool("close_page", { pageIdx: idx })).text);
  });

  console.log("\n[probe-dom] PASS");
  server.kill("SIGTERM");
  await sleep(200);
  process.exit(0);
}

main().catch((err) => {
  console.error("[probe-dom] FAIL:", err.message);
  process.exit(1);
});

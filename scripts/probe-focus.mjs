#!/usr/bin/env node
// Verifies the no-focus-steal changes:
//  1. default new_page opens in background AND does not change which tab is active
//  2. screenshot_page returns a real image on an inactive tab (captureTab path)
//  3. new_page active:true still foregrounds the new tab
// Restores the original active tab on exit.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function spawnLogged(name, cmd, args) {
  const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
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
      const timer = setTimeout(() => { this.pending.delete(id); rejectP(new Error(`timeout: ${method}`)); }, 12000);
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
    const text = r.result?.content?.[0]?.text ?? "";
    if (r.result?.isError) throw new Error(`${name}: ${text}`);
    return text;
  }
}

function activeLine(listText) {
  return listText.split("\n").find((l) => l.startsWith("*")) ?? null;
}
function idxOf(line) {
  return Number.parseInt(line.match(/\[(\d+)\]/)?.[1] ?? "-1", 10);
}
function tabIdOf(line) {
  return Number.parseInt(line.match(/tabId=(\d+)/)?.[1] ?? "-1", 10);
}
function lineForUrl(listText, url) {
  return listText.split("\n").find((l) => l.includes(url)) ?? null;
}

const fails = [];
function check(cond, msg) {
  console.log(`  ${cond ? "PASS" : "FAIL"}: ${msg}`);
  if (!cond) fails.push(msg);
}

async function main() {
  const server = spawnLogged("mcp", "node", [resolve(root, "server/dist/index.js"), "--port", "8766"]);
  await sleep(400);
  const mcp = new McpClient(server);
  await mcp.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe-focus", version: "0.0.1" } });
  mcp.notify("notifications/initialized");

  const baseline = await mcp.callTool("list_pages");
  console.log("\n--- baseline ---\n" + baseline);
  const origActive = activeLine(baseline);
  if (!origActive) throw new Error("no active tab in baseline; is the extension connected?");
  const origActiveTabId = tabIdOf(origActive);
  console.log(`> original active tabId=${origActiveTabId}`);

  // 1. default new_page -> background, no focus change
  const BG = "https://example.com/focus-bg";
  console.log("\n--- new_page (default, no active flag) ---");
  console.log(await mcp.callTool("new_page", { url: BG }));
  await sleep(700);
  const afterBg = await mcp.callTool("list_pages");
  console.log(afterBg);
  const bgLine = lineForUrl(afterBg, BG);
  check(!!bgLine, "background tab appears in list");
  check(bgLine ? !bgLine.startsWith("*") : false, "new background tab is NOT active");
  const stillActive = activeLine(afterBg);
  check(stillActive ? tabIdOf(stillActive) === origActiveTabId : false,
    `original tab (tabId=${origActiveTabId}) is STILL active -> no focus steal`);

  // 2. screenshot the inactive background tab -> real image via captureTab
  const bgIdx = bgLine ? idxOf(bgLine) : -1;
  console.log(`\n--- screenshot_page idx=${bgIdx} (inactive tab) ---`);
  const shot = await mcp.callTool("screenshot_page", { pageIdx: bgIdx });
  console.log("  " + shot);
  const bytes = Number.parseInt(shot.match(/\((\d+) bytes/)?.[1] ?? "0", 10);
  check(bytes > 2000, `screenshot returned a non-trivial image on an inactive tab (${bytes} base64 bytes)`);
  const afterShot = activeLine(await mcp.callTool("list_pages"));
  check(afterShot ? tabIdOf(afterShot) === origActiveTabId : false,
    "screenshot did NOT change the active tab");

  // 3. opt-in: new_page active:true still foregrounds
  const FG = "https://example.com/focus-fg";
  console.log("\n--- new_page active:true (opt-in foreground) ---");
  console.log(await mcp.callTool("new_page", { url: FG, active: true }));
  await sleep(700);
  const afterFg = await mcp.callTool("list_pages");
  const fgLine = lineForUrl(afterFg, FG);
  check(fgLine ? fgLine.startsWith("*") : false, "active:true tab IS foregrounded");

  // cleanup: close created tabs, restore original active tab
  console.log("\n--- cleanup ---");
  const closeList = (await mcp.callTool("list_pages"))
    .split("\n")
    .filter((l) => /example\.com\/focus-(bg|fg)/.test(l))
    .map(idxOf).filter((n) => n >= 0).sort((a, b) => b - a);
  for (const idx of closeList) console.log("  " + await mcp.callTool("close_page", { pageIdx: idx }));

  const restoreList = await mcp.callTool("list_pages");
  const restoreLine = restoreList.split("\n").find((l) => tabIdOf(l) === origActiveTabId);
  if (restoreLine) {
    const ridx = idxOf(restoreLine);
    console.log("  restoring active tab: " + await mcp.callTool("select_page", { pageIdx: ridx }));
  }

  server.kill("SIGTERM");
  await sleep(200);
  if (fails.length) { console.log(`\n[probe-focus] FAIL (${fails.length})`); process.exit(1); }
  console.log("\n[probe-focus] PASS");
  process.exit(0);
}

main().catch((err) => { console.error("[probe-focus] FAIL:", err.message); process.exit(1); });

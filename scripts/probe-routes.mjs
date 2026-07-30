#!/usr/bin/env node
// Live-Zen probe for host -> container routing and tab reuse.
//
// Two phases. Phase A reads the REAL route file and only asks questions: does each rule
// resolve, and does the container it names exist in this Zen? Nothing is opened.
// Phase B exercises open_url end to end against a THROWAWAY route file that maps
// example.com, so reuse can only ever land on the probe's own tab - a probe must never
// navigate a real project tab out from under the user. Cleans up after itself and verifies
// that every pre-existing tab still sits at the URL it started on.
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// The container the probe borrows for its example.com tab. Any real container works; this
// one is only used to prove the routed cookieStoreId reached the browser.
const PROBE_CONTAINER = process.env.ZEN_PROBE_CONTAINER ?? "Artist Advisory";
const PROBE_HOST = "example.com";

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
      const entry = this.pending.get(parsed.id);
      if (entry) {
        this.pending.delete(parsed.id);
        entry(parsed);
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
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolveP(msg);
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async callTool(name, args) {
    const r = await this.send("tools/call", { name, arguments: args ?? {} });
    if (r.error) throw new Error(`${name}: ${r.error.message}`);
    return {
      isError: r.result?.isError === true,
      text: r.result?.content?.find?.((c) => c.type === "text")?.text ?? "",
    };
  }
}

async function startServer(env) {
  const child = spawn("node", [resolve(root, "server/dist/index.js"), "--port", "8766"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ZEN_MCP_NAV_MEMORY: "0", ...env },
  });
  child.stderr.on("data", (c) => process.stderr.write(`[mcp] ${c}`));
  await sleep(400);
  const client = new McpClient(child);
  await client.send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "probe-routes", version: "0.0.1" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return { child, client };
}

function expectOk(label, r) {
  if (r.isError) throw new Error(`${label} unexpectedly failed: ${r.text}`);
  console.log(`  ok: ${r.text.split("\n").join(" | ")}`);
  return r;
}

function expectMatch(label, r, pattern) {
  expectOk(label, r);
  if (!pattern.test(r.text)) throw new Error(`${label} did not match ${pattern}: ${r.text}`);
  return r;
}

// Every tab this probe opens carries MARKER in its path, so this sweep can only ever close
// the probe's own tabs - never a real one that happens to be on the same host. Run at the
// start (to heal a previous aborted run) and in the finally (so a failure cleans up).
const MARKER = "zen-route-probe";

async function closeProbeTabs(client, label) {
  const listed = await client.callTool("list_pages");
  const ids = [...listed.text.matchAll(/tabId=(\d+) (\S+)/g)]
    .filter(([, , url]) => url.includes(MARKER))
    .map(([, id]) => Number(id));
  for (const tabId of ids) {
    await client.callTool("close_page", { tabId });
    console.log(`  ${label}: closed leftover probe tabId=${tabId}`);
  }
  return ids.length;
}

function tabSnapshot(text) {
  const map = new Map();
  for (const line of text.split("\n")) {
    const m = /tabId=(\d+) (\S+)/.exec(line);
    if (m) map.set(Number(m[1]), m[2]);
  }
  return map;
}

async function main() {
  let dir;
  let live;
  let probe;
  try {
    console.log("\n--- phase A: the real route table (read-only) ---");
    live = await startServer({});
    const table = expectOk("container_routes", await live.client.callTool("container_routes"));
    const rules = [...table.text.matchAll(/^- (.+?): (.+)$/gm)].flatMap(([, container, patterns]) =>
      patterns.split(", ").map((pattern) => ({ container, pattern })),
    );
    if (rules.length === 0) {
      console.log("  (no rules configured - phase A has nothing to resolve)");
    }
    for (const rule of rules) {
      const url = `https://${rule.pattern.replace(/^\*\./, "www.")}/`;
      const r = await live.client.callTool("container_routes", { url });
      expectMatch(`resolve ${url}`, r, new RegExp(`-> "${rule.container.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
      if (!/container exists:/.test(r.text)) {
        throw new Error(`route "${rule.pattern}" names a container that does not exist: ${r.text}`);
      }
    }
    live.child.kill("SIGTERM");
    live = null;

    console.log("\n--- phase B: open_url against a throwaway table ---");
    dir = await mkdtemp(join(tmpdir(), "zen-probe-routes-"));
    const routeFile = join(dir, "containers.json");
    await writeFile(
      routeFile,
      JSON.stringify({ routes: { [PROBE_CONTAINER]: [PROBE_HOST] } }, null, 2),
      "utf8",
    );
    probe = await startServer({ ZEN_MCP_ROUTES: routeFile });
    await closeProbeTabs(probe.client, "pre-clean");

    const before = tabSnapshot(expectOk("list_pages (baseline)", await probe.client.callTool("list_pages")).text);

    console.log(`\n> route ${PROBE_HOST} -> ${PROBE_CONTAINER}, nothing open there yet`);
    const opened = expectMatch(
      "open_url (new)",
      await probe.client.callTool("open_url", { url: `https://${PROBE_HOST}/zen-route-probe` }),
      new RegExp(`^new page tabId=\\d+ .*\\(${PROBE_CONTAINER}\\)`),
    );
    const tabId = Number(/tabId=(\d+)/.exec(opened.text)[1]);
    if (!new RegExp(`via route "${PROBE_HOST}"`).test(opened.text)) {
      throw new Error("the container decision was not attributed to the route");
    }

    // Deliberately no wait: the tab still reports about:blank, which is what made an
    // immediate second call open a duplicate before the pending-URL fix.
    console.log("\n> same URL again, immediately: must find the tab, not open a second one");
    expectMatch(
      "open_url (exact, mid-load)",
      await probe.client.callTool("open_url", { url: `https://${PROBE_HOST}/zen-route-probe` }),
      new RegExp(`^found tabId=${tabId} `),
    );

    // Now let the load commit and confirm the same answer comes from the tab's real URL.
    for (let i = 0; i < 20; i++) {
      const listed = await probe.client.callTool("list_pages");
      if (new RegExp(`tabId=${tabId} https://${PROBE_HOST}/zen-route-probe`).test(listed.text)) break;
      await sleep(250);
    }
    expectMatch(
      "open_url (exact, loaded)",
      await probe.client.callTool("open_url", { url: `https://${PROBE_HOST}/zen-route-probe` }),
      new RegExp(`^found tabId=${tabId} `),
    );

    console.log("\n> different path, same host: must reuse that tab");
    expectMatch(
      "open_url (reuse)",
      await probe.client.callTool("open_url", { url: `https://${PROBE_HOST}/zen-route-probe-2` }),
      new RegExp(`^reused tabId=${tabId} `),
    );
    await sleep(600);

    console.log("\n> reuse=never must open a second tab in the same container");
    const second = expectMatch(
      "open_url (never)",
      await probe.client.callTool("open_url", { url: `https://${PROBE_HOST}/zen-route-probe-3`, reuse: "never" }),
      new RegExp(`^new page tabId=\\d+ .*\\(${PROBE_CONTAINER}\\)`),
    );
    const secondId = Number(/tabId=(\d+)/.exec(second.text)[1]);

    console.log("\n--- cleanup ---");
    expectOk("close probe tab", await probe.client.callTool("close_page", { tabId }));
    expectOk("close probe tab 2", await probe.client.callTool("close_page", { tabId: secondId }));

    const after = tabSnapshot(expectOk("list_pages (after)", await probe.client.callTool("list_pages")).text);
    for (const [id, url] of before) {
      if (!after.has(id)) throw new Error(`pre-existing tabId=${id} disappeared (${url})`);
      if (after.get(id) !== url) {
        throw new Error(`pre-existing tabId=${id} was navigated: ${url} -> ${after.get(id)}`);
      }
    }
    if (after.has(tabId) || after.has(secondId)) throw new Error("probe tabs were not closed");

    console.log("\n[probe-routes] PASS");
  } finally {
    if (probe) {
      // A failed assertion must not leave probe tabs behind for the next run to trip over.
      await closeProbeTabs(probe.client, "cleanup").catch(() => undefined);
    }
    live?.child.kill("SIGTERM");
    probe?.child.kill("SIGTERM");
    await sleep(200);
    if (dir) await rm(dir, { recursive: true, force: true });
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[probe-routes] FAIL:", err.message);
  process.exit(1);
});

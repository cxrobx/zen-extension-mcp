// Coverage for host -> container routing and tab reuse.
//
// The bug this guards: a URL's container was decided by which zen-* MCP entry happened to
// issue the call, so artistadvisory.io opened in no container from zen-ext and every call
// stacked another duplicate tab. Routing makes the DOMAIN decide the container, and open_url
// goes to the tab already on that host instead of opening a new one. Both halves have to fail
// loudly rather than quietly land a session in the wrong cookie jar.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

import { matchContainerRoute, reloadRouteTable } from "../server/dist/routes.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const PORT = 18768;

const CONTAINERS = [
  { cookieStoreId: "firefox-container-1", name: "Personal", color: "blue", icon: "fingerprint" },
  { cookieStoreId: "firefox-container-7", name: "Buildersbuddy", color: "orange", icon: "fence" },
  { cookieStoreId: "firefox-container-8", name: "Artist Advisory", color: "yellow", icon: "fruit" },
  { cookieStoreId: "firefox-container-9", name: "CXVentures", color: "toolbar", icon: "fingerprint" },
];

const ROUTE_FILE = {
  routes: {
    "Artist Advisory": ["artistadvisory.io", "localhost:3000"],
    CXVentures: ["cxventures.io"],
    Buildersbuddy: ["buildersbuddy.org"],
    "Ghost Container": ["ghost.example"],
  },
};

function page({ tabId, index, url, title, container = null, active = false }) {
  const found = CONTAINERS.find((c) => c.name === container);
  return {
    tabId,
    windowId: 1,
    index,
    url,
    title,
    active,
    cookieStoreId: found?.cookieStoreId ?? "firefox-default",
    containerName: found?.name ?? null,
  };
}

// artistadvisory.io is open twice in its own container and once outside it; the outside tab
// is the trap - reuse must not touch a tab in the wrong cookie jar.
const TABS = () => [
  page({ tabId: 101, index: 0, url: "https://artistadvisory.io/", title: "AA", container: "Artist Advisory", active: true }),
  page({ tabId: 102, index: 1, url: "https://artistadvisory.io/artists", title: "Artists", container: "Artist Advisory" }),
  page({ tabId: 103, index: 2, url: "https://artistadvisory.io/marketing", title: "Marketing" }),
  page({ tabId: 104, index: 3, url: "https://cxventures.io/audit", title: "Audit", container: "Personal" }),
];

class StubExtension {
  constructor(url, token) {
    this.url = url;
    this.token = token;
    this.tabs = TABS();
    this.requests = [];
    this.nextTabId = 500;
    // Firefox reports a brand-new tab as about:blank until its first navigation commits.
    // With this on, the stub reproduces that lag instead of resolving instantly.
    this.deferLoads = false;
  }

  reset() {
    this.tabs = TABS();
    this.requests = [];
    this.deferLoads = false;
  }

  /** Let a deferred tab finish loading, as the browser eventually would. */
  commit(tabId, url) {
    this.tabs = this.tabs.map((t) => (t.tabId === tabId ? { ...t, url } : t));
  }

  requestsFor(method) {
    return this.requests.filter((r) => r.method === method);
  }

  connect() {
    return new Promise((resolveP, rejectP) => {
      this.ws = new WebSocket(this.url);
      this.ws.on("open", () => {
        this.ws.send(
          JSON.stringify({ type: "hello", protocolVersion: 1, role: "extension", token: this.token }),
        );
      });
      this.ws.on("error", rejectP);
      this.ws.on("message", (data) => {
        const msg = JSON.parse(data.toString("utf8"));
        if (msg.type === "welcome") return resolveP();
        if (msg.type === "unauthorized") return rejectP(new Error(`unauthorized: ${msg.reason}`));
        if (msg.type === "ping") return this.send({ type: "pong", ts: msg.ts });
        if (msg.type !== "request") return;
        this.requests.push({ method: msg.method, params: msg.params });
        this.send({ type: "response", id: msg.id, ...this.handle(msg) });
      });
    });
  }

  handle(msg) {
    switch (msg.method) {
      case "containers.list":
        return { result: { containers: CONTAINERS } };
      case "pages.list":
        return { result: { pages: this.tabs } };
      case "pages.new": {
        const store = msg.params?.cookieStoreId ?? "firefox-default";
        const container = CONTAINERS.find((c) => c.cookieStoreId === store);
        const tab = {
          tabId: this.nextTabId++,
          windowId: 1,
          index: this.tabs.length,
          url: this.deferLoads ? "about:blank" : msg.params.url,
          title: "",
          active: msg.params.active === true,
          cookieStoreId: store,
          containerName: container?.name ?? null,
        };
        this.tabs = [...this.tabs, tab];
        return {
          result: {
            tabId: tab.tabId,
            windowId: tab.windowId,
            url: tab.url,
            cookieStoreId: tab.cookieStoreId,
            containerName: tab.containerName,
          },
        };
      }
      case "pages.navigate": {
        this.tabs = this.tabs.map((t) =>
          t.tabId === msg.params.tabId ? { ...t, url: msg.params.url } : t,
        );
        return { result: { tabId: msg.params.tabId } };
      }
      case "pages.select":
      case "pages.close":
        return { result: { tabId: msg.params?.tabId } };
      case "info.get":
        return {
          result: {
            extensionId: "stub",
            extensionVersion: "0.0.0",
            userAgent: "stub",
            platform: "test",
            windowCount: 1,
            tabCount: this.tabs.length,
            containerCount: CONTAINERS.length,
            protocolVersion: 1,
          },
        };
      default:
        return { error: { code: -32601, message: `stub has no handler for ${msg.method}` } };
    }
  }

  send(payload) {
    this.ws.send(JSON.stringify(payload));
  }

  close() {
    this.ws?.close();
  }
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
    const text = r.result?.content?.find?.((c) => c.type === "text")?.text ?? "";
    return { isError: r.result?.isError === true, text };
  }
}

let dir;
let routeFile;
let daemon;
let ext;
let unscoped;
let scoped;
let mcp;
let mcpScoped;

async function startServer(tokenPath, extraArgs, env) {
  const child = spawn(
    "node",
    [resolve(root, "server/dist/index.js"), "--port", String(PORT), "--token-file", tokenPath, ...extraArgs],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ZEN_MCP_NAV_MEMORY: "0", ...env },
    },
  );
  child.stderr.resume();
  await sleep(400);
  const client = new McpClient(child);
  await client.send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "container-routes-test", version: "0.0.1" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return { child, client };
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "zen-container-routes-"));
  routeFile = join(dir, "containers.json");
  await writeFile(routeFile, JSON.stringify(ROUTE_FILE, null, 2), "utf8");

  const tokenPath = join(dir, "auth.token");
  daemon = spawn(
    "node",
    [
      resolve(root, "daemon/dist/index.js"),
      "--port", String(PORT),
      "--token-file", tokenPath,
      "--nav-db", join(dir, "nav-memory"),
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  daemon.stderr.resume();

  let token = "";
  for (let i = 0; i < 50 && !token; i++) {
    await sleep(100);
    token = await readFile(tokenPath, "utf8").then((t) => t.trim()).catch(() => "");
  }
  assert.ok(token, "daemon never wrote an auth token");

  // The daemon writes its token file before the WebSocket port is listening, so a connect
  // immediately after the token appears can be refused. Retry rather than fail the suite.
  ext = new StubExtension(`ws://127.0.0.1:${PORT}`, token);
  for (let attempt = 1; ; attempt++) {
    try {
      await ext.connect();
      break;
    } catch (err) {
      if (attempt >= 10) throw err;
      await sleep(200);
    }
  }

  const a = await startServer(tokenPath, [], { ZEN_MCP_ROUTES: routeFile });
  unscoped = a.child;
  mcp = a.client;

  // A container-scoped server, the zen-artist shape: routes must still win over its default.
  const b = await startServer(tokenPath, ["--container", "Personal"], { ZEN_MCP_ROUTES: routeFile });
  scoped = b.child;
  mcpScoped = b.client;
});

after(async () => {
  ext?.close();
  unscoped?.kill("SIGTERM");
  scoped?.kill("SIGTERM");
  daemon?.kill("SIGTERM");
  await sleep(200);
  if (dir) await rm(dir, { recursive: true, force: true });
});

// --- pure matcher -----------------------------------------------------------------------

test("a rule matches its host and its subdomains, and pins ports when asked", async (t) => {
  const previous = process.env.ZEN_MCP_ROUTES;
  process.env.ZEN_MCP_ROUTES = routeFile;
  const table = reloadRouteTable();
  t.after(() => {
    if (previous === undefined) delete process.env.ZEN_MCP_ROUTES;
    else process.env.ZEN_MCP_ROUTES = previous;
    reloadRouteTable();
  });

  assert.equal(matchContainerRoute(table, "https://artistadvisory.io/artists")?.container, "Artist Advisory");
  assert.equal(matchContainerRoute(table, "https://www.artistadvisory.io/")?.container, "Artist Advisory");
  assert.equal(matchContainerRoute(table, "https://qes-deck.cxventures.io/")?.container, "CXVentures");
  assert.equal(matchContainerRoute(table, "http://localhost:3000/admin")?.container, "Artist Advisory");
  // The port-pinned rule must not swallow every other localhost port.
  assert.equal(matchContainerRoute(table, "http://localhost:3900/"), null);
  assert.equal(matchContainerRoute(table, "https://example.com/"), null);
  assert.equal(matchContainerRoute(table, "about:blank"), null);
  // A lookalike domain must not inherit the rule.
  assert.equal(matchContainerRoute(table, "https://notartistadvisory.io/"), null);
});

test("a more specific rule wins, and *. excludes the apex", async (t) => {
  const previous = process.env.ZEN_MCP_ROUTES;
  const file = join(dir, "specificity.json");
  await writeFile(
    file,
    JSON.stringify({
      routes: [
        { container: "Personal", match: ["example.com"] },
        { container: "CXVentures", match: ["docs.example.com"] },
        { container: "Buildersbuddy", match: ["*.only-subs.example"] },
      ],
    }),
    "utf8",
  );
  process.env.ZEN_MCP_ROUTES = file;
  const table = reloadRouteTable();
  t.after(() => {
    if (previous === undefined) delete process.env.ZEN_MCP_ROUTES;
    else process.env.ZEN_MCP_ROUTES = previous;
    reloadRouteTable();
  });

  assert.equal(matchContainerRoute(table, "https://docs.example.com/x")?.container, "CXVentures");
  assert.equal(matchContainerRoute(table, "https://other.example.com/x")?.container, "Personal");
  assert.equal(matchContainerRoute(table, "https://sub.only-subs.example/")?.container, "Buildersbuddy");
  assert.equal(matchContainerRoute(table, "https://only-subs.example/"), null);
});

test("a broken or absent route file reports itself instead of looking empty", async (t) => {
  const previous = process.env.ZEN_MCP_ROUTES;
  const broken = join(dir, "broken.json");
  await writeFile(broken, "{ not json", "utf8");
  t.after(() => {
    if (previous === undefined) delete process.env.ZEN_MCP_ROUTES;
    else process.env.ZEN_MCP_ROUTES = previous;
    reloadRouteTable();
  });

  process.env.ZEN_MCP_ROUTES = broken;
  const bad = reloadRouteTable();
  assert.equal(bad.rules.length, 0);
  assert.match(bad.error, /invalid JSON/);

  process.env.ZEN_MCP_ROUTES = join(dir, "does-not-exist.json");
  const missing = reloadRouteTable();
  assert.equal(missing.loaded, false);
  assert.equal(missing.error, null, "an absent file is the default state, not an error");

  process.env.ZEN_MCP_ROUTES = routeFile;
  process.env.ZEN_MCP_CONTAINER_ROUTES = "0";
  const off = reloadRouteTable();
  delete process.env.ZEN_MCP_CONTAINER_ROUTES;
  assert.equal(off.enabled, false);
  assert.equal(matchContainerRoute(off, "https://artistadvisory.io/"), null);
});

// --- routing through the live tool surface -----------------------------------------------

test("open_url reuses the open tab on that host in the owning container", async () => {
  ext.reset();
  const created = ext.requestsFor("pages.new").length;
  const { isError, text } = await mcp.callTool("open_url", { url: "https://artistadvisory.io/marketing" });

  assert.equal(isError, false, text);
  assert.match(text, /^reused tabId=101 /);
  assert.match(text, /container: Artist Advisory \(firefox-container-8\) via route "artistadvisory\.io"/);
  const nav = ext.requestsFor("pages.navigate").at(-1);
  assert.equal(nav.params.tabId, 101, "must land on the active tab in the routed container");
  assert.equal(ext.requestsFor("pages.new").length, created, "no duplicate tab may be opened");
});

test("open_url never reuses a same-host tab that sits in the wrong container", async () => {
  ext.reset();
  // tabId 103 is on artistadvisory.io but in no container; 104 is cxventures.io in Personal.
  const { isError, text } = await mcp.callTool("open_url", { url: "https://cxventures.io/proposals" });

  assert.equal(isError, false, text);
  assert.match(text, /^new page tabId=\d+ /);
  assert.match(text, /container: CXVentures \(firefox-container-9\)/);
  const created = ext.requestsFor("pages.new").at(-1);
  assert.equal(created.params.cookieStoreId, "firefox-container-9");
  assert.equal(
    ext.requestsFor("pages.navigate").filter((r) => r.params.tabId === 104).length,
    0,
    "the Personal-container cxventures tab must be left alone",
  );
});

test("open_url on a URL already open just reports the tab and navigates nothing", async () => {
  ext.reset();
  const navs = ext.requestsFor("pages.navigate").length;
  const news = ext.requestsFor("pages.new").length;
  const selects = ext.requestsFor("pages.select").length;

  const { isError, text } = await mcp.callTool("open_url", { url: "https://artistadvisory.io/artists" });

  assert.equal(isError, false, text);
  assert.match(text, /^found tabId=102 /);
  assert.match(text, /already open at this URL/);
  assert.equal(ext.requestsFor("pages.navigate").length, navs);
  assert.equal(ext.requestsFor("pages.new").length, news);
  assert.equal(ext.requestsFor("pages.select").length, selects, "background by default");
});

test("active=true focuses the tab it landed on", async () => {
  ext.reset();
  const { isError, text } = await mcp.callTool("open_url", {
    url: "https://artistadvisory.io/artists",
    active: true,
  });
  assert.equal(isError, false, text);
  assert.equal(ext.requestsFor("pages.select").at(-1).params.tabId, 102);
});

test("reuse modes: exact declines a host-only match, never always opens", async () => {
  ext.reset();
  const exact = await mcp.callTool("open_url", {
    url: "https://artistadvisory.io/reports",
    reuse: "exact",
  });
  assert.equal(exact.isError, false, exact.text);
  assert.match(exact.text, /^new page tabId=\d+ /);
  assert.match(exact.text, /no tab at that exact URL/);
  assert.equal(ext.requestsFor("pages.new").at(-1).params.cookieStoreId, "firefox-container-8");

  ext.reset();
  const never = await mcp.callTool("open_url", {
    url: "https://artistadvisory.io/artists",
    reuse: "never",
  });
  assert.equal(never.isError, false, never.text);
  assert.match(never.text, /^new page tabId=\d+ /);
  assert.equal(ext.requestsFor("pages.navigate").length, 0);
});

test("a second open_url before the first tab has loaded does not duplicate it", async () => {
  // Regression: a new tab reports about:blank until its navigation commits, so the follow-up
  // call saw no tab on that host and opened another one. Caught by the live probe, not the
  // stub, because the stub used to resolve loads instantly.
  ext.reset();
  ext.deferLoads = true;
  const url = "https://buildersbuddy.org/deals/42";

  const first = await mcp.callTool("open_url", { url });
  assert.equal(first.isError, false, first.text);
  assert.match(first.text, new RegExp(`^new page tabId=\\d+ -> ${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "must report the URL it asked for, not about:blank");
  const tabId = Number(/tabId=(\d+)/.exec(first.text)[1]);
  const created = ext.requestsFor("pages.new").length;

  const second = await mcp.callTool("open_url", { url });
  assert.equal(second.isError, false, second.text);
  assert.match(second.text, new RegExp(`^found tabId=${tabId} `));
  assert.match(second.text, /still loading/);
  assert.equal(ext.requestsFor("pages.new").length, created, "no duplicate while the first tab loads");

  // Same host, different path, still mid-load: navigate that tab rather than opening another.
  const third = await mcp.callTool("open_url", { url: "https://buildersbuddy.org/deals/43" });
  assert.match(third.text, new RegExp(`^reused tabId=${tabId} `));
  assert.equal(ext.requestsFor("pages.new").length, created);

  // Once the browser catches up, the tab's own URL takes over again.
  ext.commit(tabId, "https://buildersbuddy.org/deals/43");
  const fourth = await mcp.callTool("open_url", { url: "https://buildersbuddy.org/deals/43" });
  assert.match(fourth.text, new RegExp(`^found tabId=${tabId} `));
  assert.doesNotMatch(fourth.text, /still loading/);
});

test("a host rule outranks the session default container", async () => {
  ext.reset();
  // This server was started with --container Personal.
  const routed = await mcpScoped.callTool("open_url", { url: "https://buildersbuddy.org/deals" });
  assert.equal(routed.isError, false, routed.text);
  assert.match(routed.text, /container: Buildersbuddy \(firefox-container-7\) via route "buildersbuddy\.org"/);
  assert.equal(ext.requestsFor("pages.new").at(-1).params.cookieStoreId, "firefox-container-7");

  // An unrouted host still falls back to the session default.
  const fallback = await mcpScoped.callTool("open_url", { url: "https://unmapped.example/x" });
  assert.equal(fallback.isError, false, fallback.text);
  assert.match(fallback.text, /container: Personal \(firefox-container-1\) via the session default container/);
  assert.equal(ext.requestsFor("pages.new").at(-1).params.cookieStoreId, "firefox-container-1");
});

test("new_page follows the same table, and new_page_in_container overrides it out loud", async () => {
  ext.reset();
  const routed = await mcp.callTool("new_page", { url: "https://artistadvisory.io/pricing" });
  assert.equal(routed.isError, false, routed.text);
  assert.match(routed.text, /^new page tabId=\d+ -> https:\/\/artistadvisory\.io\/pricing \(Artist Advisory\)/);
  assert.equal(ext.requestsFor("pages.new").at(-1).params.cookieStoreId, "firefox-container-8");

  const forced = await mcp.callTool("new_page_in_container", {
    name: "Personal",
    url: "https://artistadvisory.io/pricing",
  });
  assert.equal(forced.isError, false, forced.text);
  assert.equal(ext.requestsFor("pages.new").at(-1).params.cookieStoreId, "firefox-container-1");
  assert.match(forced.text, /route "artistadvisory\.io" maps this host to "Artist Advisory"/);
});

test("navigate_page says so when it is about to load a URL into the wrong container", async () => {
  ext.reset();
  const { isError, text } = await mcp.callTool("navigate_page", {
    tabId: 104,
    url: "https://artistadvisory.io/artists",
  });
  assert.equal(isError, false, text);
  assert.match(text, /cannot be moved/);
  assert.match(text, /Use open_url/);
});

test("a route naming a container that does not exist fails loudly and opens nothing", async () => {
  ext.reset();
  const news = ext.requestsFor("pages.new").length;
  const { isError, text } = await mcp.callTool("open_url", { url: "https://ghost.example/" });

  assert.equal(isError, true, "a typo in the table must not silently fall back to another jar");
  assert.match(text, /Ghost Container/);
  assert.match(text, /does not exist/);
  assert.equal(ext.requestsFor("pages.new").length, news, "nothing may be opened");
});

test("container_routes reports the table and resolves one URL", async () => {
  const listed = await mcp.callTool("container_routes");
  assert.equal(listed.isError, false, listed.text);
  assert.match(listed.text, /Artist Advisory: artistadvisory\.io, localhost:3000/);
  assert.match(listed.text, /5 rules from /);

  const resolved = await mcp.callTool("container_routes", { url: "https://cxventures.io/audit" });
  assert.match(resolved.text, /-> "CXVentures" via rule "cxventures\.io"/);
  assert.match(resolved.text, /container exists: CXVentures \(firefox-container-9\)/);

  const unmapped = await mcp.callTool("container_routes", { url: "https://example.org/" });
  assert.match(unmapped.text, /no matching rule/);
});

test("list_pages can filter by container without renumbering positions", async () => {
  ext.reset();
  const all = await mcp.callTool("list_pages");
  const fingerprint = /tabSet=([0-9a-f]{8})/.exec(all.text)[1];

  const filtered = await mcp.callTool("list_pages", { container: "Artist Advisory" });
  assert.equal(filtered.isError, false, filtered.text);
  assert.match(filtered.text, new RegExp(`tabSet=${fingerprint}`), "fingerprint covers the full set");
  assert.match(filtered.text, /Showing 2 of 4/);
  assert.match(filtered.text, /\[0\] tabId=101/);
  assert.match(filtered.text, /\[1\] tabId=102/);
  assert.doesNotMatch(filtered.text, /tabId=103/);

  const none = await mcp.callTool("list_pages", { container: "none" });
  assert.match(none.text, /\[2\] tabId=103/, "positions stay anchored to the full listing");
  assert.doesNotMatch(none.text, /tabId=101/);
});

test("select_page uses the container to break a url tie", async () => {
  ext.reset();
  const ambiguous = await mcp.callTool("select_page", { url: "artistadvisory.io" });
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.text, /pages match url/);

  const disambiguated = await mcp.callTool("select_page", {
    url: "artistadvisory.io/marketing",
    container: "none",
  });
  assert.equal(disambiguated.isError, false, disambiguated.text);
  assert.match(disambiguated.text, /selected tabId=103/);
});

test("get_firefox_info reports the route table state", async () => {
  const { isError, text } = await mcp.callTool("get_firefox_info");
  assert.equal(isError, false, text);
  assert.match(text, /mcp\.containerRoutes: 5 rules from /);
});

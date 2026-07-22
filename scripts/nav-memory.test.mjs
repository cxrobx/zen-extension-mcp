import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  matchesPathGlob,
  normalizeUrl,
  redactText,
  registrableDomain,
  sanitizeLocator,
} from "../shared/dist/nav-redact.js";
import { rankNotes } from "../daemon/dist/nav-memory/ranking.js";
import { JsonNavStore } from "../daemon/dist/nav-memory/store.js";
import { NavMemoryService } from "../daemon/dist/nav-memory/service.js";
import { NavContext } from "../server/dist/nav-memory.js";

test("normalization redacts identifiers and isolates private suffix tenants", () => {
  const value = normalizeUrl("https://User:pass@example.com/x");
  assert.equal(value, null);
  const normalized = normalizeUrl("https://Example.com/users/secret%40example.com/123456?token=bad#frag");
  assert.deepEqual(normalized, { host: "example.com", path: "/users/*/*", registrableDomain: "example.com" });
  assert.equal(registrableDomain("one.vercel.app"), "one.vercel.app");
  assert.equal(registrableDomain("two.vercel.app"), "two.vercel.app");
  assert.equal(registrableDomain("console.cloud.google.com"), "google.com");
  assert.equal(redactText("secret@example.com AKIA1234567890ABCDEF"), "<email> <aws-key>");
  assert.equal(sanitizeLocator('input[value="secret@example.com"][name="email"]'), 'input[value="*"][name="email"]');
});

test("path scoping and ranking exclude nonmatching scoped notes", () => {
  assert.equal(matchesPathGlob("/auth/clients/abc", "/auth/clients/*"), true);
  assert.equal(matchesPathGlob("/billing", "/auth/clients/*"), false);
  const now = new Date().toISOString();
  const base = {
    kind: "workflow",
    detail: "detail",
    example: null,
    tools: [],
    success: true,
    confidence: 0.8,
    reinforced: 1,
    createdAt: now,
    lastSeenAt: now,
    source: null,
    embedding: null,
    registrableDomain: "google.com",
  };
  const notes = [
    { ...base, id: "exact", host: "console.cloud.google.com", pathGlob: null, summary: "exact" },
    { ...base, id: "scoped", host: "console.cloud.google.com", pathGlob: "/auth/clients/*", summary: "scoped" },
    { ...base, id: "related", host: "accounts.google.com", pathGlob: null, summary: "related", reinforced: 16 },
  ];
  assert.deepEqual(rankNotes(notes, { host: "console.cloud.google.com", registrableDomain: "google.com", path: "/billing" }, 10).map((n) => n.id), ["exact", "related"]);
});

test("store permissions, ETL idempotency, and durable seed suppression", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nav-store-test-"));
  const distiller = {
    async distill() {
      return [{ kind: "selector", summary: "The form exposes a stable selector.", detail: "The email input uses its name attribute.", tools: ["fill"], success: true, confidence: 0.6 }];
    },
  };
  const embedder = {
    model: "fake",
    dimension: 3,
    async isAvailable() { return false; },
    async embedDocuments() { return []; },
    async embedQuery() { return new Float32Array([1, 0, 0]); },
    status() { return { available: false, lastCheckedAt: null }; },
  };
  try {
    const store = new JsonNavStore(dir);
    const service = new NavMemoryService(store, distiller, embedder);
    await service.init();
    assert.equal(store.noteCount(), 6);
    assert.equal((await stat(join(dir, "notes.json"))).mode & 0o777, 0o600);
    await service.handleRequest({ connId: "c1", containerScope: "Personal" }, "navMemory.recordEvents", {
      events: [{ ts: Date.now(), tool: "fill", host: "example.com", path: "/form", ok: true, locator: "css:input[name=email]" }],
    });
    await service.onSessionEnd("c1");
    process.env.ZEN_EXT_MCP_NAV_ETL_PROBE = "1";
    const first = await service.handleRequest({ connId: "probe", containerScope: null }, "navMemory.etlNow", {});
    assert.equal(first.status, "processed");
    const learned = store.allNotes().find((note) => note.host === "example.com");
    assert.ok(learned);
    assert.equal(await store.applyEtlBatch(first.workId, [{ note: learned }]), 0);
    assert.equal(store.allNotes().find((note) => note.id === learned.id).reinforced, 1);
    const seedId = store.allNotes().find((note) => note.source?.seed)?.id;
    await store.forget({ id: seedId });
    await service.stop();

    const reopened = new JsonNavStore(dir);
    const service2 = new NavMemoryService(reopened, distiller, embedder);
    await service2.init();
    assert.equal(reopened.allNotes().some((note) => note.id === seedId), false);
    await service2.stop();
    assert.equal((await readFile(join(dir, "notes.json"), "utf8")).includes("secret@example.com"), false);
  } finally {
    delete process.env.ZEN_EXT_MCP_NAV_ETL_PROBE;
    await rm(dir, { recursive: true, force: true });
  }
});

test("server injection is once per host and capture excludes entered values", async () => {
  const calls = [];
  const daemon = {
    async call(method, params) {
      calls.push({ method, params });
      if (method === "navMemory.query") {
        return { host: "example.com", registrableDomain: "example.com", total: 1, notes: [{ id: "n", host: "example.com", pathGlob: null, kind: "selector", summary: "The form has a stable selector.", confidence: 0.7, reinforced: 1 }] };
      }
      return { accepted: params.events.length, dropped: 0 };
    },
  };
  const nav = new NavContext(daemon, true);
  nav.observePages([{ tabId: 1, windowId: 1, index: 0, url: "https://example.com/form", title: "", active: true, cookieStoreId: "x", containerName: null }]);
  const wrapped = nav.wrap("fill", async () => ({ content: [{ type: "text", text: "filled" }] }));
  const one = await wrapped({ pageIdx: 0, selector: "css:input[name=email]", value: "secret@example.com" });
  const two = await wrapped({ pageIdx: 0, selector: "css:input[name=email]", value: "another@example.com" });
  assert.match(one.content[0].text, /^\[nav-memory\]/);
  assert.equal(two.content[0].text, "filled");
  await new Promise((resolve) => setImmediate(resolve));
  const records = calls.filter((call) => call.method === "navMemory.recordEvents");
  assert.equal(JSON.stringify(records).includes("secret@example.com"), false);
  assert.equal(JSON.stringify(records).includes("another@example.com"), false);
});

test("query failures remain retryable and the kill switch is inert", async () => {
  let queries = 0;
  const daemon = {
    async call(method, params) {
      if (method === "navMemory.query") {
        queries += 1;
        if (queries === 1) throw new Error("transient");
        return { host: "example.com", registrableDomain: "example.com", total: 1, notes: [{ id: "n", host: "example.com", pathGlob: null, kind: "timing", summary: "The page settles after navigation.", confidence: 0.6, reinforced: 1 }] };
      }
      return { accepted: params.events.length, dropped: 0 };
    },
  };
  const nav = new NavContext(daemon, true);
  const wrapped = nav.wrap("navigate_page", async () => ({ content: [{ type: "text", text: "done" }] }));
  assert.equal((await wrapped({ url: "https://example.com/" })).content[0].text, "done");
  assert.match((await wrapped({ url: "https://example.com/" })).content[0].text, /^\[nav-memory\]/);
  assert.equal(queries, 2);

  const disabled = new NavContext({ async call() { throw new Error("must not call"); } }, false);
  const plain = await disabled.wrap("navigate_page", async () => ({ content: [{ type: "text", text: "plain" }] }))({ url: "https://example.com/" });
  assert.equal(plain.content[0].text, "plain");
});

test("failed ETL reaches quarantine and decay uses elapsed time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nav-failure-test-"));
  let clock = new Date("2025-01-01T00:00:00.000Z");
  const distiller = { async distill() { throw new Error("fixture failure"); } };
  const embedder = {
    model: "fake",
    dimension: 3,
    async isAvailable() { return false; },
    async embedDocuments() { return []; },
    async embedQuery() { return new Float32Array([1, 0, 0]); },
    status() { return { available: false, lastCheckedAt: null }; },
  };
  try {
    const store = new JsonNavStore(dir);
    const service = new NavMemoryService(store, distiller, embedder, () => new Date(clock));
    await service.init();
    await service.tick();
    await service.handleRequest({ connId: "c", containerScope: null }, "navMemory.recordEvents", {
      events: [{ ts: clock.getTime(), tool: "click", host: "example.com", path: "/", ok: false, errorCode: "TIMEOUT" }],
    });
    await service.onSessionEnd("c");
    process.env.ZEN_EXT_MCP_NAV_ETL_PROBE = "1";
    for (let i = 0; i < 3; i++) await service.handleRequest({ connId: "probe", containerScope: null }, "navMemory.etlNow", {});
    assert.equal((await store.counts()).failed, 1);
    const before = store.allNotes()[0].confidence;
    clock = new Date("2025-03-12T00:00:00.000Z");
    await service.tick();
    assert.ok(store.allNotes()[0].confidence < before);
    await service.stop();
  } finally {
    delete process.env.ZEN_EXT_MCP_NAV_ETL_PROBE;
    await rm(dir, { recursive: true, force: true });
  }
});

test("corrupt stores are preserved with restrictive permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nav-corrupt-test-"));
  try {
    await mkdir(join(dir, "sessions"), { recursive: true });
    await writeFile(join(dir, "notes.json"), "not-json", { mode: 0o600 });
    const store = new JsonNavStore(dir);
    await store.init();
    const backup = (await readdir(dir)).find((name) => name.startsWith("notes.json.corrupt-"));
    assert.ok(backup);
    assert.equal((await stat(join(dir, backup))).mode & 0o777, 0o600);
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

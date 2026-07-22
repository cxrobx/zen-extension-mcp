import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  NAV_NOTE_CAPS,
  NAV_NOTE_KINDS,
  type NavEventRecord,
  type NavNote,
  type NavSessionLog,
} from "@zen-ext-mcp/shared";
import { normalizeHost, registrableDomain, sanitizeLocator, truncateUtf8, validPathGlob } from "@zen-ext-mcp/shared/nav-redact";
import { log } from "../log.js";

const STORE_SCHEMA_VERSION = 1;
const MAX_PROCESSED_IDS = 2_048;

export interface StoreMeta {
  lastDecayAt: string | null;
  embeddingModel: string;
  embeddingDimension: number;
  processedWorkIds: string[];
  suppressedSeedIds: string[];
  pruned: number;
  droppedEvents: number;
}

interface StoreDocument {
  schemaVersion: 1;
  seedVersion: number;
  notes: NavNote[];
  meta: StoreMeta;
}

export interface EtlMutation {
  note: NavNote;
  mergeIntoId?: string;
}

export interface ForgetCounts {
  notes: number;
  pending: number;
  processing: number;
  failed: number;
}

function defaultMeta(): StoreMeta {
  return {
    lastDecayAt: null,
    embeddingModel: "nomic-embed-text",
    embeddingDimension: 768,
    processedWorkIds: [],
    suppressedSeedIds: [],
    pruned: 0,
    droppedEvents: 0,
  };
}

function isNote(value: unknown): value is NavNote {
  if (!value || typeof value !== "object") return false;
  const n = value as Partial<NavNote>;
  return Boolean(
    typeof n.id === "string" && /^[0-9a-f]{64}$/.test(n.id) &&
    typeof n.host === "string" && normalizeHost(n.host) === n.host &&
    typeof n.kind === "string" && NAV_NOTE_KINDS.includes(n.kind as NavNote["kind"]) &&
    typeof n.summary === "string" && n.summary.length > 0 && Buffer.byteLength(n.summary) <= NAV_NOTE_CAPS.summary &&
    typeof n.detail === "string" && n.detail.length > 0 && Buffer.byteLength(n.detail) <= NAV_NOTE_CAPS.detail &&
    (n.example === null || (typeof n.example === "string" && Buffer.byteLength(n.example) <= NAV_NOTE_CAPS.example)) &&
    (n.pathGlob === null || (typeof n.pathGlob === "string" && validPathGlob(n.pathGlob))) &&
    Array.isArray(n.tools) && n.tools.every((tool) => typeof tool === "string") &&
    typeof n.success === "boolean" &&
    typeof n.confidence === "number" && n.confidence >= 0 && n.confidence <= 1 &&
    Number.isInteger(n.reinforced) && n.reinforced! >= 1 &&
    typeof n.createdAt === "string" && Number.isFinite(Date.parse(n.createdAt)) &&
    typeof n.lastSeenAt === "string" && Number.isFinite(Date.parse(n.lastSeenAt)) &&
    (n.embedding === null || typeof n.embedding === "string")
  );
}

function isSessionLog(value: unknown): value is NavSessionLog {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<NavSessionLog>;
  return (
    item.schemaVersion === 1 &&
    typeof item.workId === "string" &&
    typeof item.host === "string" &&
    typeof item.startedAt === "string" && Number.isFinite(Date.parse(item.startedAt)) &&
    typeof item.endedAt === "string" && Number.isFinite(Date.parse(item.endedAt)) &&
    Number.isInteger(item.attempts) && item.attempts! >= 0 &&
    Array.isArray(item.events)
  );
}

function normalizedMeta(value: unknown): StoreMeta {
  const raw = value && typeof value === "object" ? value as Partial<StoreMeta> : {};
  return {
    lastDecayAt: typeof raw.lastDecayAt === "string" && Number.isFinite(Date.parse(raw.lastDecayAt)) ? raw.lastDecayAt : null,
    embeddingModel: typeof raw.embeddingModel === "string" ? raw.embeddingModel : "nomic-embed-text",
    embeddingDimension: Number.isInteger(raw.embeddingDimension) && raw.embeddingDimension! > 0 ? raw.embeddingDimension! : 768,
    processedWorkIds: Array.isArray(raw.processedWorkIds) ? raw.processedWorkIds.filter((id): id is string => typeof id === "string").slice(-MAX_PROCESSED_IDS) : [],
    suppressedSeedIds: Array.isArray(raw.suppressedSeedIds) ? raw.suppressedSeedIds.filter((id): id is string => typeof id === "string" && /^[0-9a-f]{64}$/.test(id)) : [],
    pruned: Number.isInteger(raw.pruned) && raw.pruned! >= 0 ? raw.pruned! : 0,
    droppedEvents: Number.isInteger(raw.droppedEvents) && raw.droppedEvents! >= 0 ? raw.droppedEvents! : 0,
  };
}

function sanitizeStoredEvent(value: unknown): NavEventRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<NavEventRecord>;
  if (typeof raw.ts !== "number" || typeof raw.tool !== "string" || typeof raw.ok !== "boolean") return null;
  const event: NavEventRecord = { ts: raw.ts, tool: truncateUtf8(raw.tool, 60), ok: raw.ok };
  if (typeof raw.host === "string" && normalizeHost(raw.host) === raw.host) event.host = raw.host;
  if (typeof raw.path === "string" && raw.path.startsWith("/")) event.path = truncateUtf8(raw.path, 500);
  if (raw.navigated === true) event.navigated = true;
  if (typeof raw.errorCode === "string" && /^[A-Z_]{2,32}$/.test(raw.errorCode)) event.errorCode = raw.errorCode;
  for (const key of ["locator", "relatedLocator"] as const) {
    if (typeof raw[key] === "string") {
      const clean = sanitizeLocator(raw[key]!);
      if (clean) event[key] = clean;
    }
  }
  if (typeof raw.keys === "string" && /^[A-Za-z0-9+ ]{1,40}$/.test(raw.keys)) event.keys = raw.keys;
  if (typeof raw.waitCondition === "string" && /^[a-z_]{1,32}$/.test(raw.waitCondition)) event.waitCondition = raw.waitCondition;
  if (Number.isInteger(raw.matchCount) && raw.matchCount! >= 0) event.matchCount = Math.min(raw.matchCount!, 10_000);
  if (typeof raw.role === "string" && /^[a-z-]{1,40}$/.test(raw.role)) event.role = raw.role;
  if (Number.isInteger(raw.snapshotUids) && raw.snapshotUids! >= 0) event.snapshotUids = Math.min(raw.snapshotUids!, 100_000);
  if (typeof raw.snapshotTruncated === "boolean") event.snapshotTruncated = raw.snapshotTruncated;
  return event.host ? event : null;
}

export class JsonNavStore {
  readonly notesPath: string;
  readonly pendingDir: string;
  readonly processingDir: string;
  readonly failedDir: string;
  private notes = new Map<string, NavNote>();
  private meta: StoreMeta = defaultMeta();
  private seedVersion = 0;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(readonly dir: string) {
    this.notesPath = join(dir, "notes.json");
    this.pendingDir = join(dir, "sessions", "pending");
    this.processingDir = join(dir, "sessions", "processing");
    this.failedDir = join(dir, "sessions", "failed");
  }

  async init(): Promise<void> {
    for (const path of [this.dir, join(this.dir, "sessions"), this.pendingDir, this.processingDir, this.failedDir]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      await chmod(path, 0o700);
    }
    await this.assertNotSymlink(this.notesPath);
    try {
      const raw = await readFile(this.notesPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreDocument>;
      if (parsed.schemaVersion !== STORE_SCHEMA_VERSION || !Array.isArray(parsed.notes)) {
        throw new Error("unsupported or malformed nav-memory store");
      }
      this.notes = new Map(parsed.notes.filter(isNote).map((note) => [note.id, note]));
      this.seedVersion = typeof parsed.seedVersion === "number" ? parsed.seedVersion : 0;
      this.meta = normalizedMeta(parsed.meta);
      await chmod(this.notesPath, 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        await this.preserveCorruptStore();
        log.warn("nav-memory store corrupt; starting empty", { err: (err as Error).message });
      }
      await this.persist();
    }
    await this.recoverProcessing();
  }

  private async assertNotSymlink(path: string): Promise<void> {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`refusing symlinked nav-memory path: ${path}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  private async preserveCorruptStore(): Promise<void> {
    try {
      const target = join(this.dir, `notes.json.corrupt-${Date.now()}`);
      await rename(this.notesPath, target);
      await chmod(target, 0o600);
      const backups = (await readdir(this.dir))
        .filter((name) => name.startsWith("notes.json.corrupt-"))
        .sort();
      for (const old of backups.slice(0, -3)) await rm(join(this.dir, old), { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  private document(): StoreDocument {
    return {
      schemaVersion: STORE_SCHEMA_VERSION,
      seedVersion: this.seedVersion,
      notes: [...this.notes.values()],
      meta: this.meta,
    };
  }

  private persist(): Promise<void> {
    const write = async () => {
      const temp = join(this.dir, `notes.json.tmp-${process.pid}-${randomUUID()}`);
      await writeFile(temp, JSON.stringify(this.document(), null, 2) + "\n", { mode: 0o600 });
      await chmod(temp, 0o600);
      await rename(temp, this.notesPath);
      await chmod(this.notesPath, 0o600);
    };
    const next = this.writeChain.catch(() => undefined).then(write);
    this.writeChain = next;
    return next;
  }

  allNotes(): NavNote[] {
    return [...this.notes.values()];
  }

  noteCount(): number {
    return this.notes.size;
  }

  getMeta(): StoreMeta {
    return { ...this.meta, processedWorkIds: [...this.meta.processedWorkIds], suppressedSeedIds: [...this.meta.suppressedSeedIds] };
  }

  async setMeta(patch: Partial<StoreMeta>): Promise<void> {
    this.meta = { ...this.meta, ...patch };
    await this.persist();
  }

  async setSeedVersion(version: number): Promise<void> {
    this.seedVersion = version;
    await this.persist();
  }

  async upsertSeed(note: NavNote): Promise<boolean> {
    if (this.meta.suppressedSeedIds.includes(note.id) || this.notes.has(note.id)) return false;
    this.notes.set(note.id, note);
    await this.persist();
    return true;
  }

  async updateNotes(notes: NavNote[]): Promise<void> {
    for (const note of notes) this.notes.set(note.id, note);
    await this.persist();
  }

  async replaceAllNotes(notes: NavNote[], metaPatch?: Partial<StoreMeta>): Promise<void> {
    this.notes = new Map(notes.map((note) => [note.id, note]));
    if (metaPatch) this.meta = { ...this.meta, ...metaPatch };
    await this.persist();
  }

  async applyEtlBatch(workId: string, mutations: EtlMutation[]): Promise<number> {
    if (this.meta.processedWorkIds.includes(workId)) return 0;
    let changed = 0;
    for (const mutation of mutations) {
      const targetId = mutation.mergeIntoId ?? mutation.note.id;
      const existing = this.notes.get(targetId);
      if (existing) {
        const incoming = mutation.note;
        this.notes.set(targetId, {
          ...existing,
          detail: incoming.confidence > existing.confidence ? incoming.detail : existing.detail,
          example: incoming.confidence > existing.confidence ? incoming.example : existing.example,
          tools: [...new Set([...existing.tools, ...incoming.tools])],
          success: existing.success || incoming.success,
          confidence: Math.max(existing.confidence, incoming.confidence),
          reinforced: existing.reinforced + 1,
          lastSeenAt: incoming.lastSeenAt,
          embedding: existing.embedding ?? incoming.embedding,
        });
      } else {
        this.notes.set(incomingId(mutation), mutation.note);
      }
      changed += 1;
    }
    this.meta.processedWorkIds = [...this.meta.processedWorkIds, workId].slice(-MAX_PROCESSED_IDS);
    await this.persist();
    return changed;
  }

  async saveSessionLogs(logs: NavSessionLog[]): Promise<void> {
    for (const session of logs) {
      const filename = `${Date.parse(session.endedAt) || Date.now()}-${session.workId}.json`;
      await this.writeJsonAtomic(this.pendingDir, filename, session);
    }
  }

  private async writeJsonAtomic(dir: string, filename: string, value: unknown): Promise<void> {
    const target = join(dir, filename);
    await this.assertNotSymlink(target);
    const temp = join(dir, `.${filename}.tmp-${process.pid}-${randomUUID()}`);
    await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, target);
    await chmod(target, 0o600);
  }

  private async listJson(dir: string): Promise<string[]> {
    return (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  }

  async counts(): Promise<{ pending: number; processing: number; failed: number }> {
    const [pending, processing, failed] = await Promise.all([
      this.listJson(this.pendingDir),
      this.listJson(this.processingDir),
      this.listJson(this.failedDir),
    ]);
    return { pending: pending.length, processing: processing.length, failed: failed.length };
  }

  async claimOldest(): Promise<{ filename: string; log: NavSessionLog } | null> {
    const names = await this.listJson(this.pendingDir);
    const filename = names[0];
    if (!filename) return null;
    const source = join(this.pendingDir, filename);
    const target = join(this.processingDir, filename);
    try {
      await rename(source, target);
      const parsed = JSON.parse(await readFile(target, "utf8")) as unknown;
      if (!isSessionLog(parsed)) throw new Error("invalid session log");
      const host = normalizeHost(parsed.host);
      if (!host) throw new Error("invalid session host");
      const clean: NavSessionLog = {
        schemaVersion: 1,
        workId: truncateUtf8(parsed.workId, 80),
        host,
        registrableDomain: registrableDomain(host),
        container: typeof parsed.container === "string" ? truncateUtf8(parsed.container, 100) : null,
        startedAt: parsed.startedAt,
        endedAt: parsed.endedAt,
        attempts: Math.max(0, Math.min(3, parsed.attempts)),
        events: parsed.events.slice(0, 500).map(sanitizeStoredEvent).filter((event): event is NavEventRecord => Boolean(event)),
      };
      return { filename, log: clean };
    } catch (err) {
      try {
        await rename(target, join(this.failedDir, filename));
      } catch {
        // The claim may have raced with another caller.
      }
      log.warn("nav-memory could not claim session log", { filename, err: (err as Error).message });
      return null;
    }
  }

  async completeWork(filename: string): Promise<void> {
    await rm(join(this.processingDir, filename), { force: true });
  }

  async retryWork(filename: string, session: NavSessionLog): Promise<void> {
    session.attempts += 1;
    const processing = join(this.processingDir, filename);
    if (session.attempts >= 3) {
      await this.writeJsonAtomic(this.failedDir, filename, session);
      await rm(processing, { force: true });
    } else {
      await this.writeJsonAtomic(this.pendingDir, filename, session);
      await rm(processing, { force: true });
    }
  }

  private async recoverProcessing(): Promise<void> {
    for (const filename of await this.listJson(this.processingDir)) {
      try {
        await rename(join(this.processingDir, filename), join(this.pendingDir, filename));
      } catch (err) {
        log.warn("nav-memory processing recovery failed", { filename, err: (err as Error).message });
      }
    }
  }

  async prune(now = Date.now()): Promise<void> {
    const ttl = 30 * 24 * 60 * 60 * 1_000;
    let pruned = 0;
    for (const [dir, cap] of [[this.pendingDir, 200], [this.failedDir, 50]] as const) {
      const files = await this.listJson(dir);
      const remove = new Set(files.slice(0, Math.max(0, files.length - cap)));
      for (const filename of files) {
        try {
          const info = await stat(join(dir, filename));
          if (now - info.mtimeMs > ttl) remove.add(filename);
        } catch {
          remove.add(filename);
        }
      }
      for (const filename of remove) {
        await rm(join(dir, filename), { force: true });
        pruned += 1;
      }
    }
    if (pruned > 0) {
      this.meta.pruned += pruned;
      await this.persist();
      log.warn("nav-memory pruned raw work", { pruned });
    }
  }

  async forget(params: { id?: string; host?: string; includeRaw?: boolean }): Promise<ForgetCounts> {
    let notes = 0;
    if (params.id) {
      const note = this.notes.get(params.id);
      if (note?.source?.seed && !this.meta.suppressedSeedIds.includes(note.id)) {
        this.meta.suppressedSeedIds.push(note.id);
      }
      if (this.notes.delete(params.id)) notes += 1;
    } else if (params.host) {
      for (const note of [...this.notes.values()]) {
        if (note.host !== params.host) continue;
        if (note.source?.seed && !this.meta.suppressedSeedIds.includes(note.id)) {
          this.meta.suppressedSeedIds.push(note.id);
        }
        this.notes.delete(note.id);
        notes += 1;
      }
    }
    const raw = { pending: 0, processing: 0, failed: 0 };
    if (params.host && params.includeRaw !== false) {
      for (const [kind, dir] of [["pending", this.pendingDir], ["processing", this.processingDir], ["failed", this.failedDir]] as const) {
        for (const filename of await this.listJson(dir)) {
          try {
            const value = JSON.parse(await readFile(join(dir, filename), "utf8")) as Partial<NavSessionLog>;
            if (value.host === params.host) {
              await rm(join(dir, filename), { force: true });
              raw[kind] += 1;
            }
          } catch {
            // Malformed work is handled by normal recovery/pruning.
          }
        }
      }
    }
    await this.persist();
    return { notes, ...raw };
  }

  async storeBytes(): Promise<number> {
    try {
      return (await stat(this.notesPath)).size;
    } catch {
      return 0;
    }
  }

  async close(): Promise<void> {
    await this.writeChain.catch(() => undefined);
  }
}

function incomingId(mutation: EtlMutation): string {
  return mutation.note.id;
}

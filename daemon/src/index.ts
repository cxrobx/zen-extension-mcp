#!/usr/bin/env node
import { WebSocketServer, type WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_DAEMON_HOST,
  DEFAULT_DAEMON_PORT,
  ErrorCode,
  PROTOCOL_VERSION,
  decode,
  encode,
  type RequestMessage,
  type ResponseMessage,
  type WireMessage,
} from "@zen-ext-mcp/shared";
import { defaultAuthPath, loadOrCreateToken, tokensEqual } from "./auth.js";
import { log } from "./log.js";

const HEARTBEAT_INTERVAL_MS = 30_000;
const HELLO_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
const EXTENSION_RECONNECT_GRACE_MS = 3_000;
const QUEUE_SWEEP_INTERVAL_MS = 250;

interface CliOptions {
  port: number;
  host: string;
  tokenPath: string;
}

function parseArgs(argv: string[]): CliOptions {
  let port = DEFAULT_DAEMON_PORT;
  let host = DEFAULT_DAEMON_HOST;
  let tokenPath = defaultAuthPath();
  const envPort = process.env.ZEN_EXT_MCP_PORT;
  if (envPort) port = Number.parseInt(envPort, 10);
  const envHost = process.env.ZEN_EXT_MCP_HOST;
  if (envHost) host = envHost;
  const envToken = process.env.ZEN_EXT_MCP_TOKEN_FILE;
  if (envToken) tokenPath = envToken;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" && argv[i + 1]) {
      port = Number.parseInt(argv[++i] ?? "", 10);
    } else if (arg === "--host" && argv[i + 1]) {
      host = argv[++i] ?? host;
    } else if (arg === "--token-file" && argv[i + 1]) {
      tokenPath = argv[++i] ?? tokenPath;
    }
  }
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid port: ${port}`);
  }
  return { port, host, tokenPath };
}

interface PendingRequest {
  clientId: string;
  method: string;
  startedAt: number;
  timer: NodeJS.Timeout;
}

interface QueuedRequest {
  clientId: string;
  msg: RequestMessage;
  deadline: number;
}

interface Connection {
  id: string;
  ws: WebSocket;
  role: "extension" | "client" | null;
  authenticated: boolean;
  alive: boolean;
  containerScope?: string | null;
  helloTimer?: NodeJS.Timeout;
}

class Daemon {
  private wss: WebSocketServer | null = null;
  private extension: Connection | null = null;
  private clients = new Map<string, Connection>();
  private pending = new Map<string, PendingRequest>();
  private queuedForExtension: QueuedRequest[] = [];
  private heartbeat: NodeJS.Timeout | null = null;
  private queueSweep: NodeJS.Timeout | null = null;
  readonly serverId = randomUUID();

  constructor(private readonly token: string) {}

  start(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host, port });
      wss.once("listening", () => {
        log.info("daemon listening", { host, port, serverId: this.serverId });
        resolve();
      });
      wss.once("error", reject);
      wss.on("connection", (ws) => this.onConnection(ws));
      this.wss = wss;
      this.heartbeat = setInterval(() => this.tick(), HEARTBEAT_INTERVAL_MS);
      this.queueSweep = setInterval(
        () => this.sweepExpiredQueuedRequests(),
        QUEUE_SWEEP_INTERVAL_MS,
      );
    });
  }

  private onConnection(ws: WebSocket): void {
    const conn: Connection = {
      id: randomUUID(),
      ws,
      role: null,
      authenticated: false,
      alive: true,
    };
    conn.helloTimer = setTimeout(() => {
      if (!conn.authenticated) {
        log.warn("hello timeout", { connId: conn.id });
        ws.close(1008, "hello timeout");
      }
    }, HELLO_TIMEOUT_MS);

    ws.on("message", (data) => this.onMessage(conn, data.toString("utf8")));
    ws.on("close", (code, reason) => this.onClose(conn, code, reason.toString("utf8")));
    ws.on("error", (err) => log.warn("ws error", { connId: conn.id, err: err.message }));
    ws.on("pong", () => {
      conn.alive = true;
    });
  }

  private onMessage(conn: Connection, raw: string): void {
    let msg: WireMessage;
    try {
      msg = decode(raw);
    } catch (err) {
      log.warn("decode error", { connId: conn.id, err: (err as Error).message });
      conn.ws.close(1003, "invalid message");
      return;
    }

    if (!conn.authenticated) {
      if (msg.type !== "hello") {
        conn.ws.close(1008, "expected hello");
        return;
      }
      this.handleHello(conn, msg);
      return;
    }

    switch (msg.type) {
      case "ping":
        this.send(conn, { type: "pong", ts: msg.ts });
        return;
      case "pong":
        conn.alive = true;
        return;
      case "request":
        this.handleRequest(conn, msg);
        return;
      case "response":
        this.handleResponse(conn, msg);
        return;
      default:
        log.warn("unexpected message", { connId: conn.id, type: msg.type });
    }
  }

  private handleHello(conn: Connection, msg: WireMessage & { type: "hello" }): void {
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      this.send(conn, {
        type: "unauthorized",
        reason: `protocol version mismatch: server=${PROTOCOL_VERSION} client=${msg.protocolVersion}`,
      });
      conn.ws.close(1008, "protocol mismatch");
      return;
    }
    if (!tokensEqual(msg.token, this.token)) {
      this.send(conn, { type: "unauthorized", reason: "invalid token" });
      conn.ws.close(1008, "unauthorized");
      return;
    }

    if (conn.helloTimer) {
      clearTimeout(conn.helloTimer);
      conn.helloTimer = undefined;
    }

    conn.role = msg.role;
    conn.authenticated = true;
    conn.containerScope = msg.containerScope ?? null;

    if (msg.role === "extension") {
      if (this.extension) {
        log.info("replacing extension connection", {
          old: this.extension.id,
          new: conn.id,
        });
        this.extension.ws.close(1000, "replaced");
        this.failPendingForExtension();
      }
      this.extension = conn;
      this.flushQueuedRequests();
    } else {
      this.clients.set(conn.id, conn);
    }

    this.send(conn, {
      type: "welcome",
      serverId: this.serverId,
      protocolVersion: PROTOCOL_VERSION,
    });
    log.debug("authenticated", {
      connId: conn.id,
      role: msg.role,
      containerScope: conn.containerScope ?? null,
    });
  }

  private handleRequest(conn: Connection, msg: RequestMessage): void {
    if (conn.role !== "client") {
      this.respond(conn, msg.id, undefined, {
        code: ErrorCode.InvalidRequest,
        message: "only clients may send requests",
      });
      return;
    }
    if (!this.extension) {
      this.queuedForExtension.push({
        clientId: conn.id,
        msg,
        deadline: Date.now() + EXTENSION_RECONNECT_GRACE_MS,
      });
      return;
    }
    this.forwardToExtension(conn, msg);
  }

  private forwardToExtension(conn: Connection, msg: RequestMessage): void {
    if (!this.extension) {
      this.respond(conn, msg.id, undefined, {
        code: ErrorCode.ExtensionNotConnected,
        message: "extension not connected",
      });
      return;
    }
    const timer = setTimeout(() => {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      this.respond(conn, msg.id, undefined, {
        code: ErrorCode.ExtensionTimeout,
        message: `extension did not respond within ${REQUEST_TIMEOUT_MS}ms`,
      });
    }, REQUEST_TIMEOUT_MS);

    this.pending.set(msg.id, {
      clientId: conn.id,
      method: msg.method,
      startedAt: Date.now(),
      timer,
    });
    this.send(this.extension, msg);
  }

  private flushQueuedRequests(): void {
    if (!this.extension || this.queuedForExtension.length === 0) return;
    const now = Date.now();
    const queued = this.queuedForExtension;
    this.queuedForExtension = [];
    for (const item of queued) {
      const client = this.clients.get(item.clientId);
      if (!client) continue;
      if (item.deadline <= now) {
        this.respond(client, item.msg.id, undefined, {
          code: ErrorCode.ExtensionNotConnected,
          message: "extension not connected",
        });
        continue;
      }
      this.forwardToExtension(client, item.msg);
    }
  }

  private sweepExpiredQueuedRequests(): void {
    if (this.queuedForExtension.length === 0) return;
    const now = Date.now();
    const remaining: QueuedRequest[] = [];
    for (const item of this.queuedForExtension) {
      const client = this.clients.get(item.clientId);
      if (!client) continue;
      if (item.deadline <= now) {
        this.respond(client, item.msg.id, undefined, {
          code: ErrorCode.ExtensionNotConnected,
          message: "extension not connected",
        });
      } else {
        remaining.push(item);
      }
    }
    this.queuedForExtension = remaining;
  }

  private handleResponse(conn: Connection, msg: ResponseMessage): void {
    if (conn.role !== "extension") {
      log.warn("non-extension sent response", { connId: conn.id });
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) {
      log.debug("response for unknown id", { id: msg.id });
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(msg.id);
    const client = this.clients.get(pending.clientId);
    if (!client) return;
    this.send(client, msg);
    log.debug("rpc complete", {
      method: pending.method,
      durationMs: Date.now() - pending.startedAt,
    });
  }

  private onClose(conn: Connection, code: number, reason: string): void {
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    if (conn.role === "extension" && this.extension?.id === conn.id) {
      log.debug("extension disconnected", { code, reason });
      this.extension = null;
      // In-flight requests fail fast. Re-sending after reconnect could double-execute actions.
      this.failPendingForExtension();
    } else if (conn.role === "client") {
      this.clients.delete(conn.id);
      this.queuedForExtension = this.queuedForExtension.filter(
        (item) => item.clientId !== conn.id,
      );
      log.debug("client disconnected", {
        connId: conn.id,
        containerScope: conn.containerScope ?? null,
      });
    }
  }

  private failPendingForExtension(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      const client = this.clients.get(pending.clientId);
      if (client) {
        this.respond(client, id, undefined, {
          code: ErrorCode.ExtensionNotConnected,
          message: "extension disconnected before responding",
        });
      }
    }
    this.pending.clear();
  }

  private tick(): void {
    this.sweepExpiredQueuedRequests();
    const conns: Connection[] = [];
    if (this.extension) conns.push(this.extension);
    for (const c of this.clients.values()) conns.push(c);
    for (const conn of conns) {
      if (!conn.authenticated) continue;
      if (!conn.alive) {
        log.warn("heartbeat lost, terminating", { connId: conn.id, role: conn.role });
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      try {
        conn.ws.ping();
      } catch (err) {
        log.warn("ping failed", { connId: conn.id, err: (err as Error).message });
      }
    }
  }

  private send(conn: Connection, msg: WireMessage): void {
    try {
      conn.ws.send(encode(msg));
    } catch (err) {
      log.warn("send failed", { connId: conn.id, err: (err as Error).message });
    }
  }

  private respond(
    conn: Connection,
    id: string,
    result: unknown,
    error?: { code: number; message: string },
  ): void {
    const msg: ResponseMessage = error
      ? { type: "response", id, error }
      : { type: "response", id, result };
    this.send(conn, msg);
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.queueSweep) clearInterval(this.queueSweep);
    if (this.wss) {
      await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
    }
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const token = loadOrCreateToken(opts.tokenPath);
  log.info("auth token loaded", { path: opts.tokenPath });

  const daemon = new Daemon(token);
  await daemon.start(opts.host, opts.port);

  const shutdown = async (signal: string) => {
    log.info("shutting down", { signal });
    await daemon.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error("fatal", { err: (err as Error).message });
  process.exit(1);
});

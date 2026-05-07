import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import {
  ErrorCode,
  PROTOCOL_VERSION,
  decode,
  encode,
  type RequestMessage,
  type ResponseMessage,
  type WireMessage,
} from "@zen-ext-mcp/shared";

const HELLO_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export interface DaemonClientOptions {
  url: string;
  token: string;
  containerScope?: string | null;
}

export class DaemonClient {
  private ws: WebSocket | null = null;
  private connected = false;
  private connecting: Promise<void> | null = null;
  private pending = new Map<string, PendingCall>();
  private reconnectAttempt = 0;
  private closed = false;

  constructor(private readonly opts: DaemonClientOptions) {}

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.openOnce();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private openOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.opts.url);
      this.ws = ws;
      const helloTimer = setTimeout(() => {
        reject(new Error("hello timeout"));
        ws.close();
      }, HELLO_TIMEOUT_MS);

      ws.on("open", () => {
        const hello: WireMessage = {
          type: "hello",
          protocolVersion: PROTOCOL_VERSION,
          role: "client",
          token: this.opts.token,
          containerScope: this.opts.containerScope ?? null,
        };
        ws.send(encode(hello));
      });

      ws.once("message", (data) => {
        let msg: WireMessage;
        try {
          msg = decode(data.toString("utf8"));
        } catch (err) {
          clearTimeout(helloTimer);
          reject(err as Error);
          ws.close();
          return;
        }
        if (msg.type === "welcome") {
          clearTimeout(helloTimer);
          this.connected = true;
          this.reconnectAttempt = 0;
          this.attachHandlers(ws);
          resolve();
          return;
        }
        if (msg.type === "unauthorized") {
          clearTimeout(helloTimer);
          reject(new Error(`unauthorized: ${msg.reason}`));
          ws.close();
          return;
        }
        clearTimeout(helloTimer);
        reject(new Error(`unexpected handshake message: ${msg.type}`));
        ws.close();
      });

      ws.on("error", (err) => {
        clearTimeout(helloTimer);
        if (!this.connected) reject(err);
      });
    });
  }

  private attachHandlers(ws: WebSocket): void {
    ws.on("message", (data) => {
      let msg: WireMessage;
      try {
        msg = decode(data.toString("utf8"));
      } catch {
        return;
      }
      if (msg.type === "response") {
        this.handleResponse(msg);
      } else if (msg.type === "ping") {
        ws.send(encode({ type: "pong", ts: msg.ts }));
      }
    });
    ws.on("close", () => this.onDisconnect("close"));
    ws.on("error", () => this.onDisconnect("error"));
  }

  private handleResponse(msg: ResponseMessage): void {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(msg.id);
    if (msg.error) {
      pending.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
    } else {
      pending.resolve(msg.result);
    }
  }

  private onDisconnect(_reason: string): void {
    this.connected = false;
    this.ws = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new RpcError(ErrorCode.ExtensionNotConnected, "daemon connection lost"));
    }
    this.pending.clear();
    if (!this.closed) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    setTimeout(() => {
      if (this.closed) return;
      this.connect().catch(() => {
        // openOnce already logs; reconnect chain continues via onDisconnect
      });
    }, delay);
  }

  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.connected || !this.ws) {
      await this.connect();
    }
    const ws = this.ws;
    if (!ws) throw new Error("daemon client not connected");

    const id = randomUUID();
    const req: RequestMessage = { type: "request", id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(ErrorCode.ExtensionTimeout, `${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
      ws.send(encode(req));
    });
  }

  close(): void {
    this.closed = true;
    if (this.ws) this.ws.close();
  }
}

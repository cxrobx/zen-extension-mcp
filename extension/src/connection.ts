import {
  ErrorCode,
  PROTOCOL_VERSION,
  decode,
  encode,
  type RequestMessage,
  type WireMessage,
} from "@zen-ext-mcp/shared";
import { handlers } from "./handlers.js";

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

export interface ConnectionConfig {
  url: string;
  token: string;
}

export type ConnectionState =
  | { status: "disconnected" }
  | { status: "connecting" }
  | { status: "authenticated"; serverId: string }
  | { status: "error"; reason: string };

type StateListener = (state: ConnectionState) => void;

export class DaemonConnection {
  private ws: WebSocket | null = null;
  private state: ConnectionState = { status: "disconnected" };
  private listeners = new Set<StateListener>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private config: ConnectionConfig) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
    this.setState({ status: "disconnected" });
  }

  setConfig(config: ConnectionConfig): void {
    this.config = config;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    if (this.ws) {
      this.ws.close();
    } else if (!this.stopped) {
      this.connect();
    }
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  getState(): ConnectionState {
    return this.state;
  }

  isHealthy(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  forceReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignored
      }
      this.ws = null;
    }
    if (!this.stopped) this.connect();
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    for (const l of this.listeners) l(state);
  }

  private connect(): void {
    if (this.stopped) return;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    if (this.ws) {
      this.ws = null;
    }
    if (!this.config.url || !this.config.token) {
      this.setState({ status: "error", reason: "missing daemon URL or token" });
      return;
    }
    this.setState({ status: "connecting" });
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.config.url);
    } catch (err) {
      this.setState({ status: "error", reason: (err as Error).message });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      const hello: WireMessage = {
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        role: "extension",
        token: this.config.token,
      };
      ws.send(encode(hello));
    });

    ws.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : "";
      this.onMessage(ws, data);
    });

    ws.addEventListener("close", (event) => {
      const wasCurrent = this.ws === ws;
      if (!wasCurrent) return;
      this.ws = null;
      this.setState({ status: "disconnected" });
      if (!this.stopped) {
        console.log("[zen-ext-mcp] socket closed", event.code, event.reason);
        this.scheduleReconnect();
      }
    });

    ws.addEventListener("error", () => {
      this.setState({ status: "error", reason: "websocket error" });
    });
  }

  private onMessage(ws: WebSocket, data: string): void {
    let msg: WireMessage;
    try {
      msg = decode(data);
    } catch {
      return;
    }
    switch (msg.type) {
      case "welcome":
        this.reconnectAttempt = 0;
        this.setState({ status: "authenticated", serverId: msg.serverId });
        return;
      case "unauthorized":
        this.setState({ status: "error", reason: msg.reason });
        ws.close();
        return;
      case "ping":
        ws.send(encode({ type: "pong", ts: msg.ts }));
        return;
      case "request":
        void this.handleRequest(ws, msg);
        return;
      default:
        return;
    }
  }

  private async handleRequest(ws: WebSocket, msg: RequestMessage): Promise<void> {
    const handler = handlers[msg.method];
    if (!handler) {
      ws.send(
        encode({
          type: "response",
          id: msg.id,
          error: { code: ErrorCode.MethodNotFound, message: `unknown method: ${msg.method}` },
        }),
      );
      return;
    }
    try {
      const result = await handler(msg.params);
      ws.send(encode({ type: "response", id: msg.id, result }));
    } catch (err) {
      ws.send(
        encode({
          type: "response",
          id: msg.id,
          error: {
            code: ErrorCode.InternalError,
            message: (err as Error).message,
          },
        }),
      );
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

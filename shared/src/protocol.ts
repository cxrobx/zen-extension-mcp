export const PROTOCOL_VERSION = 1;

export const DEFAULT_DAEMON_PORT = 8766;
export const DEFAULT_DAEMON_HOST = "127.0.0.1";

export type Role = "extension" | "client";

export interface HelloMessage {
  type: "hello";
  protocolVersion: number;
  role: Role;
  token: string;
  clientId?: string;
  containerScope?: string | null;
}

export interface WelcomeMessage {
  type: "welcome";
  serverId: string;
  protocolVersion: number;
}

export interface UnauthorizedMessage {
  type: "unauthorized";
  reason: string;
}

export interface PingMessage {
  type: "ping";
  ts: number;
}

export interface PongMessage {
  type: "pong";
  ts: number;
}

export interface RequestMessage {
  type: "request";
  id: string;
  method: string;
  params?: unknown;
}

export interface ResponseMessage {
  type: "response";
  id: string;
  result?: unknown;
  error?: RpcError;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type WireMessage =
  | HelloMessage
  | WelcomeMessage
  | UnauthorizedMessage
  | PingMessage
  | PongMessage
  | RequestMessage
  | ResponseMessage;

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  Unauthorized: -32001,
  ExtensionNotConnected: -32002,
  ExtensionTimeout: -32003,
  ContainerNotFound: -32010,
  ContainerAmbiguous: -32011,
  TabNotFound: -32020,
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export function encode(message: WireMessage): string {
  return JSON.stringify(message);
}

export function decode(raw: string): WireMessage {
  const parsed = JSON.parse(raw) as unknown;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("type" in parsed) ||
    typeof (parsed as { type: unknown }).type !== "string"
  ) {
    throw new Error("invalid wire message: missing type");
  }
  return parsed as WireMessage;
}

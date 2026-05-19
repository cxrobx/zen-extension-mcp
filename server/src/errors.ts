export type ZenErrorCode =
  | "NOT_FOUND"
  | "STALE"
  | "TIMEOUT"
  | "BUDGET_EXCEEDED"
  | "BAD_SELECTOR"
  | "BAD_PERMS"
  | "BAD_INPUT"
  | "UPSTREAM";

export class ZenToolError extends Error {
  readonly code: ZenErrorCode;
  readonly hint: string | undefined;

  constructor(code: ZenErrorCode, message: string, hint?: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "ZenToolError";
    this.code = code;
    this.hint = hint;
  }

  toToolText(): string {
    const lines = [`Error [${this.code}]: ${this.message}`];
    if (this.hint) lines.push(`Hint: ${this.hint}`);
    return lines.join("\n");
  }
}

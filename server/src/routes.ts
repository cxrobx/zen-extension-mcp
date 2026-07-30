import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Host -> container routing. The table answers "which Firefox container owns this domain?"
// so a URL lands in the same cookie jar no matter which zen-* MCP entry issued the call.
// Nothing personal ships in this repo: the table is a user config file, absent by default.

export interface CompiledRule {
  /** Pattern exactly as written in the config, for error and report text. */
  pattern: string;
  /** Firefox container name. Resolved to a cookieStoreId lazily, at first use. */
  container: string;
  /** Normalized host portion of the pattern. */
  host: string;
  /** Port the pattern pins, or null when it matches any port. */
  port: string | null;
  /** "*.example.com" matches subdomains only; "example.com" also matches the apex. */
  subdomainsOnly: boolean;
}

export interface RouteTable {
  /** Config path consulted, whether or not it exists. */
  path: string;
  /** The file existed and parsed. */
  loaded: boolean;
  /** Routing is switched on (ZEN_EXT_MCP_CONTAINER_ROUTES=0 turns it off). */
  enabled: boolean;
  rules: CompiledRule[];
  /** Load or parse failure, kept so the state is reportable instead of silently empty. */
  error: string | null;
}

export interface RouteMatch {
  container: string;
  pattern: string;
  kind: "exact" | "subdomain";
  /** Set when another rule matched equally well but named a different container. */
  ambiguousWith?: string;
}

export interface UrlTarget {
  host: string;
  /** "" for a scheme's default port. */
  port: string;
}

const MAX_RULES = 500;
const MAX_PATTERN_LEN = 253;

let cached: RouteTable | null = null;

export function routeConfigPath(): string {
  const override = process.env.ZEN_EXT_MCP_ROUTES;
  if (override && override.length > 0) return override;
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "zen-extension-mcp", "containers.json");
}

function routingEnabled(): boolean {
  return process.env.ZEN_EXT_MCP_CONTAINER_ROUTES !== "0";
}

/** Loaded once per process; call reloadRouteTable() to pick up an edited file. */
export function loadRouteTable(): RouteTable {
  if (!cached) cached = readRouteTable();
  return cached;
}

export function reloadRouteTable(): RouteTable {
  cached = readRouteTable();
  return cached;
}

function readRouteTable(): RouteTable {
  const path = routeConfigPath();
  const enabled = routingEnabled();
  const empty: RouteTable = { path, loaded: false, enabled, rules: [], error: null };
  if (!enabled) return empty;

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // An absent file is the default state, not a failure.
    if (code === "ENOENT") return empty;
    return { ...empty, error: `could not read ${path}: ${(err as Error).message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ...empty, error: `invalid JSON in ${path}: ${(err as Error).message}` };
  }

  try {
    const rules = compileRules(parsed);
    return { path, loaded: true, enabled, rules, error: null };
  } catch (err) {
    return { ...empty, error: `invalid route table in ${path}: ${(err as Error).message}` };
  }
}

function asPatternList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item !== "string") throw new Error("pattern entries must be strings");
      return item;
    });
  }
  throw new Error("each container maps to a host pattern or an array of host patterns");
}

function compileRules(parsed: unknown): CompiledRule[] {
  if (!parsed || typeof parsed !== "object") throw new Error("expected a JSON object");
  const record = parsed as Record<string, unknown>;
  // Two accepted shapes: { "routes": { "Container": [patterns] } } and
  // { "routes": [ { "container": "...", "match": [patterns] } ] }. A bare
  // { "Container": [patterns] } object works too, for a minimal hand-written file.
  const source = "routes" in record ? record.routes : record;
  const pairs: Array<{ container: string; patterns: string[] }> = [];

  if (Array.isArray(source)) {
    for (const entry of source) {
      if (!entry || typeof entry !== "object") throw new Error("route entries must be objects");
      const e = entry as { container?: unknown; match?: unknown; hosts?: unknown };
      if (typeof e.container !== "string" || e.container.trim().length === 0) {
        throw new Error('each route entry needs a non-empty "container"');
      }
      pairs.push({ container: e.container.trim(), patterns: asPatternList(e.match ?? e.hosts) });
    }
  } else if (source && typeof source === "object") {
    for (const [container, value] of Object.entries(source as Record<string, unknown>)) {
      if (container.trim().length === 0) throw new Error("container names cannot be empty");
      pairs.push({ container: container.trim(), patterns: asPatternList(value) });
    }
  } else {
    throw new Error('"routes" must be an object or an array');
  }

  const rules: CompiledRule[] = [];
  for (const { container, patterns } of pairs) {
    for (const pattern of patterns) {
      rules.push(compilePattern(pattern, container));
      if (rules.length > MAX_RULES) throw new Error(`too many rules (max ${MAX_RULES})`);
    }
  }
  return rules;
}

function compilePattern(pattern: string, container: string): CompiledRule {
  const original = pattern.trim();
  if (original.length === 0) throw new Error("empty host pattern");
  if (original.length > MAX_PATTERN_LEN) throw new Error(`host pattern too long: ${original}`);

  // Tolerate a pasted URL: strip scheme, path, query, and fragment.
  let value = original.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  value = value.split(/[/?#]/)[0] ?? "";
  if (value.length === 0) throw new Error(`host pattern has no host: ${original}`);

  let subdomainsOnly = false;
  if (value.startsWith("*.")) {
    subdomainsOnly = true;
    value = value.slice(2);
  }
  if (value.includes("*")) {
    throw new Error(`wildcards are only supported as a leading "*." label: ${original}`);
  }

  let host = value;
  let port: string | null = null;
  if (host.startsWith("[")) {
    // Bracketed IPv6 literal, optionally with :port after the closing bracket.
    const close = host.indexOf("]");
    if (close === -1) throw new Error(`unterminated IPv6 literal: ${original}`);
    const rest = host.slice(close + 1);
    if (rest.startsWith(":")) port = rest.slice(1);
    host = host.slice(1, close);
  } else {
    const colon = host.lastIndexOf(":");
    if (colon !== -1 && /^\d+$/.test(host.slice(colon + 1))) {
      port = host.slice(colon + 1);
      host = host.slice(0, colon);
    }
  }
  host = host.replace(/\.$/, "");
  if (host.length === 0) throw new Error(`host pattern has no host: ${original}`);
  if (port !== null && !/^\d{1,5}$/.test(port)) throw new Error(`invalid port in ${original}`);
  if (subdomainsOnly && host.split(".").length < 2) {
    throw new Error(`"*." needs a parent domain: ${original}`);
  }

  return { pattern: original, container, host, port, subdomainsOnly };
}

/** Host + port of a URL, or null for scheme-only URLs (about:, file:, data:). */
export function parseUrlTarget(url: string): UrlTarget | null {
  const attempt = (value: string): URL | null => {
    try {
      return new URL(value);
    } catch {
      return null;
    }
  };
  const parsed = attempt(url) ?? attempt(`https://${url}`);
  if (!parsed) return null;
  const host = parsed.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host.length === 0) return null;
  return { host, port: parsed.port };
}

function ruleScore(rule: CompiledRule, kind: "exact" | "subdomain"): number {
  // Longer patterns are more specific; an exact host beats a parent-domain suffix; a rule
  // that pins a port beats one that ignores it (localhost:3000 vs localhost).
  return (kind === "exact" ? 10_000 : 0) + (rule.port !== null ? 5_000 : 0) + rule.host.length;
}

function matchRule(rule: CompiledRule, target: UrlTarget): "exact" | "subdomain" | null {
  if (rule.port !== null && rule.port !== target.port) return null;
  if (target.host === rule.host) return rule.subdomainsOnly ? null : "exact";
  if (target.host.endsWith(`.${rule.host}`)) return "subdomain";
  return null;
}

export function matchContainerRoute(table: RouteTable, url: string): RouteMatch | null {
  if (!table.enabled || table.rules.length === 0) return null;
  const target = parseUrlTarget(url);
  if (!target) return null;

  let best: RouteMatch | null = null;
  let bestScore = -1;
  let ambiguousWith: string | undefined;
  for (const rule of table.rules) {
    const kind = matchRule(rule, target);
    if (!kind) continue;
    const score = ruleScore(rule, kind);
    if (score > bestScore) {
      bestScore = score;
      best = { container: rule.container, pattern: rule.pattern, kind };
      ambiguousWith = undefined;
    } else if (score === bestScore && best && rule.container !== best.container) {
      // Equal-specificity rules naming different containers: first wins, but say so.
      ambiguousWith = rule.container;
    }
  }
  if (best && ambiguousWith) best.ambiguousWith = ambiguousWith;
  return best;
}

/** One-line state summary for get_firefox_info. */
export function routeSummaryLine(table: RouteTable): string {
  if (!table.enabled) return "disabled (ZEN_EXT_MCP_CONTAINER_ROUTES=0)";
  if (table.error) return `error: ${table.error}`;
  if (!table.loaded) return `(no route file at ${table.path})`;
  return `${table.rules.length} rule${table.rules.length === 1 ? "" : "s"} from ${table.path}`;
}

/** Full table for the container_routes tool. */
export function describeRouteTable(table: RouteTable): string {
  const lines = [`routes: ${routeSummaryLine(table)}`];
  if (table.rules.length === 0) {
    lines.push(
      "",
      "No host is mapped to a container, so new tabs fall back to the session default",
      `(--container / set_default_container). Create ${table.path} to map domains:`,
      "",
      '{ "routes": { "Artist Advisory": ["artistadvisory.io"], "CXVentures": ["cxventures.io"] } }',
      "",
      'A rule matches the host and its subdomains; "*.example.com" matches subdomains only,',
      'and "localhost:3000" pins a port.',
    );
    return lines.join("\n");
  }
  const byContainer = new Map<string, string[]>();
  for (const rule of table.rules) {
    const list = byContainer.get(rule.container) ?? [];
    list.push(rule.pattern);
    byContainer.set(rule.container, list);
  }
  lines.push("");
  for (const [container, patterns] of byContainer) {
    lines.push(`- ${container}: ${patterns.join(", ")}`);
  }
  return lines.join("\n");
}

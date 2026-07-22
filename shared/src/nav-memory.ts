export const NAV_NOTE_KINDS = [
  "selector",
  "iframe-quirk",
  "timing",
  "auth-flow",
  "workflow",
  "anti-pattern",
  "url-pattern",
  "tool-tip",
] as const;

export type NavNoteKind = (typeof NAV_NOTE_KINDS)[number];

export const NAV_NOTE_CAPS = {
  summary: 140,
  detail: 500,
  example: 300,
  pathGlob: 200,
  locator: 160,
} as const;

export interface NavNoteSource {
  seed?: boolean;
  seedVersion?: number;
  container?: string;
  sessionTs?: string;
  workId?: string;
}

export interface NavNote {
  id: string;
  host: string;
  registrableDomain: string | null;
  pathGlob: string | null;
  kind: NavNoteKind;
  summary: string;
  detail: string;
  example: string | null;
  tools: string[];
  success: boolean;
  confidence: number;
  reinforced: number;
  createdAt: string;
  lastSeenAt: string;
  source: NavNoteSource | null;
  embedding: string | null;
}

export interface NavEventRecord {
  ts: number;
  tool: string;
  host?: string;
  path?: string;
  ok: boolean;
  navigated?: boolean;
  errorCode?: string;
  locator?: string;
  relatedLocator?: string;
  keys?: string;
  waitCondition?: string;
  matchCount?: number;
  role?: string;
  snapshotUids?: number;
  snapshotTruncated?: boolean;
}

export interface NavMemoryQueryParams {
  host: string;
  path?: string;
  queryText?: string;
  limit?: number;
  full?: boolean;
}

export type NavNoteSummary = Pick<
  NavNote,
  "id" | "host" | "pathGlob" | "kind" | "summary" | "confidence" | "reinforced"
>;

export interface NavMemoryQueryResult {
  host: string;
  registrableDomain: string | null;
  total: number;
  notes: Array<NavNote | NavNoteSummary>;
}

export interface NavMemoryRecordEventsParams {
  events: NavEventRecord[];
}

export interface NavMemoryRecordEventsResult {
  accepted: number;
  dropped: number;
}

export interface NavMemoryStatsResult {
  notes: number;
  byHost: Record<string, number>;
  byKind: Record<string, number>;
  pending: number;
  processing: number;
  failed: number;
  storeBytes: number;
  embeddings: {
    present: number;
    missing: number;
    model: string;
    dimension: number;
  };
  suppressedSeeds: number;
  pruned: number;
  droppedEvents: number;
  ollama: { available: boolean | null; lastCheckedAt: string | null };
}

export interface NavMemoryForgetParams {
  id?: string;
  host?: string;
  includeRaw?: boolean;
}

export interface NavMemoryForgetResult {
  notes: number;
  pending: number;
  processing: number;
  failed: number;
}

export interface NavMemoryEtlNowResult {
  status: "processed" | "empty" | "failed";
  workId?: string;
  notes?: number;
}

export interface NavSessionLog {
  schemaVersion: 1;
  workId: string;
  host: string;
  registrableDomain: string | null;
  container: string | null;
  startedAt: string;
  endedAt: string;
  attempts: number;
  events: NavEventRecord[];
}

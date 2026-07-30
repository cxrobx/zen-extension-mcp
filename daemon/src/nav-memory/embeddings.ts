import type { NavNote } from "@zen-mcp/shared";

// Cosine floor for treating two same-host notes as the same fact. Measured on
// the live store: real duplicate pairs cluster 0.864-0.888 while distinct facts
// top out at 0.843, so 0.86 splits the gap. Shared by the ETL insert path and
// the periodic consolidation sweep so both agree on what "duplicate" means.
export const MERGE_SIMILARITY = 0.86;

export interface Embedder {
  readonly model: string;
  readonly dimension: number;
  isAvailable(): Promise<boolean>;
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
  status(): { available: boolean | null; lastCheckedAt: string | null };
}

function normalized(values: number[], dimension: number): Float32Array {
  if (values.length !== dimension) throw new Error(`embedding dimension ${values.length}, expected ${dimension}`);
  let sum = 0;
  for (const value of values) sum += value * value;
  if (!Number.isFinite(sum) || sum === 0) throw new Error("invalid zero embedding");
  const scale = 1 / Math.sqrt(sum);
  return Float32Array.from(values, (value) => value * scale);
}

export function encodeEmbedding(value: Float32Array): string {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64");
}

export function decodeEmbedding(value: string, dimension: number): Float32Array | null {
  try {
    const bytes = Buffer.from(value, "base64");
    if (bytes.byteLength !== dimension * 4) return null;
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return new Float32Array(copy.buffer);
  } catch {
    return null;
  }
}

export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return -1;
  let score = 0;
  for (let i = 0; i < a.length; i++) score += (a[i] ?? 0) * (b[i] ?? 0);
  return score;
}

export class OllamaEmbedder implements Embedder {
  readonly model: string;
  readonly dimension: number;
  private available: boolean | null = null;
  private checkedAt = 0;

  constructor(
    private readonly baseUrl = process.env.ZEN_MCP_OLLAMA_URL ?? "http://127.0.0.1:11434",
    model = process.env.ZEN_MCP_OLLAMA_MODEL ?? "nomic-embed-text",
    dimension = 768,
  ) {
    this.model = model;
    this.dimension = dimension;
  }

  status(): { available: boolean | null; lastCheckedAt: string | null } {
    return {
      available: this.available,
      lastCheckedAt: this.checkedAt ? new Date(this.checkedAt).toISOString() : null,
    };
  }

  async isAvailable(): Promise<boolean> {
    if (Date.now() - this.checkedAt < 60_000 && this.available !== null) return this.available;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_000);
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, { signal: controller.signal });
      this.available = response.ok;
    } catch {
      this.available = false;
    } finally {
      clearTimeout(timer);
      this.checkedAt = Date.now();
    }
    return this.available;
  }

  async embedDocuments(texts: string[]): Promise<Float32Array[]> {
    return this.embed(texts.map((text) => `search_document: ${text}`), 5_000);
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [result] = await this.embed([`search_query: ${text}`], 750);
    if (!result) throw new Error("missing query embedding");
    return result;
  }

  private async embed(input: string[], timeoutMs: number): Promise<Float32Array[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, input }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Ollama embed failed: HTTP ${response.status}`);
      const payload = (await response.json()) as { embeddings?: number[][] };
      if (!Array.isArray(payload.embeddings) || payload.embeddings.length !== input.length) {
        throw new Error("Ollama returned malformed embeddings");
      }
      return payload.embeddings.map((values) => normalized(values, this.dimension));
    } finally {
      clearTimeout(timer);
    }
  }
}

export function nearestNote(
  notes: NavNote[],
  query: Float32Array,
  dimension: number,
): { note: NavNote; score: number } | null {
  let best: { note: NavNote; score: number } | null = null;
  for (const note of notes) {
    if (!note.embedding) continue;
    const vector = decodeEmbedding(note.embedding, dimension);
    if (!vector) continue;
    const score = dot(vector, query);
    if (!best || score > best.score) best = { note, score };
  }
  return best;
}

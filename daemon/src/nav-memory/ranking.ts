import type { NavNote } from "@zen-mcp/shared";
import { matchesPathGlob } from "@zen-mcp/shared/nav-redact";

export interface RankContext {
  host: string;
  registrableDomain: string | null;
  path?: string;
  includeOutOfScope?: boolean;
  now?: number;
}

export function scoreNote(note: NavNote, ctx: RankContext): number {
  const now = ctx.now ?? Date.now();
  const ageDays = Math.max(0, (now - Date.parse(note.lastSeenAt)) / 86_400_000);
  const recency = Math.max(0.25, 0.5 ** (ageDays / 90));
  const reinforcement = 1 + Math.min(2, Math.log2(Math.max(1, note.reinforced)));
  const hostFactor = note.host === ctx.host ? 1 : 0.35;
  const pathFactor = note.pathGlob && ctx.path && matchesPathGlob(ctx.path, note.pathGlob) ? 1.25 : 1;
  return note.confidence * recency * reinforcement * hostFactor * pathFactor;
}

export function rankNotes(notes: NavNote[], ctx: RankContext, limit: number): NavNote[] {
  return notes
    .filter((note) => {
      const related =
        note.host === ctx.host ||
        (ctx.registrableDomain !== null && note.registrableDomain === ctx.registrableDomain);
      if (!related) return false;
      if (!ctx.includeOutOfScope && note.pathGlob) {
        return Boolean(ctx.path && matchesPathGlob(ctx.path, note.pathGlob));
      }
      return true;
    })
    .sort((a, b) => {
      if ((a.host === ctx.host) !== (b.host === ctx.host)) return a.host === ctx.host ? -1 : 1;
      const score = scoreNote(b, ctx) - scoreNote(a, ctx);
      if (score !== 0) return score;
      if (a.confidence !== b.confidence) return b.confidence - a.confidence;
      const seen = Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
      return seen || a.id.localeCompare(b.id);
    })
    .slice(0, limit);
}

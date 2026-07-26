# Nav memory

Status: implemented (M0–M4).

Nav memory preserves low-sensitivity navigation knowledge learned while the Zen tools operate real websites. It is intentionally advisory: every injected block tells the model to verify observations against the live page.

## Architecture

- The per-session MCP server derives destination hosts, captures allowlisted structural events, streams them to the daemon, and injects at most 1.5 KiB of summaries once per host.
- The persistent daemon owns the atomic JSON store, exact/related-host ranking, per-host raw work files, Claude distillation, optional Ollama embeddings, deduplication, decay, stats, and deletion.
- The extension and protocol version are unchanged. `navMemory.*` requests use the existing authenticated request/response transport and never reach the extension.

State lives under `~/.config/zen-extension-mcp/nav-memory/` by default. Directories use mode `0700`; notes and raw work use `0600`. Pending, failed, and consumed (`sessions/done/`) telemetry expires after 30 days and is also count-capped (200 / 50 / 300 files).

## Session durability

A session's events live in daemon memory until something flushes them to a work file. Three things do:

- **Disconnect** — the MCP process closing finalizes one work file per host.
- **Idle checkpoint** — a session with events but no activity for 10 minutes is finalized on the next tick. The connection stays open; the next event simply starts a fresh session. This bounds loss from an abrupt daemon death (`kill -9` skips the shutdown path) to roughly ten minutes, and it means an all-day Claude session keeps flushing instead of holding everything hostage until it exits.
- **High-water checkpoint** — a session reaching 400 events is finalized immediately, rather than shift-dropping its oldest events at the 500 cap. Fragmenting one session across several work files is harmless because re-learned facts reinforce rather than duplicate.

## Privacy and injection controls

Capture is a structural allowlist. It includes normalized URL paths, sanitized locators, tool success, navigation state, match counts, snapshot counts, key combinations, and stable error codes. It excludes form values, option values, cookie/storage data, page text, find queries, script source/results, screenshots, titles, active-element names, and arbitrary errors.

The daemon repeats validation and redaction. Query strings and fragments are discarded, identifier-shaped path segments are globbed, private public-suffix tenants remain isolated, and path-scoped notes are automatically injected only on matching paths.

Learned telemetry is passed only to a tool-disabled Claude print process in safe mode, with schema-constrained output, no session persistence, a minimal environment, an empty temporary working directory, and a hard timeout. There is no Codex fallback. Learned notes use declarative language, confidence no higher than 0.7, and further validation before storage.

This is privacy minimization rather than a mathematical guarantee against all possible PII. Retention, filesystem permissions, planted-secret probes, and `nav_memory_forget` provide defense and recovery.

## Retrieval and lifecycle

Exact-host notes rank ahead of related hosts determined by a private-suffix-aware PSL. Ranking combines confidence, capped reinforcement, recency, and matching path scope. Ollama semantic ranking is used only for explicit playbook queries and has a short fallback timeout; automatic injection never waits on Ollama.

Six trusted Google Cloud Console notes bootstrap the store. Forgetting a seed records a tombstone so it is not restored on restart. Learned notes decay after 60 unseen days; weak, unreinforced notes older than 180 days are removed. Seeds retain a 0.5 confidence floor.

## Consolidation

Reinforcement is what makes the store learn rather than merely accumulate: `reinforced` feeds the ranking multiplier, so a repeatedly-confirmed observation outranks a one-off. Two mechanisms produce it, and they cover different gaps.

**At distill time.** Each ETL run shows the distiller the host's top 20 existing notes as a numbered `KNOWN NOTES` list. When an observation confirms one, the model answers with `"reinforces": <number>` instead of restating the fact in new words, and the daemon merges into that note. References are positional integers, never note ids — an index cannot be mangled or spoofed, and only `1..list.length` is honored; anything else falls through to the normal new-note paths. The model that writes the notes is the only component that can reliably judge "same fact", which is why this is the primary path. Note validation (redaction, prompt-like-text rejection, tool allowlist) runs before the merge decision, unchanged.

**Hourly sweep.** The distiller only ever sees one host during one session, so near-duplicates that arrived by other routes still pile up. Once an hour the daemon does a pairwise cosine comparison within each host and merges pairs at or above `MERGE_SIMILARITY` (0.86 — measured on the live store, where real duplicate pairs cluster 0.864–0.888 and distinct facts top out at 0.843; the same constant gates the ETL insert path). The higher-confidence note is kept as the target, `reinforced` counts are summed, `tools` are unioned, the earliest `createdAt` and latest `lastSeenAt` survive, and the target keeps its embedding. A seed may be a merge target but never a deleted source, and two seeds are never collapsed into each other. Every merge logs at `info` with host, kept id, dropped id, and score, so a bad merge is auditable and recoverable with `nav_memory_forget`.

The two mechanisms are complementary, not redundant: the sweep cannot rephrase, and the distiller cannot see across hosts or sessions. Removing either one stops a distinct class of duplicate from ever merging.

## Operations

- `get_domain_playbook`: full advisory notes for a host or page.
- `nav_memory_stats`: store, queue, retention, and embedding status, plus an `etl` block (`created`, `merged`, `consolidated`, `lastEtlAt`, `lastConsolidateAt`) and a `done` count. "Is it actually learning?" is one call: `merged` and `consolidated` moving means facts are being folded together rather than re-invented.
- `nav_memory_forget`: delete a note or exact host, including raw work by default.

Consumed work files are archived to `sessions/done/` instead of being deleted. They are already redacted, and they are the only durable record of which tools ran against which hosts — a usage history that survives daemon restarts, capped at 300 files and 30 days. `nav_memory_forget` with a host purges matching archived files too.
- `ZEN_EXT_MCP_NAV_MEMORY=0`: disable capture and automatic injection in one MCP server.
- `--nav-db` / `ZEN_EXT_MCP_NAV_DB`: override state location.
- `--claude-bin` / `ZEN_EXT_MCP_CLAUDE_BIN`: override the distiller executable.

Export by copying `notes.json`. Import only while the daemon is stopped, restore mode `0600`, then restart so startup validation and seed application run.

## Verification

```sh
npm run build && npm run typecheck
npm run test:nav-memory
node scripts/probe-navmem.mjs
node scripts/smoke.mjs
```

The nav-memory probe uses a scratch store, fake tool-free Claude process, fake Ollama endpoint, and planted secrets. It does not require a live browser or subscription request.

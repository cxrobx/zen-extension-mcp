# Nav memory

Status: implemented (M0–M4).

Nav memory preserves low-sensitivity navigation knowledge learned while the Zen tools operate real websites. It is intentionally advisory: every injected block tells the model to verify observations against the live page.

## Architecture

- The per-session MCP server derives destination hosts, captures allowlisted structural events, streams them to the daemon, and injects at most 1.5 KiB of summaries once per host.
- The persistent daemon owns the atomic JSON store, exact/related-host ranking, per-host raw work files, Claude distillation, optional Ollama embeddings, deduplication, decay, stats, and deletion.
- The extension and protocol version are unchanged. `navMemory.*` requests use the existing authenticated request/response transport and never reach the extension.

State lives under `~/.config/zen-extension-mcp/nav-memory/` by default. Directories use mode `0700`; notes and raw work use `0600`. Pending and failed telemetry expires after 30 days and is also count-capped.

## Privacy and injection controls

Capture is a structural allowlist. It includes normalized URL paths, sanitized locators, tool success, navigation state, match counts, snapshot counts, key combinations, and stable error codes. It excludes form values, option values, cookie/storage data, page text, find queries, script source/results, screenshots, titles, active-element names, and arbitrary errors.

The daemon repeats validation and redaction. Query strings and fragments are discarded, identifier-shaped path segments are globbed, private public-suffix tenants remain isolated, and path-scoped notes are automatically injected only on matching paths.

Learned telemetry is passed only to a tool-disabled Claude print process in safe mode, with schema-constrained output, no session persistence, a minimal environment, an empty temporary working directory, and a hard timeout. There is no Codex fallback. Learned notes use declarative language, confidence no higher than 0.7, and further validation before storage.

This is privacy minimization rather than a mathematical guarantee against all possible PII. Retention, filesystem permissions, planted-secret probes, and `nav_memory_forget` provide defense and recovery.

## Retrieval and lifecycle

Exact-host notes rank ahead of related hosts determined by a private-suffix-aware PSL. Ranking combines confidence, capped reinforcement, recency, and matching path scope. Ollama semantic ranking is used only for explicit playbook queries and has a short fallback timeout; automatic injection never waits on Ollama.

Six trusted Google Cloud Console notes bootstrap the store. Forgetting a seed records a tombstone so it is not restored on restart. Learned notes decay after 60 unseen days; weak, unreinforced notes older than 180 days are removed. Seeds retain a 0.5 confidence floor.

## Operations

- `get_domain_playbook`: full advisory notes for a host or page.
- `nav_memory_stats`: store, queue, retention, and embedding status.
- `nav_memory_forget`: delete a note or exact host, including raw work by default.
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

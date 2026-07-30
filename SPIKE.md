# Milestone 1 — Architecture Spike Report

Status: passing.

## What this spike proved

1. **Three-process architecture works end-to-end.** Daemon owns the WebSocket port; MCP server connects as a client; the extension connects in the same role on the other side. Requests fan out from N MCP-server clients to the single extension; responses route back to the originating client.
2. **Auth handshake works.** Daemon auto-generates a 32-byte token on first launch (`~/.config/zen-mcp/auth.token`, mode 0600) and rejects connections that present a wrong or missing token within a 5s `hello` window. Constant-time compared via `crypto.timingSafeEqual`.
3. **Heartbeat works.** Daemon sends WebSocket pings every 30s; on missing pong the next tick terminates the connection. Server and extension both auto-reconnect with exponential backoff (500ms -> 10s).
4. **`--container <name>` resolves at server startup** using the same `resolveContainerByName` logic ported verbatim from `zen-mcp/src/firefox/container.ts`. Valid names succeed; invalid names refuse startup with the existing fork's error format (lists all available containers).
5. **Single MCP tool reaches the extension.** `list_containers` round-trips through the bridge and returns a formatted list.

## Smoke evidence

`node scripts/smoke.mjs` (no real browser needed; uses `scripts/mock-extension.mjs` as a stand-in for the MV3 extension) exercises:

- daemon listening on `127.0.0.1:8765`
- mock extension authenticates as `extension`
- MCP server authenticates as `client`
- MCP `initialize` -> `tools/call list_containers` -> formatted output containing all 6 fixture containers (Personal, Work, Geek, Buildersbuddy, Artist Advisory, CXVentures)

Container scoping verified manually:

```sh
node server/dist/index.js --container CXVentures   # logs "container scope resolved" with cookieStoreId firefox-container-6
node server/dist/index.js --container DoesNotExist # exits 1 with "Container ... not found. Available: ..."
```

## What this spike did NOT prove

- The signed-XPI install path. AMO signing requires creating an API key and running `web-ext sign` against `extension/dist/` — not done in this spike. The build produces an unsigned dist/ ready for `web-ext sign --channel=unlisted`.
- The actual MV3 extension running in real Zen. Browser-side code is built and the smoke uses a mock instead of a real `browser.contextualIdentities.query()` call. The extension build (esbuild iife into `extension/dist/`) is sized 10.6kb and includes the same `DaemonConnection` + auth/heartbeat code as exercised in the smoke.
- Service-worker/event-page lifecycle. The plan's Risks section flags this; manifest uses non-module `background.scripts` for broad Firefox MV3 compat (avoids version-sensitive `"type": "module"` and top-level await).

## Next gates before Milestone 2

1. Sign the extension via `web-ext sign --channel=unlisted` with AMO credentials and confirm the signed XPI installs into daily Zen.
2. Open the extension's options page in Zen, paste in the daemon URL + token, confirm the status pill flips to `authenticated` against a live daemon.
3. Re-run the smoke against the real extension (delete `scripts/mock-extension.mjs` from the chain) and confirm `list_containers` returns the user's actual containers.

## File map

| Path | Purpose |
|---|---|
| `shared/src/protocol.ts` | Wire types, `encode`/`decode`, error codes, default port |
| `shared/src/methods.ts` | Method-name constants, result shapes |
| `daemon/src/index.ts` | WS server, auth handshake, heartbeat, request fan-out |
| `daemon/src/auth.ts` | Token generation, constant-time compare |
| `server/src/index.ts` | MCP stdio server, registers `list_containers` |
| `server/src/daemon-client.ts` | WS client with reconnect/backoff |
| `server/src/container.ts` | `resolveContainerByName`, `formatAvailableContainers` (ported from `zen-mcp`) |
| `extension/src/manifest.json` | MV3 manifest, gecko id `zen-ext-mcp@cxrobx`, min Firefox 115 |
| `extension/src/background.ts` | Background entrypoint, wires settings -> connection |
| `extension/src/connection.ts` | WS client, hello/welcome, RPC dispatch, reconnect |
| `extension/src/handlers.ts` | RPC method handlers (currently `containers.list`) |
| `extension/src/options/` | Options page (daemon URL + token, live status) |
| `scripts/smoke.mjs` | End-to-end test (daemon + mock + server + MCP probe) |
| `scripts/mock-extension.mjs` | Stand-in for the MV3 extension during testing |

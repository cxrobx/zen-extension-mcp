# zen-extension-mcp — agent guide

WebExtension-backed MCP for Zen (Firefox). Sister project to `~/Projects/zen-mcp` (Marionette/Selenium). User docs in `README.md`; this file is for an agent working on the codebase.

## Three processes, one bridge

```
Claude Code  --stdio-->  MCP server (per session, --container-scoped)
                             |
                             | ws://127.0.0.1:8766
                             v
                         daemon (launchd, persistent)
                             ^
                             | ws (token auth, 30s heartbeat)
                             |
                         MV3 extension (signed, in daily Zen)
```

- **daemon/** — Node WS router. Single extension, N clients. Auth + ping.
- **server/** — MCP stdio (`McpServer` from `@modelcontextprotocol/sdk`). Connects to daemon as a client. `--container <name>` resolves at startup, mutable via `set_default_container`.
- **extension/** — MV3 background + options page + lazy-injected snapshot bundle.
- **shared/** — Wire types, method-name constants, error codes. Single source of truth.

## Daily-driver state (already set up)

- Daemon: launchd `~/Library/LaunchAgents/io.cxrobx.zen-extension-mcp.daemon.plist` → `/usr/local/bin/node` runs `daemon/dist/index.js --port 8766`. Logs at `~/Library/Logs/zen-extension-mcp/daemon.{out,err}.log`.
- Extension: signed via AMO unlisted, gecko id `zen-ext-mcp@cxrobx`, currently 0.0.9. Settings (URL + token) live in `browser.storage.local`.
- Auth token: `~/.config/zen-extension-mcp/auth.token` (mode 0600, 32-byte hex). Daemon generates on first launch.
- 7 MCP entries at user scope (`~/.claude.json`): `zen-ext`, `zen-cxv`, `zen-personal`, `zen-geek`, `zen-music`, `zen-buildersbuddy`, `zen-artist`.

## Iteration loop (it's slow — minimize cycles)

For extension changes:
1. Edit `extension/src/...`
2. Bump `extension/src/manifest.json` version (AMO rejects same-version uploads)
3. `npm run build:extension`
4. `AMO_KEY=... AMO_SECRET=... npm run extension:sign` — uploads to AMO; signing takes 30-90s
5. Open the resulting `extension/web-ext-artifacts/*.xpi` in Zen
6. **In-place upgrade is flaky** — sometimes silently no-ops. Check `about:addons` to confirm the new version is active. If not: `⋯ → Remove`, then re-install. **Removal wipes `browser.storage.local`** so you'll re-paste daemon URL + token.
7. Re-grant the "Access your data for all websites" toggle if `screenshot_page` is involved (lost on remove)

For daemon/server/shared changes only: `npm run build` is enough; no extension reinstall needed. Daemon comes back automatically (launchd KeepAlive).

For dev iteration **without** AMO signing: `npm run extension:run` opens a fresh Firefox profile with `extension/dist/` loaded as a temporary add-on. Gone after profile close.

## Probes (must validate against live Zen)

| Script | Tests |
|---|---|
| `scripts/smoke.mjs` | Daemon + mock extension + MCP server. Useful for protocol-level changes without a browser. |
| `scripts/probe.mjs` | `list_containers` against real Zen. |
| `scripts/probe-pages.mjs` | M2: new_page, navigate, select, set_default_container, close. Creates + cleans up. |
| `scripts/probe-dom.mjs` | M3 read-side: snapshot, evaluate_script, resolve_uid, screenshot. Targets example.com. |
| `scripts/probe-interact.mjs` | M3 write-side: click, hover, fill, fill_form against a self-served localhost fixture. |
| `scripts/probe-info.mjs` | get_firefox_info with and without `--container` scope. |

After any extension change, run the relevant probe(s) — `npm run build` doesn't catch logic errors in handlers.

## Footguns to remember

- **CSP `upgrade-insecure-requests`** is in Firefox MV3's default extension CSP and silently rewrites `ws://127.0.0.1` to `wss://`. The daemon doesn't speak TLS so the connection hangs in CONNECTING. The manifest already overrides this (`content_security_policy.extension_pages` without that directive). **Don't remove that override.**
- **`<all_urls>` is opt-in by user in MV3.** Declared in manifest ≠ granted at runtime. User must toggle "Access your data for all websites" in `about:addons`. `screenshot_page` (`tabs.captureVisibleTab`) needs this; `scripting.executeScript` works without.
- **`captureVisibleTab(windowId, opts)`** rejects with "Missing activeTab permission" in Zen even with `<all_urls>`. The fix already shipped: activate the target tab first, then call `captureVisibleTab(opts)` with no windowId.
- **MV3 backgrounds suspend** after ~80s of "idle" in Firefox 147 even with active WebSockets. The 30s `browser.alarms` keepalive (already shipped in 0.0.8/0.0.9) keeps the background alive AND force-reconnects when `ws.readyState !== OPEN`. **Don't remove this** without a replacement strategy.
- **Connect must be idempotent and resilient to stale ws.** `connect()` treats CLOSED/CLOSING as null. The keepalive uses `isHealthy()` (`ws.readyState === OPEN`) not the cached state field — state lies after asymmetric WS shutdown.
- **`evaluate_script`** wraps user code with `new Function(code)()`. User provides function body, uses `return` for the result, must be JSON-serializable. DOM nodes fail.
- **AMO signing** rejects re-uploads of an already-signed version. Always bump the manifest version.

## Where things live

| What | Where |
|---|---|
| RPC types + method names | `shared/src/methods.ts`, `shared/src/protocol.ts` |
| Daemon WS routing + auth | `daemon/src/index.ts` |
| MCP tool registrations | `server/src/tools.ts` |
| Container resolver (ported from `zen-mcp`) | `server/src/container.ts` |
| Daemon WS client (used by MCP server) | `server/src/daemon-client.ts` |
| Extension RPC handlers (pages.*, dom.*, etc.) | `extension/src/handlers.ts` |
| Extension WS client + reconnect/heartbeat | `extension/src/connection.ts` |
| Snapshot port (treeWalker, selectors, attrs) | `extension/src/snapshot/` |
| Background entrypoint + keepalive | `extension/src/background.ts` |
| Options page | `extension/src/options/` |

## Things deliberately NOT done in v1

- Console / network / dialog tools — content-script bridges with degraded fidelity. Plan calls these out as v2.
- Privileged-context tools — fundamental WebExtension capability gap. Use `~/Projects/zen-mcp` for those.
- File upload by UID — browser security blocks it from any extension.
- Multi-window support is implicit (tab.windowId in PageInfo) but no window-management tools.

If you're adding any of these, double-check the README's "Tool surface" table and update both there and here.

## License

MIT OR Apache-2.0 (matches `zen-mcp`).

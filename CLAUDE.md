# zen-extension-mcp — agent guide

WebExtension-backed MCP for Zen (Firefox). Sister project to `~/Projects/zen-mcp` (Marionette/Selenium). User docs in `README.md`; this file is for an agent working on the codebase.

## You are in the daily driver — never implement new tools in `~/Projects/zen-mcp`

All seven `zen-*` entries in `claude mcp list` point at **this** repo. `~/Projects/zen-mcp` is a Marionette-based escape hatch retained only for privileged-context tools the WebExtension API can't do (`set_firefox_prefs`, `evaluate_privileged_script`, full network response bodies, file uploads). If a task is "add a tool" or "fix a tool used in a Claude Code session", the work goes here.

Before doing anything: `claude mcp list | grep zen` to confirm what's wired up. If you find yourself editing files under `~/Projects/zen-mcp/src/`, you've taken a wrong turn.

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

- **daemon/** — Node WS router plus persistent nav-memory store/ETL. Single extension, N clients. Auth + ping.
- **server/** — MCP stdio (`McpServer` from `@modelcontextprotocol/sdk`). Connects to daemon as a client, captures structural nav events, and injects advisory summaries once per host. `--container <name>` resolves lazily on first new-tab use, mutable via `set_default_container`.
- **extension/** — MV3 background + options page + lazy-injected snapshot bundle.
- **shared/** — Wire types, method-name constants, error codes. Single source of truth.

## Daily-driver state (already set up)

- Daemon: launchd `~/Library/LaunchAgents/io.cxrobx.zen-extension-mcp.daemon.plist` → `/usr/local/bin/node` runs `daemon/dist/index.js --port 8766`. Logs at `~/Library/Logs/zen-extension-mcp/daemon.{out,err}.log`.
- Extension: signed via AMO unlisted, gecko id `zen-ext-mcp@cxrobx`, currently 0.0.15. Settings (URL + token) live in `browser.storage.local`; snapshot UID maps live in `browser.storage.session`.
- Auth token: `~/.config/zen-extension-mcp/auth.token` (mode 0600, 32-byte hex). Daemon generates on first launch.
- AMO signing creds: `~/.config/zen-extension-mcp/.env` (mode 0600, `AMO_KEY` + `AMO_SECRET`). Sourced by `extension/scripts/sign.sh`; `npm run extension:sign` works with no inline env. Get fresh keys at https://addons.mozilla.org/developers/addon/api/key/.
- 7 MCP entries at user scope (`~/.claude.json`): `zen-ext`, `zen-cxv`, `zen-personal`, `zen-geek`, `zen-music`, `zen-buildersbuddy`, `zen-artist`.

## Iteration loop (it's slow — minimize cycles)

For extension changes:
1. Edit `extension/src/...`
2. **Check AMO for the highest published version before bumping**:
   ```sh
   curl -s https://addons.mozilla.org/api/v5/addons/addon/zen-ext-mcp@cxrobx/versions/ \
     | jq -r '.results[].version' | head -5
   ```
   Pick `max + 0.0.1` and write that into `extension/src/manifest.json`. AMO rejects re-uploads of any previously-signed version, even ones that were deleted locally — the manifest in the repo can lag behind AMO.
3. `npm run build:extension`
4. `npm run extension:sign` — uploads to AMO; signing takes 30-90s. Creds come from `~/.config/zen-extension-mcp/.env`; override inline with `AMO_KEY=... AMO_SECRET=... npm run extension:sign` if needed.
5. **Open the signed XPI in Zen.** Almost always:
   ```sh
   open -a "/Applications/Zen.app" extension/web-ext-artifacts/<file>.xpi
   ```
   This shows the install banner at the top of the active tab. Click Allow → Add/Update. This is what works in practice.
6. Confirm the new version in `about:addons` — **in-place upgrades occasionally no-op silently**, especially across larger version jumps. If the version didn't change: `⋯ → Remove` the old version, then re-run the `open -a` command. **Removal wipes `browser.storage.local`**; user has to re-paste daemon URL + token (`cat ~/.config/zen-extension-mcp/auth.token`) and re-toggle "Access your data for all websites" in the Permissions tab.
7. **Fallback if `open -a` itself silently fails** (rare): serve the XPI over localhost with the right MIME and navigate Zen to it.
   ```sh
   cd extension/web-ext-artifacts && \
     python3 -c "import http.server,socketserver; \
       h=http.server.SimpleHTTPRequestHandler; \
       h.extensions_map['.xpi']='application/x-xpinstall'; \
       socketserver.TCPServer(('127.0.0.1',8772),h).serve_forever()" &
   ```
   Then point Zen at `http://127.0.0.1:8772/<file>.xpi`. Don't reach for this first.

For daemon/server/shared changes only: `npm run build` is enough; no extension reinstall needed. Daemon comes back automatically (launchd KeepAlive).

For dev iteration **without** AMO signing: `npm run extension:run` opens a fresh Firefox profile with `extension/dist/` loaded as a temporary add-on. Gone after profile close.

## Don't talk yourself out of the easy path

The AMO signing pipeline is fully wired up and runnable from the CLI. If you find yourself drafting a paragraph for the user about "AMO signing needs API credentials that only you can create" — stop. The credentials already exist at `~/.config/zen-extension-mcp/.env`, `extension/scripts/sign.sh` sources them, and `npm run extension:sign` just works. The previous session burned ~10 minutes lecturing the user before the user told it to actually look. Run the command first; lecture later only if it fails.

For installation specifically: `open -a "/Applications/Zen.app" <xpi>` triggers the Zen install banner reliably across versions, ports, and fresh-install vs upgrade. Try that first. Only fall back to the localhost-MIME server flow if `open -a` produces nothing — and remember that "nothing" often means the upgrade silently no-op'd, not that `open` failed; check `about:addons` for the active version before changing approach.

## Probes (must validate against live Zen)

| Script | Tests |
|---|---|
| `scripts/smoke.mjs` | Daemon + mock extension + MCP server. Useful for protocol-level changes without a browser. |
| `scripts/probe.mjs` | `list_containers` against real Zen. |
| `scripts/probe-pages.mjs` | M2: new_page, navigate, select, set_default_container, close. Creates + cleans up. |
| `scripts/probe-dom.mjs` | M3 read-side: snapshot, evaluate_script, resolve_uid, screenshot. Targets example.com. |
| `scripts/probe-interact.mjs` | M3 write-side: click, hover, fill, fill_form, rich editor input, pointer sequence, auto-scroll, auto-wait against a self-served localhost fixture. |
| `scripts/probe-info.mjs` | get_firefox_info with and without `--container` scope. |
| `scripts/probe-tabid.mjs` | Durable tab addressing against live Zen: `tabId` round-trip, absent-tabId error, stale `expectTabSet`, mutual exclusion. Creates + closes its own tab. |
| `scripts/tab-target.test.mjs` | `node --test` regression for the workspace retargeting bug — swaps the stub extension's visible tab set mid-session and asserts the tools error instead of acting. `npm run test:tab-target`. |
| `scripts/probe-navmem.mjs` | Scratch-store M0–M4: seeds, host isolation, injection, redaction, ETL, embeddings, stats, and forget. No live browser required. |
| `scripts/container-routes.test.mjs` | `node --test` suite for host→container routing: matcher specificity, precedence, `open_url` reuse, loud failure on a missing container. Stub extension, no browser. `npm run test:container-routes`. |
| `scripts/probe-routes.mjs` | Live routing probe. Phase A resolves the REAL table read-only; phase B drives `open_url` against a throwaway `example.com` table and asserts every pre-existing tab is untouched. |

For nav-memory work run `npm run test:nav-memory`, `node scripts/probe-navmem.mjs`, and the unchanged `node scripts/smoke.mjs`. The default ETL probe uses a fake tool-free Claude executable and fake Ollama endpoint; a live subscription is not a test prerequisite.

After any extension change, run the relevant probe(s) — `npm run build` doesn't catch logic errors in handlers.

## Footguns to remember

- **Zen Workspaces scope `browser.tabs.query({})` to the ACTIVE workspace.** Tabs in other workspaces are *absent from the WebExtension API*, not hidden-but-listed — `pages.list` is already correct and global; the constraint is imposed above the API. Don't try to "fix" it with a better query. `pageIdx` is therefore a position that silently re-points at a different tab when the workspace changes; `tabId` (resolved in `resolveTarget`, `server/src/tools.ts`) is the durable handle and **must fail loudly** when the tab isn't visible. Never add a fallback that searches other workspaces or auto-reresolves by URL — silently reaching into another workspace is the same bug wearing a hat.
- **CSP `upgrade-insecure-requests`** is in Firefox MV3's default extension CSP and silently rewrites `ws://127.0.0.1` to `wss://`. The daemon doesn't speak TLS so the connection hangs in CONNECTING. The manifest already overrides this (`content_security_policy.extension_pages` without that directive). **Don't remove that override.**
- **`<all_urls>` is opt-in by user in MV3.** Declared in manifest ≠ granted at runtime. User must toggle "Access your data for all websites" in `about:addons`. `screenshot_page` (`tabs.captureVisibleTab`) needs this; `scripting.executeScript` works without.
- **`captureVisibleTab(windowId, opts)`** rejects with "Missing activeTab permission" in Zen even with `<all_urls>`. The fix already shipped: activate the target tab first, then call `captureVisibleTab(opts)` with no windowId.
- **MV3 backgrounds suspend** after ~80s of "idle" in Firefox 147 even with active WebSockets. The 30s `browser.alarms` keepalive keeps the background alive AND force-reconnects when `ws.readyState !== OPEN`. **Don't remove this** without a replacement strategy.
- **Snapshot UID maps are in `browser.storage.session`.** Keep writes small and keyed by tabId. Clear both memory and session storage on navigation invalidation.
- **Rich-editor `fill`/`type` can't rely on `execCommand("insertText")`.** Firefox gates editing execCommands on `document.hasFocus()`, which is false during background automation — and on framework editors (Lexical/ProseMirror/Slate) it then *lies*, returning `true` while inserting nothing. `richInsert` (`handlers.ts`) gates execCommand on `hasFocus`, else dispatches a synthetic `beforeinput` + explicit Range and **verifies by DOM readback** (~20ms reconcile, measured on Lexical). Only fire `input` yourself when the editor did **not** claim the `beforeinput` (`preventDefault`), or the text double-inserts. If the readback still fails, `runFillLike` escalates to focus-the-window-then-retry (the only path that gives execCommand a trusted, working beforeinput). **Don't "simplify" this back to `textContent = value` or to trusting execCommand's return.**
- **Connect must be idempotent and resilient to stale ws.** `connect()` treats CLOSED/CLOSING as null. The keepalive uses `isHealthy()` (`ws.readyState === OPEN`) not the cached state field — state lies after asymmetric WS shutdown.
- **`evaluate_script`** injects the bundled Babel + eval5 evaluator, transpiles the user function body to ES5, then interprets it against the page window without `eval()`/`Function()` so strict page CSP is not a blocker. User provides a synchronous function body, uses `return` for the result, and must return a JSON-serializable value. DOM nodes fail.
- **AMO signing** rejects re-uploads of an already-signed version. Always bump the manifest version, and check AMO for the highest version (curl + jq snippet above) before deciding what to bump to — local artifacts can lag behind what AMO has on file.
- **Container routing must fail loudly, never fall back.** The host→container table decides which cookie jar a URL lands in, so a rule naming a container that doesn't exist **errors and opens nothing** (`containerNamed` in `server/src/tools.ts`). Do not "improve" this into a fallback to the session default — a page quietly opening in the wrong jar is the exact failure the table exists to prevent, and it looks like success. Same reason the load path distinguishes *absent file* (fine, no rules) from *malformed file* (reported error, not silently empty).
- **Route beats session scope; explicit beats route.** Precedence is `new_page_in_container` / `open_url({container})` → host rule → `--container` / `set_default_container` → none. That ordering is deliberate: it is what makes a project's URL land in that project's container from *any* `zen-*` entry. Every tab-opening call prints which rule or fallback decided, so a wrong jar is diagnosable from the transcript alone.
- **A new tab reports `about:blank` until its navigation commits.** `pendingUrls` in `server/src/tools.ts` remembers, for ~30s, what this session asked each tab to load, and `effectivePageUrl` uses it while the tab is still blank. Without it, a second `open_url` issued right after the first opens a duplicate — the live probe caught exactly that. Same reason `new_page`/`open_url` report the *requested* URL rather than the extension's `result.url`. Don't drop this for "just read `page.url`".
- **`open_url` reuse is workspace-bound and container-bound.** It only considers tabs in the ACTIVE Zen workspace whose `cookieStoreId` equals the routed container's — a same-host tab in the wrong container is never touched. When nothing matches it opens a new tab and says why. Don't add a cross-container or cross-workspace search: that is the workspace footgun above wearing a different hat.
- **Nav-memory ETL receives untrusted browser telemetry.** Production invocation must retain the empty temporary cwd, `--safe-mode`, `--tools ""`, schema-constrained output, minimal environment, timeout, and no-session-persistence flags. Do not add an agentic Codex fallback.
- **Nav-memory raw data stays structural.** Never add generic text hints, fill/type/select values, find queries, page content, evaluated code, cookie/storage values, or arbitrary error messages to `NavEventRecord`.
- **Two mechanisms produce `reinforced`, and neither covers the other.** The distiller sees the host's top-20 notes as a numbered `KNOWN NOTES` list and answers `reinforces: <n>` (positional integers only — ids would be spoofable, and only `1..len` is honored); the hourly `consolidate()` sweep merges same-host pairs at cosine ≥ `MERGE_SIMILARITY` (0.86, `embeddings.ts`). The sweep can't rephrase and the distiller can't see across hosts or sessions — **deleting one because "the other handles it" silently stops a whole class of duplicate from merging**, which is exactly the state this feature was built to fix (46 notes, all stuck at `reinforced: 1`).
- **`sessions/done/` is telemetry, not garbage.** `completeWork` archives consumed work there instead of `rm`-ing it; it's the only durable record of which tools ran against which hosts, already redacted, capped at 300 files / 30 days. Don't "clean it up" back into a delete.
- **Probe scripts that drive live Zen must set `ZEN_EXT_MCP_NAV_MEMORY=0`.** Without it, probe traffic (`example.com`, localhost fixtures) is captured and distilled into the real store — that's where the 16 junk notes came from. `probe-navmem.mjs` is the deliberate exception: it tests capture, against a scratch daemon.
- **In-place extension upgrades occasionally no-op silently.** Always confirm the new version in `about:addons` after install. If stuck, remove the existing extension (`⋯ → Remove`) and re-run `open -a "/Applications/Zen.app" <xpi>`; that's reliable for a clean install. The localhost-XPI-server flow (step 7 of the iteration loop) is a deeper fallback if even `open -a` produces nothing.

## Where things live

| What | Where |
|---|---|
| RPC types + method names | `shared/src/methods.ts`, `shared/src/protocol.ts` |
| Error codes + `ZenToolError` | `shared/src/errors.ts`, `server/src/errors.ts` |
| Daemon WS routing + auth | `daemon/src/index.ts` |
| Nav-memory store, service, ETL, ranking | `daemon/src/nav-memory/` |
| Nav-memory capture and injection | `server/src/nav-memory.ts` |
| MCP tool registrations | `server/src/tools.ts` |
| Locator-prefix parser (`css:`/`xpath:`/`text:`/`text*:`/`role:`) | `server/src/locator.ts` |
| Container resolver (ported from `zen-mcp`) | `server/src/container.ts` |
| Host→container route table (load, match, describe) | `server/src/routes.ts` · config `~/.config/zen-extension-mcp/containers.json` |
| Daemon WS client (used by MCP server) | `server/src/daemon-client.ts` |
| Extension RPC handlers (pages.*, dom.*, cookies, storage, etc.) | `extension/src/handlers.ts` |
| Extension WS client + reconnect/heartbeat | `extension/src/connection.ts` |
| Snapshot port (treeWalker, selectors, attrs) | `extension/src/snapshot/` |
| Bundled Readability for `read_page` (~112KB, injected) | `extension/src/readability-bundle.js` |
| Background entrypoint + keepalive | `extension/src/background.ts` |
| Options page | `extension/src/options/` |
| AMO sign wrapper that sources `.env` | `extension/scripts/sign.sh` |

## Things deliberately NOT done

Still gaps as of this writing:

- **Console messages**, **dialog handling** (`accept_dialog` / `dismiss_dialog`), **network capture / full network response bodies**. Content-script bridges with degraded fidelity. Still v2.
- **Privileged-context tools** — fundamental WebExtension capability gap. Use `~/Projects/zen-mcp` for those.
- **File upload by UID** — browser security blocks it from any extension.
- **Multi-window management** — `tab.windowId` flows through `PageInfo` but there are no window-level tools (focus, move, resize).

Already done (was deferred in the original plan but landed since):

- `read_page` via bundled Readability + Turndown.
- Cookies (`get_cookies` / `set_cookies` / `clear_cookies`).
- Local + session storage (`get_storage` / `set_storage` / `clear_storage`).
- Locator-prefix support (`css:`, `xpath:`, `text:`, `text*:`, `role:`) across `click`, `hover`, `fill`, etc. — the `_by_uid` family still works as the snapshot path; the unprefixed/prefixed variants are the Playwright-style fast path.
- `get_page_text`, `find_by_text`, `wait_for`, `press_key`, `type`, `select_option`, `scroll`.

If you're adding any of these, double-check the README's "Tool surface" table and update both there and here.

## License

MIT OR Apache-2.0 (matches `zen-mcp`).

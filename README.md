# zen-extension-mcp

WebExtension-backed MCP for Zen / Firefox. Sister project to `zen-mcp` (a local fork of [`firefox-devtools-mcp`](https://github.com/mozilla/firefox-devtools-mcp)), which uses Marionette/Selenium and requires launching the browser with flags. This one lives as a permanently-installed signed extension in your daily Zen — no flags, no restarts, container scoping per MCP entry.

```
Claude Code  --stdio-->  MCP server (per session, --container-scoped)
                              |
                              | ws://127.0.0.1:8766
                              v
                         daemon (long-lived router)
                              ^
                              | ws (token auth, 30s heartbeat)
                              |
                         MV3 extension (signed, in daily Zen)
```

## When to use this vs `zen-mcp`

| Use this | Use `zen-mcp` |
|---|---|
| Day-to-day automation in your real Zen | Need privileged-context tools (`evaluate_privileged_script`, `set_firefox_prefs`) |
| Multiple container-scoped MCP entries (`zen-cxv`, `zen-personal`, etc.) sharing one browser | Need full network capture with response bodies |
| Browser must keep running uninterrupted | Need reliable `upload_file_by_uid` |

The two coexist. They run different daemons by default. v1 of this project is **20 tools**; the rest of zen-mcp's surface stays where it is.

## Tool surface (v1, 20 tools)

| Bucket | Tools |
|---|---|
| **Containers** | `list_containers`, `set_default_container`, `new_page_in_container` |
| **Pages** | `list_pages`, `new_page`, `navigate_page`, `select_page`, `close_page`, `navigate_history`, `screenshot_page` |
| **DOM** | `take_snapshot`, `clear_snapshot`, `click_by_uid`, `hover_by_uid`, `fill_by_uid`, `fill_form_by_uid`, `drag_by_uid_to_uid`, `resolve_uid_to_selector`, `evaluate_script` |
| **Diagnostics** | `get_firefox_info` |

Dropped from `zen-mcp` because no WebExtension equivalent: `list_privileged_contexts` / `select_privileged_context` / `evaluate_privileged_script`, `set_firefox_prefs` / `get_firefox_prefs`, `restart_firefox`, `upload_file_by_uid`, `install_extension` / `list_extensions` / `uninstall_extension`.

Deferred to v2 (need degraded-fidelity content-script bridges): `list_console_messages`, `clear_console_messages`, `list_network_requests`, `get_network_request`, `accept_dialog`, `dismiss_dialog`, `screenshot_by_uid`, full-page screenshot.

Fidelity gaps to know:
- `screenshot_page` captures the target tab's visible viewport in place via `tabs.captureTab(tabId)` — it does **not** activate the tab or change window focus.
- `evaluate_script` requires JSON-serializable args/results (the `scripting.executeScript` constraint). Returning DOM nodes or non-serializable objects fails.

Focus behavior: automation is non-disruptive by default. `new_page` / `new_page_in_container` open tabs in the **background** (pass `active: true` to foreground), `navigate_page` and the DOM tools act on a tab by id without activating it, and `screenshot_page` captures without focus. The only tools that surface a tab to the foreground are `select_page` and an explicit `new_page(..., active: true)`. This means an MCP entry can drive one container (e.g. `zen-cxv`) while you browse in another (e.g. `zen-personal`) without your focus being stolen.

## Requirements

- Node 20+
- Zen browser (Firefox 115+ derivative) — works in stock Firefox too
- An [AMO](https://addons.mozilla.org) account (free) for signing the extension

## Build

```sh
git clone https://github.com/cxrobx/zen-extension-mcp.git
cd zen-extension-mcp
npm install
npm run build
```

Produces:
- `daemon/dist/index.js` — router process
- `server/dist/index.js` — MCP stdio server
- `extension/dist/` — MV3 extension bundle (esbuild IIFE, no module imports at runtime)

## Sign + install (one-time)

### 1. Get AMO API credentials

1. Sign in at https://addons.mozilla.org with a Firefox Account.
2. Go to https://addons.mozilla.org/en-US/developers/addon/api/key/ — accept the developer agreement.
3. Click **Generate new credentials**. You get:
   - **JWT issuer** (looks like `user:1234567:42`)
   - **JWT secret** (64-hex string, shown once — save somewhere durable)

### 2. Sign

```sh
export AMO_KEY="user:1234567:42"
export AMO_SECRET="..."
npm run extension:sign
```

`web-ext sign --channel=unlisted` uploads the bundle and Mozilla's automated signer returns a signed `.xpi` in `extension/web-ext-artifacts/`. Usually <60s. The `gecko.id` in `extension/src/manifest.json` (`zen-ext-mcp@cxrobx`) is per-developer — change it if you fork this so you don't collide.

### 3. Install in Zen

```sh
open -a "/Applications/Zen.app" extension/web-ext-artifacts/d27cc...-X.Y.Z.xpi
```

Accept the install prompt. **Then grant the host permission**:

- `about:addons` -> Zen Extension MCP Bridge -> **Permissions and data** -> toggle **Access your data for all websites** ON.

This is required for `screenshot_page` (`tabs.captureTab` needs host access to the tab being captured). The other tools work without it.

> **Upgrade gotcha**: in-place upgrades (open a newer XPI while old is installed) sometimes silently no-op in Zen. If the version doesn't change in `about:addons`, **remove the old extension first**, then install the new one. Storage (URL + token settings) gets wiped on full removal.

### 4. Configure the extension

Find the auth token:

```sh
cat ~/.config/zen-extension-mcp/auth.token
```

In Zen, open the extension's Preferences page (via `about:addons`'s `⋯` menu, or the toolbar puzzle-piece icon — varies by Zen UI version). Paste:

- **Daemon URL**: `ws://127.0.0.1:8766`
- **Auth token**: contents of `auth.token`

Click Save. The pill should flip to `authenticated` within 1-2 seconds (it can take up to ~10s if the extension was recently restarted because of reconnect backoff).

## Run

### Start the daemon

```sh
node daemon/dist/index.js --port 8766
```

The daemon writes a 32-byte random token to `~/.config/zen-extension-mcp/auth.token` on first launch (mode 0600). All later launches reuse it.

Default port is 8765 — many systems already have something there (`browsermcp`, `python -m http.server` for testing). If you collide, use `--port 8766`. Update the extension's options page URL to match.

A simple launchd plist for keeping the daemon running:

```xml
<!-- ~/Library/LaunchAgents/io.cxrobx.zen-extension-mcp.daemon.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.cxrobx.zen-extension-mcp.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/YOU/Projects/zen-extension-mcp/daemon/dist/index.js</string>
    <string>--port</string>
    <string>8766</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
```

Load it: `launchctl load ~/Library/LaunchAgents/io.cxrobx.zen-extension-mcp.daemon.plist`.

### Register MCP servers in Claude Code

Each entry is short-lived (one per Claude Code session) and connects to the daemon as a client.

**Single, no scoping**:

```sh
claude mcp add zen-ext node /abs/path/to/zen-extension-mcp/server/dist/index.js -- --port 8766
```

**Container-scoped** (one per container — they all share the daemon and extension):

```sh
claude mcp add zen-cxv          node /abs/path/.../server/dist/index.js -- --port 8766 --container CXVentures
claude mcp add zen-buildersbuddy node /abs/path/.../server/dist/index.js -- --port 8766 --container Buildersbuddy
claude mcp add zen-personal     node /abs/path/.../server/dist/index.js -- --port 8766 --container Personal
```

`--container <name>` resolves at server startup using the existing `zen-mcp` resolver: 0 matches errors with the available list; >1 matches errors with the matching list.

When `--container` is set, `new_page` defaults to that cookieStoreId. `new_page_in_container` always takes an explicit name. `set_default_container` updates the scope at runtime for that MCP entry. Both new-tab tools open in the background by default; pass `active: true` to foreground the tab.

## Architecture

### Multi-entry pattern

Three Claude Code MCP entries (e.g. `zen-cxv`, `zen-personal`, `zen-buildersbuddy`) each spawn a fresh **MCP server process**. All three connect to the same **daemon** (single TCP port). The daemon routes each request to the single **extension** and routes the response back to the originating client. Order-preserving with a per-request id; no cross-talk.

Two MCP entries calling `new_page` simultaneously each open their own tab in their own container — the daemon doesn't serialize them.

### Auth + heartbeat

- **Token**: shared secret, 32 bytes random hex, stored at `~/.config/zen-extension-mcp/auth.token` (0600). First message on every connection must be a `hello` with the token within 5s. Constant-time compared via `crypto.timingSafeEqual`.
- **Heartbeat**: daemon sends WebSocket pings every 30s. If no pong, the connection is terminated and (for clients) eligible for replacement.
- **Reconnect**: clients (server + extension) reconnect with exponential backoff capped at 10s. Resets to 0 on `welcome`.

### What the daemon owns

The daemon binds the WebSocket port. Exactly **one** extension connection at a time (a new hello with role=extension replaces the old one and fails its in-flight requests). Many clients. Extension-bound requests are routed by request id; a per-id timer fails the call after 30s.

### Snapshot caching

`take_snapshot` injects `extension/dist/snapshot/inject.js` via `scripting.executeScript({ files, world: 'MAIN' })`, then calls `window.__zenExtMcpCreateSnapshot`. The returned `uidMap` is cached in the background script keyed by tabId. Subsequent `click_by_uid`/`fill_by_uid`/etc. resolve uid -> selector via the cache, then run an inline action `func` against `document.querySelector(selector)`.

The cache is dropped on `webNavigation.onCommitted` (frame 0) and `tabs.onRemoved`. Take a fresh snapshot after any navigation.

## Development loop

For non-prod iteration, skip AMO signing — load the extension as a temporary add-on via `web-ext run`:

```sh
npm run extension:run
```

This opens a fresh Firefox profile with `extension/dist/` loaded as a temporary extension, no signing required. The extension is gone after the dev profile closes — fine for development.

When iterating on extension code with the signed install in production: rebuild + re-sign + remove + reinstall. Use the `npm run extension:sign` script (requires `AMO_KEY` + `AMO_SECRET`).

## Troubleshooting

**`extension not connected` from a tool call**: the extension is between reconnect attempts. Check `about:addons` -> Preferences -> status pill. If it says `error`, look at the background console (`about:debugging` -> Inspect on this extension -> Console). Common: token mismatch, daemon not running, port wrong.

**`Missing host permission for the tab` on `screenshot_page`**: the host permission isn't granted. Toggle "Access your data for all websites" in the extension's Permissions tab.

**Storm of "replacing extension connection" in daemon log**: an old buggy version is still running alongside a new one (two background instances both reconnecting and replacing each other). Fully quit Zen and relaunch — should resolve. If it persists, uninstall and reinstall the extension.

**Port collision**: `--port 8766` (or any other free port) on the daemon, then update the extension's options URL.

**Token rotation**: `rm ~/.config/zen-extension-mcp/auth.token` and restart the daemon. Paste the new value into the options page.

## Security model

- Daemon binds 127.0.0.1 only. No remote network exposure.
- Auth token is the only thing that gates the extension's tool surface from other processes on the same machine. Treat it like any other local credential.
- The signed extension has `<all_urls>` host permission (gated behind explicit user opt-in for site-data access). It can therefore script any page you visit. Don't grant it lightly.
- `evaluate_script` runs arbitrary user-provided JS in the page's MAIN world. The MCP token gates who can call it. There is no per-tool permission check beyond auth.

## License

MIT OR Apache-2.0

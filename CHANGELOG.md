# Changelog

All notable changes to this project will be documented here. Versions track the
extension manifest and the AMO-signed XPI artifacts. Server, daemon, and shared
package versions move together with the extension.

## 0.0.13 (non-disruptive automation: background tabs + focus-free screenshots)

- `new_page` / `new_page_in_container` now open tabs in the **background** by
  default instead of foregrounding them. Added an optional `active` param
  (default `false`) to both tools; pass `active: true` to bring the new tab to
  the front. Handler default is `params.active ?? false`, so even an older
  server that doesn't send the field gets background behavior.
- `screenshot_page` no longer activates the target tab and focuses its window
  before capturing. It now uses `tabs.captureTab(tabId)`, which captures a
  specific tab in place. This removes the only remaining focus-steal in the
  normal automation path.
- Net effect: an MCP entry can drive one container (e.g. `zen-cxv`) while you
  browse in another (e.g. `zen-personal`) without your active tab or window
  focus being disturbed. The only tools that surface a tab are now `select_page`
  and an explicit `new_page(..., active: true)`.
- Verified live (`scripts/probe-focus.mjs`): a default `new_page` opened in the
  background and left the originally-active tab active; `screenshot_page`
  returned a full ~162 KB image of that inactive background tab without changing
  focus; `active: true` still foregrounded. The probe restores the original
  active tab on exit.

## 0.0.9 (keepalive bug fix)

- `connect()` was bailing on a stale `this.ws` even when the socket was
  already CLOSED. The keepalive alarm checked the cached `state` field
  ("authenticated") rather than the actual `ws.readyState`, so after the
  daemon restarted the alarm thought everything was fine and never kicked
  a new connect. Fix: alarm calls a new `isHealthy()` (returns
  `ws.readyState === OPEN`) and triggers `forceReconnect()` if not. Connect
  now gates on `OPEN || CONNECTING`, treats CLOSED/CLOSING as null.
- Verified: killed the daemon process; launchd restarted it; extension
  reconnected within ~450ms via the keepalive alarm without any user
  action.

## 0.0.8 (keepalive)

- Add `browser.alarms` "zen-ext-keepalive" firing every 30 seconds. The alarm
  keeps the MV3 background alive across Firefox's idle suspension and re-kicks
  the WebSocket connect if the previous one was torn down. Without this, the
  extension's background suspends after ~80 seconds of "idle" (despite the
  active WebSocket), `setTimeout`-based reconnect timers die with it, and the
  extension stays disconnected until something else wakes it (e.g. opening
  the options page). Long-lived WebSockets do not, in practice, keep MV3
  backgrounds alive in Firefox 147.
- New manifest permission: `alarms`.

## 0.0.7 (Milestone 4)

- New tool: `get_firefox_info`. Returns MCP server identity (name, version,
  daemon URL, current container scope) plus extension-side runtime data
  (extension id/version, platform, userAgent, window/tab/container counts,
  protocol version). Replaces zen-mcp's `get_firefox_output` semantics.
- README rewrite: full v1 tool list, AMO key creation, install gotchas
  (in-place upgrade flakiness, host-permission opt-in for screenshot),
  multi-MCP-entry pattern, troubleshooting.
- CHANGELOG added.
- No protocol changes from 0.0.6.

## 0.0.6 (Milestone 3 fix)

- `screenshot_page`: stop passing `windowId` to `tabs.captureVisibleTab` and
  instead activate the target tab + capture the focused window. Avoids a Zen
  quirk where the windowId form rejects with "Missing activeTab permission"
  even when `<all_urls>` is granted.

## 0.0.5 (Milestone 3)

- Ported `zen-mcp/src/firefox/snapshot/injected/` to
  `extension/src/snapshot/`. Builds as a separate esbuild IIFE entry
  (`dist/snapshot/inject.js`) that exposes `window.__zenExtMcpCreateSnapshot`,
  lazy-injected via `scripting.executeScript({ files, world: 'MAIN' })`.
- New tools: `take_snapshot`, `clear_snapshot`, `click_by_uid`, `hover_by_uid`,
  `fill_by_uid`, `fill_form_by_uid`, `drag_by_uid_to_uid`,
  `resolve_uid_to_selector`, `evaluate_script`, `screenshot_page`.
- Background caches `uidMap` per tabId; `webNavigation.onCommitted` and
  `tabs.onRemoved` clear it.
- Manifest gains `webNavigation` permission and `host_permissions: ["<all_urls>"]`.
- `fill_*` uses the `value` setter from the prototype to bypass React-style
  state shadowing, then dispatches `input` + `change`.

## 0.0.4 (Milestone 2)

- New tools: `list_pages`, `new_page`, `new_page_in_container`,
  `set_default_container`, `navigate_page`, `select_page`, `close_page`,
  `navigate_history`.
- `pageIdx` is sorted by `(windowId, tab.index)` for stability across
  `list_pages` calls within a single window/tab arrangement.
- `--container <name>` flag at server startup sets a mutable default scope
  for that MCP entry. `set_default_container` updates it at runtime.

## 0.0.3 (Milestone 1 fix + reconnect cleanup)

- Drop `upgrade-insecure-requests` from the default CSP via explicit
  `content_security_policy.extension_pages`. Without this Firefox MV3
  silently rewrites `ws://127.0.0.1` to `wss://127.0.0.1`, which the daemon
  doesn't speak and the connection hangs forever in CONNECTING.
- Make `connect()` idempotent (`if (this.ws) return;`) and gate the close
  handler on `wasCurrent` to avoid two parallel sockets fighting for the
  daemon's single extension slot.

## 0.0.2

- Lost release. The extension's settings persisted but a connect-storm bug
  shipped along with the CSP fix attempt.

## 0.0.1 (Milestone 1)

- Initial scaffold. Three workspaces (`shared`, `daemon`, `server`,
  `extension`), one tool: `list_containers`.
- Shared-secret auth with constant-time compare, 30s heartbeat, reconnect
  with exponential backoff capped at 10s.
- Daemon binds 127.0.0.1:8765 by default; `--port <n>` flag for collisions.
- MCP server `--container <name>` resolves at startup using the
  `resolveContainerByName` helper ported verbatim from `zen-mcp`.
- Signed via AMO unlisted (`web-ext sign --channel=unlisted`); install once
  into daily Zen, persists across browser restarts.

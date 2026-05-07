# zen-extension-mcp

WebExtension-backed MCP for Zen / Firefox. Three pieces talking over a localhost WebSocket:

```
Claude Code  ---stdio--->  MCP server  --ws-->  daemon  <--ws--  MV3 extension (in Zen)
                            (per session)        (long-lived)     (installed once)
```

This is the v1 spike for Milestone 1: prove the bridge, prove signed-extension install survives Zen restarts, prove container-scoped tab ops work without launching Zen with any flags. Sister project to `zen-mcp`, which keeps the Marionette/Selenium backend for privileged-context tools.

## Why three processes

- The **daemon** owns the WebSocket port. One process, lives across Claude Code sessions, holds the single extension connection.
- Each **MCP server** is short-lived — one per `claude mcp add` entry. Connects to the daemon as a client, scoped by `--container <name>` at startup. Three separate `claude mcp add` entries (e.g. `zen-cxv`, `zen-buildersbuddy`, `zen-personal`) all share the same daemon and the same extension.
- The **extension** runs inside daily Zen. Connects to the daemon, handles RPC requests against the WebExtension API surface (containers, tabs, scripting).

## Layout

```
shared/      RPC types, method names, error codes (single source of truth)
daemon/      WebSocket router, auth + heartbeat, request fan-out
server/      MCP stdio server; registers tools that proxy through the daemon
extension/   MV3 WebExtension (background script + options page)
```

## Install (developer)

Requires Node 20+.

```sh
npm install
npm run build
```

This compiles `shared/`, `daemon/`, `server/`, and bundles `extension/dist/` via esbuild.

## Running locally

### 1. Start the daemon

```sh
node daemon/dist/index.js
```

On first launch the daemon writes a 32-byte random token to `~/.config/zen-extension-mcp/auth.token` (mode 0600). All later launches reuse that file. The daemon binds `127.0.0.1:8765` by default.

Flags:
- `--port <n>` (default 8765, env `ZEN_EXT_MCP_PORT`)
- `--host <addr>` (default 127.0.0.1, env `ZEN_EXT_MCP_HOST`)
- `--token-file <path>` (default `~/.config/zen-extension-mcp/auth.token`)

Set `ZEN_EXT_MCP_LOG=debug` for verbose stderr JSON logs.

### 2. Install the extension into Zen

For development, load it temporarily (gone after browser restart):

```sh
npm run extension:run
```

This runs `web-ext run --source-dir=extension/dist` and opens a temporary Firefox/Zen profile with the extension installed.

For daily use, sign and install the XPI permanently — see [Signing](#signing) below.

After install, open the extension's options page in Zen and paste in:
- **Daemon URL**: `ws://127.0.0.1:8765`
- **Auth token**: the contents of `~/.config/zen-extension-mcp/auth.token`

The status pill should flip to `authenticated` within a second.

### 3. Register the MCP server in Claude Code

A single entry that lists all containers:

```sh
claude mcp add zen-ext node /absolute/path/to/zen-extension-mcp/server/dist/index.js
```

A container-scoped entry (matches the Marionette fork's `--container` flag — but no Zen restart, ever):

```sh
claude mcp add zen-cxv node /absolute/path/to/zen-extension-mcp/server/dist/index.js --container CXVentures
```

Multiple scoped entries are fine — they all connect through the same daemon to the same extension.

## Signing

For the daily Zen path (signed XPI, persists across restarts):

1. Register an AMO account at https://addons.mozilla.org and create an API key (Tools -> Manage API Keys).
2. Export credentials:
   ```sh
   export AMO_KEY=user:12345:67
   export AMO_SECRET=...
   ```
3. Sign:
   ```sh
   npm run extension:sign
   ```
   This calls `web-ext sign --channel=unlisted` against `extension/dist/`. Mozilla's automated signer returns a signed `.xpi` in `extension/web-ext-artifacts/`.
4. Drag the signed XPI into Zen's add-ons page; accept the install prompt. It now persists across Zen restarts.

If you don't want an AMO account: install Firefox Developer Edition, set `xpinstall.signatures.required` to `false` in `about:config`, and load the unsigned XPI there. Daily Zen stays untouched but you trade away the "lives in my actual daily browser" goal.

## Security model

- Daemon binds to `127.0.0.1` only — no remote network exposure.
- Auth: shared-secret token (32 random bytes, hex-encoded). The first message on every connection must be a `hello` carrying the token; everything else is rejected with a 5s timeout.
- Tokens are constant-time compared (`crypto.timingSafeEqual`).
- Token file is mode 0600 in `~/.config/zen-extension-mcp/`.

This protects against unrelated processes on the machine speaking to the extension. It is not a sandbox against the user's own malicious code.

## v1 tool surface

Milestone 1 ships `list_containers` only. The full v1 tool list lands across milestones 2 and 3:

| Bucket | Tools |
|---|---|
| **v1 (planned)** | `list_containers`, `set_default_container`, `new_page_in_container`, `list_pages`, `new_page`, `navigate_page`, `select_page`, `close_page`, `navigate_history`, `take_snapshot`, `clear_snapshot`, `click_by_uid`, `hover_by_uid`, `fill_by_uid`, `fill_form_by_uid`, `drag_by_uid_to_uid`, `resolve_uid_to_selector`, `evaluate_script`, `screenshot_page`, `get_firefox_info` |
| **v2 candidates** | `list_console_messages`, `clear_console_messages`, `list_network_requests`, `get_network_request`, `accept_dialog`, `dismiss_dialog`, `screenshot_by_uid` (degraded fidelity — content-script canvas), full-page screenshot |
| **Dropped** | `list_privileged_contexts`, `select_privileged_context`, `evaluate_privileged_script`, `set_firefox_prefs`, `get_firefox_prefs`, `restart_firefox`, `upload_file_by_uid`, `install_extension`, `list_extensions`, `uninstall_extension` (no WebExtension equivalent — keep using `zen-mcp`) |

Fidelity gaps to call out:
- `set_viewport_size` will resize the **window**, not the inner viewport (`browser.windows.update` is the only available knob). If you need exact viewport sizing, use `zen-mcp`.
- `evaluate_script` requires JSON-serializable args and returns. `scripting.executeScript` enforces this; `zen-mcp`'s Marionette equivalent is more permissive.

## Troubleshooting

**"extension not connected"**: the MCP server is up but the extension isn't talking to the daemon. Open the options page; check the daemon URL and token; check Zen's Browser Console (`Cmd+Shift+J`) for `[zen-ext-mcp]` messages.

**Port collision**: another process is on 8765. Pass `--port 8766` to both the daemon and your MCP server entry, then update the daemon URL in the extension's options page to match.

**Token rotation**: delete `~/.config/zen-extension-mcp/auth.token` and restart the daemon — it generates a fresh token. Paste the new value into the extension's options page.

## License

MIT OR Apache-2.0

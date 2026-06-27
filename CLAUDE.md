# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A lightweight web GUI that wraps the `ccb` / `claude` Claude Code CLI. The backend is pure Python standard library (no third-party packages, no web framework); the frontend is static HTML/CSS/vanilla JavaScript with no build step. The primary target platform is Windows.

## Running

```bash
python server.py        # cross-platform
start.bat               # Windows (checks Python, then runs server.py)
```

The server binds `127.0.0.1:17878` and auto-increments the port if occupied, then opens a browser. There is no build, lint, or test setup — changes are verified by running the server and exercising the UI.

## Architecture

Request flow: browser → `server.py` (HTTP + REST + SSE) → `ccb_bridge.py` (subprocess) → `ccb`/`claude` CLI. Streaming results flow back over SSE.

- **`server.py`** — Hand-rolled async HTTP server on `asyncio.start_server`, parsing requests line-by-line. Routes static files, REST endpoints under `/api/`, the `/api/action` command channel, `/api/upload` (manual multipart parsing), and the `/sse` long-lived event stream. Holds all per-client in-memory state in module-level dicts keyed by `client_id`: `sse_clients` (event queues), `client_session_ids`, `client_meta` (model/cwd), `client_last_msg`.
- **`ccb_bridge.py`** — Spawns and manages CLI subprocesses. `CCBSession` runs `ccb -p --output-format stream-json --verbose --include-partial-messages` and parses stdout JSONL line-by-line. `SessionManager` maps `client_id` → `CCBSession`. `discover_slash_commands()` does a short-lived CLI launch to read the `system/init` event (cached with TTL).
- **`config_manager.py`** — Reads/writes `~/.claude/settings.json`, GUI prefs in `~/.ccb/gui_settings.json`, and lists skills/agents by parsing frontmatter from `~/.claude/skills/*/SKILL.md` and `~/.claude/agents/*.md`. Model list is derived from `env` keys containing `MODEL` in settings.json.
- **`session_store.py`** — Session metadata persistence in `~/.claude/gui_sessions.json` plus discovery/merge of native CLI sessions from `~/.claude/projects/<sanitized-cwd>/<session-id>.jsonl`.

### Concepts that span files

- **One subprocess per message.** Each `send_message` spawns a fresh CLI process; multi-turn continuity is achieved with `--resume <session_id>`, not a persistent process. The `stream-json` *stdin input* mode was abandoned as unreliable — input is plain text on stdin, output is stream-json (see the module docstring in `ccb_bridge.py`).
- **SSE instead of WebSocket** — deliberate choice to avoid Windows `asyncio` compatibility issues. Heartbeats (`: heartbeat`) keep the connection alive every 15s.
- **session_id capture.** The CLI generates its own session UUID. `ccb_bridge.py` detects a new `session_id` in any event and emits a synthetic `session_id_captured` event; `server.py`'s `on_event` handler intercepts it to persist the session via `save_session`. This is how the frontend and store learn the real session ID.
- **Event filtering.** `server.py` only forwards a whitelist of event types to the frontend (`assistant`, `system`, `error`, `process_ended`, `model_changed`, `result`, `session_id_captured`); others (e.g. `hook_started`) are dropped.
- **Cost accumulation.** `result.total_cost_usd` from each turn is added to the per-session running total via `add_session_cost` and re-attached as `session_total_cost_usd`.
- **cwd → project dir mapping.** `_sanitize_cwd` replaces every non-alphanumeric char with `-`, matching the CLI's own `sanitizePath`, to locate native session JSONL files. Keep this in sync if the CLI's scheme changes.

### CLI detection order (`ccb_bridge.py`)

`ccb.exe` in script dir → `ccb.exe` in parent dir → `ccb` on PATH → `claude` on PATH. The selected CLI is global mutable state (`_current_cli`), switchable via `POST /api/clis`.

## Conventions

- Code comments and CLI-facing UI strings are Chinese (zh-CN); user-facing UI text is localized via `static/i18n/{en,zh}.json` (same key set, read through `data-i18n*` attributes).
- All filesystem paths are normalized to forward slashes (`.replace("\\", "/")`) before being sent to the frontend.
- Path-traversal guards exist on static serving (must resolve under `static/`) and `/api/file` (must be under an uploads dir) — preserve these when touching those handlers.
- Directory browsing/search endpoints skip dotfiles and `node_modules`, `__pycache__`, `.git`, `venv`, `.venv`.

## Persistence locations

| Data | Path |
|------|------|
| GUI prefs (theme, language, font size) | `~/.ccb/gui_settings.json` |
| Session index + accumulated cost | `~/.claude/gui_sessions.json` |
| Claude global settings + env vars | `~/.claude/settings.json` |
| Native CLI session transcripts | `~/.claude/projects/<sanitized-cwd>/*.jsonl` |
| Per-workdir upload cache | `<cwd>/.gui-uploads/` (fallback: `uploads/`) |

## Error handling & pre-flight validation

- **Pre-flight checks in `ccb_bridge.py`.** `validate_cli(cli_path)` checks that the CLI executable exists before spawning a subprocess; `validate_cwd(cwd)` checks that the working directory exists and is a directory. Both raise `FileNotFoundError` with Chinese-language messages describing what's wrong. These are called in `CCBSession.start()` (fail-fast on cwd), `_start_persistent_proc()`, and `_send_one_shot_message()`.
- **JSON error responses for all API routes.** The top-level HTTP handler in `server.py` catches unhandled exceptions and returns `{"error":"..."}` as `application/json` for any `/api/*` route, instead of the old `text/plain` behavior. This prevents frontend `resp.json()` parse crashes.
- **SSE error push on send failures.** `handle_action` for `send_message` and `new_session` wraps the subprocess-launching calls in try/except; on failure it pushes an `error` event over SSE (so the user sees the message in the chat) and returns a JSON error response.
- **CWD update flow.** When a session's working directory has been renamed or deleted, the error propagates to the frontend, which detects cwd-related errors (via `isCwdError()`) and prompts the user for a new directory. The new cwd is persisted via `POST /api/sessions/update-cwd` → `session_store.update_session_cwd()`, then `resume_session` is retried automatically. Users can also proactively change a session's cwd by clicking the 📁 button next to any session in the sidebar list.

## Desktop packaging (Tauri + PyInstaller)

The `desktop/` directory contains a **Tauri v2** wrapper that bundles the Python server as a sidecar into a native desktop application with auto-update support.

### Architecture

```
Tauri Shell (Rust, ~5.6 MB)
  → WebView loads http://127.0.0.1:{PORT}
  → Manages Python sidecar lifecycle (start/kill on window close)

Python Sidecar (PyInstaller, ~14 MB)
  → server.py --sidecar
  → Prints "SIDECAR_PORT:{port}" to stdout
  → HTTP + SSE server, CLI subprocess management
```

The `--sidecar` flag (detected in `server.py:main()`) changes behavior:
- Redirects startup logs to stderr only (stdout is reserved for the port handshake)
- Monitors stdin closure to gracefully shut down
- Suppresses `Ctrl+C` message and browser-open behavior

### Prerequisites

- [Rust](https://rustup.rs/) 1.84+
- [Node.js](https://nodejs.org/) 20+
- [Python](https://python.org/) 3.11+ (for PyInstaller build)

### Development

```bash
# Terminal 1: Start Python server
python server.py

# Terminal 2: Start Tauri dev mode
cd desktop
npm install
npx tauri dev
```

### Production build

```bash
cd desktop

# 1. Build Python sidecar (PyInstaller → single .exe/.bin)
python -m PyInstaller build/pyinstaller.spec \
  --distpath src-tauri/binaries/server \
  --workpath build/pyinstaller-work \
  --clean --noconfirm

# 2. Build Tauri desktop app
npm install
npx tauri build
```

Outputs in `src-tauri/target/release/bundle/`:
- Windows: `.msi` + `.exe` (MSI + NSIS installer)
- macOS: `.dmg`
- Linux: `.deb` + `.AppImage`

The `build/pyinstaller.spec` bundles `server.py` + all Python modules + `static/` into a single executable. `tauri.conf.json` declares the sidecar binary path under `bundle.resources`.

### Key files

| File | Purpose |
|------|---------|
| `desktop/src-tauri/src/main.rs` | Rust entry point, sidecar lifecycle, window management |
| `desktop/src-tauri/tauri.conf.json` | App metadata, bundle config, updater endpoints |
| `desktop/src-tauri/capabilities/default.json` | Permissions: updater, window controls |
| `desktop/build/pyinstaller.spec` | PyInstaller spec for the Python sidecar |
| `desktop/build/desktop.iss` | Inno Setup script (alternative Windows installer) |

## Auto-update

The desktop app uses Tauri's built-in updater plugin. When a new version is released, the app detects it on startup and prompts the user to download and install.

### Release flow

1. **Tag a version:**
   ```bash
   git tag v0.1.1
   git push origin v0.1.1
   ```

2. **CI builds all platforms.** `.github/workflows/desktop-release.yml` is triggered by the tag push:
   - Builds Python sidecar on Windows/macOS/Linux via PyInstaller
   - Builds Tauri app on all three platforms
   - Creates a **draft** GitHub Release with all installers + `latest.json`

3. **Review and publish.** The release is created as a draft — go to GitHub Releases, verify the artifacts, then click "Publish".

4. **Clients auto-update.** The Tauri updater plugin polls `latest.json` (served from the GitHub Release) and downloads the new installer when available.

### Updater configuration

In `tauri.conf.json`:
```json
"plugins": {
  "updater": {
    "pubkey": "PLACEHOLDER",
    "endpoints": [
      "https://github.com/OWNER/REPO/releases/latest/download/latest.json"
    ]
  }
}
```

The `pubkey` must be replaced with a real key pair generated by `npx tauri signer generate`. The private key is used in CI to sign the update, the public key goes in `tauri.conf.json`.

### `latest.json` format

Generated by the CI workflow, served from the GitHub Release:
```json
{
  "version": "0.1.1",
  "notes": "See release page for changelog",
  "pub_date": "2025-01-01T00:00:00Z",
  "platforms": {
    "windows-x86_64": { "signature": "...", "url": "..." },
    "darwin-x86_64": { "signature": "...", "url": "..." },
    "linux-x86_64": { "signature": "...", "url": "..." }
  }
}
```

### Sidecar resolution order

The Rust code in `desktop/src-tauri/src/main.rs` searches for the Python sidecar binary in this order:
1. `<exe_dir>/binaries/server/` (production install)
2. `<exe_dir>/` (flat install)
3. Tauri resource dir
4. `CARGO_MANIFEST_DIR/binaries/server/` (development build)
5. Fallback: `python ../server.py --sidecar` (dev with source)
6. Last resort: try PATH + fallback to connecting to existing server on ports 17878-17880 |

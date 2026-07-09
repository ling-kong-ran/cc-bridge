# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A lightweight web GUI that wraps the `ccb` / `claude` Claude Code CLI. The backend is mostly Python standard library with a few third-party deps (`qrcode`, `lark-oapi`, `paramiko` in `requirements.txt`) and no web framework; the frontend is static HTML/CSS/vanilla JavaScript with no build step. The primary target platform is Windows.

## Running

```bash
start.bat               # Windows entry; should delegate to start.ps1/bootstrap
./start.sh              # macOS/Linux entry; should delegate to bootstrap.py
python bootstrap.py     # cross-platform bootstrap once Python exists
python server.py        # development / already configured environments
```

The server binds `127.0.0.1:17878` and auto-increments the port if occupied, then opens a browser. There is no build, lint, or test setup — changes are verified by running the server and exercising the UI.

## Desktop packaging and release

Local Windows packaging should use the project script instead of hand-written `electron-builder` commands:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package-desktop.ps1              # build Windows installer
powershell -ExecutionPolicy Bypass -File scripts/package-desktop.ps1 -SkipInstall # reuse current node_modules
powershell -ExecutionPolicy Bypass -File scripts/package-desktop.ps1 -Target pack # unpacked app only
```

The script writes output to `release/` and performs Python syntax checks before packaging. By default it uses the version in `package.json`. The script's `-Version` parameter only applies with `-Release`, because release mode bumps `package.json` via `npm version` before packaging.

For GitHub all-platform packaging, use the workflow file name and pass the intended release version explicitly:

```bash
gh workflow run release-desktop.yml --ref master -f version=0.1.6
```

If `version` is omitted, the workflow uses the current `package.json` version. Check the run and release with:

```bash
gh run list --workflow release-desktop.yml --branch master --limit 3
gh run view <run-id> --json status,conclusion,url,jobs
gh release view v0.1.6
```

The release workflow builds Windows, macOS, and Linux artifacts, then publishes/updates the matching GitHub release tag `v<version>`. Electron and electron-builder binary downloads are cached and retried in CI because GitHub-hosted downloads can intermittently return 504.

### Bootstrap design

Do not put Python / Node / npm / Claude CLI installation logic in `server.py`. `server.py` is the Web/SSE/REST service only. Startup environment preparation belongs in platform launchers plus a separate bootstrap layer:

```text
start.bat       # Windows double-click entry; thin wrapper around start.ps1
start.ps1       # Windows Python-missing fallback, then calls bootstrap.py
start.sh        # macOS/Linux Python-missing fallback, then calls bootstrap.py
bootstrap.py    # cross-platform bootstrap once Python can run
bootstrap/      # probe/install/venv/launcher modules
```

Planned bootstrap modules:

- `bootstrap/probe.py` — detect OS, Python, venv, Node, npm, ccb, and claude.
- `bootstrap/python_setup.py` — Python version checks and platform installer hints/calls.
- `bootstrap/venv_setup.py` — create/use project `.venv`.
- `bootstrap/node_setup.py` — install Node/npm via winget, brew, apt, dnf, or pacman.
- `bootstrap/claude_setup.py` — install Claude Code CLI via npm.
- `bootstrap/launcher.py` — launch `server.py` with `.venv` Python.
- `bootstrap/state.py` — write `~/.ccb/bootstrap.log` and `~/.ccb/bootstrap_state.json`.

Python-missing cases must be handled by `start.ps1` / `start.sh`, because Python code cannot run without Python. After Python exists, `bootstrap.py` should create `<repo>/.venv/`, ensure Node/npm, ensure Claude CLI, then run `server.py` with `.venv` Python.

Prefer installing Claude CLI into a controlled prefix instead of global npm:

```bash
npm install --prefix ~/.ccb/npm-global @anthropic-ai/claude-code
```

Then prepend that bin directory to the server process `PATH`. Update CLI detection to include this path before PATH lookup: local `ccb.exe` → parent `ccb.exe` → `~/.ccb/npm-global` claude → PATH `ccb` → PATH `claude`.

Installer actions should be interactive by default and support unattended mode via `CCB_BOOTSTRAP_ASSUME_YES=1` or `bootstrap.py --yes`.

## Architecture

Request flow: browser → `server.py` (HTTP + REST + SSE) → `ccb_bridge.py` (subprocess) → `ccb`/`claude` CLI. Streaming results flow back over SSE.

- **`server.py`** — Hand-rolled async HTTP server on `asyncio.start_server`, parsing requests line-by-line. Routes static files, REST endpoints under `/api/`, the `/api/action` command channel, `/api/upload` (manual multipart parsing), and the `/sse` long-lived event stream. Holds all per-client in-memory state in module-level dicts keyed by `client_id`: `sse_clients` (event queues), `client_session_ids`, `client_meta` (model/cwd), `client_last_msg`.
- **`ccb_bridge.py`** — Spawns and manages CLI subprocesses. `CCBSession` prefers a persistent local CLI process for ordinary local sessions, and uses one-shot subprocesses with `--resume <session_id>` for remote/MCP/dynamic configuration sessions or when persistent mode fails. It parses stdout JSONL line-by-line. `SessionManager` maps `client_id` → `CCBSession`. `discover_slash_commands()` does a short-lived CLI launch to read the `system/init` event (cached with TTL).
- **`config_manager.py`** — Reads/writes `~/.claude/settings.json`, GUI prefs in `~/.ccb/gui_settings.json`, and lists skills/agents by parsing frontmatter from `~/.claude/skills/*/SKILL.md` and `~/.claude/agents/*.md`. Model list is derived from `env` keys containing `MODEL` in settings.json.
- **`session_store.py`** — Session metadata persistence in `~/.claude/gui_sessions.json` plus discovery/merge of native CLI sessions from `~/.claude/projects/<sanitized-cwd>/<session-id>.jsonl`.

### Concepts that span files

- **CLI process model.** Ordinary local sessions prefer a persistent `ccb -p --output-format stream-json --verbose --include-partial-messages` subprocess and write subsequent messages to stdin. Remote/MCP/dynamic configuration sessions use one-shot subprocesses; multi-turn continuity there is achieved with `--resume <session_id>`. Persistent mode falls back to one-shot if startup or runtime fails. See `docs/architecture/cli-process-model.md`.
- **SSE instead of WebSocket** — deliberate choice to avoid Windows `asyncio` compatibility issues. Heartbeats (`: heartbeat`) keep the connection alive every 15s.
- **session_id capture.** The CLI generates its own session UUID. `ccb_bridge.py` detects a new `session_id` in any event and emits a synthetic `session_id_captured` event; `server.py`'s `on_event` handler intercepts it to persist the session via `save_session`. This is how the frontend and store learn the real session ID.
- **Event filtering.** `server.py` only forwards a whitelist of event types to the frontend (`assistant`, `system`, `error`, `process_ended`, `model_changed`, `result`, `session_id_captured`); others (e.g. `hook_started`) are dropped.
- **Cost accumulation.** `result.total_cost_usd` from each turn is added to the per-session running total via `add_session_cost` and re-attached as `session_total_cost_usd`.
- **cwd → project dir mapping.** `_sanitize_cwd` replaces every non-alphanumeric char with `-`, matching the CLI's own `sanitizePath`, to locate native session JSONL files. Keep this in sync if the CLI's scheme changes.

### CLI detection order (`ccb_bridge.py`)

`ccb.exe` in script dir → `ccb.exe` in parent dir → `~/.ccb/npm-global` claude → `ccb` on PATH → `claude` on PATH. The selected CLI is global mutable state (`_current_cli`), switchable via `POST /api/clis`.

## Conventions

- Code comments and CLI-facing UI strings are Chinese (zh-CN); user-facing UI text is localized via `static/i18n/{en,zh}.json` (same key set, read through `data-i18n*` attributes).
- Git commit messages for this project must be written in Chinese.
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

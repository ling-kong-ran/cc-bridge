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

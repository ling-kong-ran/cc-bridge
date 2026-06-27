# CC-GUI Desktop

Desktop application wrapper for [CC-GUI](https://github.com/ling-kong-ran/cc-gui) built with **Tauri v2 + Python sidecar**.

## Architecture

```
Tauri Shell (Rust, 5.6MB)
  → WebView loads http://127.0.0.1:{PORT}
  → Manages Python sidecar lifecycle

Python Sidecar (PyInstaller, ~14MB)
  → server.py --sidecar
  → HTTP + SSE server
  → CLI subprocess management
```

## Prerequisites

- [Rust](https://rustup.rs/) 1.84+
- [Node.js](https://nodejs.org/) 20+
- [Python](https://python.org/) 3.11+ (for PyInstaller build)

## Quick Start (Development)

```bash
# Terminal 1: Start Python server
python ../server.py

# Terminal 2: Start Tauri dev mode (connects to the server)
cd desktop
npm install
npx tauri dev
```

## Build

```bash
cd desktop

# 1. Build Python sidecar
python -m PyInstaller build/pyinstaller.spec --distpath src-tauri/binaries/server --workpath build/pyinstaller-work --clean --noconfirm

# 2. Build Tauri desktop app
npm install
npx tauri build
```

Outputs in `src-tauri/target/release/bundle/`:
- Windows: `.msi` (MSI installer) + `.exe` (NSIS installer)
- macOS: `.dmg`
- Linux: `.deb` + `.AppImage`

## Auto-Update

The app checks for updates on startup via GitHub Releases. Pushing a new tag triggers the CI pipeline to build all platforms and create a draft release.

```bash
git tag v0.1.1
git push origin v0.1.1
```

## Platform Notes

- **Windows**: WebView2 runtime required (pre-installed on Win 10+)
- **macOS**: WKWebView (built-in)
- **Linux**: `libwebkit2gtk-4.1-dev` required

## Related

- [CC-GUI](../) — The web GUI this desktop app wraps
- The Python backend (`server.py`) runs unchanged, with `--sidecar` flag for desktop mode

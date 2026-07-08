# 桌面包依赖策略

## 目标

桌面安装包只打包 CC Bridge 应用代码和静态资源，不打包运行时依赖。

安装包不内置：

- Python 解释器。
- Python 第三方依赖，例如 `qrcode`、`pywinauto`、`pywin32`。
- Node.js。
- Claude Code CLI。

这样可以避免 Windows 下 DLL 被占用、Python 版本绑定依赖不匹配等问题。用户机器需要自行准备 Python 与 Claude Code CLI；轻量包/全量包概念不再区分。

## 启动行为

1. Electron 调用系统 `python` / `python3` 或 `CCB_DESKTOP_PYTHON` 启动 `bootstrap.py --desktop`。
2. `bootstrap.py` 按现有流程准备运行环境：
   - 查找/创建 `.venv`。
   - 在线时按需执行 `pip install -r requirements.txt`。
   - 检测 Claude CLI。
   - 只有缺 Claude CLI 且需要 npm 安装时，才检查/安装 Node/npm。
3. `server.py --desktop` 仍只绑定 `127.0.0.1`。

## Claude CLI 检测顺序

保持现有顺序：

1. 项目目录中的 `ccb.exe`。
2. 项目上级目录中的 `ccb.exe`。
3. `~/.ccb/npm-global` 中的 `claude`。
4. PATH 中的 `ccb`。
5. PATH 中的 `claude`。

## 打包命令

Windows 本地打包：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package-desktop.ps1
```

Shell 打包：

```bash
./scripts/package-desktop.sh
```

打包脚本不会准备 `runtime/`，也不会把 `runtime/` 复制进安装包。

## 验证清单

```bash
python -m py_compile server.py bootstrap.py bootstrap/*.py ccb_bridge.py
node --check desktop/electron/main.cjs
node --check desktop/electron-builder.config.cjs
```

打包后检查：

- `resources/cc-bridge/` 下有应用源码、`bootstrap/**`、`static/**`、`requirements.txt`。
- `resources/cc-bridge/` 下没有 `runtime/`。
- 安装包内没有 Python 解释器、Python site-packages、Node 或 Claude CLI。
- 首次启动时，如果用户环境缺少 Python 或 Claude CLI，应通过启动失败页或 CLI 检测 UI 提示用户自行安装。

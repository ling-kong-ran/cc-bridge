# 桌面包离线 Python 依赖

## 目标

桌面应用保持单一安装包，不再区分轻量包/全量包。打包时把本应用运行所需的 Python 第三方依赖放进安装包，启动时优先通过 `PYTHONPATH` 使用这些随包依赖，从而避免在用户机器上联网执行 `pip install -r requirements.txt`。

安装包不内置：

- Python 解释器：桌面端仍通过系统 `python` / `python3` 或 `CCB_DESKTOP_PYTHON` 启动 `bootstrap.py`。
- Node.js：只在开发/打包阶段需要；运行时只有在用户缺少 Claude CLI 且选择安装时才需要 npm。
- Claude Code CLI：继续保持原有逻辑，按本地 `ccb.exe`、上级 `ccb.exe`、`~/.ccb/npm-global`、PATH `ccb`、PATH `claude` 的顺序检测；缺失时仍可走原有安装入口。

> 这里解决的是 ccb-gui 自身 Python 依赖的离线可用性；Claude 账号认证、模型服务访问、远程 MCP 服务等能力仍取决于用户已有登录状态和实际网络/服务可达性。

## 打包资源目录

Electron `resources/cc-bridge/runtime/` 下放置随包 Python 依赖：

```text
resources/cc-bridge/
  bootstrap.py
  server.py
  bootstrap/**
  backend/**
  custom_tools/**
  static/**
  requirements.txt
  runtime/
    manifest.json
    python/               # pip --target 生成的第三方依赖目录
```

`runtime/manifest.json` 示例：

```json
{
  "bundled_python_deps": true,
  "pythonpath_relpaths": ["python"],
  "skip_python_install": true
}
```

字段说明：

- `bundled_python_deps`：标记当前包携带 Python 依赖。
- `pythonpath_relpaths`：相对 `runtime/` 的 Python 依赖目录列表，会注入 `PYTHONPATH`。
- `skip_python_install`：为 `true` 时，桌面模式跳过 `.venv` 创建和 `pip install`。

## 启动行为

1. Electron 仍调用系统 `python` / `python3` 或 `CCB_DESKTOP_PYTHON` 启动 `bootstrap.py --desktop`。
2. `bootstrap.py` 检测到 `runtime/manifest.json` 后：
   - 调用 `find_server_python(allow_install=False)`，只选择已有 Python，不创建 `.venv`，不执行 `pip install`。
   - 将 `runtime/python` 注入 `PYTHONPATH`。
   - 启动 `server.py --desktop`。
3. Claude CLI 继续保持原有检测/安装逻辑；只有缺 CLI 且需要安装时才要求 Node/npm。

## Node 运行时说明

运行 ccb-gui 本身不需要 Node。Node 主要用于：

- 开发阶段运行 Electron。
- 打包阶段运行 `electron-builder`。
- 用户机器缺少 Claude CLI 且选择自动安装时，通过 npm 安装 `@anthropic-ai/claude-code` 到 `~/.ccb/npm-global`。

因此安装包不需要打入 Node。若用户已经有 `ccb` / `claude` CLI，桌面应用运行时不会用到 Node。

## 打包命令

Windows 本地打包：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package-desktop.ps1
```

打包脚本会先执行：

```bash
python scripts/prepare-desktop-runtime.py
```

该脚本会用当前 `.venv` Python（没有则用当前 Python）执行：

```bash
python -m pip install -r requirements.txt --target runtime/python --upgrade
```

然后写入 `runtime/manifest.json`，再执行 Electron Builder。

如果只是复用已准备好的 `runtime/`，可以：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package-desktop.ps1 -SkipRuntime
```

## 验证清单

```bash
python -m py_compile server.py bootstrap.py bootstrap/*.py ccb_bridge.py scripts/prepare-desktop-runtime.py
node --check desktop/electron/main.cjs
node --check desktop/electron-builder.config.cjs
```

打包后检查：

- `resources/cc-bridge/runtime/manifest.json` 存在。
- `resources/cc-bridge/runtime/python/qrcode` 存在。
- `resources/cc-bridge/runtime/python/pywinauto` 存在（Windows）。
- `resources/cc-bridge/runtime` 下不存在 `node` 或 `claude` 目录。
- 断网启动时不执行 `pip install`。
- `/api/clis` 不出现 `resources/cc-bridge/runtime` 下的内置 Claude CLI 候选。

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

## 离线 runtime zip 分发

除了让用户自行准备 Python / Claude CLI，还支持「预配置 runtime 压缩包」离线分发：

### 制作压缩包

1. 在一台有网的机器上首次运行桌面端，bootstrap 会在 `CC Bridge Runtime/` 下生成 `venv/`（用 `--copies` 创建，可跨机器拷贝）和 `npm-global/`（含 claude CLI）。
2. 把整个 `CC Bridge Runtime/` 目录压缩成 `CC Bridge Runtime.zip`（zip 内可以是顶层 `CC Bridge Runtime/` 目录，也可以直接是 `venv/`、`npm-global/`，两种结构 bootstrap 都能识别）。

### 离线机器使用

1. 安装 CC Bridge。
2. 把 `CC Bridge Runtime.zip` 放到**安装目录同级**（即与 `CC Bridge Runtime/` 同级，例如 `D:\Programs\CC Bridge Runtime.zip`）。文件名必须正好是 `CC Bridge Runtime.zip`。
3. 启动桌面端。bootstrap 在准备运行时阶段会：
   - 检测到该 zip（按文件名触发，不做 hash 校验）；
   - 解压到 `CC Bridge Runtime/`；
   - 写入 `.unpacked_from`（zip 的 sha256，仅作「zip 是否变过」的判重），后续启动命中则跳过（幂等）。
4. 解压后 `venv/`、`npm-global/` 齐备，离线机器无需联网即可复用。

### 降级与容错

- zip 不存在：直接跳过，走原有的在线/离线检测流程。
- 解压过程异常：仅记日志，不阻断 bootstrap。
- zip 内容变化（sha256 变了）：会重新解压覆盖。

### 内置 Node 支持

若离线机器没有系统 Node，`npm-global/` 里的 claude 仍无法执行。此时可把 node 运行时随 runtime 一起分发：把 `node/` 目录放进 `CC Bridge Runtime/`（Windows 直接含 `node.exe`；macOS/Linux 含 `bin/node`），压进 `CC Bridge Runtime.zip`。解压后 `bootstrap/probe.py` 的 `bundled_node_dirs()` 会从内置 runtime（`CCB_BUNDLED_RUNTIME_ROOT`，即安装包内 `resources/cc-bridge/runtime/`）而非 CCB_HOME 读取——因此内置 node 需通过打包内置 runtime 提供，或确保离线机器 PATH 中有 node。


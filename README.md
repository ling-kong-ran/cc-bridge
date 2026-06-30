# CC Bridge

把本机 `ccb` / `claude` Claude Code CLI 包装成一个轻量、可视化、适合多端使用的 Web 控制台。

CC Bridge 保留 Claude Code CLI 的会话体系和流式输出能力，同时提供聊天界面、历史会话、附件、模型与 CLI 切换、Agents / Skills、远程目标、配置管理、项目记忆检索和多端观察者同步。

后端只使用 **Python 标准库**，前端是 **静态 HTML / CSS / Vanilla JavaScript**，不需要数据库、Web 框架或前端构建步骤。项目优先面向 Windows 本机使用，也可跨平台运行。

## 预览

### 桌面端

![桌面端预览](docs/preview-desktop.png)

### 移动端

![移动端预览](docs/preview-mobile.png)

## 功能

- **流式聊天**：通过 SSE 实时展示 Claude Code `stream-json` 输出、工具调用、思考块、错误和完成状态。
- **历史会话**：读取 GUI 会话索引和 Claude Code 原始 JSONL，会话可恢复、重命名、删除、置顶和切换工作目录。
- **多端观察者**：同一会话可被多个浏览器标签页或手机浏览器打开；观察者实时接收当前输出和状态变化。
- **运行设置**：支持 CLI、模型、权限模式、工作目录、远程目标、环境变量 profile 和自定义 Agents。
- **附件与文件上下文**：支持拖拽上传、目录浏览、文件搜索、上传文件预览和附件缓存。
- **Slash Commands / Skills / Agents**：从 CLI 初始化事件和本地配置中发现可用命令、skills、agents，并在输入框中快速选择。
- **远程目标**：Claude Code CLI 仍在本机运行；选择远程目标后，agent 通过 SSH / MCP 工具操作目标机器。
- **配置管理**：可在 GUI 中维护 Claude settings、env、MCP servers、GUI 偏好和自定义 agent 文件。
- **项目记忆检索**：为 Claude Code auto memory 文件建立本地索引，支持搜索、查看、创建、更新和删除。
- **费用与 Token 展示**：读取 CLI `result` 事件并按会话累计费用和 token 用量。

## 快速开始

### 前置条件

推荐使用平台启动脚本自动检测环境。直接运行 `python server.py` 时，需要手动准备：

- Python 3.10+
- 已安装并可用的 `claude` 或 `ccb` CLI
- 已完成 Claude Code 认证或 API Key 配置

### 启动

Windows：

```bat
start.bat
```

macOS / Linux：

```bash
chmod +x start.sh
./start.sh
```

已安装 Python 的任意系统也可以直接进入 bootstrap：

```bash
python bootstrap.py
# 或
python3 bootstrap.py
```

开发/已配置环境可直接启动服务：

```bash
python server.py
```

默认从 `17878` 端口启动。启动时会先清理当前应用遗留的旧服务进程；如果端口被其他应用占用，则自动递增到下一个可用端口。

终端会打印访问地址：

```text
[CC Bridge] Server running at http://127.0.0.1:17878
[CC Bridge] LAN access: http://192.168.x.x:17878
```

默认不会自动打开浏览器。如需启动后自动打开，先设置环境变量：

```bash
CCB_GUI_OPEN_BROWSER=1 python server.py
```

## Bootstrap / 自动环境准备设计

启动和依赖安装逻辑不放进 `server.py`。`server.py` 的职责保持为 Web / SSE / REST 服务；Python、Node/npm、Claude CLI 和虚拟环境准备由启动器与 bootstrap 层负责。

### 入口分层

```text
start.bat       # Windows 双击入口，只转调 start.ps1
start.ps1       # Windows PowerShell 入口，负责 Python 不存在时兜底安装
start.sh        # macOS / Linux 入口，负责 Python 不存在时兜底安装
bootstrap.py    # Python 已可运行后的跨平台统一入口
bootstrap/      # 检测、安装、venv、启动 server 的实现模块
```

`.bat` 不是跨平台入口，只服务 Windows。macOS / Linux 使用 `start.sh`；已经有 Python 的任意系统可以直接运行 `bootstrap.py`。

### 推荐目录

```text
bootstrap/
  __init__.py
  probe.py              # OS / Python / venv / Node / npm / claude / ccb 检测
  installer.py          # 跨平台安装调度与命令执行
  python_setup.py       # Python 检测、版本校验、系统安装器调用建议
  node_setup.py         # Node/npm 检测与安装
  claude_setup.py       # Claude Code CLI 检测与 npm 安装
  venv_setup.py         # .venv 创建与 venv Python 路径解析
  launcher.py           # 使用 .venv Python 启动 server.py
  state.py              # ~/.ccb/bootstrap_state.json 和 bootstrap.log
```

### 启动流程

```text
用户运行平台入口
  ↓
start.ps1 / start.sh 检测 Python
  ↓
没有 Python → 使用平台包管理器安装，或提示手动安装
  ↓
python bootstrap.py
  ↓
检测 / 创建项目 .venv
  ↓
检测 Node/npm
  ↓
没有 Node/npm → 使用 winget / brew / apt / dnf / pacman 安装
  ↓
检测 ccb / claude CLI
  ↓
没有 Claude CLI → 使用 npm 安装 @anthropic-ai/claude-code
  ↓
使用 .venv Python 启动 server.py
```

### Python 与 venv 策略

- Python 缺失时不能依赖 Python 代码处理，必须由 `start.ps1` / `start.sh` 兜底。
- Python 最低版本为 3.10。
- 项目内创建虚拟环境：`<repo>/.venv/`。
- 启动服务时优先使用 `.venv` 内的 Python：
  - Windows: `.venv/Scripts/python.exe server.py`
  - macOS / Linux: `.venv/bin/python server.py`
- 当前后端只用标准库，暂不需要安装 Python 依赖；如果以后加入 `requirements.txt`，由 bootstrap 层检测并安装。

### Node/npm 与 Claude CLI 策略

- Node/npm 只用于安装 Claude Code CLI，不用于前端构建。
- 检测顺序：`node --version`、`npm --version`。
- 安装器建议：
  - Windows: `winget install --id OpenJS.NodeJS.LTS -e`
  - macOS: `brew install node`
  - Debian/Ubuntu: `sudo apt install nodejs npm`
  - Fedora: `sudo dnf install nodejs npm`
  - Arch: `sudo pacman -S nodejs npm`
- Claude CLI 推荐安装到受控 prefix，避免污染全局 npm 或要求管理员权限：

```bash
npm install --prefix ~/.ccb/npm-global @anthropic-ai/claude-code
```

bootstrap 启动 `server.py` 前，把该 prefix 的 bin 目录加入当前进程 `PATH`。`ccb_bridge.py` 的 CLI 检测顺序应包含该位置：

```text
项目目录 ccb.exe → 上级目录 ccb.exe → ~/.ccb/npm-global 中的 claude → PATH 中 ccb → PATH 中 claude
```

### 自动安装确认

安装 Python / Node/npm / Claude CLI 属于会修改用户环境的操作。默认应在终端中提示确认；需要无人值守时使用：

```bash
CCB_BOOTSTRAP_ASSUME_YES=1 python bootstrap.py
# 或
python bootstrap.py --yes
```

### server.py 边界

`server.py` 不承载 bootstrap 细节。后续如果 GUI 需要展示环境状态或触发 CLI 安装，只允许做薄路由转发，例如：

```python
from bootstrap.probe import get_environment_status
from bootstrap.claude_setup import install_claude_cli
```

具体检测、安装、日志、状态持久化仍放在 `bootstrap/` 模块。

### 日志与状态

bootstrap 相关状态写入：

```text
~/.ccb/bootstrap.log
~/.ccb/bootstrap_state.json
```

记录 OS、Python、venv、Node/npm、Claude CLI 路径与版本，以及安装失败原因，方便排障。

## 使用说明

1. 打开终端打印的本机地址。
2. 在左侧会话列表中新建会话，或恢复已有会话。
3. 在运行设置中按需选择 CLI、模型、权限模式、工作目录、远程目标和 agent。
4. 输入 `/` 选择 slash command；输入 `@` 选择自定义 agent。
5. 拖拽文件到输入区，或使用附件按钮添加文件上下文。
6. 点击顶部 Session ID 可复制 `<cli> --resume <session-id>`，便于回到终端继续。
7. 在其他标签页或手机浏览器打开同一会话，可实时观察当前输出。

## 远程目标不是远程会话

“远程目标”只表示 agent 的操作对象在另一台机器上。Claude Code CLI 和 CC Bridge 服务仍运行在本机；远程能力通过 SSH / MCP 工具暴露给 agent。

这意味着：

- 会话、CLI 进程、浏览器 UI 都在本机管理。
- 远程机器只需要 SSH 访问能力，不需要运行 CC Bridge。
- 默认远程工具只读；写入能力需要在目标配置中显式开启。

## 架构概览

```text
browser
  │
  ├─ HTTP / REST ──> server.py
  └─ SSE <────────── server.py
                       │
                       └─ ccb_bridge.py ──> ccb / claude CLI
```

- `server.py`：手写 HTTP / REST / SSE 服务，处理静态资源、上传、配置、会话 API、事件广播和端口启动逻辑。
- `ccb_bridge.py`：检测并启动 `ccb` / `claude` CLI，解析 `stream-json` 输出，管理持久进程、一次性进程、观察者和 session id 捕获。
- `session_store.py`：保存 GUI 会话索引、标题、累计费用、token、CWD，并读取 Claude Code 原始 JSONL 历史。
- `config_manager.py`：读写 Claude settings、GUI 偏好、env、MCP、skills 和 agents。
- `static/`：无构建前端，包含页面结构、样式、交互逻辑和中英文 i18n 文案。

## 数据位置

| 内容 | 位置 |
|------|------|
| GUI 偏好 | `~/.ccb/gui_settings.json` |
| 环境变量 profiles | `~/.ccb/env_profiles.json` |
| 远程目标配置 | `~/.ccb/remote_targets.json` |
| 远程目标私钥 | `~/.ccb/keys/` |
| 远程 MCP 临时配置 | `~/.ccb/mcp/` |
| 远程操作审计日志 | `~/.ccb/remote_audit.log` |
| 项目记忆索引 | `~/.ccb/memory_index/` |
| GUI 会话索引 | `~/.claude/gui_sessions.json` |
| GUI 隐藏会话 | `~/.claude/gui_hidden_sessions.json` |
| Claude settings / env / MCP | `~/.claude/settings.json` |
| 全局 skills | `~/.claude/skills/*/SKILL.md` |
| 全局 agents | `~/.claude/agents/*.md` |
| 项目 agents | `<工作目录>/.claude/agents/*.md` |
| Claude Code 原始会话 | `~/.claude/projects/<sanitized-cwd>/*.jsonl` |
| auto memory 文件 | `~/.claude/projects/<sanitized-cwd>/memory/*.md` |
| 附件缓存 | `<工作目录>/.gui-uploads/`，失败时回退到 `uploads/` |

## 开发说明

本项目没有构建步骤。修改后通常这样验证：

```bash
python -m py_compile server.py ccb_bridge.py config_manager.py session_store.py
python server.py
```

然后在浏览器中手动验证 UI、会话恢复、流式输出和相关功能。

用于截图或局部测试时，可以从 Python 中调用 `server.run_server(port, cleanup_old_servers=False)` 启动独立测试端口，避免触发默认的旧服务清理逻辑。

## License

MIT

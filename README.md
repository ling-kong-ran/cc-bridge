# CC Bridge

把本机 `ccb` / `claude` Claude Code CLI 包装成一个轻量、可视化、适合多端使用的 Web 控制台。

CC Bridge 保留 Claude Code CLI 的会话体系和流式输出能力，同时提供聊天界面、历史会话、附件、模型与 CLI 切换、Agents / Skills、远程目标、配置管理、项目记忆检索和多端观察者同步。

后端只使用 **Python 标准库**，前端是 **静态 HTML / CSS / Vanilla JavaScript**，不需要数据库、Web 框架、npm 或构建步骤。项目优先面向 Windows 本机使用，也可通过 `python server.py` 跨平台运行。

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

- Python 3.10+
- 已安装并可用的 `claude` 或 `ccb` CLI
- 已完成 Claude Code 认证或 API Key 配置

### 启动

Windows：

```bat
start.bat
```

跨平台：

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

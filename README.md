# CC Bridge Client

> 把 Claude Code CLI 变成一个更顺手、更可视、更适合日常工作的本地控制台。

CC Bridge 是一个轻量级 Client，用浏览器桥接 `ccb` / `claude` CLI：保留 Claude Code 的能力与会话体系，同时补上流式界面、历史会话、附件、模型/CLI 切换、远程诊断和更清晰的运行状态。

服务端只使用 **Python 标准库**，前端是 **静态 HTML / CSS / Vanilla JavaScript**，没有数据库、没有构建步骤、没有 Web 框架。下载后即可启动，特别适合 Windows 本机使用。

![界面预览](docs/preview.png)

---

## 为什么值得一试

- **像聊天软件一样使用 Claude Code**：SSE 实时流式输出，代码块、工具调用、思考块都清楚展示。
- **会话不再散落终端里**：按工作目录分组历史会话，支持恢复、删除、重命名和继续上下文。
- **运行信息一眼看懂**：顶部直接显示会话 ID、当前模型、正在调用的 CLI；会话 ID 可一键复制 `--resume` 命令。
- **侧栏可折叠，专注对话**：活跃会话中可收起左侧栏，累计费用、Token、连接状态会迁移到顶部状态区。
- **@提及自定义 Agent**：输入 `@agent名` 即可在消息中启用自定义 Agent，支持全局和项目级 Agent 定义。
- **会话共享 / 观察者模式**：同一会话可被多个前端标签页实时查看流式回复；只有消息发起者可以停止，观察者只能看不能动。
- **文件上下文更顺滑**：支持上传、拖拽、目录浏览、文件搜索和附件预览。
- **远程机器也能排查**：可配置 SSH 远程目标，让 agent 通过 MCP 工具查看无 Claude 环境的 Linux 机器日志和状态。
- **自动检查更新**：启动时可自动检查远端更新，也可在设置页手动检查；无更新、检查中、检查失败都会在按钮右侧即时提示。
- **零重依赖**：Python 标准库 + 静态前端，直接跑 `python server.py`。

---

## 功能特性

### 会话与对话

- **流式对话**：通过 SSE 实时展示 CLI 的 `stream-json` 输出。
- **会话恢复**：支持新建、恢复、中断后继续补充，以及删除历史会话。
- **按工作目录收纳会话**：历史会话按工作目录分组折叠，适合会话数量较多时使用。
- **会话元信息**：顶部展示 Session ID、当前模型和当前 CLI。
- **复制恢复命令**：点击 Session ID 复制 `<cli> --resume <session-id>`，方便回到终端继续。
- **会话费用累计**：读取 CLI 单轮返回费用，并按会话持久化累计费用。
- **Token 使用展示**：展示当前会话累计 Token，用于快速感知上下文消耗。
- **Markdown 展示**：支持基础 Markdown、代码块、工具调用卡片和思考块折叠。

### 工作流与上下文

- **工作目录切换**：可为会话选择工作目录，工具调用在对应目录下执行。
- **文件附件**：支持按钮选择、输入框拖拽上传，内置文件选择器可搜索当前目录及子目录中的文件。
- **动态斜杠菜单**：从 CLI `stream-json` 初始化事件读取 slash commands，支持输入 `/` 后搜索选择。
- **快捷键帮助**：内置快捷键帮助面板，快速查看常用操作。
- **会话导出**：支持将当前对话复制为 Markdown。

### Agent 与成员协作

- **@提及自定义 Agent**：在消息中输入 `@agent名` 即可为该轮对话添加自定义 Agent，从 `~/.claude/agents/` 和 `<workdir>/.claude/agents/` 自动发现。
- **观察者模式**：当某会话正在生成回复时，其他前端标签页进入同一会话会自动成为观察者，实时查看流式输出但无法发送消息或停止。
- **成员面板**：点击右下角浮动按钮展开侧栏，查看当前会话启用的 Agent 列表，支持添加/移除。

### CLI、模型与设置

- **模型与 CLI 选择**：自动检测本地 `ccb.exe`、PATH 中的 `ccb` / `claude`，模型列表来自 Claude 配置。
- **会话中切换模型**：新建或恢复的会话都可以调整模型，下一条消息会使用当前选择的模型继续同一会话。
- **运行设置折叠面板**：命令行工具、模型、跳过权限确认放在侧栏折叠面板中，减少对会话列表空间的占用。
- **界面设置持久化**：支持亮暗主题、中文/英文、字体大小设置，并保存到用户目录。
- **自动更新检查**：支持启动时自动检查更新，设置页也可手动检查；按钮右侧会显示检查中、已是最新版本或检查失败等状态。
- **外部配置自动刷新**：浏览器页面重新获得焦点或从后台切回前台时，会重新读取本机 CLI、模型、环境变量和 slash commands。

### 远程诊断

- **远程目标管理**：支持配置远程机器连接信息，用于排查不方便安装 Claude 的目标机。
- **MCP 远程桥接**：通过 `remote_bridge.py` 暴露远程工具，让 CLI 可以显式调用 `mcp__remote__*` 工具。
- **只读优先**：默认远程工具用于查看日志、列目录、读文件、采集系统信息等诊断动作。
- **写入受控**：远程变更能力需要显式开启，避免误操作目标机器。

---

## 快速开始

### 前置条件

- Python 3.10+
- 已安装并可用的 `claude` 或 `ccb` CLI
- 已配置 Claude Code 所需认证或 API Key

### 启动

Windows：

```bat
start.bat
```

跨平台：

```bash
python server.py
```

服务默认从 `17878` 端口启动；如果该端口被占用，会自动递增尝试下一个端口。启动后会打印本机访问地址，例如：

```text
[CC Bridge] Server running at http://127.0.0.1:17878
```

打开浏览器访问该地址即可。

---

## 使用方式

1. 在侧栏确认工作目录。
2. 如需调整 CLI、模型或权限模式，展开侧栏的”运行设置”。
3. 点击”新建会话”后开始输入消息。
4. 输入 `/` 可打开 slash command 面板；输入 `@` 可搜索选择自定义 Agent。
5. 点击历史会话可恢复上下文并继续对话。
6. 活跃会话中可点击顶部左侧按钮折叠侧栏，专注当前对话。
7. 点击顶部 Session ID 可复制 CLI 恢复命令。
8. 在设置页可开启启动时自动检查更新，或点击”检查更新”手动查看当前版本状态。
9. 右下角浮动按钮可展开会话成员面板，管理当前启用的 Agent。

说明：

- `/compact` 等出现在 CLI 初始化元数据中的命令可以在 GUI 中选择并发送。
- 终端 TUI 自己实现的本地命令不一定会出现在 `stream-json` 元数据中，例如部分版本里的 `/clear`。这类命令不保证在 GUI 中可用。
- “中断”只停止当前生成，保留会话状态，便于继续补充。
- 恢复历史会话后仍可在“运行设置”中切换模型，GUI 会在下一条消息发送时带上新的模型参数并通过 `--resume` 继续原会话。
- 如果在外部修改了 `~/.claude/settings.json` 或切换了本机 CLI，回到 GUI 页面时会自动重新加载相关配置。

---

## 配置与持久化

| 内容 | 位置 |
|------|------|
| GUI 偏好设置（主题、语言、字体大小） | `~/.ccb/gui_settings.json` |
| 远程目标配置 | `~/.ccb/remote_targets.json` |
| GUI 会话索引与费用累计 | `~/.claude/gui_sessions.json` |
| Claude 全局设置与环境变量 | `~/.claude/settings.json` |
| 全局自定义 Agent 定义 | `~/.claude/agents/*.md` |
| 项目级自定义 Agent 定义 | `<工作目录>/.claude/agents/*.md` |
| 全局自定义 Skill 定义 | `~/.claude/skills/*/SKILL.md` |
| Claude Code 原始会话 JSONL | `~/.claude/projects/.../*.jsonl` |
| 工作目录附件缓存 | `<工作目录>/.gui-uploads/` |

语言文案位于：

```text
static/i18n/en.json
static/i18n/zh.json
```

两份文件使用同一组 key。页面通过 `data-i18n`、`data-i18n-placeholder`、`data-i18n-title` 读取当前语言对应的 value。

---

## 桌面打包

CC Bridge 支持打包为 **Windows / macOS / Linux 桌面安装程序**，使用 **Tauri v2** 作为桌面壳 + **PyInstaller** 将 Python 后端编译为独立可执行文件。

### 打包原理

```
桌面应用 (.exe / .app / AppImage)
  └── Tauri Shell (Rust, ~5.6 MB)
       ├── WebView 内嵌 GUI 前端 (static/)
       └── Python Sidecar 子进程 (PyInstaller → server.exe, ~14 MB)
            └── server.py --sidecar
                 └── ccb/claude CLI 子进程
```

Tauri 负责窗口管理、系统托盘、自动更新；Python 侧载进程在后台启动 HTTP 服务并回传端口号，WebView 连接到 `http://127.0.0.1:<port>` 加载界面。

### 构建前准备

| 工具 | 用途 | 安装方式 |
|------|------|----------|
| Rust 1.84+ | 编译 Tauri 桌面壳 | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Node.js 20+ | Tauri CLI (npm) | [nodejs.org](https://nodejs.org/) |
| Python 3.11+ | PyInstaller 打包 & 服务端运行 | [python.org](https://python.org/) |

### 开发模式（热重载）

```bash
# 终端 1：启动 Python 服务端（与平时一样）
python server.py

# 终端 2：启动 Tauri 开发模式（连接到上面的服务端）
cd desktop
npm install          # 首次运行
npx tauri dev
```

### 生产构建

```bash
cd desktop

# 步骤 1：将 Python 服务端编译为独立可执行文件
npm run build:python
# 等价于：
# python -m PyInstaller build/pyinstaller.spec \
#   --distpath src-tauri/binaries/server \
#   --workpath build/pyinstaller-work \
#   --clean --noconfirm

# 步骤 2：构建 Tauri 桌面安装包
npm run build:all
# 等价于：npm run build:python && npx tauri build
```

构建产物位置：

| 平台 | 产物 |
|------|------|
| Windows | `src-tauri/target/release/bundle/msi/*.msi` + `nsis/*.exe` |
| macOS | `src-tauri/target/release/bundle/dmg/*.dmg` |
| Linux | `src-tauri/target/release/bundle/deb/*.deb` + `appimage/*.AppImage` |

### 关键配置

| 文件 | 作用 |
|------|------|
| `desktop/build/pyinstaller.spec` | 指定 `server.py` 入口 + `static/` 数据目录 + hidden imports |
| `desktop/src-tauri/tauri.conf.json` | 应用名/版本/图标路径、updater 公钥和更新端点 URL |
| `desktop/src-tauri/capabilities/default.json` | 授予 Tauri updater/窗口操作的权限 |

### 注意事项

- **PyInstaller 需要对应平台执行**：Windows 只能在 Windows 上交叉编译 `.exe`；CI 流程会在三平台分别构建。
- **Windows 需要 WebView2**：Win10+ 已预装；Win7/8 需手动安装。
- **macOS 需要签名**：未签名的 `.dmg` 需用户在「安全性与隐私」中允许打开。
- **Linux 需要 `libwebkit2gtk-4.1-dev`**：`sudo apt install libwebkit2gtk-4.1-dev`。

---

## 目录结构

```text
cc-bridge/
├── .gitignore                       # 过滤缓存、构建产物、本地配置
├── .github/
│   └── workflows/
│       └── desktop-release.yml      # CI: tag 推送自动构建桌面安装包+发布
├── server.py                        # HTTP 静态服务、REST API、SSE
├── ccb_bridge.py                    # CLI 子进程管理与 stream-json 解析
├── remote_bridge.py                 # MCP 远程工具桥接服务
├── remote_manager.py                # 远程目标配置、连接测试与 MCP 配置生成
├── config_manager.py                # Claude 配置、GUI 偏好、Agent 定义读写
├── session_store.py                 # 会话索引、标题、CWD更新、费用累计与历史读取
├── memory_index.py                  # 项目记忆索引与搜索
├── start.bat                        # Windows 启动脚本
├── static/
│   ├── index.html                   # 页面结构
│   ├── app.js                       # 前端逻辑
│   ├── style.css                    # 样式
│   └── i18n/
│       ├── en.json                  # 英文文案
│       └── zh.json                  # 中文文案
├── desktop/                         # 桌面端封装（Tauri + PyInstaller）
│   ├── README.md                    # 桌面端开发/构建说明
│   ├── package.json                 # Tauri CLI (npm)
│   ├── build/
│   │   ├── pyinstaller.spec         # PyInstaller 打包规格（server.py → .exe）
│   │   └── desktop.iss              # Inno Setup 安装程序脚本（备选）
│   └── src-tauri/
│       ├── Cargo.toml               # Rust 依赖（tauri + updater）
│       ├── build.rs                 # Tauri 构建钩子
│       ├── tauri.conf.json          # 应用元数据、资源路径、更新端点
│       ├── capabilities/
│       │   └── default.json         # 权限声明（窗口、更新器）
│       ├── icons/                   # 应用图标（多分辨率）
│       └── src/
│           ├── main.rs              # Rust 入口 + 侧载进程启动/关闭
│           └── lib.rs               # 侧载解析/窗口管理/自动更新
└── README.md
```

---

## API 概览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 主页面 |
| GET | `/sse?id=...` | SSE 事件流 |
| POST | `/api/action` | 会话动作：`new_session`、`resume_session`、`send_message`、`interrupt`、`stop` |
| POST | `/api/upload` | 上传附件到工作目录 `.gui-uploads/` |
| GET | `/api/settings` | 读取 Claude settings |
| POST | `/api/settings` | 保存 Claude settings |
| GET | `/api/gui-settings` | 读取 GUI 偏好 |
| POST | `/api/gui-settings` | 合并保存 GUI 偏好 |
| GET | `/api/env` | 读取环境变量配置 |
| POST | `/api/env` | 保存环境变量配置 |
| GET | `/api/skills` | 列出本地 skills |
| GET | `/api/agents` | 列出本地 agents |
| GET | `/api/models` | 从 Claude 配置读取模型列表 |
| GET | `/api/slash-commands` | 从 CLI 初始化事件读取 slash commands |
| GET | `/api/session/agents` | 读取当前会话的 agent 列表 |
| POST | `/api/session/agents` | 设置当前会话的 agent 列表 |
| GET | `/api/clis` | 检测可用 CLI |
| POST | `/api/clis` | 切换当前 CLI |
| GET | `/api/check-update` | 检查 `origin/master` 是否有更新 |
| POST | `/api/update` | 拉取更新 |
| POST | `/api/restart` | 重启本地服务进程 |
| GET | `/api/default-cwd` | 获取默认工作目录 |
| GET | `/api/sessions` | 列出历史会话 |
| POST | `/api/sessions/history` | 读取指定会话历史 |
| POST | `/api/sessions/delete` | 删除会话索引 |
| POST | `/api/sessions/rename` | 重命名会话标题 |
| POST | `/api/sessions/update-cwd` | 更新会话工作目录 |
| GET | `/api/file?path=...` | 预览允许范围内的上传文件 |
| POST | `/api/browse` | 浏览目录，仅返回子目录 |
| POST | `/api/browse-files` | 浏览目录，返回文件和子目录 |
| POST | `/api/search-files` | 搜索当前目录及子目录中的文件 |
| GET | `/api/remote-targets` | 列出远程目标 |
| POST | `/api/remote-targets` | 保存远程目标 |
| POST | `/api/remote-targets/delete` | 删除远程目标 |
| POST | `/api/remote-targets/test` | 测试远程连接 |
| POST | `/api/remote-files/list` | 浏览远程文件 |
| POST | `/api/remote-files/cache` | 缓存远程文件为附件 |

---

## 技术说明

- **零 Web 框架依赖**：HTTP、SSE、静态文件和 multipart 处理基于 Python 标准库实现。
- **SSE 通信**：浏览器通过 EventSource 接收服务端事件，避免额外 WebSocket 依赖。
- **CLI 子进程模型**：每次发送消息启动一次 `ccb` / `claude -p --output-format stream-json`，通过 `--resume` 关联多轮会话。
- **动态模型列表**：从 `~/.claude/settings.json` 的环境变量配置中提取模型值，避免历史会话污染模型下拉框。
- **动态 slash command**：短生命周期启动 CLI，读取 `system/init` 事件中的 `slash_commands`、`skills`、`agents` 后缓存。
- **自定义 Agent 注入**：从 `@mention` 提取 agent 名，从全局和项目级 `.md` 文件加载定义，通过 `--agents <json>` 标志传给 CLI。
- **多观察者 SSE 广播**：每个会话维护一个 owner 和多个 viewer 回调；`_emit_event` 将事件同时推送给 owner 和所有 viewer 的 SSE 队列。
- **消息所有权**：服务端追踪 `_message_owner_id`，只有发送者可以 `interrupt`/`stop`；viewer 的 stop 请求会被拒绝。
- **标签页隔离**：使用 `sessionStorage` 为每个标签页分配独立 clientId，避免跨标签页 SSE 队列冲突。
- **焦点刷新配置**：监听页面 `focus` 和 `visibilitychange` 事件，节流后重新加载 CLI 列表、模型列表、Claude settings，并刷新 slash command 缓存。
- **费用与 Token 累计**：读取 CLI `result` 事件，将每轮费用和 Token 使用量展示到 UI，并持久化会话费用。
- **远程桥接**：为绑定远程目标的会话生成 MCP 配置，CLI 通过 `remote_bridge.py` 操作远程机器。
- **主题与界面偏好**：GUI 偏好保存在 `~/.ccb/gui_settings.json`，重启服务后仍生效。

---

## License

MIT

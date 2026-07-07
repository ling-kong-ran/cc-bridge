# Bootstrap 边界

CC Bridge 把启动环境准备和 Web 服务运行分离。`server.py` 只负责 HTTP、REST、SSE 和 CLI 会话编排，不负责安装 Python、Node、npm 或 Claude Code CLI。

## 入口分层

```text
start.bat       # Windows 双击入口，薄包装
start.ps1       # Windows Python 缺失兜底，然后调用 bootstrap.py
start.sh        # macOS/Linux Python 缺失兜底，然后调用 bootstrap.py
bootstrap.py    # Python 可运行后的跨平台 bootstrap 入口
bootstrap/      # 环境探测、安装提示、venv、Node、Claude CLI、启动 server
server.py       # Web/SSE/REST 服务本体
```

Python 不存在时不能依赖 Python 代码自举，因此 Python 缺失兜底必须留在 `start.ps1` / `start.sh`。

## bootstrap.py 职责

`bootstrap.py` 的流程：

1. 检查 Python 版本。
2. 探测当前环境并写入状态文件。
3. `--status` 模式只输出状态，不启动服务。
4. 找到或创建用于运行服务的 Python。
5. 确保 Node/npm 可用。
6. 确保 Claude Code CLI 可用。
7. 再次写入环境状态。
8. 启动 `server.py`。

支持参数：

- `--yes`：自动确认安装操作。
- `--status`：仅探测环境并写状态。
- `--desktop`：桌面模式启动，不打开外部浏览器。

## 受控 Claude CLI 安装

优先把 Claude Code CLI 安装到受控 npm prefix，而不是全局 npm：

```bash
npm install --prefix ~/.ccb/npm-global @anthropic-ai/claude-code
```

服务启动环境会把该 prefix 的 bin 目录放到 `PATH` 最前，避免依赖用户全局 npm 状态。

## CLI 检测顺序

CLI 检测顺序必须与运行时保持一致：

1. 仓库目录下的 `ccb.exe`。
2. 仓库父目录下的 `ccb.exe`。
3. `~/.ccb/npm-global` 下的 `claude`。
4. PATH 中的 `ccb`。
5. PATH 中的 `claude`。

`bootstrap/probe.py` 负责探测；`ccb_bridge.py` 负责实际运行时选择和切换。

## 状态与日志

bootstrap 状态写入：

```text
~/.ccb/bootstrap_state.json
```

bootstrap 日志写入：

```text
~/.ccb/bootstrap.log
```

这些文件用于诊断用户机器上的环境问题，不属于项目仓库内容。

## server.py 边界

`server.py` 可以做：

- 解析 HTTP 请求。
- 提供静态文件、REST API、SSE。
- 调用 `ccb_bridge.py` 管理 CLI 会话。
- 返回清晰的 JSON 错误。
- 在启动时选择监听端口、打开浏览器。

`server.py` 不应做：

- 安装 Python。
- 安装 Node/npm。
- 安装 Claude Code CLI。
- 创建或管理项目 `.venv`。
- 写 bootstrap 状态文件。
- 包含平台包管理器逻辑。

## 安装交互原则

安装动作默认应是交互式，避免未经用户确认修改系统环境。无人值守模式由以下方式显式开启：

```text
CCB_BOOTSTRAP_ASSUME_YES=1
bootstrap.py --yes
```

## 迁移注意事项

- 新增环境准备逻辑时，应放入 `bootstrap/`，不要放进 `server.py`。
- 修改 CLI 安装位置时，要同步 `bootstrap/probe.py`、`bootstrap/claude_setup.py` 和 `ccb_bridge.py` 的检测逻辑。
- 修改桌面模式时，要同时检查 `bootstrap/launcher.py` 和 `server.py --desktop` 行为。
- `python bootstrap.py --status` 应保持无副作用，只做探测和状态记录。

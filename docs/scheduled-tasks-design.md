# 定时任务功能设计

## 功能定位

新增一个 **定时任务 / Scheduled Tasks** 功能，用来创建周期性 agent 任务，例如：

- 每 10 分钟检查一次项目状态
- 每天 09:00 总结某个目录的变更
- 每小时运行一次指定 prompt
- 每天固定时间执行 `/review`、`/memory`、`/compact` 等命令

任务本质上是：

```text
在某个 cwd / model / cli / remote target 下，按计划向 Claude Code 发送一条 prompt
```

结合 cc-bridge 当前架构，建议实现成：

```text
本地持久化任务 + server 内 asyncio 调度器 + 复用现有 send_message 会话管线
```

---

## 后端设计

### 1. 新增 `scheduled_task_store.py`

持久化到：

```text
~/.ccb/cron_jobs.json
```

数据结构建议：

```json
{
  "tasks": [
    {
      "id": "uuid",
      "name": "每日代码审查",
      "enabled": true,
      "schedule": {
        "type": "interval",
        "every_seconds": 3600
      },
      "repeat": true,
      "prompt": "检查当前项目是否有需要关注的问题",
      "cwd": "E:/code/cc-bridge",
      "model": "claude-sonnet-4-6",
      "cli": "claude",
      "remote_target_id": "",
      "allow_remote_mutate": false,
      "skip_permissions": true,
      "session_id": "",
      "created_at": 1710000000,
      "updated_at": 1710000000,
      "last_run_at": null,
      "next_run_at": 1710003600,
      "last_status": "idle",
      "last_error": "",
      "run_count": 0
    }
  ]
}
```

第一版只支持三类 schedule：

```json
{ "type": "interval", "every_seconds": 600 }
```

```json
{ "type": "daily", "time": "09:30" }
```

```json
{ "type": "once", "run_at": 1710003600 }
```

`once` 任务执行完成后自动置为 disabled，保留运行记录和会话入口。

先不做完整 cron 表达式，避免 UI 和解析复杂化。Hermes 依赖 croniter 支持 cron 表达式，但 cc-bridge 需要保持纯标准库。

---

### 2. 新增 `scheduled_task_runner.py`

职责：

- server 启动时加载任务
- 计算 `next_run_at`
- 后台 `asyncio.create_task()` 循环检查 due tasks
- 任务到点后执行
- 更新状态并通过 SSE 通知前端

核心对象：

```python
class ScheduledTaskRunner:
    def __init__(self, session_manager):
        self.session_manager = session_manager
        self._task = None
        self._running_task_ids = set()

    async def start(self):
        ...

    async def stop(self):
        ...

    async def tick(self):
        ...

    async def run_task(self, task):
        ...
```

不要为每个任务长期保持一个 CLI 进程。沿用项目现有原则：**一条消息一个 subprocess，通过 `--resume` 保持上下文**。

当前发送入口在 `server.py` 的 `send_message` 分支，建议抽一个内部 helper，避免定时任务复制整段逻辑。

建议抽成：

```python
async def send_prompt_to_session(
    client_id: str,
    content: str,
    model: str,
    cwd: str,
    cli: str,
    resume_id: str = "",
    remote_target_id: str = "",
    allow_remote_mutate: bool = False,
    skip_permissions: bool = True,
    source: str = "user",
):
    ...
```

然后：

- 普通聊天继续调用它
- 定时任务也调用它
- 定时任务使用虚拟 client id：

```python
client_id = f"scheduled:{task_id}"
```

---

## 任务执行策略

每次任务运行：

1. 检查 `enabled`
2. 检查是否已有同任务运行中
3. 如果任务还没有 `session_id`：
   - 创建新 session
   - 首次 prompt 后捕获真实 `session_id`
   - 写回任务
4. 如果已有 `session_id`：
   - 使用 `resume_id`
   - 把结果接到原定时任务会话
5. 运行结束后：
   - 更新 `last_run_at`
   - 更新 `next_run_at`
   - 更新 `last_status`
   - 更新 `run_count`
   - `once` 任务自动置为 disabled
   - 推送 SSE：`scheduled_task_updated`

这样每个定时任务都可以形成自己的持续会话历史，用户点进去能看到历次执行上下文。

---

## API 设计

新增 REST：

```text
GET    /api/scheduled-tasks
POST   /api/scheduled-tasks
POST   /api/scheduled-tasks/update
POST   /api/scheduled-tasks/delete
POST   /api/scheduled-tasks/run-now
POST   /api/scheduled-tasks/toggle
```

示例：

```json
POST /api/scheduled-tasks/run-now
{
  "id": "task-id"
}
```

返回：

```json
{
  "ok": true
}
```

SSE 事件：

```text
scheduled_task_started
scheduled_task_updated
scheduled_task_finished
scheduled_task_error
```

前端收到后刷新任务列表即可。

---

## 前端设计

入口建议放在左侧导航，和现在的：

- 对话
- 资产
- 配置

并列新增：

```text
任务
```

页面结构：

```text
定时任务
 ├─ 新建任务
 ├─ 任务列表
 │   ├─ 名称
 │   ├─ 周期
 │   ├─ 下次运行
 │   ├─ 上次状态
 │   ├─ 启用/停用
 │   ├─ 立即运行
 │   ├─ 编辑
 │   └─ 删除
```

编辑表单字段：

- 名称
- Prompt
- 工作目录 cwd
- model
- cli
- remote target
- 是否允许远程写入
- 调度类型：
  - 一次性运行
  - 每隔 N 分钟 / 小时
  - 每天 HH:mm
- 是否启用
- 是否复用同一个会话

建议默认：

```text
复用同一个会话：开启
```

因为这更像 Hermes 的 agent task 逻辑：同一个任务有连续上下文。

---

## 和现有会话系统的关系

定时任务运行后，如果生成了 session_id，需要调用现有：

```python
save_session(...)
```

这样它会自然出现在历史会话里。

建议标题格式：

```text
[定时任务] 每日代码审查
```

任务会话被用户手动打开后，只是普通历史会话；如果用户继续发送消息，可以接管这条会话。

Hermes 会把每次运行输出额外保存为 markdown 文件。cc-bridge 第一版不需要单独保存运行输出，直接复用现有 session history、成本统计和资产提取即可，避免引入第二套记录体系。

---

## 冲突与安全策略

### 1. 防止重复执行

同一个 task 同时只能跑一个实例：

```python
running_task_ids: set[str]
```

如果上一次还没结束，下一次到点：

- 默认跳过
- 更新状态为 `skipped_running`

不要排队堆积，避免失控。

### 2. 权限

默认使用：

```python
skip_permissions = true
```

但 UI 要明确显示。

远程写入 `allow_remote_mutate` 默认 false。

### 3. LAN 访问

定时任务是 server 本地后台行为，不应该受某个浏览器 client IP 绑定影响。

所以它不要调用 `is_cli_access_allowed()` 这类面向 HTTP client 的校验，而是在创建任务时校验一次请求来源即可。

### 4. 失败记录

失败时记录：

```json
"last_status": "error",
"last_error": "...",
"next_run_at": ...
```

不要因为一次失败自动禁用任务，除非连续失败次数达到阈值。第一版可以不做阈值。

### 5. 防止递归创建任务

定时任务执行期间不向 agent 暴露创建、修改定时任务的能力，避免任务自我复制或递归调度。未来如果增加 agent 创建定时任务工具，必须走显式用户确认，不能在后台自动创建。

---

## 推荐落地顺序

1. `scheduled_task_store.py`
   - list/create/update/delete
   - calculate_next_run

2. `scheduled_task_runner.py`
   - server 启动时 start
   - 到点执行 prompt
   - SSE 推状态

3. `server.py`
   - 抽出可复用的内部发送 helper
   - 加 `/api/scheduled-tasks*` 路由

4. 前端
   - 新增任务页面
   - 新建/编辑弹窗
   - 立即运行/启停/删除
   - SSE 更新状态

5. 历史会话打通
   - 定时任务 session 保存到现有历史
   - 点击任务的 “查看会话” 可跳转 resume

---

## MVP 范围

第一版只做：

- interval
- daily time
- once 一次性任务
- enable/disable
- run now
- reuse same session
- 查看最近状态
- 任务结果进入历史会话

先不要做：

- 完整 cron 表达式
- 多步骤 workflow
- 复杂重试策略
- 任务依赖
- 并发队列
- UI 日历视图

这样最贴合当前项目：轻量、本地、无第三方依赖，也符合现有 `server.py -> ccb_bridge.py -> CLI` 的架构。

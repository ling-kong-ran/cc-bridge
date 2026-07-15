# Agent 工作流编排设计方案

## 1. 功能定位

Agent 工作流编排用于把一次复杂任务拆成可视化、可追踪、可恢复的多节点流程。它不是替代现有聊天会话，而是在 cc-bridge 现有 `server.py → ccb_bridge.py → Claude Code CLI` 管线之上增加一层“流程执行器”。

典型使用场景：

- 自动执行“需求分析 → 代码修改 → 测试 → 总结”的工程任务
- 周期性巡检项目，并按条件触发修复或报告
- 多 agent 分工：研究、实现、审查、测试、安全检查
- 高风险动作前暂停，等待人工审批
- 将常用工作流模板化，例如 PR review、重构、发布前检查

第一版目标：

```text
可视化定义流程 → 后端执行流程 → SSE 实时推送节点状态 → 支持暂停/继续/取消 → 保存运行记录
```

---

## 2. 设计原则

1. **复用现有能力**
   - 复用 `SessionManager` / `CCBSession` 发送 prompt。
   - 复用现有 SSE 事件通道。
   - 复用 session_store 保存会话关联。

2. **先做轻量 DAG，不做完整 BPMN**
   - 节点 + 边 + 条件表达式即可。
   - 第一版避免复杂并发 join、补偿事务、子流程嵌套。

3. **高风险动作必须显式审批**
   - git push、发消息、发布、删除、远程变更等节点默认需要 approval。
   - approval 节点暂停执行，等待用户确认。

4. **上下文隔离优先**
   - 默认每个 agent 节点使用独立会话。
   - 需要连续上下文时通过 `input_mapping` 显式传递上游摘要或产物。

5. **运行记录可回放**
   - 保存每个节点输入、输出摘要、状态、耗时、关联 session_id。
   - 大文本输出只保存摘要和 artifact 引用。

---

## 3. 概念模型

### 3.1 Workflow Definition

工作流定义是用户编辑和复用的模板。

```json
{
  "id": "wf-code-review",
  "name": "代码审查工作流",
  "description": "检查当前改动、运行测试并生成审查报告",
  "version": 1,
  "enabled": true,
  "variables": {
    "cwd": "E:/code/cc-bridge",
    "model": "claude-sonnet-4-6"
  },
  "nodes": [],
  "edges": [],
  "created_at": 1780000000,
  "updated_at": 1780000000
}
```

### 3.2 Workflow Run

运行实例是一次执行记录。

```json
{
  "id": "run-uuid",
  "workflow_id": "wf-code-review",
  "status": "running",
  "started_at": 1780000100,
  "ended_at": null,
  "current_node_ids": ["node-test"],
  "node_runs": {},
  "artifacts": [],
  "last_error": ""
}
```

状态枚举：

| 状态 | 含义 |
| --- | --- |
| `draft` | 定义未发布 |
| `idle` | 可执行 |
| `running` | 正在执行 |
| `paused` | 等待人工或外部条件 |
| `succeeded` | 执行成功 |
| `failed` | 执行失败 |
| `cancelled` | 用户取消 |

---

## 4. 节点类型

第一版建议支持 7 类节点。

### 4.1 start

流程入口节点。只能有一个。

```json
{
  "id": "start",
  "type": "start",
  "title": "开始"
}
```

### 4.2 agent

调用 Claude Code CLI 执行一段 prompt。

```json
{
  "id": "analyze",
  "type": "agent",
  "title": "分析需求",
  "config": {
    "prompt": "分析当前 git diff，列出需要修改的文件和风险。",
    "cwd": "{{variables.cwd}}",
    "model": "{{variables.model}}",
    "reuse_session": false,
    "output_key": "analysis"
  }
}
```

执行方式：

```text
WorkflowRunner → SessionManager.send_message() → CCBSession → CLI
```

节点输出：

```json
{
  "session_id": "cli-session-id",
  "text": "...",
  "summary": "...",
  "cost_usd": 0.012,
  "artifacts": []
}
```

### 4.3 command

执行本地命令。第一版建议默认关闭，或仅允许白名单命令。

```json
{
  "id": "test",
  "type": "command",
  "title": "运行测试",
  "config": {
    "cwd": "{{variables.cwd}}",
    "command": "python -m pytest tests/test_memory_index.py",
    "timeout_seconds": 300,
    "requires_approval": false
  }
}
```

安全约束：

- 禁止默认执行 destructive 命令。
- 支持命令白名单和 approval。
- 保存 stdout/stderr 摘要。

### 4.4 condition

根据上游输出决定分支。

```json
{
  "id": "need-fix",
  "type": "condition",
  "title": "是否需要修复",
  "config": {
    "expression": "outputs.analyze.summary contains '需要修改'"
  }
}
```

第一版表达式可以非常简单：

- `contains`
- `equals`
- `status == succeeded`
- `cost_usd < 1`

避免直接执行用户提供的 Python/JS 表达式。

### 4.5 approval

人工审批节点。

```json
{
  "id": "approve-push",
  "type": "approval",
  "title": "确认是否推送",
  "config": {
    "message": "即将执行 git push，请确认。",
    "approve_label": "确认推送",
    "reject_label": "停止流程"
  }
}
```

执行到该节点时：

- run 状态变为 `paused`
- SSE 推送 `workflow_approval_required`
- 前端显示审批卡片
- 用户确认后调用 `/api/workflows/runs/{run_id}/approve`

### 4.6 artifact

生成结构化产物，例如 Markdown 报告、patch、JSON 摘要。

```json
{
  "id": "report",
  "type": "artifact",
  "title": "生成报告",
  "config": {
    "format": "markdown",
    "template": "# 审查报告\n\n{{outputs.review.text}}",
    "filename": "workflow-review.md"
  }
}
```

### 4.7 end

结束节点。可有多个。

```json
{
  "id": "end",
  "type": "end",
  "title": "完成"
}
```

---

## 5. 边与分支

```json
{
  "id": "edge-1",
  "from": "analyze",
  "to": "need-fix"
}
```

条件边：

```json
{
  "id": "edge-yes",
  "from": "need-fix",
  "to": "implement",
  "when": "true"
}
```

第一版执行规则：

- 默认串行执行。
- 一个节点可以有多个后继。
- condition 节点只选择一个分支。
- 多分支并发可作为第二版能力。

---

## 6. 后端模块设计

### 6.1 新增 `workflow_store.py`

持久化路径：

```text
~/.ccb/workflows.json
~/.ccb/workflow_runs.json
```

职责：

- CRUD workflow definition
- 创建 run
- 更新 run 状态
- 记录 node_run
- 查询最近运行记录

建议 API：

```python
def list_workflows(): ...
def get_workflow(workflow_id): ...
def save_workflow(workflow): ...
def delete_workflow(workflow_id): ...
def create_run(workflow_id, inputs): ...
def update_run(run_id, patch): ...
def append_node_event(run_id, node_id, event): ...
```

### 6.2 新增 `workflow_runner.py`

核心执行器。

```python
class WorkflowRunner:
    def __init__(self, session_manager, event_sink):
        self.session_manager = session_manager
        self.event_sink = event_sink
        self._running = {}

    async def start_run(self, workflow_id, inputs=None):
        ...

    async def cancel_run(self, run_id):
        ...

    async def approve_run(self, run_id, approval_id, approved):
        ...

    async def _execute_node(self, run, node):
        ...
```

执行器职责：

- 校验 DAG
- 按边推进节点
- 调用 agent / command / condition / approval / artifact handler
- 捕获错误并更新状态
- 通过 SSE 推送运行事件

### 6.3 新增 `workflow_nodes.py`

按节点类型拆分 handler。

```python
class AgentNodeHandler: ...
class CommandNodeHandler: ...
class ConditionNodeHandler: ...
class ApprovalNodeHandler: ...
class ArtifactNodeHandler: ...
```

这样后续增加 HTTP、Feishu、GitHub、MCP 节点时不会膨胀 `workflow_runner.py`。

### 6.4 `server.py` 新增 API

```text
GET    /api/workflows
POST   /api/workflows
GET    /api/workflows/{id}
PUT    /api/workflows/{id}
DELETE /api/workflows/{id}

POST   /api/workflows/{id}/runs
GET    /api/workflows/runs
GET    /api/workflows/runs/{run_id}
POST   /api/workflows/runs/{run_id}/cancel
POST   /api/workflows/runs/{run_id}/approve
```

SSE 事件：

```json
{
  "type": "workflow_event",
  "run_id": "run-uuid",
  "node_id": "analyze",
  "event": "node_started",
  "payload": {}
}
```

事件类型：

- `run_started`
- `node_started`
- `node_output`
- `node_succeeded`
- `node_failed`
- `approval_required`
- `run_paused`
- `run_resumed`
- `run_succeeded`
- `run_failed`
- `run_cancelled`

---

## 7. 前端页面设计

建议新增一个独立页面或侧栏入口：**工作流 / Workflow Studio**。

视觉方向不再采用普通后台管理页，而是偏“工程编排工作台”：深色低饱和背景、暖琥珀主色、卡片式 DAG 画布、实时运行态高亮。目标是让用户一眼看出：这是一个可观察、可审批、可回放的 agent 执行控制台。

设计系统建议：

| 项 | 方案 |
| --- | --- |
| 主背景 | 深灰黑 `#0d0f14` / `#121620` |
| 主强调色 | 琥珀色 `#d6a14a`，用于主按钮、选中态、审批提示 |
| 状态色 | sage green 表示运行/成功，muted gray 表示 pending，soft red 表示危险动作 |
| 字体 | Windows 优先使用 `Aptos` / `Segoe UI` / `Microsoft YaHei`，代码使用 `Cascadia Code` |
| 圆角 | 大面板 28px，节点卡片 22px，输入控件 12px |
| 动效 | 180–220ms ease，hover 轻微上浮，运行节点使用低频 pulse |

页面分区：

```text
顶部：运行状态条 / 模板库 / 保存草稿 / 取消运行 / 继续执行
左侧：工作流列表 / 搜索 / 模板入口
中间：Live DAG 画布 / SVG 连线 / 节点状态
右侧：Inspector 节点配置 / 风险策略 / 上下文策略
底部：Run timeline / SSE 实时日志 / 运行进度
右下：Tweaks 面板，用于原型阶段切换紧凑节点、专注画布等变体
```

### 7.1 顶部运行状态条

顶部条承担全局操作和运行概览：

- 当前 run id
- 已完成节点数
- 本次累计 cost
- 模板库入口
- 保存草稿
- 取消运行
- 继续执行 / 审批继续

高风险动作相关按钮需要使用明确的视觉区分：

- `取消运行` 使用 soft red
- `继续执行` 使用琥珀主按钮
- `审批通过` 不应和普通保存按钮混淆

### 7.2 工作流列表

左侧工作流列表用于快速切换定义和模板。

卡片内容：

- 工作流名称
- 一句话定位
- 当前状态：运行中 / 空闲 / 待审批 / 失败
- 节点数量

交互：

- 搜索过滤
- 点击切换工作流
- hover 轻微上浮
- active 卡片使用琥珀色边框和浅色背景层

### 7.3 Live DAG 画布

画布是核心区域。第一版不引入图编辑库，继续使用：

```text
绝对定位节点卡片 + SVG path 连线 + CSS 状态样式
```

节点卡片展示：

- 编号和节点类型，例如 `04 · agent`
- 节点标题
- 简短说明
- 当前状态点：done / running / paused / pending
- 耗时、输出变量或 session 简写

运行态规则：

- `done`：sage green 状态点
- `running`：sage green 发光状态点
- `paused`：amber 状态点
- `pending`：整体透明度降低
- `selected`：琥珀描边 + 外发光

连线规则：

- 普通边使用低对比浅色
- 当前执行路径使用 sage green
- 审批 / 高风险路径使用 amber
- condition 分支后续可以在边上显示 `true` / `false` 标签

### 7.4 Inspector 节点配置面板

右侧 Inspector 按当前选中节点展示配置。

agent 节点字段：

- 工作目录
- 模型
- Prompt
- 输出变量
- 是否复用会话
- 上下文策略说明
- 风险策略说明

command 节点字段：

- cwd
- command
- timeout
- 是否需要 approval
- 命令白名单状态

approval 节点字段：

- 审批文案
- 通过按钮文案
- 拒绝按钮文案
- 通过后目标节点
- 拒绝后目标节点

Inspector 应始终显示该节点的安全边界，避免用户误以为工作流会自动执行 commit / push / release。

### 7.5 Run timeline 与日志

底部区域分为两块：

1. 左侧运行摘要卡片
   - 当前 run 状态
   - 运行说明
   - 进度条

2. 右侧实时日志
   - 来自 SSE 的 `workflow_event`
   - 按时间、事件名、消息三列展示
   - 使用等宽字体

日志示例：

```text
[10:01:03] run_started     代码修改流水线开始执行，cwd=E:/code/cc-bridge
[10:01:06] node_started    analyze 调用 Claude Code CLI
[10:01:24] node_succeeded  analysis 输出修改计划，捕获 session_id=a13f...
[10:01:25] node_started    implement 正在执行，reuse_session=false
```

### 7.7 交互逻辑

当前交互分为两层：第一层保证“可运行、可观察、可审批”，第二层补齐轻量可视化编辑器能力，支持在画布上直接调整 workflow definition。

#### 页面进入

1. 用户点击左侧导航的 `Workflows / 工作流`。
2. 前端调用 `GET /api/workflows` 拉取 workflow definitions。
3. 前端调用 `GET /api/workflows/runs` 拉取最近运行记录。
4. 默认选中最近运行过的工作流；如果没有，则选中内置示例模板。
5. 中央画布渲染 DAG，右侧 Inspector 显示当前选中节点。

#### 选择工作流

1. 点击左侧工作流卡片。
2. 更新当前 workflow。
3. 中央画布重新绘制节点和连线。
4. 底部 timeline 切换到该 workflow 的最近一次 run。
5. 顶部状态条显示最近 run 状态、完成节点数和 cost。

#### 选择节点

1. 点击画布节点。
2. 节点进入 `selected` 状态。
3. Inspector 根据节点类型切换配置表单。
4. 如果节点有最近运行输出，Inspector 展示 session_id、输出摘要、耗时和错误信息。

#### 创建与编辑工作流

编辑器采用轻量画布实现，不引入额外图编辑库：

1. 点击 `从模板创建` 生成 workflow draft。
2. 点击 `+ Node` 在当前画布新增 agent 节点，默认 `mode=mock`，并自动生成唯一节点 ID。
3. 选中节点后点击 `Delete` 删除节点，同时删除关联入边和出边。
4. 拖拽节点卡片可调整位置，位置写入 `node.position` 并随 workflow 保存。
5. 点击节点右侧输出端口或工具栏 `Connect` 进入连线模式，再点击目标节点或目标输入端口创建 edge。
6. 点击 SVG 连线可选中 edge，右侧 Inspector 可修改 `when` 条件：default / true / false / approved / succeeded。
7. 选中 edge 后可在 Inspector 删除该连线。
8. 选中节点后，Inspector 以表单方式编辑 `id`、`title`、`type`、`config.prompt`、`config.expression`、`config.message`、`config.output_key`、`config.mode`。
9. 修改节点 ID 时，前端同步更新所有 edge 的 `from` / `to` 引用，避免断边。
10. 点击 `保存草稿` 调用 `POST /api/workflows` 或 `PUT /api/workflows/{id}`。
11. 保存成功后刷新左侧列表，后续运行按最新 DAG 定义执行。

#### 运行工作流

1. 点击 `运行工作流`。
2. 前端调用 `POST /api/workflows/{id}/runs`。
3. 后端创建 run，返回 run_id。
4. 顶部状态条切换为 running。
5. 画布节点按 SSE 事件逐步变更状态。
6. 底部日志追加 `workflow_event`。

#### SSE 状态同步

前端监听现有 `/sse` 通道中的 `workflow_event`：

```json
{
  "type": "workflow_event",
  "run_id": "run-uuid",
  "workflow_id": "workflow-id",
  "node_id": "implement",
  "event": "node_started",
  "payload": {
    "status": "running",
    "message": "implement 正在执行"
  }
}
```

前端收到事件后：

- 更新 run 状态缓存
- 更新对应节点状态
- 追加 timeline 日志
- 如果当前 Inspector 选中该节点，同步刷新输出摘要
- 如果事件为 `approval_required`，显示审批操作区

#### 人工审批

1. 后端执行到 approval 节点后暂停 run。
2. 前端收到 `approval_required`。
3. 顶部主按钮变为 `审批继续`。
4. Inspector 显示审批文案、上游摘要和风险说明。
5. 用户点击通过：`POST /api/workflows/runs/{run_id}/approve`，body 为 `{ "approved": true }`。
6. 用户点击拒绝：同一接口传 `{ "approved": false }`，run 进入 cancelled 或 failed。

#### 取消运行

1. 用户点击 `取消运行`。
2. 前端调用 `POST /api/workflows/runs/{run_id}/cancel`。
3. 后端取消尚未执行的节点，并尽量停止当前节点。
4. 前端收到 `run_cancelled` 后将未完成节点标为 pending / cancelled。

#### 原型阶段 Tweaks

`Tweaks` 只用于设计验证，不参与业务状态：

- `紧凑节点`：切换节点信息密度。
- `专注画布`：弱化侧栏、Inspector、timeline，让用户聚焦 DAG。



---

## 8. 内置模板

### 8.1 代码修改工作流

```text
start → analyze → implement → test → review → report → end
```

### 8.2 PR Review 工作流

```text
start → collect_diff → review_risk → review_tests → report → end
```

### 8.3 发布前检查

```text
start → status_check → test → package → approval → release_command → end
```

### 8.4 记忆整理工作流

```text
start → scan_memory → consolidate → approval → apply_changes → end
```

---

## 9. 权限与安全

高风险节点默认策略：

| 动作 | 默认策略 |
| --- | --- |
| 本地文件写入 | 允许，但记录 diff 摘要 |
| 删除文件 | 需要 approval |
| git commit | 允许用户显式触发，不自动提交 |
| git push | 需要 approval |
| 远程服务器命令 | 需要 approval |
| 发飞书 / GitHub 评论 | 需要 approval |
| 发布 release | 需要 approval |
| 任意 shell command | 默认需要 approval 或白名单 |

此外：

- 所有 workflow definition 按本地文件保存，不自动同步。
- API 写操作必须校验 JSON schema。
- command 节点禁止直接拼接未转义的用户输入。
- condition 表达式使用自定义解析器，不能 eval。

---

## 10. 迭代计划

### Milestone 1：最小可用版本

- workflow JSON 持久化
- start / agent / condition / approval / end 节点
- 串行执行
- SSE 推送运行状态
- 前端静态画布原型

### Milestone 2：工程化节点

- command 节点
- artifact 节点
- 运行历史详情
- 节点输出映射
- 内置模板

### Milestone 3：高级编排

- 并行分支
- join 节点
- 子工作流
- 定时触发
- 失败重试策略
- webhook / Feishu / GitHub 节点

### Milestone 4：可视化增强

- 拖拽节点
- 连线编辑
- 运行中节点高亮
- 节点输出 diff / artifact 预览
- 从一次聊天记录生成工作流模板

---

## 11. 推荐第一版落地范围

为了避免一次性做太大，建议第一版只实现：

1. 后端保存 workflow definition。
2. 后端可执行固定 JSON DAG。
3. 节点类型只做 `start`、`agent`、`condition`、`approval`、`end`。
4. 前端先做静态画布和运行日志，不做拖拽。
5. 工作流模板先内置 2 个：代码修改、PR review。

这能尽快验证核心价值：

```text
把多轮 Claude Code 操作封装成可复用、可观察、可审批的流程。
```

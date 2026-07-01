# Session Workspace 设计

## 目标

在中间聊天区域实现类似 Xshell 的会话页签工作台：用户可以把多个会话同时打开在主页聊天区，每个会话作为一个子页签独立保留消息内容、运行状态和进度。当前会话可以展开占满聊天区，其他会话收起为状态页签；也可以切换到 Grid 模式，同时展示多个会话 pane。

## 核心体验

- 顶部显示会话页签栏，每个页签展示会话标题、运行状态、当前阶段和耗时。
- 点击页签切换当前展开会话。
- 非当前页签仍显示进度：idle、running、tool、done、error。
- Grid 模式下多个会话并排显示。
- Grid 模式中每个子会话 pane 的宽度可以通过拖拽分隔条自由调整。
- 后续可扩展为关闭页签、拖拽排序、未读计数、viewer/takeover 分离。

## 第一版 MVP 范围

第一版以低风险方式落地，不一次性重构所有流式渲染状态：

1. 保留现有单会话流式渲染主链路。
2. 在聊天区外层新增 `session-workspace`。
3. 当前活动会话使用原有 `#messages` 容器。
4. 打开的其他会话以独立 pane 保存历史快照。
5. 支持 Focus / Grid 两种模式。
6. Grid 模式下 pane 之间可拖拽调整宽度。
7. 页签状态随现有会话事件更新。

## 后续完整版本原则

完整版本需要将这些状态全部迁移到 per-session 状态对象中：

```js
currentAssistantEl
currentAssistantMessageId
currentContent
streamBlocks
isResponding
currentRunId
currentTurnContent
currentTurnStartedAt
currentTurnHasAssistantOutput
toolResults
toolStartTimes
runningTasks
subagentBubbles
```

每个 workspace session 应维护自己的消息 DOM 和流式状态，避免 A 会话的工具卡、thinking block 或 streaming 状态污染 B 会话。

## 前端状态结构

```js
workspaceSessions = new Map();
activeWorkspaceSessionId = null;
workspaceMode = 'focus';
```

每个 session：

```js
{
  sessionId,
  title,
  cwd,
  model,
  cli,
  paneEl,
  messagesEl,
  status: 'idle' | 'running' | 'tool' | 'done' | 'error',
  phase,
  startedAt,
  updatedAt,
  runId,
  width
}
```

## DOM 结构

```html
<div id="session-workspace" class="session-workspace">
  <div class="workspace-tabs-shell">
    <div id="workspace-tabs" class="workspace-tabs"></div>
    <div class="workspace-actions">
      <button id="workspace-focus-mode">Focus</button>
      <button id="workspace-grid-mode">Grid</button>
    </div>
  </div>
  <div id="workspace-panes" class="workspace-panes workspace-focus">
    <section id="workspace-live-pane" class="workspace-pane active">
      <div class="workspace-pane-head">...</div>
      <div id="messages" class="messages"></div>
    </section>
  </div>
</div>
```

## 交互规则

- 从欢迎页或 Sessions 页面点击会话时，打开/激活对应 workspace tab。
- `resumeSession()` 仍负责真正恢复会话并绑定主输入框。
- Focus 模式只显示当前 active pane。
- Grid 模式显示所有打开 pane。
- 点击 pane header 或 tab 会激活该会话。
- 拖拽 pane 右侧 resizer 调整 pane 宽度。

## 主题约束

- 暗色主题保持原有霓虹终端风格。
- 亮色主题使用 Engineering Blueprint 风格。
- 所有亮色专属增强必须限定在 `html.light-theme` 下。

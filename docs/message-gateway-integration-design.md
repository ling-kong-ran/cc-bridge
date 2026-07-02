# 飞书消息网关接入设计

## 背景

本设计调研 Hermes Agent 的消息网关实现方式，评估是否可以把类似能力引入 cc-bridge。当前实施范围已收敛为 **只接入飞书**：微信、企业微信、通用 Webhook 暂不实现，只保留后续扩展方向。

当前实现采用飞书开放平台事件订阅 + 飞书消息 API：

```text
飞书事件订阅 -> /api/feishu-gateway/events -> FeishuGateway -> CCBSession -> 飞书消息回复
```

---

## 当前实现范围

新增文件：

- `feishu_gateway_store.py`：持久化飞书配置、scope 映射、event 去重记录。
- `feishu_gateway.py`：处理飞书事件、鉴权、scope 会话、Claude Code 调用和飞书回复。

新增 API：

```text
GET  /api/feishu-gateway/config
POST /api/feishu-gateway/config
GET  /api/feishu-gateway/scopes
POST /api/feishu-gateway/events
POST /api/feishu-gateway/reset-scope
POST /api/feishu-gateway/stop-scope
```

支持能力：

- 飞书 URL verification challenge。
- 飞书 v2 message receive event 文本消息。
- `verification_token` 校验。
- `tenant_access_token` 获取与缓存。
- 使用飞书官方 Python SDK `lark-oapi` 回复文本消息。
- 按 `chat_id` 维护独立 Claude Code session。
- 支持 `/new`、`/reset`、`/status`、`/stop`。
- 支持 `allowed_users` / `allowed_chats`。
- 支持 `busy_mode=queue|reject`。
- 支持 event_id 去重。

暂不支持：

- 飞书 encrypt key 加密事件解密。
- 图片、文件、卡片消息。
- 飞书消息 streaming 编辑。
- 飞书 SDK 依赖为可选功能依赖：启用飞书网关前需在当前 Python 环境安装 `lark-oapi`；离线运行或缺少 SDK 时自动屏蔽飞书网关，不影响 cc-bridge 本体启动和本地 GUI 使用。

---

## Hermes 相关调研结论

### 1. Hermes Messaging Gateway 的整体模式

Hermes 的消息入口是独立后台 gateway 进程：

```text
消息平台 adapter -> gateway session store -> AIAgent -> 平台回复
```

其特点：

- gateway 是独立进程，可前台运行，也可安装为 systemd / launchd 服务。
- 通过 `hermes gateway setup` 做交互配置。
- 通过 `hermes gateway` 或 `hermes gateway start` 运行。
- 一个 gateway 进程可同时承载多个平台 adapter。
- 每个平台 adapter 负责平台协议、鉴权、消息收取、回复发送。
- gateway 按聊天维度维护 session，直到 reset。
- gateway 内置 cron 调度，定时任务结果也可以投递到消息平台。
- adapter 外层有 circuit breaker，连续失败后自动暂停，需要手动 resume。
- 支持聊天内命令，例如 `/new`、`/reset`、`/model`、`/status`、`/stop`、`/approve`、`/deny`、`/resume`、`/usage`、`/platform list` 等。
- 对忙碌输入支持 interrupt / queue / steer 三种策略。
- 安全侧默认依赖 allowlist / pairing code / admin 权限分层。

Hermes 官方文档列出的平台包括 Feishu / Lark、WeCom、WeCom Callback、Weixin / WeChat、DingTalk、Telegram、Discord、Slack、WhatsApp、Signal、Email、Webhooks 等。

### 2. 飞书接入方式

公开文档能确认：Hermes gateway 有 `hermes-feishu` toolset 和 Feishu / Lark adapter，支持 reaction 等平台能力。

但公开页面没有展开 Feishu adapter 的具体 webhook payload、事件订阅、challenge 校验、tenant token 刷新等实现细节。因此当前只能推断其实现大概率是标准飞书机器人模式：

```text
飞书开放平台事件订阅 / webhook
  -> 本地或公网可达 gateway endpoint
  -> 校验 app_id / app_secret / verification token / encrypt key
  -> 转换成统一 MessageEvent
  -> 调用 agent
  -> 使用飞书消息 API 回复 chat_id / open_id / thread
```

对 cc-bridge 来说，飞书应优先按官方机器人事件订阅实现，而不是复用 Hermes 代码。

### 3. 微信接入方式

Hermes README 提到微信相关主要有两类：

1. Hermes 自身支持 Weixin / WeChat、WeCom、WeCom Callback adapter。
2. 社区项目 HermesClaw 提供 WeChat bridge。

HermesClaw 的实现更具体：

```text
iLink WeChat API
  -> HermesClaw 作为唯一轮询者 / token 持有者
  -> 按命令路由到 Hermes / OpenClaw / OpenCode
  -> 各 agent gateway 继续以为自己在访问 iLink API
```

HermesClaw 的关键点：

- 本机 Python 代理 / 路由器。
- 它是唯一 iLink 轮询者，避免多个 gateway 抢同一个 iLink 连接导致 403 或消息丢失。
- 给 Hermes gateway 暴露本地代理端口，安装器会把 Hermes 的 `WEIXIN_BASE_URL` 改成 `http://127.0.0.1:19998`。
- 给 OpenClaw 暴露另一个本地代理端口，常见为 `http://127.0.0.1:19999`。
- 文本消息原样转发。
- 语音消息使用 iLink 转写文本转发。
- 图片、视频、文件保留原始 iLink 消息，由下游 gateway 自行处理下载、解密、转码。
- 不直接调用 agent API，也不处理 agent memory。
- 通过 `/hermes`、`/openclaw`、`/opencode`、`/both`、`/three`、`/whoami` 等命令做路由。

这说明微信个人号接入通常不是稳定官方 webhook，而是依赖第三方桥接层。对 cc-bridge 来说不建议第一版直接做个人微信协议，应优先支持：

- 飞书 bot。
- 企业微信 / WeCom callback。
- 通用 Webhook。
- 微信个人号仅作为“外部桥接适配器”预留，不内置 iLink 依赖。

---

## 当前 cc-bridge 可接入点

cc-bridge 现有架构适合接一个独立消息网关层：

```text
browser -> server.py REST/SSE -> ccb_bridge.py -> ccb/claude CLI
```

关键现状：

- `server.py` 已有 `/api/action`，支持 `new_session`、`resume_session`、`send_message`、`stop`，入口在 `server.py:1689`。
- `handle_action` 的 `send_message` 分支最终复用 `session.send_message(content, owner_id=client_id)`，见 `server.py:1887`、`server.py:2148`。
- `CCBSession.send_message()` 封装了持久 CLI / one-shot CLI 两种发送方式，见 `ccb_bridge.py:390`。
- 会话元数据通过 `save_session()` 写入 `~/.claude/gui_sessions.json`，见 `session_store.py:212`。
- SSE client 当前面向浏览器，由 `sse_clients` 和 `handle_sse()` 管理，见 `server.py:1519`。
- 定时任务已经验证过“非浏览器入口复用 session 管线”的方向，可作为消息网关复用模式参考。

设计上不应让飞书 / 微信 adapter 直接操作 CLI 子进程，而应调用一层内部 gateway service，让所有入口共用：

```text
平台消息 -> GatewayService -> SessionManager / CCBSession -> CLI -> GatewayService -> 平台回复
```

---

## 推荐方案

### 总体结论

可以引入，但建议分三层，不要直接把 Hermes gateway 作为运行时依赖：

```text
平台 adapter 层
  FeishuAdapter / WeComAdapter / WebhookAdapter / ExternalWeChatBridgeAdapter

统一 gateway 核心层
  MessageEvent 规范化、鉴权、路由、session 映射、忙碌策略、命令处理

cc-bridge 会话执行层
  复用 SessionManager / CCBSession / session_store
```

第一版建议做 **飞书 + 通用 Webhook**。微信个人号仅做接口预留，后续通过外部桥接器转入通用 Webhook。

---

## 设计目标

### 必须支持

- 外部平台向 cc-bridge 发送文本 prompt。
- cc-bridge 通过 Claude Code CLI 生成回复。
- 结果回发到原聊天。
- 每个外部聊天维持独立 session。
- 支持 `/new`、`/reset`、`/status`、`/stop`。
- 支持 allowlist，避免任意用户远程操作本机。
- 支持平台配置持久化。
- 不破坏现有浏览器 GUI 和 SSE 行为。

### 暂不支持

- 直接内置个人微信协议。
- 多模态附件完整处理。
- 平台侧 streaming 编辑消息。
- OAuth 管理后台。
- 多进程分布式 gateway。

---

## 新增模块建议

### 1. `message_gateway.py`

统一 gateway 核心，不绑定具体平台。

职责：

- 接收标准化 `GatewayMessage`。
- 根据 `platform + scope_id` 映射到 cc-bridge session。
- 创建 / 恢复 `CCBSession`。
- 调用 `send_message()`。
- 收集 assistant / result / error 事件。
- 调用 adapter 的 `send_reply()`。
- 执行 slash command。
- 处理 busy 策略。

建议接口：

```python
class GatewayService:
    async def handle_message(self, message: GatewayMessage) -> GatewayReply: ...
    async def stop_scope(self, platform: str, scope_id: str) -> None: ...
    def get_scope_status(self, platform: str, scope_id: str) -> dict: ...
```

### 2. `message_gateway_store.py`

持久化平台配置和聊天会话映射。

建议路径：

```text
~/.ccb/message_gateway.json
```

建议结构：

```json
{
  "enabled": false,
  "default_model": "claude-sonnet-4-6",
  "default_cwd": "E:/code/cc-bridge",
  "busy_input_mode": "queue",
  "platforms": {
    "feishu": {
      "enabled": false,
      "app_id": "",
      "app_secret": "",
      "verification_token": "",
      "encrypt_key": "",
      "allowed_users": [],
      "allowed_chats": []
    },
    "webhook": {
      "enabled": false,
      "secret": "",
      "allowed_sources": []
    }
  },
  "scopes": {
    "feishu:chat:oc_xxx": {
      "session_id": "uuid",
      "model": "claude-sonnet-4-6",
      "cwd": "E:/code/cc-bridge",
      "cli": "claude",
      "created_at": "...",
      "updated_at": "..."
    }
  }
}
```

敏感字段后续可考虑移到 `~/.ccb/message_gateway.secrets.json` 或系统凭据存储；第一版至少不能暴露到前端明文列表。

### 3. `message_adapters/feishu.py`

飞书 adapter。

职责：

- 处理飞书 challenge。
- 校验 verification token / encrypt key。
- 提取 message event。
- 去重 event_id / message_id。
- 把飞书消息转换成 `GatewayMessage`。
- 使用飞书 API 回复文本。

建议接入方式：

```text
POST /api/gateway/feishu/events
```

事件处理：

```text
飞书 event -> verify/decrypt -> GatewayMessage -> GatewayService -> send_reply(chat_id, text)
```

### 4. `message_adapters/webhook.py`

通用 Webhook adapter，用于后续接微信桥、企业内部机器人、脚本自动化。

建议 endpoint：

```text
POST /api/gateway/webhook/{source}
```

请求示例：

```json
{
  "secret": "...",
  "scope_id": "wechat:room:xxx",
  "user_id": "user123",
  "user_name": "Alice",
  "text": "帮我检查项目状态",
  "reply_url": "http://127.0.0.1:19998/reply/xxx"
}
```

回复策略：

- 如果有 `reply_url`，异步 POST 回调。
- 如果没有 `reply_url`，HTTP response 直接返回回复。

### 5. `message_adapters/wecom.py`（第二阶段）

企业微信 callback 比个人微信更适合内置：

- 官方 callback 模式。
- 支持 token / encoding aes key 校验。
- 可部署到公网或内网穿透地址。

第二阶段可加，不建议和飞书第一版混在一起。

### 6. 外部微信桥接预留

个人微信建议不内置协议，只定义桥接契约：

```text
WeChat bridge / HermesClaw-like process
  -> POST /api/gateway/webhook/wechat
  -> cc-bridge GatewayService
  -> reply_url 回传
```

这样可以兼容 HermesClaw 类项目，也避免 cc-bridge 维护不稳定的个人号协议。

---

## 标准消息模型

```python
@dataclass
class GatewayMessage:
    platform: str          # feishu / webhook / wecom / wechat_bridge
    scope_type: str        # dm / group / channel / webhook
    scope_id: str          # chat_id / open_chat_id / room_id
    user_id: str
    user_name: str
    text: str
    message_id: str
    thread_id: str = ""
    raw: dict | None = None
```

scope key：

```text
{platform}:{scope_type}:{scope_id}
```

示例：

```text
feishu:chat:oc_xxx
webhook:wechat-room:room_123
wecom:group:wr_xxx
```

---

## 会话映射设计

每个 scope 对应一个 Claude Code session：

```text
scope_key -> session_id -> CCBSession
```

行为：

- 第一次收到消息：创建新 `CCBSession`，发送 prompt，捕获真实 `session_id` 后保存。
- 后续同 scope 消息：用 `--resume <session_id>` 继续。
- `/new` 或 `/reset`：清空 scope 绑定，下一条消息创建新 session。
- `/status`：返回当前 model / cwd / session_id / 是否 running。
- `/stop`：停止当前 scope 的运行。

注意：浏览器 `client_id` 与 gateway scope 不同。建议 gateway 使用内部 client id：

```text
gateway:{platform}:{scope_hash}
```

这样可以复用现有 `client_meta`、`client_session_ids`、`session_owner` 等结构，但实现时需要避免污染浏览器在线状态。

---

## 忙碌输入策略

借鉴 Hermes，第一版建议实现两个模式：

### queue（默认）

同一 scope 正在生成时，新消息进入队列，当前 run 结束后作为下一轮发送。

优点：安全、符合 IM 直觉。

### reject

同一 scope 正在生成时，直接回复：

```text
当前任务仍在执行，请稍后再发，或发送 /stop 中断。
```

不建议第一版做 interrupt，因为当前 cc-bridge 的浏览器侧有 live input / stop / lock 逻辑，直接映射到外部平台容易造成误中断。

---

## 安全设计

必须默认关闭 gateway。

### 1. 全局开关

```json
{
  "message_gateway_enabled": false
}
```

### 2. 平台 allowlist

飞书至少支持：

- `allowed_users`
- `allowed_chats`

Webhook 至少支持：

- shared secret
- source allowlist
- 可选 HMAC 签名

### 3. 权限边界

第一版所有 gateway 会话默认：

- `skip_permissions=false` 或沿用 GUI 明确配置。
- 不允许远程 target mutation，除非配置中显式启用。
- 不暴露任意 cwd 切换给普通聊天用户。
- `/cwd`、`/cli`、`/remote` 等高风险命令暂不开放。

### 4. 内网部署注意

飞书事件订阅需要公网可访问 URL。当前 cc-bridge 默认主要是本机 GUI，若要接飞书，需要用户自行提供：

- 反向代理。
- 内网穿透。
- VPS 部署。

文档和 UI 必须提示：把本地服务暴露到公网前必须设置 secret / allowlist。

---

## API 设计草案

### 平台事件入口

```text
POST /api/gateway/feishu/events
POST /api/gateway/webhook/{source}
POST /api/gateway/wecom/callback     # 第二阶段
```

### 管理接口

```text
GET  /api/gateway/config
POST /api/gateway/config
GET  /api/gateway/scopes
POST /api/gateway/scopes/{scope_key}/reset
POST /api/gateway/scopes/{scope_key}/stop
DELETE /api/gateway/scopes/{scope_key}
```

### 内部事件回收

GatewayService 不需要 SSE，但需要订阅 `CCBSession` 的 `on_event`：

```text
assistant -> 累积文本
result -> 发送最终回复并记录 usage
error -> 发送错误回复
process_ended -> 解锁 / 执行队列下一条
session_id_captured -> 保存 scope 映射
```

---

## UI 设计建议

新增“消息网关”设置页。

### 页面内容

- 总开关：启用消息网关。
- 默认 model / cwd / cli。
- 忙碌策略：queue / reject。
- 平台卡片：飞书、Webhook、企业微信（后续）、微信桥（外部）。
- 每个平台显示：启用状态、配置是否完整、最近错误、最近消息时间。
- scope 列表：平台、聊天名、session、last active、操作（停止、重置、删除）。

### 飞书配置字段

- App ID
- App Secret
- Verification Token
- Encrypt Key
- Allowed Users
- Allowed Chats
- Event URL 只读展示：`http://host/api/gateway/feishu/events`

### Webhook 配置字段

- Source name
- Secret
- Reply mode：sync / callback
- Example curl

---

## 实施阶段建议

### Phase 1：通用 Gateway 核心 + Webhook

目标：验证非浏览器消息入口可以稳定复用 cc-bridge 会话。

内容：

- `GatewayMessage`。
- `GatewayService`。
- `message_gateway_store.py`。
- `/api/gateway/webhook/{source}`。
- scope -> session 映射。
- `/new`、`/status`、`/stop`。
- queue / reject 忙碌策略。

### Phase 2：飞书 Bot

内容：

- 飞书 challenge。
- 飞书事件验签 / 解密。
- 文本消息收取。
- 文本回复。
- event 去重。
- allowlist。

### Phase 3：企业微信 / WeCom

内容：

- callback 验签。
- AES 解密 / 加密回复。
- 群聊 / 单聊 scope。

### Phase 4：微信个人号桥接契约

内容：

- 完善 Webhook bridge 协议。
- 文档说明如何让外部 WeChat bridge 调用 cc-bridge。
- 可选兼容 HermesClaw 类代理输出。

---

## 风险与取舍

### 1. 个人微信协议风险

个人微信没有稳定官方 bot webhook，依赖 iLink / hook / 桥接项目会带来可用性和账号风险。因此不应作为内置第一目标。

### 2. 公网暴露风险

cc-bridge 可以操作本机文件和运行 CLI。消息网关一旦暴露到公网，必须默认关闭并强制鉴权。

### 3. 长回复体验

Claude Code 输出可能很长。平台 adapter 需要做分段：

- 飞书文本长度限制。
- Markdown / 富文本兼容。
- 错误消息不要泄露敏感路径或 token。

第一版可按纯文本分段发送。

### 4. Streaming 复杂度

Hermes 在部分平台支持 streaming / typing。cc-bridge 第一版不建议实现 streaming，等最终回复完成后一次性或分段发送即可。

### 5. Session 与 GUI 并发

同一个 native session 可能被 GUI 和 gateway 同时恢复。第一版建议 gateway scope 独占自己的 session，不提供“绑定到当前 GUI 会话”的功能，避免 owner/viewer/lock 逻辑复杂化。

---

## 是否引入 Hermes 代码

不建议直接引入 Hermes runtime 或复制 adapter 代码，原因：

- Hermes 是完整 agent 系统，架构和配置体系与 cc-bridge 不同。
- cc-bridge 的核心价值是包装 Claude Code CLI，应该保持轻量、标准库优先。
- 直接复用 Hermes 可能引入大量依赖和服务化复杂度。
- 飞书 / 企业微信官方协议相对清晰，独立实现更可控。
- 微信个人号本身适合外部 bridge，不适合做成 cc-bridge 核心依赖。

建议引入的是设计模式：

```text
adapter + gateway + scope session store + allowlist + slash command subset
```

而不是引入 Hermes 作为依赖。

---

## 推荐第一版范围

第一版已按飞书接入收敛，实际交付：

1. 飞书 bot 文本消息入口。
2. 每个 `chat_id` 独立 session。
3. `/new`、`/reset`、`/status`、`/stop`。
4. `allowed_users` / `allowed_chats`。
5. 通过飞书官方 SDK `lark-oapi` 发送飞书文本回复；离线/缺少 SDK 时网关自动不可用。

明确不做：

- 微信 / 企业微信 / 通用 Webhook。
- 个人微信内置连接。
- 附件处理。
- streaming 消息编辑。
- admin / regular user 细粒度权限。
- pairing code。

这样能以最小风险验证“飞书控制 cc-bridge”的核心价值。

---

## 参考来源

- Hermes Agent README：`https://github.com/NousResearch/hermes-agent`
- Hermes Agent 中文 README：`https://github.com/NousResearch/hermes-agent/blob/main/README.zh-CN.md`
- Hermes Messaging Gateway 文档：`https://hermes-agent.nousresearch.com/docs/user-guide/messaging`
- Hermes Agent 中文社区文档：`https://hermesagent.org.cn/`
- HermesClaw：`https://github.com/AaronWong1999/hermesclaw`

# 统一消息网关页面设计

## 背景

当前网关页面已经从飞书单平台入口调整为统一入口。后续会继续接入微信等平台，因此页面不能以横向 tabs 或单平台配置页为核心，也不能默认暴露大量高级参数。

本设计基于 Hermes Agent Desktop 的网关相关源码调研，结合 cc-bridge 当前纯 Python 后端与静态前端架构，定义下一版“消息网关”页面的信息架构和交互。

## 源码调研结论

调研对象主要包括：

- `apps/desktop/src/app/settings/gateway-settings.tsx`
- `apps/desktop/src/app/shell/gateway-menu-panel.tsx`
- `apps/desktop/src/app/gateway/hooks/use-gateway-boot.ts`
- `apps/desktop/src/app/gateway/hooks/use-gateway-request.ts`
- `apps/desktop/src/store/gateway.ts`
- `apps/desktop/electron/gateway-ws-probe.cjs`
- `gateway/platform_registry.py`
- `gateway/config.py`
- `gateway/platforms/ADDING_A_PLATFORM.md`
- `plugins/platforms/*/plugin.yaml`

### 1. Desktop 的网关设置不是平台配置页

Hermes Agent Desktop 的 `GatewaySettings` 更关注“本地 / 远程 gateway 连接方式”：

- `local` / `remote` 两种模式卡片。
- 远程 URL 输入。
- 自动探测远程 gateway 的鉴权方式。
- OAuth / password / session token 的不同登录控件。
- `Test remote`、`Save for restart`、`Save and reconnect`。
- 诊断日志入口。
- 支持按 profile 作用域覆盖连接。

也就是说，Desktop 页面本身不把 Telegram、Slack、WhatsApp 等平台全部铺成复杂表单，而是把平台 adapter 的配置留给 gateway setup / 插件 schema / 后端配置模型。

对 cc-bridge 的启发：

- 页面默认应该展示“连接状态 + 平台入口 + 最少必要参数”。
- 复杂的运行时状态、日志、allowlist、会话管理应作为二级信息。
- 不要把所有平台的所有字段同时暴露出来。

### 2. 网关状态应有轻量可见入口

Hermes 的 `GatewayMenuPanel` 是一个小型状态面板，包含：

- gateway 连接状态。
- inference 就绪状态。
- restart gateway 按钮。
- open system/settings 按钮。
- recent activity 日志尾部。
- messaging platforms 列表，每个平台显示状态点。

对 cc-bridge 的启发：

- 左侧导航只需要进入统一“消息网关”。
- 页面顶部应先给整体状态，例如“已启用 / 未启用 / 部分平台异常”。
- 平台列表中每个平台应有状态点，而不是只靠表单是否填写判断。
- 诊断日志、最近事件、会话 scope 列表可折叠放在下方。

### 3. 多平台扩展依赖平台元数据

Hermes 的平台侧通过 `PlatformEntry` 和插件 `plugin.yaml` 描述平台：

- `name`
- `label`
- `description`
- `requires_env`
- `optional_env`
- `check_fn`
- `validate_config`
- `is_connected`
- `setup_fn`
- `allowed_users_env`
- `allow_all_env`
- `max_message_length`
- `platform_hint`

平台是否 connected 的判断不是统一字段，而是平台自己的必备参数：

- Telegram：`TELEGRAM_BOT_TOKEN`
- Slack：`SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`
- Discord：`DISCORD_BOT_TOKEN`
- WhatsApp：`WHATSAPP_ENABLED` + 本地 bridge
- Weixin：`account_id` + `token`
- QQBot：`app_id` + `client_secret`
- Yuanbao：`app_id` + `app_secret`

对 cc-bridge 的启发：

- 前端不要硬编码所有平台表单布局。
- 后端应返回平台 manifest，前端按 schema 渲染“必备参数”。
- 每个平台的连接判断由平台 adapter 或 store 提供，不由前端猜测。

### 4. WebSocket 探测思想可迁移为事件入口探测

Hermes 的 `gateway-ws-probe.cjs` 不只检查 HTTP status，还实际打开 WebSocket 验证真实可用性，因为 HTTP 可达不代表聊天通路可用。

cc-bridge 当前飞书采用 webhook/event endpoint，不是 WebSocket。可迁移的思想是：

- 配置保存成功不等于平台已连接。
- 需要区分：参数完整、事件地址可复制、最近收到平台事件、回复 API 可用。
- 飞书第一版可以用“参数完整 + 最近一次事件成功 + 最近一次回复成功”作为 connected 状态。

## 页面目标

### 必须满足

- 左侧导航是统一网关入口，不出现单个平台名称。
- 页面能容纳未来多个平台，不使用横向平台 tabs 作为主导航。
- 每个平台默认只展示必备参数。
- 飞书主流程只展示：`app_id`、`app_secret`。
- 保留扫码连接能力。
- 高级配置默认折叠或移入二级入口。
- 前端用户可见文案不出现 Hermes 字样。

### 暂不解决

- 真正的一键 OAuth / 扫码授权飞书开放平台。
- 微信个人号协议内置。
- 多平台同时运行的完整后端抽象重构。
- 平台插件系统。

## 信息架构

页面采用三段式：

```text
消息网关页
  顶部：整体状态 / 刷新 / 诊断
  中部：平台卡片网格
  底部：最近活动 / 会话 / 高级配置
```

### 1. 顶部整体状态

内容：

- 标题：消息网关。
- 副标题：从一个入口连接多个消息平台到 Claude Code 会话。
- 总状态：
  - 未配置：没有任何平台参数完整。
  - 待启用：有平台参数完整但未开启。
  - 运行中：至少一个平台开启且最近状态正常。
  - 异常：至少一个已启用平台最近事件或回复失败。
- 操作：刷新、查看日志/诊断。

### 2. 平台卡片网格

不要使用 tabs。使用 responsive grid：

```text
[飞书]        [微信 即将支持]
[企业微信]    [Webhook]
[更多平台...]
```

每张卡片包含：

- 平台图标。
- 平台名称。
- 状态点：未配置 / 待启用 / 已启用 / 异常 / 即将支持。
- 一句话说明。
- 必备参数摘要。
- 主按钮：配置 / 继续配置 / 已连接 / 即将支持。

卡片适配规则：

- 桌面端：`grid-template-columns: repeat(auto-fit, minmax(260px, 1fr))`。
- 小屏：单列。
- 平台多时自然换行，不增加顶部横向滚动。
- 只展开当前选中的平台详情，其它平台仍保持卡片状态。

### 3. 平台详情抽屉 / 内联展开区

点击平台卡片后，在网格下方显示平台详情，不切换整页 tabs。

详情区结构：

```text
平台详情：飞书
  左侧/上方：扫码连接卡片
  右侧/下方：必备参数表单
  下方：高级设置 details
```

#### 扫码连接卡片

保留现有扫码视觉，但语义调整为“快捷连接”。

状态：

- 未配置：展示二维码占位 + “扫码或填写必备参数连接”。
- 参数缺失：扫码卡片下提示需要先填写必备参数。
- 可启用：显示开启开关和保存按钮。
- 已启用：显示已连接状态、最近事件时间。

重要约束：

- 如果当前后端不支持真实扫码授权，二维码只能作为快捷连接占位/引导，不能误导成真正完成授权。
- 可以保留二维码视觉入口，但必须配合必备参数填写。
- 后续如接入真实扫码授权，可把二维码区域替换为真实二维码图片和轮询状态。

#### 必备参数表单

每个平台只展示 manifest 中 `required_fields`。

飞书第一版：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `app_id` | text | 飞书开放平台应用 App ID |
| `app_secret` | password | 飞书开放平台应用 App Secret |

主流程不展示：

- `verification_token`
- `encrypt_key`
- `busy_mode`
- `allowed_users`
- `allowed_chats`
- scope/session 列表

这些全部放到高级设置或诊断区。

#### 高级设置

默认折叠，面向调试/安全配置：

- 事件订阅地址复制。
- Verification Token。
- Encrypt Key（后端支持前可置灰或隐藏）。
- Allow users。
- Allow chats。
- Busy mode。
- 重置/停止会话 scope。
- 最近事件和错误。

## 平台 manifest 设计

建议新增一个前端消费的 manifest，由后端返回。第一版可硬编码在 `server.py` 或 `feishu_gateway_store.py` 附近，后续再抽象。

```json
{
  "platforms": [
    {
      "id": "feishu",
      "label": "飞书",
      "status": "disabled",
      "enabled": false,
      "coming_soon": false,
      "description": "接收飞书应用消息并回复到原会话。",
      "required_fields": [
        {
          "name": "app_id",
          "label": "App ID",
          "type": "text",
          "placeholder": "cli_xxx",
          "required": true
        },
        {
          "name": "app_secret",
          "label": "App Secret",
          "type": "password",
          "required": true
        }
      ],
      "quick_connect": {
        "type": "qr",
        "available": true,
        "real_auth": false
      },
      "advanced_fields": [
        "verification_token",
        "allowed_users",
        "allowed_chats",
        "busy_mode"
      ]
    },
    {
      "id": "wechat",
      "label": "微信",
      "status": "coming_soon",
      "enabled": false,
      "coming_soon": true,
      "description": "预留微信消息入口。",
      "required_fields": []
    }
  ]
}
```

状态枚举：

```text
unconfigured   参数未填完整
disabled       参数完整但未启用
enabled        已启用，等待事件或无最近错误
connected      最近事件和回复成功
error          已启用但最近失败
coming_soon    暂未支持
```

## 后端 API 调整建议

保留现有飞书 API，同时新增统一页面 API。

### `GET /api/message-gateway/platforms`

返回平台 manifest + 当前配置摘要。

用途：

- 渲染平台卡片。
- 渲染 required fields。
- 判断状态点。

### `GET /api/message-gateway/platforms/{platform}`

返回单个平台完整配置，包含高级字段。

第一版可以只支持 `feishu`。

### `POST /api/message-gateway/platforms/{platform}`

保存单个平台配置。

请求体示例：

```json
{
  "enabled": true,
  "required": {
    "app_id": "cli_xxx",
    "app_secret": "..."
  },
  "advanced": {
    "verification_token": "...",
    "busy_mode": "queue",
    "allowed_users": [],
    "allowed_chats": []
  }
}
```

后端适配到当前 `feishu_gateway_store.py` 结构。

### 兼容策略

- 现有 `/api/feishu-gateway/config` 保留。
- 前端新页面优先调用统一 API。
- 第一版如不想改后端，也可以在前端通过现有飞书 API 组装单个平台 manifest，但这只是过渡方案。

## 前端落地建议

### HTML 结构

把当前单一二维码舞台改为：

```html
<section class="gateway-overview">...</section>
<section class="gateway-platform-grid">...</section>
<section class="gateway-platform-detail">...</section>
<section class="gateway-diagnostics">...</section>
```

保留现有 `page-feishu-gateway` id 以降低路由改动，但类名逐步改为 `message-gateway-*`。

### CSS 方向

新增通用类：

- `.message-gateway-shell`
- `.gateway-status-card`
- `.gateway-platform-grid`
- `.gateway-platform-card`
- `.gateway-platform-card.active`
- `.gateway-platform-detail`
- `.gateway-quick-connect-card`
- `.gateway-required-form`

逐步减少 `feishu-*` 视觉类的承担范围，只把平台特有样式留给图标或颜色。

### JS 状态

建议从飞书单状态：

```js
let feishuGatewayConfig = null;
let feishuGatewayScopes = [];
```

演进为：

```js
let messageGatewayPlatforms = [];
let messageGatewayConfigs = {};
let activeGatewayPlatform = 'feishu';
```

第一版可内部仍复用 `loadFeishuGatewayConfig()` / `saveFeishuGatewayConfig()`，但渲染层走平台 card/detail。

## 飞书第一版交互流程

### 首次进入

1. 顶部显示“未配置”。
2. 平台网格展示飞书卡片和微信“即将支持”卡片。
3. 飞书卡片状态为“未配置”。
4. 默认展开飞书详情。
5. 详情区展示扫码卡片 + `App ID` / `App Secret`。

### 填写参数

1. 用户填写 `App ID` 和 `App Secret`。
2. 点击保存。
3. 后端保存配置但不强制启用，或根据开关启用。
4. 状态更新为“待启用”或“已启用”。

### 扫码入口

1. 扫码卡片保留在详情区。
2. 如果真实扫码授权不可用，显示为快捷引导/占位。
3. 如果后续可生成真实二维码：
   - 后端提供 `qr_url` / `qr_image` / `qr_state`。
   - 前端轮询扫码状态。
   - 成功后自动刷新平台配置和状态。

### 高级配置

1. 用户点击“高级设置”。
2. 展示事件订阅地址、Verification Token、allowlist、busy mode。
3. scope/session 管理放到“会话”折叠区，不混在主配置表单中。

## 与当前实现的差异

当前页面已有：

- 左侧统一入口。
- 中心二维码卡片。
- 飞书配置加载保存。
- 飞书 scope 管理。
- 平台 tabs。

需要调整：

- 移除平台 tabs 主布局。
- 改为平台卡片网格。
- 主详情区只展示当前平台必备参数。
- 飞书主流程只保留 `app_id` / `app_secret`。
- 高级字段默认折叠。
- 类名和状态变量逐步从 `feishu-*` 过渡到 `message-gateway-*`。

## 推荐实施顺序

1. 前端先改布局：tabs -> 平台卡片网格 + 详情区。
2. 飞书详情主表单收敛为 `app_id` / `app_secret`。
3. 保留二维码卡片，但调整为详情区中的快捷连接区域。
4. 高级字段和 scope 管理折叠到详情下方。
5. i18n 同步中英文 key。
6. 用现有 `/api/feishu-gateway/*` 完成第一版，不改后端行为。
7. 后续再新增 `/api/message-gateway/platforms`，把平台 manifest 后端化。

## 验收标准

- 左侧导航文案为统一网关，不是飞书网关。
- 默认页面能看到多个平台卡片，新增平台不会挤爆布局。
- 飞书主流程只要求 `App ID` 和 `App Secret`。
- 扫码区域仍保留。
- Verification Token、allowlist、busy mode、sessions 不在默认主流程中出现。
- 页面用户可见文案不出现 Hermes 字样。
- `static/app.js` 通过 `node --check`。
- `static/i18n/en.json`、`static/i18n/zh.json` JSON 格式有效且 key 集合一致。

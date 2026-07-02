# 飞书扫码自动创建 Bot 设计

## 背景

参照 Hermes Agent 的飞书接入方式，实现扫码自动创建并绑定飞书 Bot 的完整流程。原方案需要用户手动去飞书开放平台创建应用、复制凭据、配置事件订阅，步骤繁琐。新方案通过飞书 OAuth App Registration API 实现一扫绑定。

## 整体流程

```text
用户点击「扫码创建 Bot」
  → 后端调用飞书设备码注册 API（begin）
  → 获取 verification_uri_complete
  → 前端渲染 QR 码
  → 用户飞书 App 扫码授权
  → 后端轮询注册状态（poll）
  → 授权成功后飞书自动创建应用，返回 app_id + app_secret
  → 自动填充凭据，启用 WebSocket 连接模式
  → 完成：Bot 即可接收和回复消息
```

## 对比

| | 原方案（手动） | 新方案（扫码） |
|---|---|---|
| **创建 Bot** | 用户手动去 open.feishu.cn 创建 | 扫码自动创建 |
| **获取凭据** | 手动复制粘贴 app_id / app_secret | API 自动返回 |
| **连接方式** | Webhook（需要公网可达 URL） | WebSocket（出站连接，无需公网 IP） |
| **QR 码内容** | 事件订阅 API 地址（无意义） | 飞书 OAuth 授权 URL |
| **用户体验** | 多步手动操作 | 一扫完成 |

## 飞书注册 API

Hermes 使用的 `/oauth/v1/app/registration` 端点（非官方文档，但由飞书 SDK 内部使用）：

### 端点

| Domain | URL |
|--------|-----|
| 飞书（中国） | `https://accounts.feishu.cn/oauth/v1/app/registration` |
| Lark（国际） | `https://accounts.larksuite.com/oauth/v1/app/registration` |

### 流程

#### 1. init — 验证环境

```http
POST /oauth/v1/app/registration
Content-Type: application/x-www-form-urlencoded

action=init
```

响应：
```json
{
  "supported_auth_methods": ["client_secret", ...]
}
```

检查 `client_secret` 是否在支持列表中。

#### 2. begin — 发起设备码注册

```http
POST /oauth/v1/app/registration
Content-Type: application/x-www-form-urlencoded

action=begin&archetype=PersonalAgent&auth_method=client_secret&request_user_info=open_id
```

响应：
```json
{
  "device_code": "xxx",
  "verification_uri_complete": "https://accounts.feishu.cn/oauth/device?xxx",
  "user_code": "ABC-123",
  "interval": 5,
  "expire_in": 600
}
```

`verification_uri_complete` 转换为 QR 码供用户扫描。

#### 3. poll — 轮询授权结果

```http
POST /oauth/v1/app/registration
Content-Type: application/x-www-form-urlencoded

action=poll&device_code=xxx&tp=ob_app
```

用户确认授权后返回：
```json
{
  "client_id": "cli_xxxx",
  "client_secret": "xxxxx",
  "user_info": {
    "open_id": "ou_xxx"
  }
}
```

- `client_id` → 即 `app_id`
- `client_secret` → 即 `app_secret`
- 轮询间隔 5s，超时 600s（10 分钟）
- `access_denied` 或 `expired_token` 表示失败

#### 4. probe_bot — 验证 Bot 连通性

调用飞书开放 API `/open-apis/bot/v3/info` 获取 Bot 名称和 open_id（best-effort，失败不阻塞注册流程）。

## 架构

### 新文件

| 文件 | 职责 |
|------|------|
| `feishu_onboard.py` | 设备码注册流程（纯标准库，不依赖 lark_oapi） |
| `docs/feishu-onboard-design.md` | 本文档 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `server.py` | 新增 `POST /api/feishu-gateway/onboard/begin`、`POST /api/feishu-gateway/onboard/poll`；config 响应增加 `lan_ips`、`ws_available`；POST config 保存后启动/停止 WebSocket |
| `feishu_gateway.py` | 新增 `FEISHU_WS_AVAILABLE` 标识；`FeishuGateway` 增加 WebSocket 长连接管理（`ensure_ws_running`、`stop_ws`）；线程桥接将 WS 事件投递到 asyncio 队列 |
| `feishu_gateway_store.py` | `update_feishu_gateway_config` 允许 `connection_mode` 字段 |
| `static/index.html` | 新增 `#feishu-onboard-area`（扫码创建区域）、`#feishu-event-qr-area`（已配置后显示）、`connection_mode` 选择器 |
| `static/app.js` | 新增 onboard 流程函数（`beginFeishuOnboard`/`pollFeishuOnboard`/`handleOnboardSuccess`）；UI 状态切换逻辑 |
| `static/style.css` | 新增 onboard spinner 动画 |
| `static/i18n/zh.json` | 新增 onboard 和 connection_mode 相关中文文案 |
| `static/i18n/en.json` | 新增 onboard 和 connection_mode 相关英文文案 |

### 新增 API

```text
POST /api/feishu-gateway/onboard/begin   — 发起注册
POST /api/feishu-gateway/onboard/poll    — 轮询注册状态
```

## WebSocket 连接模式

### 原理

WebSocket 模式使用 `lark_oapi.ws.Client`（飞书 SDK 内置长连接客户端）与飞书服务器建立持久连接：

- **出站连接**：cc-bridge → 飞书服务器（`wss://open.feishu.cn`），不接收外部入站请求
- **无需公网 IP**：NAT/局域网天然可用，是 QR 扫码创建的默认模式
- **心跳保活**：SDK 自动处理 ping/pong 和断线重连

### 与 Webhook 模式的对比

| | WebSocket | Webhook |
|---|---|---|
| 连接方向 | cc-bridge → 飞书（出站） | 飞书 → cc-bridge（入站） |
| 公网 IP | 不需要 | 需要 |
| 防火墙/NAT | 天然支持 | 需要端口映射 |
| 延迟 | 实时推送 | 实时推送 |
| 依赖 | `lark_oapi` + `websockets` | `lark_oapi` |
| 适用场景 | 个人/局域网部署 | 服务器部署 |

### 线程模型

```
asyncio event loop (main)
  └── asyncio.Queue (_ws_event_queue)
        ↑
        │ loop.call_soon_threadsafe()
        │
Thread: feishu-ws (daemon)
  └── lark_oapi.ws.Client.start()
        └── _BridgeHandler.do_without_validation(payload)
              └── 解析 JSON → 投递到 asyncio 队列
```

## 使用流程

1. 打开 cc-bridge → 消息网关 → 飞书
2. 点击「扫码创建 Bot」
3. 用飞书 App 扫描弹出（或手动打开链接）的 QR 码
4. 在飞书中确认授权
5. 等待自动完成（约 3-5 秒轮询间隔）
6. 凭据自动填充，连接模式默认 WebSocket
7. 点击保存，即可在飞书中 @Bot 发送消息

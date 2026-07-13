# 生图能力接入设计

## 背景

当前 ccb-gui 是 Claude Code CLI 的轻量 GUI：

```text
浏览器 -> server.py REST/SSE -> ccb_bridge.py -> ccb/claude CLI
```

Claude 负责文本对话、代码任务和工具调用；现有 `model-select` 表示 Claude Code CLI 的 `--model` 参数。生图模型来自 OpenAI、Gemini/Imagen、FLUX、Stability 等外部服务，接口形态、认证方式、返回格式和异步模型差异较大，不应混入现有 Claude CLI 会话链路。

本设计目标是在保持现有聊天能力稳定的前提下，新增一套可扩展的图片生成能力。第一版落地 OpenAI 与 Gemini 两个 Provider，后续可继续接入 FLUX、Stability、Replicate、fal.ai、国内云厂商或 Claude Code MCP/custom tool。

---

## 设计原则

1. **与 Claude CLI 会话解耦**
   - 不修改 `ccb_bridge.py` 的核心发送、流式、resume 逻辑。
   - 不把生图模型混入现有 Claude `model-select`。
   - 生图走独立 REST API 和独立 Provider 抽象。

2. **Provider 可插拔**
   - 后端定义统一请求/响应模型。
   - OpenAI、Gemini 分别实现 Provider。
   - 公共参数保持精简，厂商特有参数放入 `extra`。

3. **图片落盘，不内联 Base64**
   - Provider 返回的 Base64 或远程 URL 统一转成本地文件。
   - 文件保存到当前 cwd 的 `.gui-uploads/generated/`。
   - 前端只拿 `/api/file?path=...` URL，不通过 SSE 或聊天消息传大 Base64。

4. **复用现有安全边界**
   - 生成图片路径必须位于 `.gui-uploads/` 下。
   - 图片访问复用 `/api/file` 与 `is_allowed_upload_path()`。
   - 文件名使用 UUID，不信任用户 prompt 或模型返回文件名。

5. **前端结构化渲染**
   - 不依赖 Markdown 图片语法。
   - 使用结构化 `generated_image` 数据渲染图片卡片。
   - `<img>` 通过 DOM API 创建，并限制 src 只能是同源 `/api/file?...`。

6. **第一版同步，后续异步**
   - 第一版 `POST /api/images/generate` 等待生成完成后返回。
   - 后续接入异步 Provider 时再引入 task API 与 SSE 进度事件。

---

## 功能范围

### 第一版支持

- 输入框左下角按钮区域新增“生图”按钮。
- 点击按钮进入一次性生图模式或打开轻量配置面板。
- 支持 Provider：
  - OpenAI
  - Gemini
- 支持参数：
  - prompt
  - provider
  - model
  - size 或 aspect_ratio
  - quality，可选
  - n，第一版可限制为 1-4
- 生成完成后在聊天消息区插入图片卡片。
- 图片保存到 `.gui-uploads/generated/`。
- 返回图片可下载、复制本地路径、复制图片 URL。

### 第一版暂不支持

- 图片编辑 / 局部重绘。
- 参考图输入。
- 异步任务队列和取消。
- 生图结果写入 Claude CLI 原生 session jsonl。
- Claude 自动调用生图工具。
- 多 Provider 高级参数完整暴露。

### 后续扩展

- 参考图生图 / 图生图。
- Gemini 图片编辑。
- Replicate / fal.ai / FLUX / Stability Provider。
- 异步任务：`POST /api/images/tasks` + `GET /api/images/tasks/{id}`。
- SSE 事件：`image_generation_started/progress/completed/error`。
- Claude Code MCP/custom tool：`generate_image`。
- Artifacts 页面图片集合与历史恢复。

---

## 用户交互设计

### 输入框左下角按钮

当前输入框左下角已有附件按钮：

```html
<div class="composer-tool-row" aria-label="Composer tools">
  <button id="btn-attach" class="btn-attach composer-tool-btn" ...></button>
</div>
```

新增按钮放在同一行，位于附件按钮之后：

```html
<button id="btn-generate-image" class="composer-tool-btn" type="button" title="Generate image" data-i18n-title="generateImage" aria-label="Generate image">
  ...
</button>
```

推荐图标：小图片/魔法棒 SVG。按钮状态：

- 默认可用：点击打开生图面板。
- 请求中禁用，显示 loading 状态。
- 未配置 Provider key 时点击弹出配置提示。

### 生图面板

第一版可采用输入框上方浮层或轻量 modal，字段：

```text
Provider: OpenAI / Gemini
Model: 根据 provider 动态选择
Size / Aspect Ratio
Quality
Prompt: 默认取当前输入框内容，可编辑
[生成图片]
```

行为：

1. 用户在主输入框输入提示词。
2. 点击左下角“生图”按钮。
3. 面板自动带入当前输入框内容作为 prompt。
4. 用户确认参数后发送到 `/api/images/generate`。
5. 前端插入一条用户消息，显示 prompt 和参数摘要。
6. 前端插入 assistant 图片消息占位，显示“正在生成图片...”。
7. API 返回后更新占位为图片卡片。
8. 失败时将占位更新为错误消息。

第一版也可以跳过 modal：点击按钮直接使用当前默认 Provider/模型生成，长按或二级按钮打开设置。但为了多 Provider 可扩展性，推荐第一版就提供轻量参数面板。

---

## 后端架构

### 新增模块

```text
image_generation/
├── __init__.py
├── base.py              # 数据模型、Provider 抽象、错误类型
├── service.py           # Provider 选择、参数校验、落盘、统一响应
├── openai_provider.py   # OpenAI 图片生成适配器
└── gemini_provider.py   # Gemini 图片生成适配器
```

后续 Provider 继续扩展：

```text
image_generation/
├── stability_provider.py
├── replicate_provider.py
├── fal_provider.py
└── domestic_provider.py
```

### 数据模型

```python
@dataclass
class ImageGenerationRequest:
    provider: str
    model: str
    prompt: str
    cwd: str = ""
    size: str = "1024x1024"
    aspect_ratio: str = ""
    quality: str = ""
    n: int = 1
    input_images: list[str] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)

@dataclass
class GeneratedImage:
    path: str
    url: str
    mime_type: str
    name: str
    width: int | None = None
    height: int | None = None

@dataclass
class ImageGenerationResult:
    provider: str
    model: str
    prompt: str
    images: list[GeneratedImage]
    request_id: str = ""
    usage: dict[str, Any] = field(default_factory=dict)
```

### Provider 抽象

```python
class ImageProvider:
    name: str

    def models(self) -> list[dict]:
        raise NotImplementedError

    async def generate(self, request: ImageGenerationRequest) -> ImageGenerationResult:
        raise NotImplementedError
```

Provider 只负责调用外部 API 并返回图片 bytes、Base64 或远程 URL 的中间结果；文件命名、路径安全和 `/api/file` URL 由 `service.py` 统一处理，避免每个 Provider 各自处理落盘规则。

### Provider 中间结果

```python
@dataclass
class ProviderImagePayload:
    data: bytes | None = None
    b64_json: str = ""
    url: str = ""
    mime_type: str = "image/png"
```

`service.py` 负责：

1. 校验 provider/model/prompt/n。
2. 校验 cwd，无法使用 cwd 时回退到 `uploads/generated/` 或返回错误。
3. 调用 Provider。
4. 将 Base64/URL/bytes 统一保存为文件。
5. 返回统一 JSON。

---

## Provider 设计

### OpenAI Provider

默认模型：

```text
gpt-image-1
```

配置：

```text
OPENAI_API_KEY
OPENAI_BASE_URL，可选
```

第一版请求字段映射：

| 内部字段 | OpenAI 字段 |
|---|---|
| `model` | `model` |
| `prompt` | `prompt` |
| `size` | `size` |
| `quality` | `quality` |
| `n` | `n` |

返回支持：

- `b64_json`
- `url`，如 Provider 或配置返回 URL

第一版优先使用标准库 `urllib.request`，避免新增 SDK 依赖；后续如需要图片编辑、流式或更复杂认证，可改为官方 SDK。

### Gemini Provider

默认模型可配置为：

```text
gemini-2.5-flash-image
```

如果用户所在账号只开放其他图像模型，可在配置中覆盖。

配置：

```text
GEMINI_API_KEY 或 GOOGLE_API_KEY
GEMINI_BASE_URL，可选
```

请求使用 `generateContent` 形态，内部字段映射：

| 内部字段 | Gemini 字段 |
|---|---|
| `model` | URL 中的 model |
| `prompt` | `contents[].parts[].text` |
| `aspect_ratio` | 可进入 `generationConfig` 或 `extra`，按实际模型能力适配 |
| `n` | 第一版可限制为 1 |

返回解析：

```text
candidates[].content.parts[].inlineData.data
candidates[].content.parts[].inline_data.data
```

需要兼容 snake_case 与 camelCase 字段。

Gemini 图片模型的命名和可用性变化较快，因此模型列表应来自配置默认值 + 内置候选，不应写死只有一个模型。

---

## 后端 API

### `GET /api/images/models`

返回前端可选 Provider 与模型：

```json
{
  "providers": [
    {
      "id": "openai",
      "name": "OpenAI",
      "configured": true,
      "models": [
        { "id": "gpt-image-1", "name": "GPT Image 1", "default": true }
      ],
      "sizes": ["1024x1024", "1536x1024", "1024x1536"],
      "qualities": ["low", "medium", "high"]
    },
    {
      "id": "gemini",
      "name": "Gemini",
      "configured": false,
      "models": [
        { "id": "gemini-2.5-flash-image", "name": "Gemini 2.5 Flash Image", "default": true }
      ],
      "aspect_ratios": ["1:1", "16:9", "9:16", "4:3", "3:4"]
    }
  ],
  "defaults": {
    "provider": "openai",
    "model": "gpt-image-1",
    "size": "1024x1024",
    "quality": "medium"
  }
}
```

`configured` 只表示服务端是否能读到对应 API key 环境变量，不返回 key 内容。

### `POST /api/images/generate`

请求：

```json
{
  "provider": "openai",
  "model": "gpt-image-1",
  "prompt": "一只坐在窗边的橘猫",
  "cwd": "D:/work/project",
  "size": "1024x1024",
  "quality": "medium",
  "n": 1,
  "extra": {}
}
```

响应：

```json
{
  "ok": true,
  "provider": "openai",
  "model": "gpt-image-1",
  "prompt": "一只坐在窗边的橘猫",
  "images": [
    {
      "type": "generated_image",
      "name": "generated_abc.png",
      "path": "D:/work/project/.gui-uploads/generated/generated_abc.png",
      "url": "/api/file?path=...",
      "mime_type": "image/png",
      "width": 1024,
      "height": 1024
    }
  ],
  "request_id": "...",
  "usage": {}
}
```

错误响应：

```json
{
  "ok": false,
  "error": "未配置 OPENAI_API_KEY"
}
```

### `GET /api/images/settings`

可选。返回 GUI 偏好，不含密钥：

```json
{
  "provider": "openai",
  "model": "gpt-image-1",
  "size": "1024x1024",
  "quality": "medium"
}
```

### `POST /api/images/settings`

可选。保存 GUI 偏好到 `~/.ccb/gui_settings.json`：

```json
{
  "provider": "openai",
  "model": "gpt-image-1",
  "size": "1024x1024",
  "quality": "medium"
}
```

---

## 配置设计

### GUI 偏好

保存在 `~/.ccb/gui_settings.json`：

```json
{
  "image_generation": {
    "provider": "openai",
    "model": "gpt-image-1",
    "size": "1024x1024",
    "quality": "medium"
  }
}
```

### 环境变量

密钥不保存到 GUI 设置中，服务端只从环境变量读取：

```text
OPENAI_API_KEY=...
OPENAI_BASE_URL=...
GEMINI_API_KEY=...
GOOGLE_API_KEY=...
GEMINI_BASE_URL=...
```

如果需要在设置页配置环境变量，可复用现有 `/api/env`，但前端展示时应避免明文回显敏感值；可沿用现有 env 管理规则。

---

## 文件落盘与安全

### 保存目录

优先保存到：

```text
<cwd>/.gui-uploads/generated/
```

如果 cwd 无效：

- 第一版建议直接返回错误，让用户选择有效工作目录。
- 不建议悄悄写入仓库根目录，避免图片和项目上下文错位。

### 文件名

```text
generated_<uuid>.<ext>
```

扩展名从 MIME 推断：

| MIME | 扩展名 |
|---|---|
| `image/png` | `.png` |
| `image/jpeg` | `.jpg` |
| `image/webp` | `.webp` |

不使用 prompt、URL basename 或 Provider 返回文件名作为最终文件名。

### 路径访问

响应中的 URL 使用：

```text
/api/file?path=<urlencoded absolute path>
```

该 path 必须通过 `is_allowed_upload_path()`，即位于 `.gui-uploads/` 或 fallback uploads 下。

### 限制

第一版建议限制：

- prompt 最大 4000 字符。
- `n` 最大 4。
- 下载远程图片最大 20MB。
- 只接受 `image/png`、`image/jpeg`、`image/webp`。
- Provider 请求超时 120 秒。
- URL 下载只允许 `https://`。

---

## 前端架构

### 新增模块

```text
static/js/image-generation.js
```

职责：

- 管理生图按钮和参数面板。
- 拉取 `/api/images/models`。
- 读取/保存默认偏好。
- 调用 `/api/images/generate`。
- 插入用户 prompt 消息和图片结果消息。
- 处理 loading、错误、重试。

建议对外暴露：

```javascript
window.CCBridge.imageGeneration = {
  initImageGeneration,
  openImagePanel,
  generateImage,
  renderGeneratedImages,
};
```

### 图片消息结构

```javascript
{
  type: 'generated_image',
  provider: 'openai',
  model: 'gpt-image-1',
  prompt: '一只坐在窗边的橘猫',
  images: [
    {
      name: 'generated_xxx.png',
      path: 'D:/.../.gui-uploads/generated/generated_xxx.png',
      url: '/api/file?path=...',
      mime_type: 'image/png'
    }
  ]
}
```

### 渲染方式

图片卡片由 DOM API 创建，禁止拼接未校验 URL 到 `innerHTML`。

```javascript
function isSafeGeneratedImageUrl(url) {
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.origin === window.location.origin && parsed.pathname === '/api/file';
  } catch (_) {
    return false;
  }
}
```

卡片内容：

```text
[图片缩略图]
Prompt: ...
Provider / Model
[打开] [下载] [复制路径]
```

### 与 chat-renderer 的关系

第一版可以直接通过 `message-ui.js` 新增：

```javascript
addGeneratedImageMessage(result)
```

并插入独立 assistant 气泡。

如果要支持刷新后恢复历史，则需要同步扩展：

- `chat-renderer.js renderBlock()` 支持 `generated_image`。
- `renderHistory()` / `prependHistory()` 支持 `generated_image`。
- 后端需要将生图结果写入可恢复的历史或 artifact store。

第一版建议先保证当前 UI 展示和文件落盘；历史恢复作为后续扩展。

---

## 与现有 Artifacts 的关系

当前 `artifact_store.py` 已能识别 Markdown 图片和图片扩展。生图结果落盘后，可以在后续版本将结果登记为 artifact：

```json
{
  "kind": "image",
  "source": "image_generation",
  "path": "...",
  "prompt": "...",
  "provider": "openai",
  "model": "gpt-image-1"
}
```

第一版不强依赖 artifacts 页面，但文件路径位于 `.gui-uploads/`，后续接入成本较低。

---

## 异步任务扩展预留

接入 Replicate、fal.ai 或国内任务式 API 后，新增：

```text
POST /api/images/tasks
GET  /api/images/tasks/{task_id}
POST /api/images/tasks/{task_id}/cancel
```

SSE 事件：

```json
{ "type": "image_generation_started", "task_id": "..." }
{ "type": "image_generation_progress", "task_id": "...", "progress": 60 }
{ "type": "image_generation_completed", "task_id": "...", "images": [...] }
{ "type": "image_generation_error", "task_id": "...", "error": "..." }
```

注意：SSE 中只传状态和图片 URL/path，不传图片 Base64。

---

## Claude 工具调用扩展预留

后续将 `image_generation.service` 包装为 MCP/custom tool：

```json
{
  "name": "generate_image",
  "description": "根据提示词生成图片，并返回本地图片文件 URL。适合用户明确要求生成图片、封面、插画、UI 配图时调用。",
  "input_schema": {
    "type": "object",
    "properties": {
      "prompt": { "type": "string" },
      "provider": { "type": "string", "enum": ["openai", "gemini"] },
      "model": { "type": "string" },
      "size": { "type": "string" }
    },
    "required": ["prompt"]
  }
}
```

工具返回：

```json
{
  "images": [
    {
      "url": "/api/file?path=...",
      "path": "...",
      "mime_type": "image/png"
    }
  ]
}
```

Claude 可继续用文字解释图片用途，GUI 负责根据结构化结果展示图片。

---

## 实施步骤

### Step 1：后端抽象与 OpenAI/Gemini Provider

- 新增 `image_generation/base.py`。
- 新增 `image_generation/service.py`。
- 新增 `image_generation/openai_provider.py`。
- 新增 `image_generation/gemini_provider.py`。
- 支持将 Provider 返回内容保存到 `.gui-uploads/generated/`。

### Step 2：后端 API

- 在 `server.py` 的 `handle_api_get()` 增加 `/api/images/models`。
- 在 `server.py` 的 `handle_api_post()` 增加 `/api/images/generate`。
- 错误统一返回 JSON：`{"ok": false, "error": "..."}`。

### Step 3：前端入口

- 在 `static/index.html` 输入框左下角按钮区域新增生图按钮。
- 新增 `static/js/image-generation.js`。
- 在主脚本加载和初始化链路中注册该模块。

### Step 4：前端渲染

- 新增图片生成面板。
- 新增图片结果卡片。
- 使用 DOM API 安全渲染图片。
- i18n 增加中英文案。

### Step 5：验证

- 未配置 API key 时有清晰错误。
- OpenAI 生成图片并保存到 `.gui-uploads/generated/`。
- Gemini 生成图片并保存到 `.gui-uploads/generated/`。
- `/api/file?path=...` 可访问生成图片。
- 图片 URL 不能越权访问非 `.gui-uploads` 文件。
- 普通 Claude 聊天不受影响。

---

## 风险与约束

1. **Provider API 变化**
   - Gemini 图片模型命名和响应字段可能变化，Provider 解析需要宽容处理。

2. **网络与超时**
   - 生图请求通常比文本请求慢，第一版同步 HTTP 需要合理超时。

3. **密钥管理**
   - 不在 GUI settings 明文保存 API key。

4. **历史恢复**
   - 第一版如果只插入 DOM，刷新后图片消息不恢复。后续需接入 session history 或 artifacts。

5. **成本提示**
   - 生图调用通常单独计费，后续可在 UI 标明 provider/model，避免用户误以为是 Claude 聊天 token 成本。

6. **安全渲染**
   - 不放宽 Markdown 链接白名单。
   - 不允许任意 `img src`。
   - 只允许同源 `/api/file` 图片。

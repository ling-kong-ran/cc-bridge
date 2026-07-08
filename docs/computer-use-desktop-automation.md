# Computer Use 桌面自动化设计

## 目标

让 Agent 可以通过自定义 MCP 工具启动和操作桌面应用：启动进程、查找窗口、读取控件树、点击按钮、输入文本、发送按键。实现应优先走操作系统的 Accessibility / UI Automation 能力，而不是移动真实鼠标或接管用户当前键盘。

## 边界

- 不做全局 `SendInput` / 真实鼠标移动作为默认能力。
- 不绕过应用安全边界、系统权限弹窗或登录/支付/高风险确认流程。
- 默认只操作明确启动或明确匹配到的目标应用窗口。
- 工具调用写入 `~/.ccb/computer_use_audit.log`，便于审计。
- 浏览器网页测试后续可单独接 Playwright；本设计面向通用桌面应用。

## 目录结构

```text
custom_tools/
  registry.py                       # 自定义工具 manifest 统一注册
  computer_use/
    mcp_server.py                   # stdio MCP server，暴露 tools/list 和 tools/call
    driver.py                       # 按平台加载 driver
    drivers/
      base.py                       # 安全兜底驱动
      windows.py                    # Windows pywinauto/UIA 驱动
      macos.py                      # macOS Accessibility 预留
      linux.py                      # Linux AT-SPI 预留
```

## MCP 工具

基础目标能力：

- `computer_list_targets`：列出可操作目标。
- `computer_get_target`：读取目标信息。
- `computer_screenshot`：读取目标截图或占位截图。
- `computer_click`：目标内坐标点击。
- `computer_type_text`：目标内文本输入。
- `computer_key`：目标内按键。

桌面应用自动化能力：

- `computer_launch_app`：启动应用，返回窗口/进程信息。
- `computer_list_windows`：列出可见窗口。
- `computer_find_window`：按标题/进程名匹配窗口。
- `computer_list_controls`：列出窗口内控件树摘要。
- `computer_click_control`：按控件标识或属性点击按钮/菜单等。
- `computer_set_text`：给输入框设置文本。
- `computer_get_text`：读取窗口或控件文本。
- `computer_wait_for`：等待窗口或控件出现。

## Windows 实现

第一版使用 `pywinauto`：

- `Application(backend="uia").start(command)` 启动应用。
- `Desktop(backend="uia").windows()` 枚举窗口。
- `window.descendants()` 获取控件树。
- 优先使用 UIA 控件语义操作：`invoke()`、`set_edit_text()`、`type_keys()`。
- 坐标点击使用 `click_input()`，仅对目标窗口/控件执行；如果系统要求前台焦点，由驱动返回提示，不静默切换用户当前操作上下文。

如果未安装 `pywinauto`，Windows 驱动回退到 `base.py` 的安全占位能力，并在工具结果里提示安装依赖。

## Agent 使用流程

典型流程：

1. `computer_launch_app` 启动应用。
2. `computer_find_window` 确认目标窗口。
3. `computer_list_controls` 查看可操作控件。
4. `computer_click_control` 点击按钮或菜单。
5. `computer_set_text` / `computer_type_text` 输入内容。
6. `computer_get_text` 或 `computer_screenshot` 检查结果。

## 安全策略

- 所有变更类动作记录 action、target、参数摘要。
- 工具描述明确“只操作受控目标，不控制当前真实键鼠”。
- 失败时返回错误原因，不自动退化为全局输入注入。
- 后续可增加 GUI 侧“允许桌面自动化写入/点击”的二级开关。

"""
Config Manager - 管理 CCB 配置文件（settings.json、skills、agents）
"""
import json
import os
from pathlib import Path
from typing import Any
import re

CLAUDE_DIR = Path(os.environ.get("USERPROFILE", "~")) / ".claude"
CCB_DIR = Path.home() / ".ccb"
SETTINGS_FILE = CLAUDE_DIR / "settings.json"
CLAUDE_JSON_FILE = Path.home() / ".claude.json"
GUI_SETTINGS_FILE = CCB_DIR / "gui_settings.json"
ENV_PROFILES_FILE = CCB_DIR / "env_profiles.json"
SKILLS_DIR = CLAUDE_DIR / "skills"
AGENTS_DIR = CLAUDE_DIR / "agents"


def _normalize_mcp_server(name: str, config: Any, scope: str) -> dict[str, Any]:
    """把 MCP 配置规整成前端易展示的结构。"""
    if not isinstance(config, dict):
        config = {}
    transport = str(config.get("type") or "").strip().lower()
    url = str(config.get("url") or "").strip()
    command = str(config.get("command") or "").strip()
    if not transport:
        transport = "url" if url else "stdio"
    return {
        "name": name,
        "scope": scope,
        "type": transport,
        "command": command,
        "args": config.get("args") if isinstance(config.get("args"), list) else [],
        "env": config.get("env") if isinstance(config.get("env"), dict) else {},
        "url": url,
        "raw": config,
    }


def _read_json_file(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def _write_json_file(path: Path, data: dict[str, Any]):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def _project_mcp_file(cwd: str = "") -> Path | None:
    if not cwd:
        return None
    try:
        root = Path(cwd).expanduser().resolve()
    except (OSError, RuntimeError):
        return None
    if not root.exists() or not root.is_dir():
        return None
    return root / ".mcp.json"


def _project_key(cwd: str = "") -> str:
    if not cwd:
        return ""
    try:
        return str(Path(cwd).expanduser().resolve()).replace("\\", "/")
    except (OSError, RuntimeError):
        return str(cwd).replace("\\", "/")


def _read_legacy_claude_config() -> dict[str, Any]:
    """读取 Claude Code 仍在使用的 ~/.claude.json（包含项目级与全局 MCP）。"""
    return _read_json_file(CLAUDE_JSON_FILE)


def _legacy_global_mcp() -> dict[str, Any]:
    data = _read_legacy_claude_config().get("mcpServers", {})
    return data if isinstance(data, dict) else {}


def _legacy_project_mcp(cwd: str = "") -> dict[str, Any]:
    key = _project_key(cwd)
    if not key:
        return {}
    projects = _read_legacy_claude_config().get("projects", {})
    if not isinstance(projects, dict):
        return {}
    project = projects.get(key) or projects.get(key.replace("/", "\\")) or {}
    data = project.get("mcpServers", {}) if isinstance(project, dict) else {}
    return data if isinstance(data, dict) else {}


def _append_mcp_servers(servers: list[dict[str, Any]], configs: dict[str, Any], scope: str, seen: set[tuple[str, str]]):
    for name, config in configs.items():
        key = (scope, str(name))
        if key in seen:
            continue
        seen.add(key)
        servers.append(_normalize_mcp_server(str(name), config, scope))


def list_mcp_servers(cwd: str = "") -> list[dict[str, Any]]:
    """列出 Claude Code 可用 MCP：settings.json、~/.claude.json 和当前项目 .mcp.json。"""
    servers: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    global_mcp = get_settings().get("mcpServers", {})
    if isinstance(global_mcp, dict):
        _append_mcp_servers(servers, global_mcp, "global", seen)
    _append_mcp_servers(servers, _legacy_global_mcp(), "global", seen)

    project_file = _project_mcp_file(cwd)
    if project_file:
        project_mcp = _read_json_file(project_file).get("mcpServers", {})
        if isinstance(project_mcp, dict):
            _append_mcp_servers(servers, project_mcp, "project", seen)
    _append_mcp_servers(servers, _legacy_project_mcp(cwd), "project", seen)

    return sorted(servers, key=lambda item: (item.get("scope") != "global", item.get("name", "").lower()))


def save_mcp_server(data: dict[str, Any]) -> dict[str, Any]:
    """新增或覆盖 MCP 配置。支持 stdio(command/args/env) 与 url(url/type)。"""
    name = str(data.get("name", "")).strip()
    if not name or not re.match(r"^[A-Za-z0-9_.-]{1,64}$", name):
        raise ValueError("invalid MCP name")

    scope = str(data.get("scope") or "global").strip().lower()
    if scope not in ("global", "project"):
        scope = "global"

    server_type = str(data.get("type") or "stdio").strip().lower()
    if server_type in ("sse", "http", "url"):
        url = str(data.get("url", "")).strip()
        if not (url.startswith("http://") or url.startswith("https://")):
            raise ValueError("url required")
        config: dict[str, Any] = {"type": server_type, "url": url}
    else:
        command = str(data.get("command", "")).strip()
        if not command:
            raise ValueError("command required")
        args = data.get("args", [])
        if isinstance(args, str):
            args = [part for part in args.split() if part]
        if not isinstance(args, list):
            args = []
        env = data.get("env", {})
        if not isinstance(env, dict):
            env = {}
        config = {"command": command}
        if args:
            config["args"] = [str(arg) for arg in args]
        if env:
            config["env"] = {str(k): str(v) for k, v in env.items() if str(k).strip()}

    if scope == "project":
        project_file = _project_mcp_file(str(data.get("cwd", "")))
        if not project_file:
            raise ValueError("valid cwd required")
        root = _read_json_file(project_file)
        if not isinstance(root.get("mcpServers"), dict):
            root["mcpServers"] = {}
        root["mcpServers"][name] = config
        _write_json_file(project_file, root)
    else:
        settings = get_settings()
        if not isinstance(settings.get("mcpServers"), dict):
            settings["mcpServers"] = {}
        settings["mcpServers"][name] = config
        save_settings(settings)

    return _normalize_mcp_server(name, config, scope)


# 项目级配置
PROJECT_DIR = Path(__file__).parent.parent
PROJECT_SETTINGS = PROJECT_DIR / "settings.json"


def get_settings() -> dict[str, Any]:
    """读取全局 settings.json"""
    if SETTINGS_FILE.exists():
        return json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    return {}


def save_settings(data: dict[str, Any]):
    """保存全局 settings.json"""
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(
        json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def get_env_config() -> dict[str, str]:
    """获取 env 配置段"""
    settings = get_settings()
    return settings.get("env", {})


def update_env_config(env: dict[str, str]):
    """更新 env 配置段"""
    settings = get_settings()
    settings["env"] = env
    save_settings(settings)


def get_gui_settings() -> dict[str, Any]:
    """读取 GUI 偏好设置（存储在用户目录 ~/.ccb 下）。"""
    if GUI_SETTINGS_FILE.exists():
        try:
            return json.loads(GUI_SETTINGS_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def save_gui_settings(data: dict[str, Any]):
    """保存 GUI 偏好设置到用户目录 ~/.ccb/gui_settings.json。"""
    GUI_SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    GUI_SETTINGS_FILE.write_text(
        json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def update_gui_settings(data: dict[str, Any]) -> dict[str, Any]:
    """合并更新 GUI 偏好设置。"""
    settings = get_gui_settings()
    settings.update(data)
    save_gui_settings(settings)
    return settings


# ─── 环境变量配置方案 ─────────────────────────────────────────
def get_env_profiles() -> dict[str, Any]:
    """读取所有环境变量配置方案。"""
    if ENV_PROFILES_FILE.exists():
        try:
            return json.loads(ENV_PROFILES_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {"profiles": {}}
    return {"profiles": {}}


def save_env_profile(name: str, env: dict[str, str]):
    """保存或覆盖一个环境变量配置方案。"""
    data = get_env_profiles()
    if "profiles" not in data:
        data["profiles"] = {}
    data["profiles"][name] = {"env": env}
    ENV_PROFILES_FILE.parent.mkdir(parents=True, exist_ok=True)
    ENV_PROFILES_FILE.write_text(
        json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def delete_env_profile(name: str):
    """删除一个环境变量配置方案。"""
    data = get_env_profiles()
    if "profiles" in data and name in data["profiles"]:
        del data["profiles"][name]
        ENV_PROFILES_FILE.write_text(
            json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
        )


def list_skills() -> list[dict[str, str]]:
    """列出所有已安装的 skills"""
    skills = []
    if not SKILLS_DIR.exists():
        return skills

    for skill_dir in SKILLS_DIR.iterdir():
        if skill_dir.is_dir():
            skill_file = skill_dir / "SKILL.md"
            if skill_file.exists():
                content = skill_file.read_text(encoding="utf-8")
                # 解析 frontmatter
                name = skill_dir.name
                description = ""
                if content.startswith("---"):
                    parts = content.split("---", 2)
                    if len(parts) >= 3:
                        for line in parts[1].strip().split("\n"):
                            if line.startswith("name:"):
                                name = line.split(":", 1)[1].strip().strip('"\'')
                            elif line.startswith("description:"):
                                description = line.split(":", 1)[1].strip().strip('"\'')
                skills.append({
                    "name": name,
                    "dir": skill_dir.name,
                    "description": description,
                })
    return skills


AGENT_FRONTMATTER_FIELDS = ["name", "description", "tools", "disallowedTools", "model",
                             "permissionMode", "maxTurns", "skills", "mcpServers", "memory",
                             "background", "effort", "isolation", "color", "initialPrompt"]

PROJECT_AGENTS_DIR_TEMPLATE = ".claude/agents"


def _parse_agent_file(file_path: Path) -> dict:
    """解析 agent .md 文件，返回完整 frontmatter 与 body。"""
    content = file_path.read_text(encoding="utf-8")
    name = file_path.stem
    frontmatter = {}
    body = ""

    if content.startswith("---"):
        parts = content.split("---", 2)
        if len(parts) >= 3:
            fm_text = parts[1].strip()
            body = parts[2].strip()
            for line in fm_text.split("\n"):
                line = line.strip()
                if not line or ":" not in line:
                    continue
                key, _, val = line.partition(":")
                key = key.strip()
                val = val.strip().strip('"\'')
                if key == "tools" or key == "disallowedTools" or key == "skills":
                    val_list = [v.strip() for v in val.replace(",", " ").split() if v.strip()]
                    frontmatter[key] = val_list
                elif key == "mcpServers":
                    # 不解析复杂结构，标记存在即可
                    frontmatter[key] = True
                elif key == "maxTurns":
                    try:
                        frontmatter[key] = int(val)
                    except ValueError:
                        frontmatter[key] = val
                elif key == "background":
                    frontmatter[key] = val.lower() == "true"
                elif key in AGENT_FRONTMATTER_FIELDS:
                    frontmatter[key] = val
            if "name" in frontmatter:
                name = frontmatter["name"]
    else:
        body = content.strip()
        # 提取首行作为 description fallback
        first_line = next((l for l in body.split("\n") if l.strip()), "")
        if first_line:
            frontmatter["description"] = first_line.strip()

    frontmatter.setdefault("description", "")
    return {"name": name, "file": file_path.name, "scope": "user", **frontmatter, "body": body}


def _scan_agents_dir(agents_dir: Path, scope: str) -> list[dict]:
    """扫描指定目录下的 agent .md 文件。"""
    agents = []
    if not agents_dir.exists():
        return agents
    for agent_file in sorted(agents_dir.iterdir()):
        if agent_file.suffix == ".md":
            agent = _parse_agent_file(agent_file)
            agent["scope"] = scope
            agents.append(agent)
    return agents


def list_agents() -> list[dict]:
    """列出所有已配置的 agents（用户级 + 当前项目级）。"""
    # 如果当前工作目录下有 .claude/agents/，同时扫描项目级
    agents = _scan_agents_dir(AGENTS_DIR, "user")
    try:
        cwd = Path.cwd()
        project_dir = cwd / PROJECT_AGENTS_DIR_TEMPLATE
        if project_dir != AGENTS_DIR and project_dir.exists():
            project_agents = _scan_agents_dir(project_dir, "project")
            # 项目级同名 agent 覆盖用户级
            user_names = {a["name"] for a in agents}
            for pa in project_agents:
                if pa["name"] in user_names:
                    agents = [a for a in agents if a["name"] != pa["name"]]
                agents.append(pa)
    except (OSError, RuntimeError):
        pass
    return agents


def get_agent(name: str) -> dict | None:
    """获取单个 agent 的完整定义。"""
    for agent in list_agents():
        if agent["name"] == name:
            return agent
    return None


# Windows 命令行限制约 32KB，--agents 的 JSON 文本需控制在此之下。
# prompt 来自 agent .md 的 body，可能很长；超过此值则截断。
MAX_AGENT_PROMPT_CHARS = 20000


def get_agents_for_cli(names: list[str], cwd: str = "") -> dict[str, dict[str, str]]:
    """将指定 agent 转为 CLI --agents 参数所需的 JSON 对象。

    扫描 ~/.claude/agents/ 和 <cwd>/.claude/agents/，找到名称匹配的 agent，
    提取其 description 和 prompt（body），组装为 CLI 可识别的结构。
    单 agent 的 prompt 截断至 MAX_AGENT_PROMPT_CHARS 字符。
    """
    all_agents = {}
    # 先扫描用户级 agent
    for a in _scan_agents_dir(AGENTS_DIR, "user"):
        all_agents[a["name"]] = a
    # 再扫描项目级 agent（覆盖同名）
    if cwd:
        try:
            project_dir = Path(cwd).expanduser().resolve() / PROJECT_AGENTS_DIR_TEMPLATE
            if project_dir.exists() and project_dir != AGENTS_DIR:
                for a in _scan_agents_dir(project_dir, "project"):
                    all_agents[a["name"]] = a
        except (OSError, RuntimeError):
            pass
    result: dict[str, dict[str, str]] = {}
    total_prompt_chars = 0
    for name in names:
        name = name.strip()
        if not name or name in result:
            continue
        agent = all_agents.get(name)
        if not agent:
            continue
        entry: dict[str, str] = {}
        desc = str(agent.get("description") or "").strip()
        if desc:
            entry["description"] = desc
        body = str(agent.get("body") or "").strip()
        if body:
            # 控制单个 agent 和累计 prompt 总量，避免超出命令行长度限制
            remaining = MAX_AGENT_PROMPT_CHARS * 2 - total_prompt_chars
            if remaining <= 0:
                break
            if len(body) > MAX_AGENT_PROMPT_CHARS:
                body = body[:MAX_AGENT_PROMPT_CHARS] + "\n...(prompt truncated)"
            if len(body) > remaining:
                body = body[:remaining] + "\n...(prompt truncated)"
            total_prompt_chars += len(body)
            entry["prompt"] = body
        if entry:
            result[name] = entry
    return result


def _agent_file_path(name: str, scope: str = "user") -> Path:
    """根据名称和范围获取 agent 文件路径。"""
    if scope == "project":
        cwd = Path.cwd()
        base = cwd / PROJECT_AGENTS_DIR_TEMPLATE
    else:
        base = AGENTS_DIR
    safe_name = re.sub(r"[^A-Za-z0-9_.-]", "-", name).strip("-") or name
    return base / f"{safe_name}.md"


def _format_frontmatter(data: dict) -> str:
    """将配置 dict 格式化为 YAML frontmatter 文本。"""
    lines = ["---"]
    for key in AGENT_FRONTMATTER_FIELDS:
        val = data.get(key)
        if val is None or val == "" or val == [] or val is False:
            continue
        if isinstance(val, list):
            lines.append(f"{key}: {' '.join(val)}")
        elif isinstance(val, bool):
            lines.append(f"{key}: {'true' if val else 'false'}")
        else:
            lines.append(f"{key}: {val}")
    lines.append("---")
    return "\n".join(lines)


def create_agent(data: dict) -> dict:
    """创建新 agent：写入 .md 文件到 ~/.claude/agents/ 或 .claude/agents/。"""
    name = str(data.get("name", "")).strip()
    if not name or not re.match(r"^[A-Za-z0-9_.-]{1,64}$", name):
        raise ValueError("invalid agent name")
    scope = data.get("scope", "user")
    if scope not in ("user", "project"):
        scope = "user"

    file_path = _agent_file_path(name, scope)
    if file_path.exists():
        raise ValueError(f"agent '{name}' already exists")

    frontmatter_data = {k: data[k] for k in AGENT_FRONTMATTER_FIELDS if k in data}
    if "name" not in frontmatter_data:
        frontmatter_data["name"] = name
    if "description" not in frontmatter_data:
        frontmatter_data["description"] = data.get("description", "")

    body = str(data.get("body", "")).strip()
    fm_text = _format_frontmatter(frontmatter_data)
    content = f"{fm_text}\n\n{body}\n" if body else f"{fm_text}\n"

    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_text(content, encoding="utf-8")

    agent = _parse_agent_file(file_path)
    agent["scope"] = scope
    return agent


def update_agent(name: str, data: dict) -> dict:
    """更新 agent 的 frontmatter 和/或 body。"""
    agent = get_agent(name)
    if not agent:
        raise ValueError(f"agent '{name}' not found")

    scope = agent.get("scope", "user")
    file_path = _agent_file_path(name, scope)
    if not file_path.exists():
        raise ValueError(f"agent file not found: {file_path}")

    # 合并 frontmatter
    frontmatter_data = {}
    for key in AGENT_FRONTMATTER_FIELDS:
        if key in data:
            frontmatter_data[key] = data[key]
        elif key in agent:
            frontmatter_data[key] = agent[key]

    body = data.get("body", agent.get("body", ""))
    if isinstance(body, str):
        body = body.strip()
    else:
        body = ""

    fm_text = _format_frontmatter(frontmatter_data)
    content = f"{fm_text}\n\n{body}\n" if body else f"{fm_text}\n"
    file_path.write_text(content, encoding="utf-8")

    updated = _parse_agent_file(file_path)
    updated["scope"] = scope
    return updated


def delete_agent(name: str) -> bool:
    """删除 agent（重命名为 .bak）。"""
    agent = get_agent(name)
    if not agent:
        raise ValueError(f"agent '{name}' not found")
    scope = agent.get("scope", "user")
    file_path = _agent_file_path(name, scope)
    if not file_path.exists():
        raise ValueError(f"agent file not found: {file_path}")
    bak_path = file_path.with_suffix(file_path.suffix + ".bak")
    file_path.rename(bak_path)
    return True


def get_available_models() -> list[str]:
    """获取可用模型列表"""
    env = get_env_config()
    models = []

    # 从环境变量中提取已配置的模型
    for key, value in env.items():
        if "MODEL" in key and value:
            models.append(str(value).strip())

    # 确保有默认模型
    if not models:
        models = ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-6"]

    unique_models = []
    for model in models:
        if model and model not in unique_models:
            unique_models.append(model)
    return unique_models

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


def list_mcp_servers(cwd: str = "") -> list[dict[str, Any]]:
    """列出全局 settings.json 和当前项目 .mcp.json 中配置的 MCP。"""
    servers: list[dict[str, Any]] = []

    global_mcp = get_settings().get("mcpServers", {})
    if isinstance(global_mcp, dict):
        for name, config in global_mcp.items():
            servers.append(_normalize_mcp_server(str(name), config, "global"))

    project_file = _project_mcp_file(cwd)
    if project_file:
        project_mcp = _read_json_file(project_file).get("mcpServers", {})
        if isinstance(project_mcp, dict):
            for name, config in project_mcp.items():
                servers.append(_normalize_mcp_server(str(name), config, "project"))

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


def list_agents() -> list[dict[str, str]]:
    """列出所有已配置的 agents"""
    agents = []
    if not AGENTS_DIR.exists():
        return agents

    for agent_file in AGENTS_DIR.iterdir():
        if agent_file.suffix == ".md":
            content = agent_file.read_text(encoding="utf-8")
            name = agent_file.stem
            description = ""

            # 尝试解析 frontmatter
            if content.startswith("---"):
                parts = content.split("---", 2)
                if len(parts) >= 3:
                    for line in parts[1].strip().split("\n"):
                        if line.startswith("name:"):
                            name = line.split(":", 1)[1].strip().strip('"\'')
                        elif line.startswith("description:"):
                            description = line.split(":", 1)[1].strip().strip('"\'')

            agents.append({
                "name": name,
                "file": agent_file.name,
                "description": description,
            })
    return agents


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

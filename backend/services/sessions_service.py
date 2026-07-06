"""会话相关服务。"""
from typing import Any, Callable

OwnedSessionGetter = Callable[[str, str], Any]


def list_gui_sessions(
    *,
    sessions: list[dict[str, Any]],
    session_owner: dict[str, str],
    get_owned_session: OwnedSessionGetter,
    query: dict[str, list[str]] | None,
) -> dict[str, Any]:
    """为会话列表附加运行态信息并分页。"""
    active_sids: set[str] = set()
    for sid, owner_id in session_owner.items():
        owner_sess = get_owned_session(owner_id, sid)
        if owner_sess and owner_sess.is_running and owner_sess._message_owner_id:
            active_sids.add(sid)

    for session in sessions:
        sid = session.get("session_id")
        session["is_active"] = sid in active_sids
        owner_id = session_owner.get(sid) if sid else ""
        session["active_owner_id"] = owner_id if session["is_active"] else ""

    total = len(sessions)
    try:
        offset = max(0, int((query or {}).get("offset", ["0"])[0]))
        limit = max(1, min(200, int((query or {}).get("limit", ["200"])[0])))
    except (ValueError, IndexError):
        offset = 0
        limit = 200
    return {"sessions": sessions[offset:offset + limit], "total": total}

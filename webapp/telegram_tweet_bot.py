from __future__ import annotations

import asyncio
import json
import logging
import secrets
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from io import BytesIO
from typing import Any, Awaitable, Callable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException

from .db import db


logger = logging.getLogger(__name__)

PAGE_SIZE = 6
MAX_TELEGRAM_MEDIA_BYTES = 20 * 1024 * 1024
PERSONA_CONTROL_BUTTON = "👤 人设管理"
CREATION_CONTROL_BUTTON = "✍️ 推文创作"
CONTENT_CONTROL_BUTTON = "🗂 内容管理"
PUBLISH_CONTROL_BUTTON = "🚀 发布管理"
TASK_CONTROL_BUTTON = "📋 任务中心"
STATUS_CONTROL_BUTTON = "📊 工作台状态"
HELP_CONTROL_BUTTON = "ℹ️ 使用提示"
CONTROL_BUTTONS = frozenset({
    PERSONA_CONTROL_BUTTON,
    CREATION_CONTROL_BUTTON,
    CONTENT_CONTROL_BUTTON,
    PUBLISH_CONTROL_BUTTON,
    TASK_CONTROL_BUTTON,
    STATUS_CONTROL_BUTTON,
    HELP_CONTROL_BUTTON,
})
HELP_TEXT = (
    "使用提示\n\n"
    "• 管理员在后台加入当前 Chat ID 后，即可使用全部推文 Bot 功能。\n"
    "• 人设、生成、草稿、收藏、媒体、热点和任务均可直接在 Telegram 内操作。\n"
    "• 首次发布前需已有可用的 Threads 账号；若尚未授权，请从“发布管理”进入账号与浏览器完成一次 OAuth。\n"
    "• 在输入流程中点击任一总控按钮，会退出当前未提交的输入并切换模块。\n"
    "• Bot 不接收账号密码、验证码或浏览器凭证。"
)
SUPPORTED_MEDIA_MIME_SUFFIXES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
}
try:
    BUSINESS_TIMEZONE = ZoneInfo("Asia/Shanghai")
except ZoneInfoNotFoundError:
    BUSINESS_TIMEZONE = timezone(timedelta(hours=8), name="Asia/Shanghai")


Dispatch = Callable[[int, str, dict[str, Any]], Any]
AsyncDispatch = Callable[[int, str, dict[str, Any]], Awaitable[Any]]


@dataclass(frozen=True)
class TweetWorkbenchOps:
    dispatch: Dispatch
    dispatch_async: AsyncDispatch


def _json_loads(value: Any, default: Any) -> Any:
    try:
        parsed = json.loads(str(value or ""))
    except (TypeError, ValueError, json.JSONDecodeError):
        return default
    return parsed


def ensure_native_bot_schema(conn) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS telegram_tweet_bot_states (
          chat_id INTEGER PRIMARY KEY,
          selected_persona_id TEXT NOT NULL DEFAULT '',
          mode TEXT NOT NULL DEFAULT '',
          payload_json TEXT NOT NULL DEFAULT '{}',
          updated_at REAL NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS telegram_tweet_bot_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id INTEGER NOT NULL,
          web_user_id INTEGER NOT NULL,
          action TEXT NOT NULL,
          resource_type TEXT NOT NULL DEFAULT '',
          resource_id TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL,
          detail TEXT NOT NULL DEFAULT '',
          created_at REAL NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_telegram_tweet_bot_audit_chat "
        "ON telegram_tweet_bot_audit(chat_id, created_at DESC)"
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS telegram_tweet_bot_callbacks (
          token TEXT PRIMARY KEY,
          chat_id INTEGER NOT NULL,
          action TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          expires_at REAL NOT NULL,
          created_at REAL NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_telegram_tweet_bot_callbacks_expiry "
        "ON telegram_tweet_bot_callbacks(chat_id, expires_at)"
    )


def callback_token(chat_id: int, action: str, payload: dict[str, Any], *, ttl_seconds: int = 900) -> str:
    token = secrets.token_urlsafe(8).rstrip("=")
    now = time.time()
    with db() as conn:
        ensure_native_bot_schema(conn)
        conn.execute("DELETE FROM telegram_tweet_bot_callbacks WHERE expires_at < ?", (now,))
        conn.execute(
            "INSERT INTO telegram_tweet_bot_callbacks(token, chat_id, action, payload_json, expires_at, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                token, int(chat_id), str(action)[:24],
                json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                now + max(60, int(ttl_seconds)), now,
            ),
        )
        conn.execute(
            "DELETE FROM telegram_tweet_bot_callbacks WHERE token IN ("
            "SELECT token FROM telegram_tweet_bot_callbacks WHERE chat_id = ? "
            "ORDER BY created_at DESC LIMIT -1 OFFSET 200)",
            (int(chat_id),),
        )
    return f"tt:{action}:{token}"


def resolve_callback_token(chat_id: int, action: str, token: str, *, consume: bool = False) -> dict[str, Any]:
    with db() as conn:
        ensure_native_bot_schema(conn)
        row = conn.execute(
            "SELECT payload_json, expires_at FROM telegram_tweet_bot_callbacks "
            "WHERE token = ? AND chat_id = ? AND action = ?",
            (str(token or ""), int(chat_id), str(action or "")),
        ).fetchone()
        if row is None or float(row["expires_at"] or 0) < time.time():
            raise HTTPException(status_code=410, detail="操作已过期，请返回菜单重新选择")
        payload = _json_loads(row["payload_json"], {})
        if consume:
            deleted = conn.execute(
                "DELETE FROM telegram_tweet_bot_callbacks WHERE token = ? AND chat_id = ? AND action = ?",
                (str(token or ""), int(chat_id), str(action or "")),
            )
            if int(deleted.rowcount or 0) != 1:
                raise HTTPException(status_code=410, detail="操作已执行，请返回菜单查看结果")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="操作参数无效")
    return payload


def load_state(chat_id: int) -> dict[str, Any]:
    with db() as conn:
        ensure_native_bot_schema(conn)
        row = conn.execute(
            "SELECT selected_persona_id, mode, payload_json, updated_at "
            "FROM telegram_tweet_bot_states WHERE chat_id = ?",
            (int(chat_id),),
        ).fetchone()
    if not row:
        return {"selected_persona_id": "", "mode": "", "payload": {}, "updated_at": 0.0}
    payload = _json_loads(row["payload_json"], {})
    return {
        "selected_persona_id": str(row["selected_persona_id"] or ""),
        "mode": str(row["mode"] or ""),
        "payload": payload if isinstance(payload, dict) else {},
        "updated_at": float(row["updated_at"] or 0),
    }


def save_state(
    chat_id: int,
    *,
    selected_persona_id: str | None = None,
    mode: str | None = None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    current = load_state(chat_id)
    next_state = {
        "selected_persona_id": (
            str(selected_persona_id or "").strip()
            if selected_persona_id is not None
            else current["selected_persona_id"]
        ),
        "mode": str(mode or "").strip() if mode is not None else current["mode"],
        "payload": dict(payload) if payload is not None else current["payload"],
        "updated_at": time.time(),
    }
    with db() as conn:
        ensure_native_bot_schema(conn)
        conn.execute(
            """
            INSERT INTO telegram_tweet_bot_states(chat_id, selected_persona_id, mode, payload_json, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(chat_id) DO UPDATE SET
              selected_persona_id = excluded.selected_persona_id,
              mode = excluded.mode,
              payload_json = excluded.payload_json,
              updated_at = excluded.updated_at
            """,
            (
                int(chat_id),
                next_state["selected_persona_id"],
                next_state["mode"],
                json.dumps(next_state["payload"], ensure_ascii=False, separators=(",", ":")),
                next_state["updated_at"],
            ),
        )
    return next_state


def clear_pending_state(chat_id: int) -> dict[str, Any]:
    current = load_state(chat_id)
    retained = {
        key: value
        for key, value in current["payload"].items()
        if str(key).startswith("last_")
    }
    return save_state(chat_id, mode="", payload=retained)


def audit_action(
    chat_id: int,
    web_user_id: int,
    action: str,
    *,
    status: str,
    resource_type: str = "",
    resource_id: str = "",
    detail: str = "",
) -> None:
    with db() as conn:
        ensure_native_bot_schema(conn)
        conn.execute(
            """
            INSERT INTO telegram_tweet_bot_audit(
              chat_id, web_user_id, action, resource_type, resource_id, status, detail, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                int(chat_id), int(web_user_id), str(action)[:80], str(resource_type)[:40],
                str(resource_id)[:160], str(status)[:24], str(detail)[:1000], time.time(),
            ),
        )
        conn.execute(
            "DELETE FROM telegram_tweet_bot_audit WHERE id IN ("
            "SELECT id FROM telegram_tweet_bot_audit WHERE chat_id = ? "
            "ORDER BY created_at DESC LIMIT -1 OFFSET 1000)",
            (int(chat_id),),
        )


def parse_schedule_time(value: str) -> int:
    text = str(value or "").strip()
    for pattern in ("%Y-%m-%d %H:%M", "%Y/%m/%d %H:%M", "%m-%d %H:%M"):
        try:
            parsed = datetime.strptime(text, pattern)
        except ValueError:
            continue
        if pattern == "%m-%d %H:%M":
            parsed = parsed.replace(year=datetime.now(BUSINESS_TIMEZONE).year)
        scheduled = parsed.replace(tzinfo=BUSINESS_TIMEZONE)
        timestamp = int(scheduled.timestamp())
        if timestamp <= int(time.time()) + 60:
            raise ValueError("定时时间必须至少晚于当前时间 1 分钟")
        return timestamp
    raise ValueError("请输入 YYYY-MM-DD HH:MM，例如 2026-09-10 18:30")


def _error_text(exc: BaseException) -> str:
    if isinstance(exc, HTTPException):
        detail = exc.detail
        if isinstance(detail, dict):
            return str(detail.get("message") or detail.get("detail") or detail)
        return str(detail)
    return str(exc) or exc.__class__.__name__


def _post_label(post: dict[str, Any], index: int) -> str:
    title = str(post.get("title") or "").strip()
    content = str(post.get("content") or "").strip().replace("\n", " ")
    return (title or content or f"推文 {index + 1}")[:28]


def _task_status(task: dict[str, Any]) -> str:
    return str(task.get("status") or task.get("state") or "unknown").strip().lower()


class NativeTweetBotController:
    def __init__(
        self,
        *,
        ops: TweetWorkbenchOps,
        get_runtime: Callable[[], dict[str, Any]],
        load_member: Callable[[int], Any],
    ) -> None:
        self.ops = ops
        self.get_runtime = get_runtime
        self.load_member = load_member

    def _member(self, chat_id: int) -> dict[str, Any] | None:
        row = self.load_member(int(chat_id))
        return dict(row) if row is not None else None

    def _member_still_bound(self, chat_id: int, user_id: int) -> bool:
        member = self._member(chat_id)
        return member is not None and int(member.get("web_user_id") or 0) == int(user_id)

    async def _call(self, user_id: int, action: str, payload: dict[str, Any] | None = None) -> Any:
        return await asyncio.to_thread(self.ops.dispatch, int(user_id), action, payload or {})

    async def _call_async(self, user_id: int, action: str, payload: dict[str, Any] | None = None) -> Any:
        return await self.ops.dispatch_async(int(user_id), action, payload or {})

    async def _authorized(self, chat: Any, from_user: Any, reply: Callable[..., Awaitable[Any]]) -> dict[str, Any] | None:
        chat_id = int(chat.id)
        if str(chat.type or "") != "private" or from_user is None or int(from_user.id) != chat_id:
            await reply("推文工作台仅支持与 Bot 私聊使用。")
            return None
        member = self._member(chat_id)
        if member is None:
            await reply(f"当前 Chat ID：{chat_id}\n请让管理员在推文工作台授权列表中加入该 ID，然后重新发送 /start。")
            return None
        return member

    @staticmethod
    def _main_keyboard(types: Any) -> Any:
        button = types.KeyboardButton
        return types.ReplyKeyboardMarkup(
            keyboard=[
                [button(text=PERSONA_CONTROL_BUTTON), button(text=CREATION_CONTROL_BUTTON)],
                [button(text=CONTENT_CONTROL_BUTTON), button(text=PUBLISH_CONTROL_BUTTON)],
                [button(text=TASK_CONTROL_BUTTON), button(text=STATUS_CONTROL_BUTTON), button(text=HELP_CONTROL_BUTTON)],
            ],
            resize_keyboard=True,
            is_persistent=True,
            input_field_placeholder="请选择推文工作台功能",
        )

    @staticmethod
    def _return_keyboard(types: Any) -> Any:
        return types.InlineKeyboardMarkup(inline_keyboard=[[
            types.InlineKeyboardButton(text="返回总控菜单", callback_data="tt:menu"),
        ]])

    @staticmethod
    def _section_keyboard(types: Any, section: str) -> Any:
        button = types.InlineKeyboardButton
        rows = {
            "persona": [
                [button(text="👤 我的人设", callback_data="tt:personas:0"), button(text="⚙️ 内容设置", callback_data="tt:profile")],
            ],
            "creation": [
                [button(text="✍️ 推文生成", callback_data="tt:generate"), button(text="🔥 热点创作", callback_data="tt:hot")],
            ],
            "content": [
                [button(text="📝 草稿", callback_data="tt:drafts:0"), button(text="⭐ 收藏", callback_data="tt:favorites:0")],
            ],
            "publish": [
                [button(text="🚀 矩阵发布", callback_data="tt:matrix"), button(text="🔐 账号与浏览器", callback_data="tt:accounts")],
            ],
        }.get(section, [])
        return types.InlineKeyboardMarkup(inline_keyboard=rows)

    async def send_main_menu(self, message: Any, types: Any) -> None:
        member = await self._authorized(message.chat, message.from_user, message.answer)
        if not member:
            return
        state = load_state(int(message.chat.id))
        selected = ""
        if state["selected_persona_id"]:
            try:
                personas = await self._call(int(member["web_user_id"]), "personas.list")
                current = next((item for item in personas if str(item.get("id")) == state["selected_persona_id"]), None)
                if current:
                    selected = f"\n当前人设：{current.get('name') or '未命名人设'}"
            except Exception:
                selected = ""
        clear_pending_state(int(message.chat.id))
        await message.answer(
            f"当前 Chat ID 已授权。{selected}\n"
            "请使用输入框下方的总控按钮；进入模块后再选择具体操作。",
            reply_markup=self._main_keyboard(types),
        )

    async def _send_control_section(self, message: Any, types: Any, section: str, title: str) -> None:
        await message.answer(
            f"{title}\n请选择具体操作。",
            reply_markup=self._section_keyboard(types, section),
        )

    async def _send_task_center(self, message: Any, types: Any, member: dict[str, Any], page: int = 0) -> None:
        tasks = await self._call(int(member["web_user_id"]), "tasks.list", {"limit": 30})
        page = max(0, int(page))
        start = page * PAGE_SIZE
        rows = []
        for item in tasks[start:start + PAGE_SIZE]:
            task_id = str(item.get("id") or "")
            task_kind = str(item.get("_tg_task_kind") or "social")
            label = f"{_task_status(item)} · {str(item.get('type') or item.get('task_type') or 'task')[:18]}"
            rows.append([types.InlineKeyboardButton(
                text=label,
                callback_data=callback_token(
                    int(message.chat.id), "t", {"task_id": task_id, "task_kind": task_kind},
                ),
            )])
        nav = []
        if page > 0:
            nav.append(types.InlineKeyboardButton(text="⬅️", callback_data=f"tt:tasks:{page - 1}"))
        if start + PAGE_SIZE < len(tasks):
            nav.append(types.InlineKeyboardButton(text="➡️", callback_data=f"tt:tasks:{page + 1}"))
        if nav:
            rows.append(nav)
        rows.append([types.InlineKeyboardButton(text="返回总控菜单", callback_data="tt:menu")])
        await message.answer(
            f"任务中心（最近 {len(tasks)} 条）" if tasks else "暂无任务。",
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    async def _send_workbench_status(self, message: Any, types: Any, member: dict[str, Any]) -> None:
        personas = await self._call(int(member["web_user_id"]), "personas.list")
        tasks = await self._call(int(member["web_user_id"]), "tasks.list", {"limit": 30})
        state = load_state(int(message.chat.id))
        current = next(
            (item for item in personas if str(item.get("id") or "") == state["selected_persona_id"]),
            None,
        )
        draft_count = sum(int((item.get("counts") or {}).get("posts") or 0) for item in personas)
        favorite_count = sum(int((item.get("counts") or {}).get("favorites") or 0) for item in personas)
        active_count = sum(1 for item in tasks if _task_status(item) in {"queued", "pending", "running", "retrying", "scheduled"})
        await message.answer(
            "推文工作台状态\n\n"
            f"当前人设：{str((current or {}).get('name') or '未选择')}\n"
            f"人设：{len(personas)} · 草稿：{draft_count} · 收藏：{favorite_count}\n"
            f"进行中任务：{active_count} · 最近任务：{len(tasks)}",
            reply_markup=self._main_keyboard(types),
        )

    async def _handle_control_button(
        self,
        message: Any,
        types: Any,
        member: dict[str, Any],
        text: str,
    ) -> bool:
        if text not in CONTROL_BUTTONS:
            return False
        chat_id = int(message.chat.id)
        user_id = int(member["web_user_id"])
        clear_pending_state(chat_id)
        try:
            if text == PERSONA_CONTROL_BUTTON:
                await self._send_control_section(message, types, "persona", "人设管理")
            elif text == CREATION_CONTROL_BUTTON:
                await self._send_control_section(message, types, "creation", "推文创作")
            elif text == CONTENT_CONTROL_BUTTON:
                await self._send_control_section(message, types, "content", "内容管理")
            elif text == PUBLISH_CONTROL_BUTTON:
                await self._send_control_section(message, types, "publish", "发布管理")
            elif text == TASK_CONTROL_BUTTON:
                await self._send_task_center(message, types, member)
            elif text == STATUS_CONTROL_BUTTON:
                await self._send_workbench_status(message, types, member)
            else:
                await message.answer(HELP_TEXT, reply_markup=self._main_keyboard(types))
            audit_action(chat_id, user_id, "control.open", status="success", detail=text)
        except Exception as exc:
            logger.exception("Telegram tweet control action failed: %s", text)
            audit_action(chat_id, user_id, "control.open", status="failed", detail=f"{text}: {_error_text(exc)}")
            await message.answer(
                f"打开失败：{_error_text(exc)}",
                reply_markup=self._main_keyboard(types),
            )
        return True

    async def _persona_list(self, query: Any, types: Any, member: dict[str, Any], page: int) -> None:
        personas = await self._call(int(member["web_user_id"]), "personas.list")
        page = max(0, int(page))
        start = page * PAGE_SIZE
        rows = []
        state = load_state(int(query.message.chat.id))
        for item in personas[start:start + PAGE_SIZE]:
            persona_id = str(item.get("id") or "")
            marker = "✅ " if persona_id == state["selected_persona_id"] else ""
            rows.append([types.InlineKeyboardButton(
                text=f"{marker}{str(item.get('name') or '未命名人设')[:30]}",
                callback_data=callback_token(int(query.message.chat.id), "p", {"persona_id": persona_id}),
            )])
        nav = []
        if page > 0:
            nav.append(types.InlineKeyboardButton(text="⬅️", callback_data=f"tt:personas:{page - 1}"))
        if start + PAGE_SIZE < len(personas):
            nav.append(types.InlineKeyboardButton(text="➡️", callback_data=f"tt:personas:{page + 1}"))
        if nav:
            rows.append(nav)
        rows.extend([
            [types.InlineKeyboardButton(text="➕ 新建人设", callback_data="tt:persona_new")],
            [types.InlineKeyboardButton(text="返回总控菜单", callback_data="tt:menu")],
        ])
        await query.message.edit_text(
            f"我的人设（{len(personas)}）\n选择后，生成、草稿和发布都会限定在该人设。" if personas else "尚无人设，可先新建一个。",
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    async def _post_list(self, query: Any, types: Any, member: dict[str, Any], *, source: str, page: int) -> None:
        state = load_state(int(query.message.chat.id))
        persona_id = state["selected_persona_id"]
        if not persona_id:
            await query.answer("请先选择人设", show_alert=True)
            await self._persona_list(query, types, member, 0)
            return
        posts = await self._call(int(member["web_user_id"]), "posts.list", {"persona_id": persona_id, "source": source})
        page = max(0, int(page))
        start = page * PAGE_SIZE
        prefix = "f" if source == "favorites" else "d"
        rows = [[types.InlineKeyboardButton(
            text=_post_label(post, start + index),
            callback_data=callback_token(
                int(query.message.chat.id), prefix,
                {"post_id": str(post.get("id") or ""), "source": source},
            ),
        )] for index, post in enumerate(posts[start:start + PAGE_SIZE])]
        nav = []
        target = "favorites" if source == "favorites" else "drafts"
        if page > 0:
            nav.append(types.InlineKeyboardButton(text="⬅️", callback_data=f"tt:{target}:{page - 1}"))
        if start + PAGE_SIZE < len(posts):
            nav.append(types.InlineKeyboardButton(text="➡️", callback_data=f"tt:{target}:{page + 1}"))
        if nav:
            rows.append(nav)
        if source == "posts":
            rows.append([types.InlineKeyboardButton(text="➕ 手工新建草稿", callback_data="tt:draft_new")])
        rows.append([types.InlineKeyboardButton(text="返回总控菜单", callback_data="tt:menu")])
        await query.message.edit_text(
            f"{'收藏' if source == 'favorites' else '草稿'}（{len(posts)}）" if posts else f"当前人设暂无{'收藏' if source == 'favorites' else '草稿'}。",
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    async def _post_detail(self, query: Any, types: Any, member: dict[str, Any], post_id: str, source: str) -> None:
        state = load_state(int(query.message.chat.id))
        posts = await self._call(int(member["web_user_id"]), "posts.list", {"persona_id": state["selected_persona_id"], "source": source})
        post = next((item for item in posts if str(item.get("id") or "") == post_id), None)
        if not post:
            await query.answer("推文不存在或已删除", show_alert=True)
            return
        media = post.get("media_items") if isinstance(post.get("media_items"), list) else post.get("mediaPaths") or post.get("media_paths") or []
        rows = [
            [types.InlineKeyboardButton(text="✏️ 编辑", callback_data=callback_token(int(query.message.chat.id), "edit", {"source": source, "post_id": post_id})),
             types.InlineKeyboardButton(text="📎 添加媒体", callback_data=callback_token(int(query.message.chat.id), "media", {"source": source, "post_id": post_id}))],
            [types.InlineKeyboardButton(text="立即发布", callback_data=callback_token(int(query.message.chat.id), "pub", {"source": source, "post_id": post_id})),
             types.InlineKeyboardButton(text="定时发布", callback_data=callback_token(int(query.message.chat.id), "sched", {"source": source, "post_id": post_id}))],
        ]
        if media:
            rows.append([
                types.InlineKeyboardButton(text="♻️ 替换首个媒体", callback_data=callback_token(int(query.message.chat.id), "mediareplace", {"source": source, "post_id": post_id, "index": 0})),
                types.InlineKeyboardButton(text="移除最后媒体", callback_data=callback_token(int(query.message.chat.id), "mediadel", {"source": source, "post_id": post_id, "index": len(media) - 1})),
            ])
        if source == "posts":
            rows.append([types.InlineKeyboardButton(text="⭐ 加入收藏", callback_data=callback_token(int(query.message.chat.id), "favadd", {"post_id": post_id}))])
        rows.extend([
            [types.InlineKeyboardButton(text="🗑 删除", callback_data=callback_token(int(query.message.chat.id), "delask", {"source": source, "post_id": post_id}))],
            [types.InlineKeyboardButton(text="返回列表", callback_data=f"tt:{'favorites' if source == 'favorites' else 'drafts'}:0")],
        ])
        content = str(post.get("content") or "").strip()
        await query.message.edit_text(
            f"{str(post.get('title') or '推文')[:100]}\n\n{content[:3000]}\n\n媒体：{len(media)} 项",
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    async def _publish_account_picker(
        self,
        query: Any,
        types: Any,
        member: dict[str, Any],
        *,
        source: str,
        post_id: str,
        scheduled: bool,
    ) -> None:
        chat_id = int(query.message.chat.id)
        state = load_state(chat_id)
        accounts = await self._call(int(member["web_user_id"]), "accounts.list")
        eligible = [
            account for account in accounts
            if str(account.get("persona_id") or "") == state["selected_persona_id"]
            and str(account.get("platform") or "").lower() == "threads"
        ]
        if not eligible:
            raise HTTPException(status_code=409, detail="当前人设没有绑定 Threads 账号，请先在网页端完成账号授权")
        rows = []
        for account in eligible[:12]:
            account_id = str(account.get("id") or "")
            label = str(account.get("display_name") or account.get("username") or account_id)[:32]
            rows.append([types.InlineKeyboardButton(
                text=label,
                callback_data=callback_token(chat_id, "pa", {
                    "source": source,
                    "post_id": post_id,
                    "account_id": account_id,
                    "scheduled": bool(scheduled),
                }),
            )])
        rows.append([types.InlineKeyboardButton(
            text="取消",
            callback_data=f"tt:{'favorites' if source == 'favorites' else 'drafts'}:0",
        )])
        await query.message.edit_text(
            "请选择用于发布的 Threads 账号。",
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    async def _tasks(self, query: Any, types: Any, member: dict[str, Any], page: int) -> None:
        tasks = await self._call(int(member["web_user_id"]), "tasks.list", {"limit": 30})
        page = max(0, int(page))
        start = page * PAGE_SIZE
        rows = []
        for item in tasks[start:start + PAGE_SIZE]:
            task_id = str(item.get("id") or "")
            task_kind = str(item.get("_tg_task_kind") or "social")
            label = f"{_task_status(item)} · {str(item.get('type') or item.get('task_type') or 'task')[:18]}"
            rows.append([types.InlineKeyboardButton(
                text=label,
                callback_data=callback_token(
                    int(query.message.chat.id), "t", {"task_id": task_id, "task_kind": task_kind},
                ),
            )])
        nav = []
        if page > 0:
            nav.append(types.InlineKeyboardButton(text="⬅️", callback_data=f"tt:tasks:{page - 1}"))
        if start + PAGE_SIZE < len(tasks):
            nav.append(types.InlineKeyboardButton(text="➡️", callback_data=f"tt:tasks:{page + 1}"))
        if nav:
            rows.append(nav)
        rows.append([types.InlineKeyboardButton(text="返回总控菜单", callback_data="tt:menu")])
        await query.message.edit_text(
            f"任务中心（最近 {len(tasks)} 条）" if tasks else "暂无任务。",
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    async def handle_callback(self, query: Any, types: Any) -> None:
        if query.message is None:
            await query.answer("消息已失效", show_alert=True)
            return
        member = await self._authorized(query.message.chat, query.from_user, query.answer)
        if not member:
            return
        chat_id = int(query.message.chat.id)
        user_id = int(member["web_user_id"])
        data = str(query.data or "")
        parts = data.split(":")
        action = parts[1] if len(parts) > 1 else ""
        try:
            if action == "menu":
                clear_pending_state(chat_id)
                await query.message.edit_text("已返回推文工作台总控菜单。")
                await query.message.answer("请选择总控功能。", reply_markup=self._main_keyboard(types))
            elif action == "help":
                await query.message.edit_text(
                    HELP_TEXT,
                    reply_markup=self._return_keyboard(types),
                )
            elif action == "personas":
                await self._persona_list(query, types, member, int(parts[2]) if len(parts) > 2 else 0)
            elif action == "p" and len(parts) > 2:
                persona_id = str(resolve_callback_token(chat_id, "p", parts[2]).get("persona_id") or "")
                personas = await self._call(user_id, "personas.list")
                persona = next((item for item in personas if str(item.get("id") or "") == persona_id), None)
                if not persona:
                    raise HTTPException(status_code=404, detail="人设不存在")
                save_state(chat_id, selected_persona_id=persona_id, mode="", payload={})
                rows = [
                    [types.InlineKeyboardButton(text="生成推文", callback_data="tt:generate"), types.InlineKeyboardButton(text="查看草稿", callback_data="tt:drafts:0")],
                    [types.InlineKeyboardButton(text="内容设置", callback_data="tt:profile"), types.InlineKeyboardButton(text="热点创作", callback_data="tt:hot")],
                    [types.InlineKeyboardButton(text="返回人设", callback_data="tt:personas:0")],
                ]
                await query.message.edit_text(
                    f"已选择：{persona.get('name') or '未命名人设'}\n草稿 {persona.get('counts', {}).get('posts', 0)} · 收藏 {persona.get('counts', {}).get('favorites', 0)}",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
            elif action == "persona_new":
                save_state(chat_id, mode="persona_new", payload={})
                await query.message.edit_text("请发送：人设名称｜简介\n例如：科技观察员｜关注 AI 产品与创业趋势\n发送 /cancel 取消。")
            elif action == "generate":
                if not load_state(chat_id)["selected_persona_id"]:
                    await query.answer("请先选择人设", show_alert=True)
                    await self._persona_list(query, types, member, 0)
                    return
                save_state(chat_id, mode="generate_prompt", payload={"count": 3, "target_words": 120})
                await query.message.edit_text("请发送本次推文主题或写作要求。默认生成 3 篇、约 120 字。\n发送 /cancel 取消。")
            elif action == "drafts":
                await self._post_list(query, types, member, source="posts", page=int(parts[2]) if len(parts) > 2 else 0)
            elif action == "favorites":
                await self._post_list(query, types, member, source="favorites", page=int(parts[2]) if len(parts) > 2 else 0)
            elif action in {"d", "f"} and len(parts) > 2:
                reference = resolve_callback_token(chat_id, action, parts[2])
                await self._post_detail(query, types, member, str(reference.get("post_id") or ""), str(reference.get("source") or "posts"))
            elif action == "draft_new":
                if not load_state(chat_id)["selected_persona_id"]:
                    raise HTTPException(status_code=400, detail="请先选择人设")
                save_state(chat_id, mode="draft_new", payload={})
                await query.message.edit_text("请发送草稿正文。发送 /cancel 取消。")
            elif action in {"edit", "media", "mediareplace", "mediadel", "pub", "sched", "delask"} and len(parts) > 2:
                reference = resolve_callback_token(chat_id, action, parts[2])
                source, post_id = str(reference.get("source") or "posts"), str(reference.get("post_id") or "")
                if action == "edit":
                    save_state(chat_id, mode="draft_edit", payload={"source": source, "post_id": post_id})
                    await query.message.edit_text("请发送新的推文正文。发送 /cancel 取消。")
                elif action == "media":
                    save_state(chat_id, mode="media_upload", payload={"source": source, "post_id": post_id})
                    await query.message.edit_text("请发送图片、视频或文件。上传成功后可继续发送，/done 完成，/cancel 取消。")
                elif action == "mediareplace":
                    save_state(chat_id, mode="media_replace", payload={"source": source, "post_id": post_id, "replace_index": int(reference.get("index") or 0)})
                    await query.message.edit_text("请发送用于替换的图片、视频或文件。发送 /cancel 取消。")
                elif action == "mediadel":
                    await self._call(user_id, "media.delete", {
                        "persona_id": load_state(chat_id)["selected_persona_id"],
                        "source": source,
                        "post_id": post_id,
                        "index": int(reference.get("index") or 0),
                    })
                    audit_action(chat_id, user_id, "media.delete", status="success", resource_type=source, resource_id=post_id)
                    await query.message.edit_text("媒体已移除。", reply_markup=self._return_keyboard(types))
                elif action == "pub":
                    await self._publish_account_picker(
                        query, types, member, source=source, post_id=post_id, scheduled=False,
                    )
                elif action == "sched":
                    await self._publish_account_picker(
                        query, types, member, source=source, post_id=post_id, scheduled=True,
                    )
                else:
                    rows = [[
                        types.InlineKeyboardButton(text="确认删除", callback_data=callback_token(chat_id, "delok", {"source": source, "post_id": post_id})),
                        types.InlineKeyboardButton(text="取消", callback_data=f"tt:{'favorites' if source == 'favorites' else 'drafts'}:0"),
                    ]]
                    await query.message.edit_text("删除后无法恢复，确认删除？", reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows))
            elif action == "favadd" and len(parts) > 2:
                state = load_state(chat_id)
                post_id = str(resolve_callback_token(chat_id, "favadd", parts[2], consume=True).get("post_id") or "")
                await self._call(user_id, "posts.favorite", {"persona_id": state["selected_persona_id"], "post_id": post_id})
                audit_action(chat_id, user_id, "favorite.add", status="success", resource_type="post", resource_id=post_id)
                await query.answer("已收藏", show_alert=True)
            elif action == "pa" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "pa", parts[2], consume=True)
                source = str(reference.get("source") or "posts")
                post_id = str(reference.get("post_id") or "")
                account_id = str(reference.get("account_id") or "")
                if bool(reference.get("scheduled")):
                    save_state(chat_id, mode="schedule_time", payload={
                        "source": source, "post_id": post_id, "account_id": account_id,
                    })
                    await query.message.edit_text("请输入北京时间 YYYY-MM-DD HH:MM。发送 /cancel 取消。")
                else:
                    rows = [[
                        types.InlineKeyboardButton(
                            text="确认发布",
                            callback_data=callback_token(chat_id, "pubok", {
                                "source": source, "post_id": post_id, "account_id": account_id,
                            }),
                        ),
                        types.InlineKeyboardButton(
                            text="取消",
                            callback_data=f"tt:{'favorites' if source == 'favorites' else 'drafts'}:0",
                        ),
                    ]]
                    await query.message.edit_text(
                        "确认立即提交到现有发布队列？",
                        reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                    )
            elif action in {"pubok", "delok"} and len(parts) > 2:
                reference = resolve_callback_token(chat_id, action, parts[2], consume=True)
                source, post_id = str(reference.get("source") or "posts"), str(reference.get("post_id") or "")
                state = load_state(chat_id)
                if action == "delok":
                    await self._call(user_id, "posts.delete", {"persona_id": state["selected_persona_id"], "source": source, "post_id": post_id})
                    audit_action(chat_id, user_id, "post.delete", status="success", resource_type=source, resource_id=post_id)
                    await query.message.edit_text("已删除。", reply_markup=self._return_keyboard(types))
                else:
                    result = await self._call(user_id, "publish.start", {
                        "persona_id": state["selected_persona_id"],
                        "source": source,
                        "post_id": post_id,
                        "account_id": str(reference.get("account_id") or ""),
                        "scheduled_at": 0,
                    })
                    task = result.get("task") if isinstance(result, dict) else {}
                    task_id = str((task or {}).get("id") or "")
                    audit_action(chat_id, user_id, "publish.enqueue", status="success", resource_type=source, resource_id=post_id, detail=task_id)
                    await query.message.edit_text(f"已进入发布队列。\n任务：{task_id or '已创建'}", reply_markup=self._return_keyboard(types))
                    if task_id:
                        asyncio.create_task(self._watch_publish(query.message.bot, chat_id, user_id, task_id, types))
            elif action == "hot":
                if not load_state(chat_id)["selected_persona_id"]:
                    raise HTTPException(status_code=400, detail="请先选择人设")
                state = load_state(chat_id)
                last_hot_task_id = str(state["payload"].get("last_hot_task_id") or "")
                last_hot_persona_id = str(state["payload"].get("last_hot_persona_id") or state["selected_persona_id"])
                save_state(chat_id, mode="hot_prompt", payload={})
                rows = []
                if last_hot_task_id:
                    rows.append([
                        types.InlineKeyboardButton(
                            text="查看上次热点任务",
                            callback_data=callback_token(chat_id, "hotstatus", {
                                "task_id": last_hot_task_id, "persona_id": last_hot_persona_id,
                            }),
                        ),
                        types.InlineKeyboardButton(
                            text="取消上次热点任务",
                            callback_data=callback_token(chat_id, "hotcancel", {
                                "task_id": last_hot_task_id, "persona_id": last_hot_persona_id,
                            }),
                        ),
                    ])
                await query.message.edit_text(
                    "请输入热点主题或关键词。Bot 会调用现有热点任务，完成后可选入草稿。\n发送 /cancel 取消。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows) if rows else None,
                )
            elif action in {"hotstatus", "hotcancel"} and len(parts) > 2:
                reference = resolve_callback_token(
                    chat_id, action, parts[2], consume=(action == "hotcancel"),
                )
                task_id = str(reference.get("task_id") or "")
                persona_id = str(reference.get("persona_id") or load_state(chat_id)["selected_persona_id"])
                if action == "hotcancel":
                    result = await self._call(user_id, "hot.cancel", {
                        "persona_id": persona_id, "task_id": task_id,
                    })
                    clear_pending_state(chat_id)
                    audit_action(
                        chat_id, user_id, "hot.cancel", status="success",
                        resource_type="task", resource_id=task_id,
                    )
                    await query.message.edit_text(
                        "热点任务已取消。" if result.get("cancelled") else "热点任务已结束或无需取消。",
                        reply_markup=self._return_keyboard(types),
                    )
                else:
                    task = await self._call(user_id, "hot.status", {
                        "persona_id": persona_id, "task_id": task_id,
                    })
                    status = _task_status(task)
                    if status == "success":
                        candidates = task.get("candidates") or (task.get("result") or {}).get("candidates") or []
                        candidates = [item for item in candidates if isinstance(item, dict)][:5]
                        save_state(
                            chat_id, selected_persona_id=persona_id, mode="hot_select",
                            payload={"hot_candidates": candidates, "last_hot_task_id": task_id,
                                     "last_hot_persona_id": persona_id},
                        )
                        rows = [[types.InlineKeyboardButton(
                            text=str(item.get("title") or item.get("content") or f"候选 {index + 1}")[:28],
                            callback_data=callback_token(chat_id, "hotpick", {"index": index}),
                        )] for index, item in enumerate(candidates)]
                        rows.append([types.InlineKeyboardButton(text="返回总控菜单", callback_data="tt:menu")])
                        await query.message.edit_text(
                            "热点候选已完成，选择一条保存为草稿。" if candidates else "热点任务已完成，但没有可导入候选。",
                            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                        )
                    elif status in {"queued", "running"}:
                        rows = [[
                            types.InlineKeyboardButton(
                                text="刷新状态",
                                callback_data=callback_token(chat_id, "hotstatus", {
                                    "task_id": task_id, "persona_id": persona_id,
                                }),
                            ),
                            types.InlineKeyboardButton(
                                text="取消任务",
                                callback_data=callback_token(chat_id, "hotcancel", {
                                    "task_id": task_id, "persona_id": persona_id,
                                }),
                            ),
                        ]]
                        await query.message.edit_text(
                            f"热点任务进行中：{task_id}",
                            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                        )
                    else:
                        await query.message.edit_text(
                            f"热点任务 {status}：{str(task.get('error') or '')[:1200]}",
                            reply_markup=self._return_keyboard(types),
                        )
            elif action == "hotpick" and len(parts) > 2:
                state = load_state(chat_id)
                candidates = state["payload"].get("hot_candidates") if isinstance(state["payload"].get("hot_candidates"), list) else []
                index = int(resolve_callback_token(chat_id, "hotpick", parts[2], consume=True).get("index") or 0)
                if index < 0 or index >= len(candidates):
                    raise HTTPException(status_code=404, detail="热点候选已过期")
                await self._call(user_id, "hot.import", {"persona_id": state["selected_persona_id"], "candidates": [candidates[index]]})
                clear_pending_state(chat_id)
                audit_action(chat_id, user_id, "hot.import", status="success", resource_type="persona", resource_id=state["selected_persona_id"])
                await query.message.edit_text("热点内容已保存为草稿。", reply_markup=self._return_keyboard(types))
            elif action == "matrix":
                personas = await self._call(user_id, "personas.list")
                eligible = [item for item in personas if int((item.get("counts") or {}).get("posts") or 0) > 0]
                if not eligible:
                    raise HTTPException(status_code=409, detail="没有可用于矩阵发布的人设草稿")
                save_state(chat_id, mode="matrix_confirm", payload={"persona_ids": [str(item.get("id") or "") for item in eligible]})
                rows = [[
                    types.InlineKeyboardButton(
                        text="确认矩阵发布",
                        callback_data=callback_token(chat_id, "matrixok", {"persona_ids": [str(item.get("id") or "") for item in eligible]}),
                    ),
                    types.InlineKeyboardButton(text="取消", callback_data="tt:menu"),
                ]]
                await query.message.edit_text(
                    f"将从 {len(eligible)} 个人设各取 1 篇草稿，提交 Threads 矩阵发布队列。确认继续？",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
            elif action == "matrixok" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "matrixok", parts[2], consume=True)
                persona_ids = reference.get("persona_ids") if isinstance(reference.get("persona_ids"), list) else []
                result = await self._call(user_id, "publish.matrix", {"persona_ids": persona_ids})
                clear_pending_state(chat_id)
                if not bool(result.get("ok")):
                    errors = result.get("errors") if isinstance(result.get("errors"), list) else []
                    skipped = result.get("skipped") if isinstance(result.get("skipped"), list) else []
                    detail = "；".join(str(item.get("message") or item) for item in (errors + skipped)[:5])
                    audit_action(chat_id, user_id, "publish.matrix", status="failed", detail=detail)
                    await query.message.edit_text(
                        f"矩阵发布未入队。{detail or '没有符合条件的草稿或账号。'}"[:3500],
                        reply_markup=self._return_keyboard(types),
                    )
                else:
                    created = result.get("created") if isinstance(result.get("created"), list) else []
                    audit_action(chat_id, user_id, "publish.matrix", status="success", detail=str(result.get("batch_id") or ""))
                    await query.message.edit_text(
                        f"矩阵发布已入队：{result.get('batch_id') or '已创建'}\n已创建 {len(created)} 个任务。",
                        reply_markup=self._return_keyboard(types),
                    )
            elif action == "tasks":
                await self._tasks(query, types, member, int(parts[2]) if len(parts) > 2 else 0)
            elif action == "t" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "t", parts[2])
                task_id = str(reference.get("task_id") or "")
                task_kind = str(reference.get("task_kind") or "social")
                task = await self._call(user_id, "tasks.get", {"task_id": task_id})
                task_kind = str(task.get("_tg_task_kind") or task_kind)
                status = _task_status(task)
                rows = []
                if status in {"queued", "running", "scheduled", "pending"}:
                    rows.append([types.InlineKeyboardButton(text="取消任务", callback_data=callback_token(chat_id, "tcancel", {"task_id": task_id, "task_kind": task_kind}))])
                if status == "failed" and task_kind == "social":
                    rows.append([types.InlineKeyboardButton(text="重试任务", callback_data=callback_token(chat_id, "tretry", {"task_id": task_id, "task_kind": task_kind}))])
                elif status == "failed" and task_kind == "normal":
                    rows.append([types.InlineKeyboardButton(text="重新生成", callback_data="tt:generate")])
                rows.append([types.InlineKeyboardButton(text="返回任务", callback_data="tt:tasks:0")])
                await query.message.edit_text(
                    f"任务：{task_id}\n类型：{task.get('type') or task.get('task_type')}\n状态：{status}\n{str(task.get('error') or task.get('message') or '')[:1500]}",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
            elif action in {"tcancel", "tretry"} and len(parts) > 2:
                task_action = "tasks.cancel" if action == "tcancel" else "tasks.retry"
                reference = resolve_callback_token(chat_id, action, parts[2], consume=True)
                task_id = str(reference.get("task_id") or "")
                if action == "tretry" and str(reference.get("task_kind") or "") != "social":
                    raise HTTPException(status_code=409, detail="生成任务请从推文生成重新提交")
                result = await self._call(user_id, task_action, {"task_id": task_id})
                audit_action(chat_id, user_id, task_action, status="success", resource_type="task", resource_id=task_id)
                await query.message.edit_text(str(result.get("message") or "操作已提交"), reply_markup=self._return_keyboard(types))
            elif action == "profile":
                state = load_state(chat_id)
                if not state["selected_persona_id"]:
                    raise HTTPException(status_code=400, detail="请先选择人设")
                profile = await self._call(user_id, "profile.get", {"persona_id": state["selected_persona_id"]})
                rows = [[
                    types.InlineKeyboardButton(text="编辑简介", callback_data="tt:bio"),
                    types.InlineKeyboardButton(text="编辑推文风格", callback_data="tt:style"),
                ], [types.InlineKeyboardButton(text="返回总控菜单", callback_data="tt:menu")]]
                await query.message.edit_text(
                    f"内容设置\n\n简介：{str(profile.get('content') or '')[:1200]}\n\n推文风格：{str(profile.get('tweet_style_sample') or '')[:1200]}",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
            elif action in {"bio", "style"}:
                save_state(chat_id, mode="profile_content" if action == "bio" else "profile_style", payload={})
                await query.message.edit_text("请发送新的内容。发送 /cancel 取消。")
            elif action == "accounts":
                accounts = await self._call(user_id, "accounts.list")
                lines = [f"{item.get('platform')} · @{item.get('username')} · {item.get('status')}" for item in accounts[:20]]
                base = str((self.get_runtime() or {}).get("telegram_tweet_public_base_url") or "").rstrip("/")
                rows = []
                if base.startswith("https://"):
                    rows.append([types.InlineKeyboardButton(text="网页登录/授权", url=f"{base}/console.html?view=accounts")])
                rows.append([types.InlineKeyboardButton(text="返回总控菜单", callback_data="tt:menu")])
                await query.message.edit_text(
                    "账号状态\n" + ("\n".join(lines) if lines else "暂无已绑定账号。") + "\n\n登录、OAuth、代理和浏览器人工接管必须在网页端完成，Bot 不接收密码或验证码。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
            else:
                await query.answer("操作已过期，请返回总控菜单", show_alert=True)
                return
            await query.answer()
        except Exception as exc:
            logger.exception("Telegram tweet callback failed: %s", data)
            audit_action(chat_id, user_id, action or "callback", status="failed", detail=_error_text(exc))
            await query.answer(_error_text(exc)[:180], show_alert=True)

    async def handle_text(self, message: Any, types: Any) -> None:
        member = await self._authorized(message.chat, message.from_user, message.answer)
        if not member:
            return
        chat_id = int(message.chat.id)
        user_id = int(member["web_user_id"])
        text = str(message.text or "").strip()
        if text in {"/cancel", "/done"}:
            clear_pending_state(chat_id)
            await message.answer("已结束当前操作。", reply_markup=self._main_keyboard(types))
            return
        if await self._handle_control_button(message, types, member, text):
            return
        state = load_state(chat_id)
        mode = state["mode"]
        persona_id = state["selected_persona_id"]
        if not mode:
            await self.send_main_menu(message, types)
            return
        try:
            if mode == "persona_new":
                name, _, content = text.partition("｜")
                if not content:
                    name, _, content = text.partition("|")
                result = await self._call(user_id, "personas.create", {"name": name.strip(), "content": content.strip()})
                persona = result.get("persona") if isinstance(result, dict) else result
                new_id = str((persona or {}).get("id") or result.get("id") or "")
                save_state(chat_id, selected_persona_id=new_id, mode="", payload={})
                audit_action(chat_id, user_id, "persona.create", status="success", resource_type="persona", resource_id=new_id)
                await message.answer(f"人设已创建：{(persona or {}).get('name') or name.strip()}", reply_markup=self._main_keyboard(types))
            elif mode == "generate_prompt":
                result = await self._call(user_id, "generation.start", {
                    "persona_id": persona_id,
                    "prompt": text,
                    "count": int(state["payload"].get("count") or 3),
                    "target_words": int(state["payload"].get("target_words") or 120),
                    "idempotency_key": f"tg:{chat_id}:{int(message.message_id)}",
                })
                task_id = str(result.get("task_id") or "")
                save_state(chat_id, mode="", payload={"last_task_id": task_id})
                audit_action(chat_id, user_id, "generation.start", status="success", resource_type="task", resource_id=task_id)
                await message.answer(f"生成任务已提交：{task_id}\n可在“任务中心”查看进度。", reply_markup=self._main_keyboard(types))
                asyncio.create_task(self._watch_generation(message.bot, chat_id, user_id, persona_id, task_id, types))
            elif mode == "draft_new":
                result = await self._call(user_id, "posts.create", {"persona_id": persona_id, "content": text})
                post = result.get("post") if isinstance(result, dict) else result
                post_id = str((post or {}).get("id") or result.get("id") or "")
                clear_pending_state(chat_id)
                audit_action(chat_id, user_id, "post.create", status="success", resource_type="post", resource_id=post_id)
                await message.answer("草稿已保存。", reply_markup=self._main_keyboard(types))
            elif mode == "draft_edit":
                payload = state["payload"]
                await self._call(user_id, "posts.update", {"persona_id": persona_id, "source": payload.get("source"), "post_id": payload.get("post_id"), "content": text})
                clear_pending_state(chat_id)
                audit_action(chat_id, user_id, "post.update", status="success", resource_type=str(payload.get("source")), resource_id=str(payload.get("post_id")))
                await message.answer("推文已更新。", reply_markup=self._main_keyboard(types))
            elif mode == "schedule_time":
                scheduled_at = parse_schedule_time(text)
                payload = state["payload"]
                result = await self._call(user_id, "publish.start", {
                    "persona_id": persona_id,
                    "source": payload.get("source"),
                    "post_id": payload.get("post_id"),
                    "account_id": payload.get("account_id"),
                    "scheduled_at": scheduled_at,
                })
                clear_pending_state(chat_id)
                task = result.get("task") if isinstance(result, dict) else {}
                audit_action(chat_id, user_id, "publish.schedule", status="success", resource_type="task", resource_id=str((task or {}).get("id") or ""))
                await message.answer(f"定时发布已入队：{(task or {}).get('id') or '已创建'}", reply_markup=self._main_keyboard(types))
            elif mode in {"profile_content", "profile_style"}:
                key = "content" if mode == "profile_content" else "tweet_style_sample"
                await self._call(user_id, "profile.update", {"persona_id": persona_id, key: text})
                clear_pending_state(chat_id)
                audit_action(chat_id, user_id, "profile.update", status="success", resource_type="persona", resource_id=persona_id, detail=key)
                await message.answer("内容设置已保存。", reply_markup=self._main_keyboard(types))
            elif mode == "hot_prompt":
                result = await self._call(user_id, "hot.start", {"persona_id": persona_id, "prompt": text})
                task_id = str(result.get("task_id") or result.get("id") or "")
                if not task_id:
                    raise HTTPException(status_code=502, detail="热点任务未返回任务 ID")
                save_state(chat_id, mode="", payload={
                    "last_hot_task_id": task_id,
                    "last_hot_persona_id": persona_id,
                })
                rows = [[
                    types.InlineKeyboardButton(
                        text="查看状态",
                        callback_data=callback_token(chat_id, "hotstatus", {
                            "task_id": task_id, "persona_id": persona_id,
                        }),
                    ),
                    types.InlineKeyboardButton(
                        text="取消任务",
                        callback_data=callback_token(chat_id, "hotcancel", {
                            "task_id": task_id, "persona_id": persona_id,
                        }),
                    ),
                ], [types.InlineKeyboardButton(text="返回总控菜单", callback_data="tt:menu")]]
                await message.answer(
                    f"热点任务已提交：{task_id}\n完成后 Bot 会返回候选。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
                asyncio.create_task(self._watch_hot(message.bot, chat_id, user_id, persona_id, task_id, types))
            else:
                await message.answer("当前操作状态已失效，请重新选择。", reply_markup=self._main_keyboard(types))
                clear_pending_state(chat_id)
        except Exception as exc:
            logger.exception("Telegram tweet text action failed: %s", mode)
            audit_action(chat_id, user_id, mode, status="failed", detail=_error_text(exc))
            await message.answer(f"操作失败：{_error_text(exc)}\n状态已保留，可修正后重试，或发送 /cancel。")

    async def handle_media(self, message: Any, types: Any) -> None:
        member = await self._authorized(message.chat, message.from_user, message.answer)
        if not member:
            return
        chat_id = int(message.chat.id)
        user_id = int(member["web_user_id"])
        state = load_state(chat_id)
        if state["mode"] not in {"media_upload", "media_replace"}:
            await message.answer("请先从草稿详情选择“添加媒体”。", reply_markup=self._main_keyboard(types))
            return
        media = None
        filename = "telegram-media"
        mime_type = "application/octet-stream"
        if getattr(message, "photo", None):
            media = message.photo[-1]
            filename = f"telegram-{media.file_unique_id}.jpg"
            mime_type = "image/jpeg"
        elif getattr(message, "video", None):
            media = message.video
            filename = str(message.video.file_name or f"telegram-{message.video.file_unique_id}.mp4")
            mime_type = str(message.video.mime_type or "video/mp4")
        elif getattr(message, "document", None):
            media = message.document
            filename = str(message.document.file_name or f"telegram-{message.document.file_unique_id}")
            mime_type = str(message.document.mime_type or mime_type)
        if media is None:
            await message.answer("未识别到支持的媒体。")
            return
        if int(getattr(media, "file_size", 0) or 0) > MAX_TELEGRAM_MEDIA_BYTES:
            await message.answer("文件超过 Telegram Bot 20MB 下载限制。")
            return
        canonical_suffix = SUPPORTED_MEDIA_MIME_SUFFIXES.get(mime_type.lower())
        if not canonical_suffix:
            await message.answer("仅支持 JPG、PNG、WebP、GIF、MP4、MOV 或 WebM 媒体。")
            return
        filename = f"{filename.rsplit('.', 1)[0]}{canonical_suffix}"
        try:
            target = BytesIO()
            await message.bot.download(media, destination=target)
            content = target.getvalue()
            payload = state["payload"]
            await self._call_async(user_id, "media.add", {
                "persona_id": state["selected_persona_id"],
                "source": payload.get("source"),
                "post_id": payload.get("post_id"),
                "filename": filename,
                "mime_type": mime_type,
                "content": content,
                "replace_index": state["payload"].get("replace_index") if state["mode"] == "media_replace" else None,
            })
            audit_action(chat_id, user_id, "media.add", status="success", resource_type=str(payload.get("source")), resource_id=str(payload.get("post_id")))
            if state["mode"] == "media_replace":
                clear_pending_state(chat_id)
                await message.answer("媒体已替换。", reply_markup=self._main_keyboard(types))
            else:
                await message.answer("媒体已添加。可继续发送，或发送 /done 完成。")
        except Exception as exc:
            logger.exception("Telegram media upload failed")
            audit_action(chat_id, user_id, "media.add", status="failed", detail=_error_text(exc))
            await message.answer(f"媒体上传失败：{_error_text(exc)}")

    async def _watch_generation(self, bot: Any, chat_id: int, user_id: int, persona_id: str, task_id: str, types: Any) -> None:
        for _ in range(180):
            await asyncio.sleep(3)
            if not self._member_still_bound(chat_id, user_id):
                return
            try:
                task = await self._call(user_id, "generation.status", {"persona_id": persona_id, "task_id": task_id})
            except Exception:
                return
            status = _task_status(task)
            if status in {"queued", "running"}:
                continue
            if status == "success":
                posts = await self._call(user_id, "posts.list", {"persona_id": persona_id, "source": "posts"})
                preview = "\n\n".join(f"{index + 1}. {str(post.get('content') or '')[:600]}" for index, post in enumerate(posts[:3]))
                if not self._member_still_bound(chat_id, user_id):
                    return
                await bot.send_message(chat_id, f"推文生成完成。\n\n{preview}"[:4000], reply_markup=self._main_keyboard(types))
            else:
                if not self._member_still_bound(chat_id, user_id):
                    return
                await bot.send_message(chat_id, f"推文生成{status}：{str(task.get('error') or '')[:1200]}", reply_markup=self._main_keyboard(types))
            return

    async def _watch_publish(self, bot: Any, chat_id: int, user_id: int, task_id: str, types: Any) -> None:
        for _ in range(240):
            await asyncio.sleep(3)
            if not self._member_still_bound(chat_id, user_id):
                return
            try:
                task = await self._call(user_id, "tasks.get", {"task_id": task_id})
            except Exception:
                return
            status = _task_status(task)
            if status in {"queued", "pending", "running", "retrying"}:
                continue
            result = task.get("result") if isinstance(task.get("result"), dict) else {}
            url = str(
                task.get("published_url")
                or task.get("post_url")
                or task.get("result_url")
                or result.get("published_url")
                or result.get("post_url")
                or result.get("url")
                or ""
            ).strip()
            suffix = f"\n{url}" if url.startswith(("https://", "http://")) else ""
            if not self._member_still_bound(chat_id, user_id):
                return
            await bot.send_message(
                chat_id,
                f"发布任务 {status}：{task_id}{suffix}"[:4000],
                reply_markup=self._main_keyboard(types),
            )
            return

    async def _watch_hot(self, bot: Any, chat_id: int, user_id: int, persona_id: str, task_id: str, types: Any) -> None:
        for _ in range(180):
            await asyncio.sleep(3)
            if not self._member_still_bound(chat_id, user_id):
                return
            try:
                task = await self._call(user_id, "hot.status", {"persona_id": persona_id, "task_id": task_id})
            except Exception:
                return
            status = _task_status(task)
            if status in {"queued", "running"}:
                continue
            if status == "success":
                candidates = task.get("candidates") or (task.get("result") or {}).get("candidates") or []
                candidates = [item for item in candidates if isinstance(item, dict)][:5]
                if not self._member_still_bound(chat_id, user_id):
                    return
                save_state(chat_id, selected_persona_id=persona_id, mode="hot_select", payload={
                    "hot_candidates": candidates,
                    "last_hot_task_id": task_id,
                    "last_hot_persona_id": persona_id,
                })
                rows = [[types.InlineKeyboardButton(
                    text=str(item.get("title") or item.get("content") or f"候选 {index + 1}")[:28],
                    callback_data=callback_token(chat_id, "hotpick", {"index": index}),
                )] for index, item in enumerate(candidates)]
                rows.append([types.InlineKeyboardButton(text="返回总控菜单", callback_data="tt:menu")])
                await bot.send_message(chat_id, "热点候选已完成，选择一条保存为草稿。", reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows))
            else:
                if not self._member_still_bound(chat_id, user_id):
                    return
                await bot.send_message(chat_id, f"热点任务{status}：{str(task.get('error') or '')[:1200]}", reply_markup=self._main_keyboard(types))
            return


async def run_native_tweet_bot(
    *,
    token: str,
    get_runtime: Callable[[], dict[str, Any]],
    load_member: Callable[[int], Any],
    ops: TweetWorkbenchOps,
    stop_event: Any,
    status_callback: Callable[[dict[str, Any]], None],
    heartbeat: Callable[[], bool] | None = None,
) -> None:
    from aiogram import Bot, Dispatcher, F
    from aiogram.filters import Command
    from aiogram import types

    bot = Bot(token=token)
    dispatcher = Dispatcher()
    controller = NativeTweetBotController(ops=ops, get_runtime=get_runtime, load_member=load_member)

    async def command_menu(message: types.Message) -> None:
        await controller.send_main_menu(message, types)

    async def callback(query: types.CallbackQuery) -> None:
        await controller.handle_callback(query, types)

    async def media(message: types.Message) -> None:
        await controller.handle_media(message, types)

    async def text(message: types.Message) -> None:
        await controller.handle_text(message, types)

    dispatcher.message.register(command_menu, Command("start", "menu", "workbench"))
    dispatcher.message.register(media, F.photo | F.video | F.document)
    dispatcher.message.register(text, F.text)
    dispatcher.callback_query.register(callback, F.data.startswith("tt:"))
    await bot.set_my_commands([
        types.BotCommand(command="menu", description="打开推文工作台"),
        types.BotCommand(command="cancel", description="取消当前操作"),
    ])
    polling = asyncio.create_task(dispatcher.start_polling(bot, handle_signals=False))
    status_callback({"running": True, "last_error": "", "updated_at": time.time()})
    try:
        while not stop_event.is_set() and not polling.done():
            if heartbeat is not None and not heartbeat():
                break
            latest = get_runtime() or {}
            if not bool(latest.get("telegram_tweet_bot_enabled")) or str(latest.get("telegram_tweet_bot_token") or "").strip() != token:
                break
            await asyncio.sleep(2)
        if not polling.done():
            await dispatcher.stop_polling()
        results = await asyncio.gather(polling, return_exceptions=True)
        if results and isinstance(results[0], BaseException):
            raise results[0]
    finally:
        await bot.session.close()


__all__ = [
    "NativeTweetBotController",
    "TweetWorkbenchOps",
    "audit_action",
    "clear_pending_state",
    "ensure_native_bot_schema",
    "load_state",
    "parse_schedule_time",
    "run_native_tweet_bot",
    "save_state",
]

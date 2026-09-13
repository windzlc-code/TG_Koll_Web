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
PERSONA_CONTROL_BUTTON = "👤 我的人设"
TASK_CONTROL_BUTTON = "📋 任务中心"
ACCOUNT_CONTROL_BUTTON = "🔐 账号与浏览器"
STOP_CONTROL_BUTTON = "🛑 停止当前任务"
CONTROL_BUTTONS = frozenset({
    PERSONA_CONTROL_BUTTON,
    TASK_CONTROL_BUTTON,
    ACCOUNT_CONTROL_BUTTON,
    STOP_CONTROL_BUTTON,
})
HELP_TEXT = (
    "使用提示\n\n"
    "• 管理员在后台加入当前 Chat ID 后，即可使用全部推文 Bot 功能。\n"
    "• 人设、生成、草稿、收藏、媒体、热点和任务均可直接在 Telegram 内操作。\n"
    "• 首次发布前需已有可用的 Threads 或 Instagram 账号；若尚未授权，请从“账号与浏览器”完成一次 OAuth。\n"
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
                [button(text=PERSONA_CONTROL_BUTTON), button(text=TASK_CONTROL_BUTTON)],
                [button(text=ACCOUNT_CONTROL_BUTTON), button(text=STOP_CONTROL_BUTTON)],
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
    def _generation_count_keyboard(types: Any) -> Any:
        return types.InlineKeyboardMarkup(inline_keyboard=[[
            types.InlineKeyboardButton(text="1 篇", callback_data="tt:gcount:1"),
            types.InlineKeyboardButton(text="3 篇", callback_data="tt:gcount:3"),
            types.InlineKeyboardButton(text="5 篇", callback_data="tt:gcount:5"),
        ], [types.InlineKeyboardButton(text="取消", callback_data="tt:menu")]])

    @staticmethod
    def _task_filter_keyboard(types: Any) -> Any:
        button = types.InlineKeyboardButton
        return types.InlineKeyboardMarkup(inline_keyboard=[
            [button(text="⏳ 进行中任务", callback_data="tt:tasks:0:active"), button(text="❌ 失败任务", callback_data="tt:tasks:0:failed")],
            [button(text="📋 全部任务", callback_data="tt:tasks:0:all")],
        ])

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
            "请使用输入框下方的固定入口；人设相关操作均从“我的人设”逐步进入。",
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
        if text != STOP_CONTROL_BUTTON:
            clear_pending_state(chat_id)
        try:
            if text == PERSONA_CONTROL_BUTTON:
                page_text, markup = await self._persona_list_payload(types, member, chat_id, 0)
                await message.answer(page_text, reply_markup=markup)
            elif text == TASK_CONTROL_BUTTON:
                await message.answer("任务中心\n请选择要查看的任务状态。", reply_markup=self._task_filter_keyboard(types))
            elif text == ACCOUNT_CONTROL_BUTTON:
                page_text, markup = await self._accounts_payload(types, member, return_callback="tt:menu")
                await message.answer(page_text, reply_markup=markup)
            else:
                await self._stop_current_tasks(message, types, member)
            audit_action(chat_id, user_id, "control.open", status="success", detail=text)
        except Exception as exc:
            logger.exception("Telegram tweet control action failed: %s", text)
            audit_action(chat_id, user_id, "control.open", status="failed", detail=f"{text}: {_error_text(exc)}")
            await message.answer(
                f"打开失败：{_error_text(exc)}",
                reply_markup=self._main_keyboard(types),
            )
        return True

    @staticmethod
    def _resume_payload(chat_id: int, action: str) -> dict[str, Any]:
        state = load_state(chat_id)
        payload = {
            key: value
            for key, value in state["payload"].items()
            if str(key).startswith("last_")
        }
        payload["resume_action"] = action
        return save_state(chat_id, mode="", payload=payload)

    async def _start_generation_setup(self, query: Any, types: Any) -> None:
        chat_id = int(query.message.chat.id)
        save_state(chat_id, mode="generate_count", payload={})
        await query.message.edit_text(
            "AI 生成推文 · 第 1/3 步\n请选择本次生成数量。",
            reply_markup=self._generation_count_keyboard(types),
        )

    async def _start_hot_input(self, query: Any, types: Any) -> None:
        chat_id = int(query.message.chat.id)
        state = load_state(chat_id)
        last_hot_task_id = str(state["payload"].get("last_hot_task_id") or "")
        last_hot_persona_id = str(state["payload"].get("last_hot_persona_id") or state["selected_persona_id"])
        save_state(chat_id, mode="hot_prompt", payload={
            key: value for key, value in state["payload"].items() if str(key).startswith("last_")
        })
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
        rows.append([types.InlineKeyboardButton(text="取消", callback_data="tt:menu")])
        await query.message.edit_text(
            "热点创作 · 第 1/2 步\n请发送热点主题或关键词。\n收到后会先显示确认页，不会立即提交。",
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    async def _persona_list_payload(
        self,
        types: Any,
        member: dict[str, Any],
        chat_id: int,
        page: int,
    ) -> tuple[str, Any]:
        personas = await self._call(int(member["web_user_id"]), "personas.list")
        page = max(0, int(page))
        start = page * PAGE_SIZE
        total_pages = max(1, (len(personas) + PAGE_SIZE - 1) // PAGE_SIZE)
        page = min(page, total_pages - 1)
        start = page * PAGE_SIZE
        rows = []
        if any(
            int((item.get("counts") or {}).get("posts") or 0) > 0
            or int((item.get("counts") or {}).get("favorites") or 0) > 0
            for item in personas
        ):
            rows.append([types.InlineKeyboardButton(text="🚀 矩阵发布", callback_data="tt:matrix")])
        rows.append([types.InlineKeyboardButton(text="➕ 新建人设", callback_data="tt:persona_new")])
        state = load_state(chat_id)
        for item in personas[start:start + PAGE_SIZE]:
            persona_id = str(item.get("id") or "")
            marker = "✅ " if persona_id == state["selected_persona_id"] else ""
            count = int((item.get("counts") or {}).get("posts") or 0)
            rows.append([types.InlineKeyboardButton(
                text=f"{marker}{str(item.get('name') or '未命名人设')[:24]}（{count}篇）",
                callback_data=callback_token(chat_id, "p", {"persona_id": persona_id}),
            )])
        nav = []
        if page > 0:
            nav.append(types.InlineKeyboardButton(text="⬅️", callback_data=f"tt:personas:{page - 1}"))
        if start + PAGE_SIZE < len(personas):
            nav.append(types.InlineKeyboardButton(text="➡️", callback_data=f"tt:personas:{page + 1}"))
        if nav:
            rows.append(nav)
        rows.append([types.InlineKeyboardButton(text="返回总控菜单", callback_data="tt:menu")])
        resume_action = str(state["payload"].get("resume_action") or "")
        resume_text = {
            "generate": "AI 生成推文",
            "hot": "热点创作",
            "draft_new": "手工新建草稿",
            "drafts": "查看草稿",
            "favorites": "查看收藏",
            "publish_one": "单篇发布",
        }.get(resume_action, "")
        if personas:
            text = (
                f"{resume_text} · 准备步骤\n请选择要使用的人设，选择后会自动继续。"
                if resume_text
                else f"我的人设（{len(personas)}）\n第 {page + 1}/{total_pages} 页\n请选择人设进入详情和设置。"
            )
        else:
            text = "尚无人设，可先新建一个。"
        return text, types.InlineKeyboardMarkup(inline_keyboard=rows)

    async def _persona_list(self, query: Any, types: Any, member: dict[str, Any], page: int) -> None:
        text, markup = await self._persona_list_payload(
            types, member, int(query.message.chat.id), page,
        )
        await query.message.edit_text(text, reply_markup=markup)

    async def _accounts_payload(
        self,
        types: Any,
        member: dict[str, Any],
        *,
        return_callback: str,
        persona_id: str = "",
    ) -> tuple[str, Any]:
        accounts = await self._call(int(member["web_user_id"]), "accounts.list")
        if persona_id:
            accounts = [
                item for item in accounts
                if str(item.get("persona_id") or "") == str(persona_id)
            ]
        lines = [f"{item.get('platform')} · @{item.get('username')} · {item.get('status')}" for item in accounts[:20]]
        base = str((self.get_runtime() or {}).get("telegram_tweet_public_base_url") or "").rstrip("/")
        rows = []
        if base.startswith("https://"):
            rows.append([types.InlineKeyboardButton(text="网页登录/授权", url=f"{base}/console.html?view=accounts")])
        rows.append([types.InlineKeyboardButton(text="返回", callback_data=return_callback)])
        text = (
            "账号与浏览器\n"
            + ("\n".join(lines) if lines else "暂无已绑定账号。")
            + "\n\n登录、OAuth、代理和浏览器人工接管必须在网页端完成，Bot 不接收密码或验证码。"
        )
        return text, types.InlineKeyboardMarkup(inline_keyboard=rows)

    async def _stop_current_tasks(self, message: Any, types: Any, member: dict[str, Any]) -> None:
        chat_id = int(message.chat.id)
        user_id = int(member["web_user_id"])
        state = load_state(chat_id)
        stopped_input = bool(state["mode"])
        save_state(chat_id, mode="", payload={})
        failures = []
        try:
            tasks = await self._call(user_id, "tasks.list", {"limit": 30})
        except Exception as exc:
            tasks = []
            failures.append(f"读取当前任务失败：{_error_text(exc)}")
        active = [
            item for item in tasks
            if _task_status(item) in {"queued", "pending", "running", "retrying"}
        ]
        stopped_ids = []
        for item in active:
            task_id = str(item.get("id") or "")
            if not task_id:
                continue
            try:
                await self._call(user_id, "tasks.cancel", {"task_id": task_id})
                stopped_ids.append(task_id)
            except Exception as exc:
                failures.append(f"{task_id[:10]}：{_error_text(exc)}")
        if not stopped_ids and not stopped_input and not failures:
            text = "当前没有正在执行或等待执行的推文任务。"
        else:
            lines = ["已停止当前操作。"]
            if stopped_input:
                lines.append("未提交的输入步骤已取消。")
            if stopped_ids:
                lines.append(f"已发送取消指令：{len(stopped_ids)} 个任务。")
            if failures:
                lines.append("以下任务未能取消：\n" + "\n".join(failures[:5]))
            text = "\n".join(lines)
        audit_action(
            chat_id, user_id, "tasks.force_stop",
            status="failed" if failures else "success",
            detail=f"stopped={len(stopped_ids)}; failures={len(failures)}",
        )
        await message.answer(text, reply_markup=self._main_keyboard(types))

    async def _post_list(
        self,
        query: Any,
        types: Any,
        member: dict[str, Any],
        *,
        source: str,
        page: int,
        intro: str = "",
    ) -> None:
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
                {
                    "persona_id": persona_id,
                    "post_id": str(post.get("id") or ""),
                    "source": source,
                },
            ),
        )] for index, post in enumerate(posts[start:start + PAGE_SIZE])]
        nav = []
        target = "publishposts" if intro and source == "posts" else ("favorites" if source == "favorites" else "drafts")
        if page > 0:
            nav.append(types.InlineKeyboardButton(text="⬅️", callback_data=f"tt:{target}:{page - 1}"))
        if start + PAGE_SIZE < len(posts):
            nav.append(types.InlineKeyboardButton(text="➡️", callback_data=f"tt:{target}:{page + 1}"))
        if nav:
            rows.append(nav)
        if source == "posts":
            rows.append([types.InlineKeyboardButton(text="➕ 手工新建草稿", callback_data="tt:draft_new")])
        rows.append([types.InlineKeyboardButton(
            text="返回人设详情",
            callback_data=callback_token(
                int(query.message.chat.id), "p", {"persona_id": persona_id},
            ),
        )])
        list_text = (
            f"{'收藏' if source == 'favorites' else '草稿'}（{len(posts)}）"
            if posts else f"当前人设暂无{'收藏' if source == 'favorites' else '草稿'}。"
        )
        await query.message.edit_text(
            f"{intro}\n\n{list_text}" if intro else list_text,
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    async def _post_detail(
        self,
        query: Any,
        types: Any,
        member: dict[str, Any],
        post_id: str,
        source: str,
        *,
        notice: str = "",
    ) -> None:
        state = load_state(int(query.message.chat.id))
        posts = await self._call(int(member["web_user_id"]), "posts.list", {"persona_id": state["selected_persona_id"], "source": source})
        post = next((item for item in posts if str(item.get("id") or "") == post_id), None)
        if not post:
            await query.answer("推文不存在或已删除", show_alert=True)
            return
        media = post.get("media_items") if isinstance(post.get("media_items"), list) else post.get("mediaPaths") or post.get("media_paths") or []
        rows = [
            [types.InlineKeyboardButton(text="✏️ 编辑", callback_data=callback_token(int(query.message.chat.id), "edit", {"persona_id": state["selected_persona_id"], "source": source, "post_id": post_id})),
             types.InlineKeyboardButton(text="📎 添加媒体", callback_data=callback_token(int(query.message.chat.id), "media", {"persona_id": state["selected_persona_id"], "source": source, "post_id": post_id}))],
            [types.InlineKeyboardButton(text="立即发布", callback_data=callback_token(int(query.message.chat.id), "pub", {"persona_id": state["selected_persona_id"], "source": source, "post_id": post_id})),
             types.InlineKeyboardButton(text="定时发布", callback_data=callback_token(int(query.message.chat.id), "sched", {"persona_id": state["selected_persona_id"], "source": source, "post_id": post_id}))],
        ]
        if media:
            rows.append([
                types.InlineKeyboardButton(text="♻️ 替换首个媒体", callback_data=callback_token(int(query.message.chat.id), "mediareplace", {"persona_id": state["selected_persona_id"], "source": source, "post_id": post_id, "index": 0})),
                types.InlineKeyboardButton(text="移除最后媒体", callback_data=callback_token(int(query.message.chat.id), "mediadel", {"persona_id": state["selected_persona_id"], "source": source, "post_id": post_id, "index": len(media) - 1})),
            ])
        if source == "posts":
            rows.append([types.InlineKeyboardButton(text="⭐ 加入收藏", callback_data=callback_token(int(query.message.chat.id), "favadd", {"persona_id": state["selected_persona_id"], "post_id": post_id}))])
        rows.extend([
            [types.InlineKeyboardButton(text="🗑 删除", callback_data=callback_token(int(query.message.chat.id), "delask", {"persona_id": state["selected_persona_id"], "source": source, "post_id": post_id}))],
            [types.InlineKeyboardButton(text="返回列表", callback_data=f"tt:{'favorites' if source == 'favorites' else 'drafts'}:0")],
        ])
        content = str(post.get("content") or "").strip()
        prefix = f"{notice.strip()}\n\n" if notice.strip() else ""
        await query.message.edit_text(
            f"{prefix}{str(post.get('title') or '推文')[:100]}\n\n{content[:3000]}\n\n媒体：{len(media)} 项",
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
            and str(account.get("platform") or "").lower() in {"threads", "instagram"}
        ]
        if not eligible:
            raise HTTPException(status_code=409, detail="当前人设没有绑定 Threads 或 Instagram 账号，请先在网页端完成账号授权")
        rows = []
        for account in eligible[:12]:
            account_id = str(account.get("id") or "")
            label = str(account.get("display_name") or account.get("username") or account_id)[:32]
            platform = str(account.get("platform") or "threads").strip().lower()
            rows.append([types.InlineKeyboardButton(
                text=f"{platform.title()} · {label}"[:40],
                callback_data=callback_token(chat_id, "pa", {
                    "persona_id": state["selected_persona_id"],
                    "source": source,
                    "post_id": post_id,
                    "account_id": account_id,
                    "platform": platform,
                    "scheduled": bool(scheduled),
                }),
            )])
        rows.append([types.InlineKeyboardButton(
            text="取消",
            callback_data=f"tt:{'favorites' if source == 'favorites' else 'drafts'}:0",
        )])
        await query.message.edit_text(
            "请选择用于发布的账号。",
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    async def _tasks(
        self,
        query: Any,
        types: Any,
        member: dict[str, Any],
        page: int,
        status_filter: str = "all",
    ) -> None:
        tasks = await self._call(int(member["web_user_id"]), "tasks.list", {"limit": 30})
        if status_filter == "active":
            tasks = [
                item for item in tasks
                if _task_status(item) in {"queued", "pending", "running", "retrying", "scheduled"}
            ]
        elif status_filter == "failed":
            tasks = [item for item in tasks if _task_status(item) == "failed"]
        else:
            status_filter = "all"
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
                    int(query.message.chat.id), "t", {
                        "task_id": task_id,
                        "task_kind": task_kind,
                        "status_filter": status_filter,
                    },
                ),
            )])
        nav = []
        if page > 0:
            nav.append(types.InlineKeyboardButton(text="⬅️", callback_data=f"tt:tasks:{page - 1}:{status_filter}"))
        if start + PAGE_SIZE < len(tasks):
            nav.append(types.InlineKeyboardButton(text="➡️", callback_data=f"tt:tasks:{page + 1}:{status_filter}"))
        if nav:
            rows.append(nav)
        rows.append([types.InlineKeyboardButton(text="返回任务中心", callback_data="tt:taskmenu")])
        filter_label = {"active": "进行中", "failed": "失败", "all": "全部"}[status_filter]
        await query.message.edit_text(
            f"{filter_label}任务（{len(tasks)} 条）" if tasks else f"暂无{filter_label}任务。",
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    async def _matrix_picker(
        self,
        query: Any,
        types: Any,
        member: dict[str, Any],
        page: int = 0,
    ) -> None:
        personas = await self._call(int(member["web_user_id"]), "personas.list")
        eligible = [
            item for item in personas
            if int((item.get("counts") or {}).get("posts") or 0) > 0
            or int((item.get("counts") or {}).get("favorites") or 0) > 0
        ]
        if not eligible:
            raise HTTPException(status_code=409, detail="没有可用于矩阵发布的草稿或收藏")
        state = load_state(int(query.message.chat.id))
        selected = {
            str(item) for item in state["payload"].get("matrix_persona_ids") or [] if str(item)
        }
        page = max(0, int(page))
        start = page * PAGE_SIZE
        rows = []
        for persona in eligible[start:start + PAGE_SIZE]:
            persona_id = str(persona.get("id") or "")
            marker = "✅" if persona_id in selected else "⬜"
            rows.append([types.InlineKeyboardButton(
                text=f"{marker} {str(persona.get('name') or '未命名人设')[:28]}",
                callback_data=callback_token(
                    int(query.message.chat.id), "mx", {"persona_id": persona_id, "page": page},
                ),
            )])
        nav = []
        if page > 0:
            nav.append(types.InlineKeyboardButton(text="⬅️", callback_data=f"tt:matrixpage:{page - 1}"))
        if start + PAGE_SIZE < len(eligible):
            nav.append(types.InlineKeyboardButton(text="➡️", callback_data=f"tt:matrixpage:{page + 1}"))
        if nav:
            rows.append(nav)
        if selected:
            rows.append([types.InlineKeyboardButton(
                text=f"下一步：确认 {len(selected)} 个人设",
                callback_data="tt:matrixnext",
            )])
        rows.append([types.InlineKeyboardButton(text="取消", callback_data="tt:personas:0")])
        await query.message.edit_text(
            "矩阵发布 · 第 1/4 步\n"
            "请选择要发布的人设；后续再选择内容来源和发布平台。\n"
            f"已选择：{len(selected)} 个",
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    async def _matrix_source_picker(self, query: Any, types: Any) -> None:
        state = load_state(int(query.message.chat.id))
        persona_ids = [str(item) for item in state["payload"].get("matrix_persona_ids") or [] if str(item)]
        if not persona_ids:
            raise HTTPException(status_code=409, detail="矩阵选择已失效，请重新开始")
        rows = [[
            types.InlineKeyboardButton(text="📝 草稿", callback_data="tt:mxsource:posts"),
            types.InlineKeyboardButton(text="⭐ 收藏", callback_data="tt:mxsource:favorites"),
        ], [types.InlineKeyboardButton(text="上一步", callback_data="tt:matrixback")]]
        await query.message.edit_text(
            "矩阵发布 · 第 2/4 步\n"
            f"已选择 {len(persona_ids)} 个人设，请选择每个人设要取用的内容来源。",
            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
        )

    async def _matrix_platform_picker(
        self,
        query: Any,
        types: Any,
        member: dict[str, Any],
    ) -> None:
        chat_id = int(query.message.chat.id)
        state = load_state(chat_id)
        persona_ids = {str(item) for item in state["payload"].get("matrix_persona_ids") or [] if str(item)}
        source = str(state["payload"].get("matrix_source") or "")
        if not persona_ids or source not in {"posts", "favorites"}:
            raise HTTPException(status_code=409, detail="矩阵来源选择已失效，请重新开始")
        accounts = await self._call(int(member["web_user_id"]), "accounts.list")
        platforms = {
            str(item.get("platform") or "").strip().lower()
            for item in accounts
            if str(item.get("persona_id") or "") in persona_ids
            and str(item.get("platform") or "").strip().lower() in {"threads", "instagram"}
        }
        rows = []
        if "threads" in platforms:
            rows.append([types.InlineKeyboardButton(text="Threads", callback_data="tt:mxplatform:threads")])
        if "instagram" in platforms:
            rows.append([types.InlineKeyboardButton(text="Instagram", callback_data="tt:mxplatform:instagram")])
        rows.append([types.InlineKeyboardButton(text="上一步", callback_data="tt:mxbacksource")])
        source_ready_count = int(state["payload"].get("matrix_source_ready_count") or len(persona_ids))
        source_skipped_count = max(0, len(persona_ids) - source_ready_count)
        source_note = (
            f"\n其中 {source_ready_count} 个人设有该来源内容，{source_skipped_count} 个将在提交时跳过。"
            if source_skipped_count
            else f"\n{source_ready_count} 个人设均有该来源内容。"
        )
        message = (
            f"矩阵发布 · 第 3/4 步\n请选择发布平台。{source_note}"
            if platforms
            else "所选人设尚未绑定 Threads 或 Instagram 账号，请先完成账号授权。"
        )
        await query.message.edit_text(
            message,
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
            elif action == "taskmenu":
                clear_pending_state(chat_id)
                await query.message.edit_text(
                    "任务中心\n请选择要查看的任务状态。",
                    reply_markup=self._task_filter_keyboard(types),
                )
            elif action in {"personamenu", "creationmenu", "contentmenu", "publishmenu"}:
                clear_pending_state(chat_id)
                await self._persona_list(query, types, member, 0)
            elif action == "personas":
                await self._persona_list(query, types, member, int(parts[2]) if len(parts) > 2 else 0)
            elif action == "p" and len(parts) > 2:
                persona_id = str(resolve_callback_token(chat_id, "p", parts[2]).get("persona_id") or "")
                personas = await self._call(user_id, "personas.list")
                persona = next((item for item in personas if str(item.get("id") or "") == persona_id), None)
                if not persona:
                    raise HTTPException(status_code=404, detail="人设不存在")
                previous = load_state(chat_id)
                resume_action = str(previous["payload"].get("resume_action") or "")
                retained = {
                    key: value
                    for key, value in previous["payload"].items()
                    if str(key).startswith("last_")
                }
                save_state(chat_id, selected_persona_id=persona_id, mode="", payload=retained)
                if resume_action == "generate":
                    await self._start_generation_setup(query, types)
                    await query.answer(f"已选择 {persona.get('name') or '人设'}")
                    return
                if resume_action == "hot":
                    await self._start_hot_input(query, types)
                    await query.answer(f"已选择 {persona.get('name') or '人设'}")
                    return
                if resume_action == "draft_new":
                    save_state(chat_id, mode="draft_new", payload={})
                    await query.message.edit_text(
                        "手工新建草稿 · 输入正文\n请发送草稿正文。\n发送 /cancel 取消。"
                    )
                    await query.answer(f"已选择 {persona.get('name') or '人设'}")
                    return
                if resume_action in {"drafts", "favorites", "publish_one"}:
                    source = "favorites" if resume_action == "favorites" else "posts"
                    await self._post_list(
                        query, types, member, source=source, page=0,
                        intro="单篇发布 · 请选择要发布的草稿。" if resume_action == "publish_one" else "",
                    )
                    await query.answer(f"已选择 {persona.get('name') or '人设'}")
                    return
                rows = [
                    [types.InlineKeyboardButton(text="📝 查看推文", callback_data="tt:postsmenu"), types.InlineKeyboardButton(text="🕘 发布历史", callback_data="tt:persona_history")],
                    [types.InlineKeyboardButton(text="✍️ 新建推文", callback_data="tt:createmenu"), types.InlineKeyboardButton(text="⚙️ 人设设置", callback_data="tt:profile")],
                    [types.InlineKeyboardButton(text="🔐 账号状态", callback_data="tt:persona_accounts")],
                    [types.InlineKeyboardButton(text="🚀 发布推文", callback_data="tt:publish_one")],
                    [types.InlineKeyboardButton(text="返回我的人设", callback_data="tt:personas:0")],
                ]
                await query.message.edit_text(
                    f"👤 {persona.get('name') or '未命名人设'}\n\n"
                    f"草稿：{persona.get('counts', {}).get('posts', 0)} 篇\n"
                    f"收藏：{persona.get('counts', {}).get('favorites', 0)} 篇\n\n"
                    "该人设的创作、内容、发布与设置均从这里继续。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
            elif action == "persona_new":
                state = load_state(chat_id)
                retained = {
                    key: value
                    for key, value in state["payload"].items()
                    if str(key).startswith("last_") or key == "resume_action"
                }
                save_state(chat_id, mode="persona_new", payload=retained)
                await query.message.edit_text("请发送：人设名称｜简介\n例如：科技观察员｜关注 AI 产品与创业趋势\n发送 /cancel 取消。")
            elif action == "generate":
                if not load_state(chat_id)["selected_persona_id"]:
                    self._resume_payload(chat_id, "generate")
                    await query.answer("请先选择人设，选择后会自动继续")
                    await self._persona_list(query, types, member, 0)
                    return
                await self._start_generation_setup(query, types)
            elif action == "gagain" and len(parts) > 2:
                persona_id = str(resolve_callback_token(chat_id, "gagain", parts[2]).get("persona_id") or "")
                if not persona_id:
                    raise HTTPException(status_code=410, detail="生成人设入口已失效，请重新选择")
                save_state(chat_id, selected_persona_id=persona_id)
                await self._start_generation_setup(query, types)
            elif action == "postsmenu":
                state = load_state(chat_id)
                if not state["selected_persona_id"]:
                    await self._persona_list(query, types, member, 0)
                    return
                rows = [[
                    types.InlineKeyboardButton(text="📝 查看草稿", callback_data="tt:drafts:0"),
                    types.InlineKeyboardButton(text="⭐ 查看收藏", callback_data="tt:favorites:0"),
                ], [
                    types.InlineKeyboardButton(
                        text="返回人设详情",
                        callback_data=callback_token(chat_id, "p", {"persona_id": state["selected_persona_id"]}),
                    ),
                ]]
                await query.message.edit_text(
                    "推文内容\n请选择查看草稿、收藏，或手工新建一篇草稿。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
            elif action == "createmenu":
                state = load_state(chat_id)
                if not state["selected_persona_id"]:
                    await self._persona_list(query, types, member, 0)
                    return
                rows = [[
                    types.InlineKeyboardButton(text="✨ AI 生成推文", callback_data="tt:generate"),
                    types.InlineKeyboardButton(text="🔥 热点创作", callback_data="tt:hot"),
                ], [
                    types.InlineKeyboardButton(text="📝 手工新建草稿", callback_data="tt:draft_new"),
                ], [
                    types.InlineKeyboardButton(
                        text="返回人设详情",
                        callback_data=callback_token(chat_id, "p", {"persona_id": state["selected_persona_id"]}),
                    ),
                ]]
                await query.message.edit_text(
                    "新建推文\n请选择 AI 生成、热点创作或手工输入。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
            elif action == "persona_history":
                state = load_state(chat_id)
                persona_id = state["selected_persona_id"]
                if not persona_id:
                    await self._persona_list(query, types, member, 0)
                    return
                tasks = await self._call(user_id, "tasks.list", {"limit": 30})
                history = [
                    item for item in tasks
                    if str(item.get("_tg_task_kind") or "") == "social"
                    and str(item.get("persona_id") or item.get("archive_id") or "") == persona_id
                    and _task_status(item) in {"success", "succeeded", "completed", "published"}
                ]
                rows = [[types.InlineKeyboardButton(
                    text=f"{_task_status(item)} · {str(item.get('platform') or item.get('task_type') or '发布')[:18]}",
                    callback_data=callback_token(chat_id, "t", {
                        "task_id": str(item.get("id") or ""),
                        "task_kind": "social",
                        "status_filter": "all",
                    }),
                )] for item in history[:10] if str(item.get("id") or "")]
                rows.append([types.InlineKeyboardButton(
                    text="返回人设详情",
                    callback_data=callback_token(chat_id, "p", {"persona_id": persona_id}),
                )])
                await query.message.edit_text(
                    f"发布历史（{len(history)} 条）" if history else "当前人设暂无发布历史。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
            elif action == "gcount" and len(parts) > 2:
                state = load_state(chat_id)
                if state["mode"] != "generate_count":
                    raise HTTPException(status_code=409, detail="生成步骤已失效，请重新开始")
                count = int(parts[2])
                if count not in {1, 3, 5}:
                    raise HTTPException(status_code=400, detail="生成数量无效")
                save_state(chat_id, mode="generate_words", payload={"count": count})
                rows = [[
                    types.InlineKeyboardButton(text="精简 80 字", callback_data="tt:gwords:80"),
                    types.InlineKeyboardButton(text="标准 120 字", callback_data="tt:gwords:120"),
                ], [
                    types.InlineKeyboardButton(text="长文 200 字", callback_data="tt:gwords:200"),
                ], [
                    types.InlineKeyboardButton(text="上一步", callback_data="tt:generate"),
                    types.InlineKeyboardButton(text="取消", callback_data="tt:menu"),
                ]]
                await query.message.edit_text(
                    f"AI 生成推文 · 第 2/3 步\n数量：{count} 篇\n请选择每篇目标字数。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
            elif action == "gwords" and len(parts) > 2:
                state = load_state(chat_id)
                if state["mode"] != "generate_words":
                    raise HTTPException(status_code=409, detail="生成步骤已失效，请重新开始")
                target_words = int(parts[2])
                if target_words not in {80, 120, 200}:
                    raise HTTPException(status_code=400, detail="目标字数无效")
                save_state(
                    chat_id,
                    mode="generate_prompt",
                    payload={"count": int(state["payload"].get("count") or 3), "target_words": target_words},
                )
                await query.message.edit_text(
                    "AI 生成推文 · 第 3/3 步\n"
                    f"数量：{int(state['payload'].get('count') or 3)} 篇 · 每篇约 {target_words} 字\n"
                    "请发送本次主题或写作要求。\n收到后会先显示确认页，不会立即提交。"
                )
            elif action == "gsubmit" and len(parts) > 2:
                resolve_callback_token(chat_id, "gsubmit", parts[2], consume=True)
                state = load_state(chat_id)
                if state["mode"] != "generate_confirm":
                    raise HTTPException(status_code=409, detail="生成确认已失效，请重新开始")
                payload = state["payload"]
                try:
                    result = await self._call(user_id, "generation.start", {
                        "persona_id": state["selected_persona_id"],
                        "prompt": str(payload.get("prompt") or ""),
                        "count": int(payload.get("count") or 3),
                        "target_words": int(payload.get("target_words") or 120),
                        "idempotency_key": f"tg:{chat_id}:{int(query.message.message_id)}",
                    })
                except Exception as exc:
                    await query.message.edit_text(
                        f"生成任务提交失败：{_error_text(exc)}\n参数仍已保留，可重试或修改。"[:3500],
                        reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                            types.InlineKeyboardButton(
                                text="重试提交",
                                callback_data=callback_token(chat_id, "gsubmit", {}),
                            ),
                            types.InlineKeyboardButton(text="修改参数", callback_data="tt:generate"),
                        ]]),
                    )
                    raise
                task_id = str(result.get("task_id") or "")
                save_state(chat_id, mode="", payload={"last_task_id": task_id})
                audit_action(chat_id, user_id, "generation.start", status="success", resource_type="task", resource_id=task_id)
                await query.message.edit_text(
                    f"生成任务已提交：{task_id}\n完成后 Bot 会直接返回结果。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(text="查看任务", callback_data="tt:tasks:0:active"),
                    ]]),
                )
                asyncio.create_task(self._watch_generation(
                    query.message.bot, chat_id, user_id, state["selected_persona_id"], task_id, types,
                ))
            elif action == "drafts":
                if not load_state(chat_id)["selected_persona_id"]:
                    self._resume_payload(chat_id, "drafts")
                    await query.answer("请先选择人设，选择后会自动继续")
                    await self._persona_list(query, types, member, 0)
                    return
                await self._post_list(query, types, member, source="posts", page=int(parts[2]) if len(parts) > 2 else 0)
            elif action == "favorites":
                if not load_state(chat_id)["selected_persona_id"]:
                    self._resume_payload(chat_id, "favorites")
                    await query.answer("请先选择人设，选择后会自动继续")
                    await self._persona_list(query, types, member, 0)
                    return
                await self._post_list(query, types, member, source="favorites", page=int(parts[2]) if len(parts) > 2 else 0)
            elif action == "publish_one":
                if not load_state(chat_id)["selected_persona_id"]:
                    self._resume_payload(chat_id, "publish_one")
                    await query.answer("请先选择人设，选择后会自动继续")
                    await self._persona_list(query, types, member, 0)
                    return
                await self._post_list(
                    query, types, member, source="posts", page=0,
                    intro="单篇发布 · 请选择要发布的草稿。",
                )
            elif action == "publishposts":
                await self._post_list(
                    query, types, member, source="posts",
                    page=int(parts[2]) if len(parts) > 2 else 0,
                    intro="单篇发布 · 请选择要发布的草稿。",
                )
            elif action in {"d", "f"} and len(parts) > 2:
                reference = resolve_callback_token(chat_id, action, parts[2])
                reference_persona_id = str(reference.get("persona_id") or load_state(chat_id)["selected_persona_id"])
                if reference_persona_id:
                    save_state(chat_id, selected_persona_id=reference_persona_id)
                await self._post_detail(query, types, member, str(reference.get("post_id") or ""), str(reference.get("source") or "posts"))
            elif action == "gendrafts" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "gendrafts", parts[2])
                reference_persona_id = str(reference.get("persona_id") or "")
                if not reference_persona_id:
                    raise HTTPException(status_code=410, detail="生成结果入口已失效，请重新选择人设")
                save_state(chat_id, selected_persona_id=reference_persona_id)
                await self._post_list(query, types, member, source="posts", page=0)
            elif action == "draft_new":
                if not load_state(chat_id)["selected_persona_id"]:
                    self._resume_payload(chat_id, "draft_new")
                    await query.answer("请先选择人设，选择后会自动继续")
                    await self._persona_list(query, types, member, 0)
                    return
                save_state(chat_id, mode="draft_new", payload={})
                await query.message.edit_text("手工新建草稿 · 输入正文\n请发送草稿正文。\n发送 /cancel 取消。")
            elif action in {"edit", "media", "mediareplace", "mediadel", "pub", "sched", "delask"} and len(parts) > 2:
                reference = resolve_callback_token(chat_id, action, parts[2])
                source, post_id = str(reference.get("source") or "posts"), str(reference.get("post_id") or "")
                reference_persona_id = str(reference.get("persona_id") or load_state(chat_id)["selected_persona_id"])
                if reference_persona_id:
                    save_state(chat_id, selected_persona_id=reference_persona_id)
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
                    await self._post_detail(query, types, member, post_id, source, notice="媒体已移除。")
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
                        types.InlineKeyboardButton(text="确认删除", callback_data=callback_token(chat_id, "delok", {"persona_id": reference_persona_id, "source": source, "post_id": post_id})),
                        types.InlineKeyboardButton(text="取消", callback_data=f"tt:{'favorites' if source == 'favorites' else 'drafts'}:0"),
                    ]]
                    await query.message.edit_text("删除后无法恢复，确认删除？", reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows))
            elif action == "favadd" and len(parts) > 2:
                state = load_state(chat_id)
                reference = resolve_callback_token(chat_id, "favadd", parts[2], consume=True)
                post_id = str(reference.get("post_id") or "")
                persona_id = str(reference.get("persona_id") or state["selected_persona_id"])
                result = await self._call(user_id, "posts.favorite", {"persona_id": persona_id, "post_id": post_id})
                favorite = result.get("post") if isinstance(result, dict) and isinstance(result.get("post"), dict) else {}
                favorite_id = str(favorite.get("id") or "")
                audit_action(chat_id, user_id, "favorite.add", status="success", resource_type="post", resource_id=post_id)
                rows = []
                if favorite_id:
                    rows.append([types.InlineKeyboardButton(
                        text="查看收藏副本",
                        callback_data=callback_token(chat_id, "f", {
                            "persona_id": persona_id, "post_id": favorite_id, "source": "favorites",
                        }),
                    )])
                rows.append([types.InlineKeyboardButton(
                    text="返回原草稿",
                    callback_data=callback_token(chat_id, "d", {
                        "persona_id": persona_id, "post_id": post_id, "source": "posts",
                    }),
                )])
                await query.message.edit_text(
                    "已加入收藏。" if not bool(result.get("exists") if isinstance(result, dict) else False) else "该推文已在收藏中。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
            elif action == "pa" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "pa", parts[2], consume=True)
                source = str(reference.get("source") or "posts")
                post_id = str(reference.get("post_id") or "")
                account_id = str(reference.get("account_id") or "")
                platform = str(reference.get("platform") or "threads").strip().lower()
                persona_id = str(reference.get("persona_id") or load_state(chat_id)["selected_persona_id"])
                if bool(reference.get("scheduled")):
                    save_state(chat_id, mode="schedule_time", payload={
                        "persona_id": persona_id,
                        "source": source, "post_id": post_id, "account_id": account_id,
                        "platform": platform,
                    })
                    await query.message.edit_text("请输入北京时间 YYYY-MM-DD HH:MM。发送 /cancel 取消。")
                else:
                    rows = [[
                        types.InlineKeyboardButton(
                            text="确认发布",
                            callback_data=callback_token(chat_id, "pubok", {
                                "persona_id": persona_id,
                                "source": source, "post_id": post_id, "account_id": account_id,
                                "platform": platform,
                            }),
                        ),
                        types.InlineKeyboardButton(
                            text="取消",
                            callback_data=f"tt:{'favorites' if source == 'favorites' else 'drafts'}:0",
                        ),
                    ]]
                    await query.message.edit_text(
                        f"确认立即提交到 {platform.title()} 发布队列？",
                        reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                    )
            elif action in {"pubok", "schedok", "delok"} and len(parts) > 2:
                reference = resolve_callback_token(chat_id, action, parts[2], consume=True)
                source, post_id = str(reference.get("source") or "posts"), str(reference.get("post_id") or "")
                state = load_state(chat_id)
                persona_id = str(reference.get("persona_id") or state["selected_persona_id"])
                if action == "delok":
                    await self._call(user_id, "posts.delete", {"persona_id": persona_id, "source": source, "post_id": post_id})
                    save_state(chat_id, selected_persona_id=persona_id)
                    audit_action(chat_id, user_id, "post.delete", status="success", resource_type=source, resource_id=post_id)
                    await self._post_list(query, types, member, source=source, page=0, intro="已删除。")
                else:
                    scheduled_at = max(0, int(reference.get("scheduled_at") or 0))
                    publish_request = {
                        "persona_id": persona_id,
                        "source": source,
                        "post_id": post_id,
                        "account_id": str(reference.get("account_id") or ""),
                        "platform": str(reference.get("platform") or "threads").strip().lower(),
                        "scheduled_at": scheduled_at,
                    }
                    try:
                        result = await self._call(user_id, "publish.start", publish_request)
                    except Exception as exc:
                        await query.message.edit_text(
                            f"发布提交失败：{_error_text(exc)}"[:3500],
                            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                                types.InlineKeyboardButton(
                                    text="重试提交",
                                    callback_data=callback_token(chat_id, action, {
                                        "source": source,
                                        "post_id": post_id,
                                        "persona_id": persona_id,
                                        "account_id": publish_request["account_id"],
                                        "platform": publish_request["platform"],
                                        "scheduled_at": scheduled_at,
                                    }),
                                ),
                                types.InlineKeyboardButton(
                                    text="返回推文",
                                    callback_data=callback_token(chat_id, "d" if source == "posts" else "f", {
                                        "persona_id": persona_id, "source": source, "post_id": post_id,
                                    }),
                                ),
                            ]]),
                        )
                        raise
                    task = result.get("task") if isinstance(result, dict) else {}
                    task_id = str((task or {}).get("id") or "")
                    audit_action(
                        chat_id, user_id,
                        "publish.schedule" if scheduled_at else "publish.enqueue",
                        status="success", resource_type=source, resource_id=post_id, detail=task_id,
                    )
                    rows = []
                    if task_id:
                        rows.append([types.InlineKeyboardButton(
                            text="查看发布任务",
                            callback_data=callback_token(chat_id, "t", {
                                "task_id": task_id, "task_kind": "social", "status_filter": "active",
                            }),
                        )])
                    rows.append([types.InlineKeyboardButton(text="继续发布", callback_data="tt:publish_one")])
                    await query.message.edit_text(
                        (
                            f"定时发布已入队。\n任务：{task_id or '已创建'}"
                            if scheduled_at
                            else f"已进入发布队列。\n任务：{task_id or '已创建'}"
                        ),
                        reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                    )
                    if task_id and not scheduled_at:
                        asyncio.create_task(self._watch_publish(query.message.bot, chat_id, user_id, task_id, types))
            elif action == "hot":
                if not load_state(chat_id)["selected_persona_id"]:
                    self._resume_payload(chat_id, "hot")
                    await query.answer("请先选择人设，选择后会自动继续")
                    await self._persona_list(query, types, member, 0)
                    return
                await self._start_hot_input(query, types)
            elif action == "hotagain" and len(parts) > 2:
                persona_id = str(resolve_callback_token(chat_id, "hotagain", parts[2]).get("persona_id") or "")
                if not persona_id:
                    raise HTTPException(status_code=410, detail="热点人设入口已失效，请重新选择")
                save_state(chat_id, selected_persona_id=persona_id)
                await self._start_hot_input(query, types)
            elif action == "hotsubmit" and len(parts) > 2:
                resolve_callback_token(chat_id, "hotsubmit", parts[2], consume=True)
                state = load_state(chat_id)
                if state["mode"] != "hot_confirm":
                    raise HTTPException(status_code=409, detail="热点确认已失效，请重新开始")
                persona_id = state["selected_persona_id"]
                try:
                    result = await self._call(user_id, "hot.start", {
                        "persona_id": persona_id,
                        "prompt": str(state["payload"].get("prompt") or ""),
                    })
                except Exception as exc:
                    await query.message.edit_text(
                        f"热点任务提交失败：{_error_text(exc)}\n主题仍已保留，可重试或修改。"[:3500],
                        reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                            types.InlineKeyboardButton(
                                text="重试提交",
                                callback_data=callback_token(chat_id, "hotsubmit", {}),
                            ),
                            types.InlineKeyboardButton(text="修改主题", callback_data="tt:hot"),
                        ]]),
                    )
                    raise
                task_id = str(result.get("task_id") or result.get("id") or "")
                if not task_id:
                    raise HTTPException(status_code=502, detail="热点任务未返回任务 ID")
                save_state(chat_id, mode="", payload={
                    "last_hot_task_id": task_id,
                    "last_hot_persona_id": persona_id,
                })
                audit_action(chat_id, user_id, "hot.start", status="success", resource_type="task", resource_id=task_id)
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
                ]]
                await query.message.edit_text(
                    f"热点任务已提交：{task_id}\n完成后 Bot 会返回候选供选择。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
                asyncio.create_task(self._watch_hot(
                    query.message.bot, chat_id, user_id, persona_id, task_id, types,
                ))
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
                        reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                            types.InlineKeyboardButton(
                                text="重新开始热点创作",
                                callback_data=callback_token(chat_id, "hotagain", {"persona_id": persona_id}),
                            ),
                            types.InlineKeyboardButton(
                                text="返回人设详情",
                                callback_data=callback_token(chat_id, "p", {"persona_id": persona_id}),
                            ),
                        ]]),
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
                            callback_data=callback_token(chat_id, "hotpick", {
                                "index": index, "task_id": task_id, "persona_id": persona_id,
                            }),
                        )] for index, item in enumerate(candidates)]
                        rows.append([types.InlineKeyboardButton(
                            text="返回人设详情",
                            callback_data=callback_token(chat_id, "p", {"persona_id": persona_id}),
                        )])
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
                            reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                                types.InlineKeyboardButton(
                                    text="修改主题重试",
                                    callback_data=callback_token(chat_id, "hotagain", {"persona_id": persona_id}),
                                ),
                                types.InlineKeyboardButton(
                                    text="返回人设详情",
                                    callback_data=callback_token(chat_id, "p", {"persona_id": persona_id}),
                                ),
                            ]]),
                        )
            elif action == "hotpick" and len(parts) > 2:
                state = load_state(chat_id)
                candidates = state["payload"].get("hot_candidates") if isinstance(state["payload"].get("hot_candidates"), list) else []
                reference = resolve_callback_token(chat_id, "hotpick", parts[2], consume=True)
                persona_id = str(reference.get("persona_id") or "")
                task_id = str(reference.get("task_id") or "")
                if (
                    state["mode"] != "hot_select"
                    or not persona_id
                    or persona_id != state["selected_persona_id"]
                    or task_id != str(state["payload"].get("last_hot_task_id") or "")
                ):
                    raise HTTPException(status_code=410, detail="热点候选已失效，请重新开始")
                index = int(reference.get("index") or 0)
                if index < 0 or index >= len(candidates):
                    raise HTTPException(status_code=404, detail="热点候选已过期")
                result = await self._call(user_id, "hot.import", {"persona_id": persona_id, "candidates": [candidates[index]]})
                posts = result.get("posts") if isinstance(result, dict) and isinstance(result.get("posts"), list) else []
                imported_post_id = str((posts[0] if posts else {}).get("id") or "")
                clear_pending_state(chat_id)
                audit_action(chat_id, user_id, "hot.import", status="success", resource_type="persona", resource_id=persona_id)
                rows = []
                if imported_post_id:
                    rows.append([types.InlineKeyboardButton(
                        text="查看此草稿",
                        callback_data=callback_token(chat_id, "d", {
                            "persona_id": persona_id, "post_id": imported_post_id, "source": "posts",
                        }),
                    )])
                rows.append([types.InlineKeyboardButton(text="查看全部草稿", callback_data="tt:drafts:0")])
                await query.message.edit_text(
                    "热点内容已保存为草稿。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
            elif action == "matrix":
                save_state(chat_id, mode="matrix_select", payload={"matrix_persona_ids": []})
                await self._matrix_picker(query, types, member, 0)
            elif action == "matrixpage" and len(parts) > 2:
                if load_state(chat_id)["mode"] != "matrix_select":
                    raise HTTPException(status_code=409, detail="矩阵选择已失效，请重新开始")
                await self._matrix_picker(query, types, member, int(parts[2]))
            elif action == "mx" and len(parts) > 2:
                state = load_state(chat_id)
                if state["mode"] != "matrix_select":
                    raise HTTPException(status_code=409, detail="矩阵选择已失效，请重新开始")
                reference = resolve_callback_token(chat_id, "mx", parts[2], consume=True)
                persona_id = str(reference.get("persona_id") or "")
                selected = {
                    str(item) for item in state["payload"].get("matrix_persona_ids") or [] if str(item)
                }
                if persona_id in selected:
                    selected.remove(persona_id)
                elif persona_id:
                    selected.add(persona_id)
                save_state(chat_id, mode="matrix_select", payload={"matrix_persona_ids": sorted(selected)})
                await self._matrix_picker(query, types, member, int(reference.get("page") or 0))
            elif action == "matrixnext":
                state = load_state(chat_id)
                if state["mode"] != "matrix_select":
                    raise HTTPException(status_code=409, detail="矩阵选择已失效，请重新开始")
                persona_ids = [str(item) for item in state["payload"].get("matrix_persona_ids") or [] if str(item)]
                if not persona_ids:
                    await query.answer("请至少选择一个人设", show_alert=True)
                    return
                save_state(chat_id, mode="matrix_source", payload={"matrix_persona_ids": persona_ids})
                await self._matrix_source_picker(query, types)
            elif action == "matrixback":
                state = load_state(chat_id)
                persona_ids = [str(item) for item in state["payload"].get("matrix_persona_ids") or [] if str(item)]
                if state["mode"] != "matrix_source" or not persona_ids:
                    raise HTTPException(status_code=409, detail="矩阵来源选择已失效，请重新开始")
                save_state(chat_id, mode="matrix_select", payload={"matrix_persona_ids": persona_ids})
                await self._matrix_picker(query, types, member, 0)
            elif action == "mxsource" and len(parts) > 2:
                state = load_state(chat_id)
                source = str(parts[2] or "").strip().lower()
                persona_ids = [str(item) for item in state["payload"].get("matrix_persona_ids") or [] if str(item)]
                if state["mode"] != "matrix_source" or source not in {"posts", "favorites"} or not persona_ids:
                    raise HTTPException(status_code=409, detail="矩阵来源选择已失效，请重新开始")
                personas = await self._call(user_id, "personas.list")
                count_key = "favorites" if source == "favorites" else "posts"
                ready_ids = {
                    str(item.get("id") or "")
                    for item in personas
                    if str(item.get("id") or "") in persona_ids
                    and int((item.get("counts") or {}).get(count_key) or 0) > 0
                }
                if not ready_ids:
                    raise HTTPException(
                        status_code=409,
                        detail=f"所选人设都没有可发布的{'收藏' if source == 'favorites' else '草稿'}，请返回重新选择",
                    )
                save_state(chat_id, mode="matrix_platform", payload={
                    "matrix_persona_ids": persona_ids,
                    "matrix_source": source,
                    "matrix_source_ready_count": len(ready_ids),
                })
                await self._matrix_platform_picker(query, types, member)
            elif action == "mxbacksource":
                state = load_state(chat_id)
                persona_ids = [str(item) for item in state["payload"].get("matrix_persona_ids") or [] if str(item)]
                if state["mode"] != "matrix_platform" or not persona_ids:
                    raise HTTPException(status_code=409, detail="矩阵平台选择已失效，请重新开始")
                save_state(chat_id, mode="matrix_source", payload={"matrix_persona_ids": persona_ids})
                await self._matrix_source_picker(query, types)
            elif action == "mxplatform" and len(parts) > 2:
                state = load_state(chat_id)
                platform = str(parts[2] or "").strip().lower()
                persona_ids = [str(item) for item in state["payload"].get("matrix_persona_ids") or [] if str(item)]
                source = str(state["payload"].get("matrix_source") or "")
                if (
                    state["mode"] != "matrix_platform"
                    or platform not in {"threads", "instagram"}
                    or source not in {"posts", "favorites"}
                    or not persona_ids
                ):
                    raise HTTPException(status_code=409, detail="矩阵平台选择已失效，请重新开始")
                source_ready_count = int(state["payload"].get("matrix_source_ready_count") or len(persona_ids))
                source_skipped_count = max(0, len(persona_ids) - source_ready_count)
                save_state(chat_id, mode="matrix_confirm", payload={
                    "matrix_persona_ids": persona_ids,
                    "matrix_source": source,
                    "matrix_platform": platform,
                    "matrix_source_ready_count": source_ready_count,
                })
                rows = [[
                    types.InlineKeyboardButton(
                        text="确认矩阵发布",
                        callback_data=callback_token(chat_id, "matrixok", {
                            "persona_ids": persona_ids,
                            "source": source,
                            "platform": platform,
                            "per_persona_count": 1,
                        }),
                    ),
                    types.InlineKeyboardButton(text="上一步", callback_data="tt:mxbackplatform"),
                ]]
                confirmation_text = (
                    "矩阵发布 · 第 4/4 步\n"
                    f"人设：{len(persona_ids)} 个\n"
                    f"来源：{'收藏' if source == 'favorites' else '草稿'}\n"
                    f"平台：{platform.title()}\n"
                    "数量：每个人设 1 篇\n\n确认后才会提交发布队列。"
                )
                if source_skipped_count:
                    confirmation_text += f"\n其中 {source_skipped_count} 个人设无该来源内容，将自动跳过。"
                await query.message.edit_text(
                    confirmation_text,
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
            elif action == "mxbackplatform":
                state = load_state(chat_id)
                persona_ids = [str(item) for item in state["payload"].get("matrix_persona_ids") or [] if str(item)]
                source = str(state["payload"].get("matrix_source") or "")
                if state["mode"] != "matrix_confirm" or not persona_ids or source not in {"posts", "favorites"}:
                    raise HTTPException(status_code=409, detail="矩阵确认已失效，请重新开始")
                save_state(chat_id, mode="matrix_platform", payload={
                    "matrix_persona_ids": persona_ids,
                    "matrix_source": source,
                    "matrix_source_ready_count": int(state["payload"].get("matrix_source_ready_count") or len(persona_ids)),
                })
                await self._matrix_platform_picker(query, types, member)
            elif action == "matrixok" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "matrixok", parts[2], consume=True)
                persona_ids = reference.get("persona_ids") if isinstance(reference.get("persona_ids"), list) else []
                source = str(reference.get("source") or "posts").strip().lower()
                platform = str(reference.get("platform") or "threads").strip().lower()
                per_persona_count = max(1, int(reference.get("per_persona_count") or 1))
                try:
                    result = await self._call(user_id, "publish.matrix", {
                        "persona_ids": persona_ids,
                        "source": source,
                        "platform": platform,
                        "per_persona_count": per_persona_count,
                    })
                except Exception as exc:
                    save_state(chat_id, mode="matrix_confirm", payload={
                        "matrix_persona_ids": persona_ids,
                        "matrix_source": source,
                        "matrix_platform": platform,
                        "matrix_source_ready_count": len(persona_ids),
                    })
                    await query.message.edit_text(
                        f"矩阵发布提交失败：{_error_text(exc)}"[:3500],
                        reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                            types.InlineKeyboardButton(
                                text="重试提交",
                                callback_data=callback_token(chat_id, "matrixok", {
                                    "persona_ids": persona_ids,
                                    "source": source,
                                    "platform": platform,
                                    "per_persona_count": per_persona_count,
                                }),
                            ),
                            types.InlineKeyboardButton(text="修改平台", callback_data="tt:mxbackplatform"),
                        ]]),
                    )
                    raise
                clear_pending_state(chat_id)
                errors = result.get("errors") if isinstance(result.get("errors"), list) else []
                skipped = result.get("skipped") if isinstance(result.get("skipped"), list) else []
                created = result.get("created") if isinstance(result.get("created"), list) else []
                if not bool(result.get("ok")) or not created:
                    detail = "；".join(
                        str(item.get("message") or item.get("detail") or item.get("reason") or item)
                        for item in (errors + skipped)[:5]
                    )
                    audit_action(chat_id, user_id, "publish.matrix", status="failed", detail=detail)
                    await query.message.edit_text(
                        f"矩阵发布未入队。{detail or '没有符合条件的草稿或账号。'}"[:3500],
                        reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                            types.InlineKeyboardButton(text="重新选择人设", callback_data="tt:matrix"),
                            types.InlineKeyboardButton(text="账号状态", callback_data="tt:accounts"),
                        ]]),
                    )
                else:
                    audit_action(chat_id, user_id, "publish.matrix", status="success", detail=str(result.get("batch_id") or ""))
                    await query.message.edit_text(
                        f"矩阵发布已入队：{result.get('batch_id') or '已创建'}\n已创建 {len(created)} 个任务。",
                        reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                            types.InlineKeyboardButton(text="查看进行中任务", callback_data="tt:tasks:0:active"),
                            types.InlineKeyboardButton(text="继续矩阵发布", callback_data="tt:matrix"),
                        ]]),
                    )
            elif action == "tasks":
                await self._tasks(
                    query,
                    types,
                    member,
                    int(parts[2]) if len(parts) > 2 else 0,
                    str(parts[3]) if len(parts) > 3 else "all",
                )
            elif action == "t" and len(parts) > 2:
                reference = resolve_callback_token(chat_id, "t", parts[2])
                task_id = str(reference.get("task_id") or "")
                task_kind = str(reference.get("task_kind") or "social")
                task = await self._call(user_id, "tasks.get", {"task_id": task_id})
                task_kind = str(task.get("_tg_task_kind") or task_kind)
                status = _task_status(task)
                rows = []
                if status in {"queued", "running", "scheduled", "pending"}:
                    rows.append([types.InlineKeyboardButton(text="取消任务", callback_data=callback_token(chat_id, "tcancel", {
                        "task_id": task_id, "task_kind": task_kind,
                        "status_filter": str(reference.get("status_filter") or "active"),
                    }))])
                if status == "failed" and task_kind == "social":
                    rows.append([types.InlineKeyboardButton(text="重试任务", callback_data=callback_token(chat_id, "tretry", {
                        "task_id": task_id, "task_kind": task_kind,
                        "status_filter": str(reference.get("status_filter") or "failed"),
                    }))])
                elif status == "failed" and task_kind == "normal":
                    rows.append([types.InlineKeyboardButton(text="重新生成", callback_data="tt:generate")])
                status_filter = str(reference.get("status_filter") or "all")
                rows.append([types.InlineKeyboardButton(text="返回任务", callback_data=f"tt:tasks:0:{status_filter}")])
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
                status_filter = str(reference.get("status_filter") or "all")
                await query.message.edit_text(
                    str(result.get("message") or "操作已提交"),
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(text="返回任务", callback_data=f"tt:tasks:0:{status_filter}"),
                    ]]),
                )
            elif action == "profile":
                state = load_state(chat_id)
                if not state["selected_persona_id"]:
                    raise HTTPException(status_code=400, detail="请先选择人设")
                profile = await self._call(user_id, "profile.get", {"persona_id": state["selected_persona_id"]})
                rows = [[
                    types.InlineKeyboardButton(text="编辑简介", callback_data="tt:bio"),
                    types.InlineKeyboardButton(text="编辑推文风格", callback_data="tt:style"),
                ], [types.InlineKeyboardButton(
                    text="返回人设详情",
                    callback_data=callback_token(chat_id, "p", {"persona_id": state["selected_persona_id"]}),
                )]]
                await query.message.edit_text(
                    f"内容设置\n\n简介：{str(profile.get('content') or '')[:1200]}\n\n推文风格：{str(profile.get('tweet_style_sample') or '')[:1200]}",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
            elif action in {"bio", "style"}:
                save_state(chat_id, mode="profile_content" if action == "bio" else "profile_style", payload={})
                await query.message.edit_text("请发送新的内容。发送 /cancel 取消。")
            elif action in {"accounts", "persona_accounts"}:
                state = load_state(chat_id)
                return_callback = "tt:menu"
                if action == "persona_accounts" and state["selected_persona_id"]:
                    return_callback = callback_token(
                        chat_id, "p", {"persona_id": state["selected_persona_id"]},
                    )
                page_text, markup = await self._accounts_payload(
                    types, member, return_callback=return_callback,
                    persona_id=state["selected_persona_id"] if action == "persona_accounts" else "",
                )
                await query.message.edit_text(page_text, reply_markup=markup)
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
            state = load_state(chat_id)
            if text == "/done" and state["mode"] == "media_upload":
                payload = state["payload"]
                source = "favorites" if str(payload.get("source")) == "favorites" else "posts"
                action = "f" if source == "favorites" else "d"
                clear_pending_state(chat_id)
                await message.answer(
                    "媒体添加完成。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(
                            text="返回推文详情",
                            callback_data=callback_token(chat_id, action, {
                                "persona_id": state["selected_persona_id"],
                                "post_id": str(payload.get("post_id") or ""), "source": source,
                            }),
                        ),
                    ]]),
                )
                return
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
                resume_action = str(state["payload"].get("resume_action") or "")
                audit_action(chat_id, user_id, "persona.create", status="success", resource_type="persona", resource_id=new_id)
                created_name = str((persona or {}).get("name") or name.strip())
                if resume_action == "generate":
                    save_state(chat_id, selected_persona_id=new_id, mode="generate_count", payload={})
                    await message.answer(
                        f"人设已创建：{created_name}\n\nAI 生成推文 · 第 1/3 步\n请选择本次生成数量。",
                        reply_markup=self._generation_count_keyboard(types),
                    )
                elif resume_action == "hot":
                    save_state(chat_id, selected_persona_id=new_id, mode="hot_prompt", payload={})
                    await message.answer(
                        f"人设已创建：{created_name}\n\n热点创作 · 第 1/2 步\n"
                        "请发送热点主题或关键词。收到后会先显示确认页。"
                    )
                elif resume_action == "draft_new":
                    save_state(chat_id, selected_persona_id=new_id, mode="draft_new", payload={})
                    await message.answer(
                        f"人设已创建：{created_name}\n\n手工新建草稿 · 输入正文\n请发送草稿正文。"
                    )
                elif resume_action in {"drafts", "favorites", "publish_one"}:
                    save_state(chat_id, selected_persona_id=new_id, mode="", payload={})
                    await message.answer(
                        f"人设已创建：{created_name}\n当前还没有可操作内容，可先新建草稿。",
                        reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                            types.InlineKeyboardButton(text="新建草稿", callback_data="tt:draft_new"),
                        ]]),
                    )
                else:
                    save_state(chat_id, selected_persona_id=new_id, mode="", payload={})
                    await message.answer(f"人设已创建：{created_name}", reply_markup=self._main_keyboard(types))
            elif mode == "generate_prompt":
                if not text:
                    raise HTTPException(status_code=400, detail="主题或写作要求不能为空")
                count = int(state["payload"].get("count") or 3)
                target_words = int(state["payload"].get("target_words") or 120)
                save_state(chat_id, mode="generate_confirm", payload={
                    "count": count,
                    "target_words": target_words,
                    "prompt": text,
                })
                rows = [[
                    types.InlineKeyboardButton(
                        text="确认生成",
                        callback_data=callback_token(chat_id, "gsubmit", {}),
                    ),
                    types.InlineKeyboardButton(text="修改参数", callback_data="tt:generate"),
                ], [types.InlineKeyboardButton(text="取消", callback_data="tt:menu")]]
                await message.answer(
                    "AI 生成推文 · 提交确认\n"
                    f"数量：{count} 篇 · 每篇约 {target_words} 字\n"
                    f"主题：{text[:1200]}\n\n确认后才会提交生成任务。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
            elif mode == "draft_new":
                result = await self._call(user_id, "posts.create", {"persona_id": persona_id, "content": text})
                post = result.get("post") if isinstance(result, dict) else result
                post_id = str((post or {}).get("id") or result.get("id") or "")
                clear_pending_state(chat_id)
                audit_action(chat_id, user_id, "post.create", status="success", resource_type="post", resource_id=post_id)
                await message.answer(
                    "草稿已保存，可继续编辑、添加媒体或发布。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(
                            text="查看此草稿",
                            callback_data=callback_token(chat_id, "d", {
                                "persona_id": persona_id, "post_id": post_id, "source": "posts",
                            }),
                        ),
                    ]]),
                )
            elif mode == "draft_edit":
                payload = state["payload"]
                await self._call(user_id, "posts.update", {"persona_id": persona_id, "source": payload.get("source"), "post_id": payload.get("post_id"), "content": text})
                clear_pending_state(chat_id)
                audit_action(chat_id, user_id, "post.update", status="success", resource_type=str(payload.get("source")), resource_id=str(payload.get("post_id")))
                source = "favorites" if str(payload.get("source")) == "favorites" else "posts"
                action = "f" if source == "favorites" else "d"
                await message.answer(
                    "推文已更新。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(
                            text="返回推文详情",
                            callback_data=callback_token(chat_id, action, {
                                "persona_id": persona_id,
                                "post_id": str(payload.get("post_id") or ""), "source": source,
                            }),
                        ),
                    ]]),
                )
            elif mode == "schedule_time":
                scheduled_at = parse_schedule_time(text)
                payload = state["payload"]
                next_payload = {
                    "persona_id": str(payload.get("persona_id") or persona_id),
                    "source": str(payload.get("source") or "posts"),
                    "post_id": str(payload.get("post_id") or ""),
                    "account_id": str(payload.get("account_id") or ""),
                    "platform": str(payload.get("platform") or "threads").strip().lower(),
                    "scheduled_at": scheduled_at,
                }
                save_state(chat_id, mode="schedule_confirm", payload=next_payload)
                scheduled_text = datetime.fromtimestamp(scheduled_at, BUSINESS_TIMEZONE).strftime("%Y-%m-%d %H:%M")
                rows = [[
                    types.InlineKeyboardButton(
                        text="确认定时发布",
                        callback_data=callback_token(chat_id, "schedok", next_payload),
                    ),
                    types.InlineKeyboardButton(text="修改时间", callback_data=callback_token(chat_id, "pa", {
                        "source": next_payload["source"],
                        "post_id": next_payload["post_id"],
                        "persona_id": next_payload["persona_id"],
                        "account_id": next_payload["account_id"],
                        "platform": next_payload["platform"],
                        "scheduled": True,
                    })),
                ], [types.InlineKeyboardButton(
                    text="取消",
                    callback_data=f"tt:{'favorites' if next_payload['source'] == 'favorites' else 'drafts'}:0",
                )]]
                await message.answer(
                    "定时发布 · 最终确认\n"
                    f"平台：{next_payload['platform'].title()}\n"
                    f"北京时间：{scheduled_text}\n\n确认后才会提交发布队列。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
            elif mode in {"profile_content", "profile_style"}:
                key = "content" if mode == "profile_content" else "tweet_style_sample"
                await self._call(user_id, "profile.update", {"persona_id": persona_id, key: text})
                clear_pending_state(chat_id)
                audit_action(chat_id, user_id, "profile.update", status="success", resource_type="persona", resource_id=persona_id, detail=key)
                await message.answer(
                    "内容设置已保存。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(text="返回内容设置", callback_data="tt:profile"),
                    ]]),
                )
            elif mode == "hot_prompt":
                if not text:
                    raise HTTPException(status_code=400, detail="热点主题不能为空")
                retained = {
                    key: value
                    for key, value in state["payload"].items()
                    if str(key).startswith("last_")
                }
                save_state(chat_id, mode="hot_confirm", payload={**retained, "prompt": text})
                rows = [[
                    types.InlineKeyboardButton(
                        text="确认开始热点任务",
                        callback_data=callback_token(chat_id, "hotsubmit", {}),
                    ),
                    types.InlineKeyboardButton(text="修改主题", callback_data="tt:hot"),
                ], [types.InlineKeyboardButton(text="取消", callback_data="tt:menu")]]
                await message.answer(
                    "热点创作 · 第 2/2 步\n"
                    f"主题：{text[:1200]}\n\n确认后才会提交热点任务。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
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
                source = "favorites" if str(payload.get("source")) == "favorites" else "posts"
                action = "f" if source == "favorites" else "d"
                await message.answer(
                    "媒体已替换。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(
                            text="返回推文详情",
                            callback_data=callback_token(chat_id, action, {
                                "persona_id": state["selected_persona_id"],
                                "post_id": str(payload.get("post_id") or ""), "source": source,
                            }),
                        ),
                    ]]),
                )
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
                output = task.get("output") if isinstance(task.get("output"), dict) else {}
                posts = output.get("posts") if isinstance(output.get("posts"), list) else []
                posts = [post for post in posts if isinstance(post, dict)]
                post_ids = [str(item or "") for item in output.get("post_ids") or [] if str(item or "")]
                if not posts and post_ids:
                    all_posts = await self._call(user_id, "posts.list", {"persona_id": persona_id, "source": "posts"})
                    by_id = {str(post.get("id") or ""): post for post in all_posts if isinstance(post, dict)}
                    posts = [by_id[post_id] for post_id in post_ids if post_id in by_id]
                preview = "\n\n".join(f"{index + 1}. {str(post.get('content') or '')[:600]}" for index, post in enumerate(posts[:3]))
                if not self._member_still_bound(chat_id, user_id):
                    return
                await bot.send_message(
                    chat_id,
                    (f"推文生成完成。\n\n{preview}" if preview else "推文生成完成，可进入草稿列表查看结果。")[:4000],
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(
                            text="查看生成草稿",
                            callback_data=callback_token(chat_id, "gendrafts", {"persona_id": persona_id}),
                        ),
                        types.InlineKeyboardButton(
                            text="继续生成",
                            callback_data=callback_token(chat_id, "gagain", {"persona_id": persona_id}),
                        ),
                    ]]),
                )
            else:
                if not self._member_still_bound(chat_id, user_id):
                    return
                await bot.send_message(
                    chat_id,
                    f"推文生成{status}：{str(task.get('error') or '')[:1200]}",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(
                            text="修改参数重新生成",
                            callback_data=callback_token(chat_id, "gagain", {"persona_id": persona_id}),
                        ),
                        types.InlineKeyboardButton(
                            text="查看任务",
                            callback_data=callback_token(chat_id, "t", {
                                "task_id": task_id, "task_kind": "normal", "status_filter": "failed",
                            }),
                        ),
                    ]]),
                )
            return
        if self._member_still_bound(chat_id, user_id):
            await bot.send_message(
                chat_id,
                "推文生成仍在后台执行，可从任务中心继续查看。",
                reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                    types.InlineKeyboardButton(
                        text="查看任务",
                        callback_data=callback_token(chat_id, "t", {
                            "task_id": task_id, "task_kind": "normal", "status_filter": "active",
                        }),
                    ),
                ]]),
            )

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
            if status in {"queued", "pending", "running", "retrying", "scheduled"}:
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
                reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                    types.InlineKeyboardButton(
                        text="查看任务",
                        callback_data=callback_token(chat_id, "t", {
                            "task_id": task_id, "task_kind": "social",
                            "status_filter": "failed" if status == "failed" else "all",
                        }),
                    ),
                    types.InlineKeyboardButton(text="继续发布", callback_data="tt:publish_one"),
                ]]),
            )
            return
        if self._member_still_bound(chat_id, user_id):
            await bot.send_message(
                chat_id,
                "发布任务仍在后台执行，可从任务中心继续查看。",
                reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                    types.InlineKeyboardButton(
                        text="查看任务",
                        callback_data=callback_token(chat_id, "t", {
                            "task_id": task_id, "task_kind": "social", "status_filter": "active",
                        }),
                    ),
                ]]),
            )

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
                    callback_data=callback_token(chat_id, "hotpick", {
                        "index": index, "task_id": task_id, "persona_id": persona_id,
                    }),
                )] for index, item in enumerate(candidates)]
                rows.append([types.InlineKeyboardButton(
                    text="返回人设详情",
                    callback_data=callback_token(chat_id, "p", {"persona_id": persona_id}),
                )])
                await bot.send_message(
                    chat_id,
                    "热点候选已完成，选择一条保存为草稿。" if candidates else "热点任务已完成，但没有可导入候选。",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=rows),
                )
            else:
                if not self._member_still_bound(chat_id, user_id):
                    return
                await bot.send_message(
                    chat_id,
                    f"热点任务{status}：{str(task.get('error') or '')[:1200]}",
                    reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                        types.InlineKeyboardButton(
                            text="修改主题重试",
                            callback_data=callback_token(chat_id, "hotagain", {"persona_id": persona_id}),
                        ),
                        types.InlineKeyboardButton(
                            text="返回人设详情",
                            callback_data=callback_token(chat_id, "p", {"persona_id": persona_id}),
                        ),
                    ]]),
                )
            return
        if self._member_still_bound(chat_id, user_id):
            await bot.send_message(
                chat_id,
                "热点任务仍在后台执行，可稍后返回当前人设继续查看。",
                reply_markup=types.InlineKeyboardMarkup(inline_keyboard=[[
                    types.InlineKeyboardButton(
                        text="查看热点状态",
                        callback_data=callback_token(chat_id, "hotstatus", {
                            "task_id": task_id, "persona_id": persona_id,
                        }),
                    ),
                    types.InlineKeyboardButton(
                        text="返回人设详情",
                        callback_data=callback_token(chat_id, "p", {"persona_id": persona_id}),
                    ),
                ]]),
            )


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

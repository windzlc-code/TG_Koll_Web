from __future__ import annotations

import asyncio
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

from aiogram import Bot
from aiogram.types import FSInputFile

from .config import AppConfig, apply_setting_overrides
from .storage import WorkspaceMember, WorkspaceStore, WorkspaceTask
from .runninghub import WorkflowCancelledError
from .workflow import DigitalHumanWorkflowRunner, WorkflowRequest, WorkflowRunResult


WORKBENCH_TITLE = "多智能體協作工作台"


@dataclass(frozen=True)
class SubmittedTask:
    task: WorkspaceTask
    queue_position: int
    active_task: WorkspaceTask | None


@dataclass(frozen=True)
class TaskCancellationResult:
    task: WorkspaceTask
    state: str
    message: str


class WorkspaceService:
    def __init__(self, config: AppConfig, store: WorkspaceStore) -> None:
        self.base_config = config
        self.store = store
        self.bot: Bot | None = None
        self.worker_task: asyncio.Task | None = None
        self.shutdown_event = asyncio.Event()
        self.active_task_id: str | None = None
        self.task_cancel_events: dict[str, threading.Event] = {}
        self.task_cancel_reasons: dict[str, str] = {}

    async def start(self) -> None:
        self.store.init_db()
        self.store.seed_members(self.base_config.tg_seed_chat_ids)
        self.store.reset_stale_processing_tasks()
        self.shutdown_event.clear()
        self.worker_task = asyncio.create_task(self._worker_loop(), name="workspace-worker")

    async def stop(self) -> None:
        self.shutdown_event.set()
        if self.worker_task is not None:
            self.worker_task.cancel()
            await asyncio.gather(self.worker_task, return_exceptions=True)
            self.worker_task = None

    def attach_bot(self, bot: Bot) -> None:
        self.bot = bot

    def resolve_config(self) -> AppConfig:
        return apply_setting_overrides(self.base_config, self.store.get_settings())

    def get_app_title(self) -> str:
        return self.resolve_config().app_title or WORKBENCH_TITLE

    def is_chat_authorized(self, chat_id: int) -> bool:
        return self.store.is_authorized_chat(chat_id)

    def get_member(self, chat_id: int) -> WorkspaceMember | None:
        return self.store.get_member(chat_id)

    def list_members(self) -> list[WorkspaceMember]:
        return self.store.list_members()

    def upsert_member(
        self,
        *,
        chat_id: int,
        label: str,
        enabled: bool,
        notify_busy: bool,
        notify_available: bool,
    ) -> None:
        self.store.upsert_member(
            chat_id=chat_id,
            label=label,
            enabled=enabled,
            notify_busy=notify_busy,
            notify_available=notify_available,
        )

    def delete_member(self, chat_id: int) -> None:
        self.store.delete_member(chat_id)

    def get_settings(self) -> dict[str, str]:
        return self.store.get_settings()

    def save_settings(self, values: dict[str, str]) -> None:
        self.store.set_settings(values)

    def create_job_dir(self, prefix: str = "job") -> Path:
        stamp = time.strftime("%Y%m%d_%H%M%S")
        job_id = f"{prefix}_{stamp}_{uuid4().hex[:8]}"
        work_dir = self.base_config.jobs_dir / job_id
        work_dir.mkdir(parents=True, exist_ok=True)
        return work_dir

    def build_default_request(self, script_text: str, *, target_duration_seconds: int | None = None) -> WorkflowRequest:
        config = self.resolve_config()
        work_dir = self.create_job_dir(prefix="default")
        script = str(script_text or "").strip() or config.default_script_text
        return WorkflowRequest(
            source_video_path=config.source_video_path,
            avatar_image_path=config.avatar_image_path,
            script_text=script,
            work_dir=work_dir,
            target_duration_seconds=target_duration_seconds,
            publish_to_default_paths=True,
        )

    def submit_task(
        self,
        *,
        request: WorkflowRequest,
        submitter_chat_id: int | None,
        source: str,
        is_default_assets: bool,
    ) -> SubmittedTask:
        member = self.store.get_member(submitter_chat_id) if submitter_chat_id is not None else None
        label = member.label if member is not None else (f"TG-{submitter_chat_id}" if submitter_chat_id is not None else "Web")
        task_id = request.work_dir.name
        task = self.store.create_task(
            task_id=task_id,
            submitter_chat_id=submitter_chat_id,
            submitter_label=label,
            source=source,
            source_video_path=str(request.source_video_path),
            avatar_image_path=str(request.avatar_image_path),
            work_dir=str(request.work_dir),
            script_text=request.script_text,
            target_duration_seconds=request.target_duration_seconds,
            is_default_assets=is_default_assets,
        )
        active_task = self.store.get_active_task()
        queue_position = self.store.count_queued_before(task.id) + 1 + (1 if active_task is not None else 0)
        return SubmittedTask(task=task, queue_position=queue_position, active_task=active_task)

    def clone_task_request(self, task_id: str) -> WorkflowRequest:
        task = self.store.get_task(task_id)
        if task is None:
            raise RuntimeError(f"找不到任務: {task_id}")
        work_dir = self.create_job_dir(prefix="rerun")
        return WorkflowRequest(
            source_video_path=Path(task.source_video_path),
            avatar_image_path=Path(task.avatar_image_path),
            script_text=task.script_text,
            work_dir=work_dir,
            target_duration_seconds=task.target_duration_seconds,
            publish_to_default_paths=task.is_default_assets,
        )

    def get_task(self, task_id: str) -> WorkspaceTask | None:
        return self.store.get_task(task_id)

    def get_latest_task_for_submitter(self, chat_id: int) -> WorkspaceTask | None:
        return self.store.get_latest_task_for_submitter(chat_id)

    def get_latest_open_task_for_submitter(self, chat_id: int) -> WorkspaceTask | None:
        return self.store.get_latest_open_task_for_submitter(chat_id)

    def get_task_events(self, task_id: str) -> list[dict[str, Any]]:
        return self.store.get_task_events(task_id)

    def list_tasks(self, *, status: str | None = None, limit: int = 100) -> list[WorkspaceTask]:
        return self.store.list_tasks(status=status, limit=limit)

    def get_dashboard_snapshot(self) -> dict[str, Any]:
        return self.store.get_dashboard_snapshot()

    def get_status_snapshot(self) -> dict[str, Any]:
        active_task = self.store.get_active_task()
        counts = self.store.count_by_status()
        return {
            "app_title": self.get_app_title(),
            "active_task": active_task,
            "counts": counts,
            "queued_count": counts.get("queued", 0),
            "members_total": len(self.store.list_members()),
        }

    def get_status_text(self, *, chat_id: int | None = None) -> str:
        snapshot = self.get_status_snapshot()
        lines = [
            f"{snapshot['app_title']} 狀態",
            f"等待中任務: {snapshot['queued_count']}",
            f"進行中任務: {snapshot['counts'].get('processing', 0)}",
            f"已完成任務: {snapshot['counts'].get('completed', 0)}",
            f"失敗任務: {snapshot['counts'].get('failed', 0)}",
        ]
        active_task = snapshot["active_task"]
        if active_task is not None:
            lines.append(
                f"目前占用: {active_task.submitter_label or active_task.submitter_chat_id or '未知使用者'} / {active_task.id}"
            )
            lines.append(f"當前階段: {self._task_public_summary(active_task)}")
        else:
            lines.append("目前占用: 無，工作台可立即使用")
        if chat_id is not None:
            lines.append(f"你的 Chat ID: {chat_id}")
            latest_task = self.get_latest_task_for_submitter(chat_id)
            if latest_task is not None:
                lines.extend(
                    [
                        "",
                        f"最近任務: {latest_task.id}",
                        f"任務狀態: {self._status_label(latest_task.status)}",
                        f"任務摘要: {self._task_public_summary(latest_task)}",
                    ]
                )
                if latest_task.status == "completed":
                    timings = self._build_task_timings(latest_task)
                    lines.extend(
                        [
                            f"排隊等待: {timings['queue_wait_text']}",
                            f"生成耗時: {timings['processing_text']}",
                            f"總完成時間: {timings['total_text']}",
                        ]
                    )
                elif latest_task.status == "failed":
                    lines.append("詳細錯誤請到工作台任務詳情查看。")
        return "\n".join(lines)

    def get_task_detail(self, task_id: str) -> dict[str, Any]:
        task = self.store.get_task(task_id)
        if task is None:
            raise RuntimeError(f"找不到任務: {task_id}")
        return {
            "task": task,
            "timings": self._build_task_timings(task),
            "events": self.store.get_task_events(task_id),
            "files": self._collect_task_files(task),
        }

    def resolve_task_file(self, task_id: str, kind: str) -> Path:
        task = self.store.get_task(task_id)
        if task is None:
            raise RuntimeError(f"找不到任務: {task_id}")
        files = self._collect_task_files(task)
        if kind not in files:
            raise RuntimeError(f"找不到檔案類型: {kind}")
        return files[kind]["path"]

    async def retry_task(self, task_id: str, *, submitter_chat_id: int | None, source: str) -> SubmittedTask:
        request = self.clone_task_request(task_id)
        return self.submit_task(
            request=request,
            submitter_chat_id=submitter_chat_id,
            source=source,
            is_default_assets=request.publish_to_default_paths,
        )

    async def cancel_task(self, task_id: str, *, requested_by: str) -> TaskCancellationResult:
        task = self.store.get_task(task_id)
        if task is None:
            raise RuntimeError(f"找不到任務: {task_id}")

        cancel_reason = f"{requested_by} 已強制停止此任務"
        if task.status == "queued":
            self.store.cancel_task(task_id, reason=cancel_reason)
            updated = self.store.get_task(task_id) or task
            await self._notify_task_cancelled(updated, cancel_reason)
            return TaskCancellationResult(
                task=updated,
                state="cancelled",
                message=f"任務 {task_id} 已強制停止，後續不會再執行。",
            )

        if task.status == "processing":
            cancel_event = self.task_cancel_events.get(task_id)
            if cancel_event is None:
                cancel_event = threading.Event()
                self.task_cancel_events[task_id] = cancel_event
            if cancel_event.is_set():
                return TaskCancellationResult(
                    task=task,
                    state="cancelling",
                    message=f"任務 {task_id} 已在停止中，請稍候工作台完成中止。",
                )

            self.task_cancel_reasons[task_id] = cancel_reason
            cancel_event.set()
            self.store.mark_task_cancellation_requested(task_id, reason=f"{requested_by} 已送出強制停止指令")
            updated = self.store.get_task(task_id) or task
            return TaskCancellationResult(
                task=updated,
                state="cancelling",
                message=f"任務 {task_id} 已送出強制停止指令，工作流正在中止。",
            )

        return TaskCancellationResult(
            task=task,
            state="finished",
            message=f"任務 {task_id} 目前狀態為 {self._status_label(task.status)}，無法再強制停止。",
        )

    async def _worker_loop(self) -> None:
        while not self.shutdown_event.is_set():
            task = self.store.get_next_queued_task()
            if task is None:
                await asyncio.sleep(1.0)
                continue
            await self._process_task(task)

    async def _process_task(self, task: WorkspaceTask) -> None:
        current_task = self.store.get_task(task.id)
        if current_task is None or current_task.status != "queued":
            self.task_cancel_events.pop(task.id, None)
            self.task_cancel_reasons.pop(task.id, None)
            return

        cancel_event = self.task_cancel_events.get(task.id)
        if cancel_event is None:
            cancel_event = threading.Event()
            self.task_cancel_events[task.id] = cancel_event
        self.active_task_id = task.id
        self.store.mark_task_processing(task.id, stage="工作台已接手任務，正在啟動智能體流程")
        task = self.store.get_task(task.id) or task
        if task.status != "processing":
            self.active_task_id = None
            self.task_cancel_events.pop(task.id, None)
            self.task_cancel_reasons.pop(task.id, None)
            return
        await self._notify_task_started(task)

        config = self.resolve_config()
        runner = DigitalHumanWorkflowRunner(config, cancellation_check=lambda: self._raise_if_task_cancelled(task.id))
        request = WorkflowRequest(
            source_video_path=Path(task.source_video_path),
            avatar_image_path=Path(task.avatar_image_path),
            script_text=task.script_text,
            work_dir=Path(task.work_dir),
            target_duration_seconds=task.target_duration_seconds,
            publish_to_default_paths=task.is_default_assets,
        )

        def progress_callback(message: str) -> None:
            self._raise_if_task_cancelled(task.id)
            public_message = self._to_user_progress_message(message) or "智能體流程執行中"
            self.store.update_task_progress(task.id, stage=message, summary=public_message)

        try:
            result = await asyncio.to_thread(runner.run_request, request, progress_callback)
            self._raise_if_task_cancelled(task.id)
        except WorkflowCancelledError as exc:
            cancel_reason = str(exc).strip() or "任務已強制停止"
            self.store.cancel_task(task.id, reason=cancel_reason)
            await self._notify_task_cancelled(self.store.get_task(task.id) or task, cancel_reason)
        except Exception as exc:
            self.store.mark_task_failed(task.id, error_message=str(exc))
            await self._notify_task_failed(task, str(exc))
        else:
            finished_at = time.time()
            summary = self._build_completed_summary_text(
                created_at=task.created_at,
                started_at=task.started_at,
                finished_at=finished_at,
            )
            self.store.mark_task_completed(
                task.id,
                extracted_audio_path=str(result.extracted_audio_path),
                cloned_audio_path=str(result.cloned_audio_path),
                final_video_path=str(result.final_video_path),
                cloned_audio_duration_seconds=result.cloned_audio_duration_seconds,
                video_duration_seconds=result.video_duration_seconds,
                audio_task_id=result.audio_task_id,
                video_task_id=result.video_task_id,
                summary=summary,
            )
            await self._notify_task_completed(task.id, result)
        finally:
            self.active_task_id = None
            self.task_cancel_events.pop(task.id, None)
            self.task_cancel_reasons.pop(task.id, None)
            await self._broadcast_available(task)

    async def _notify_task_started(self, task: WorkspaceTask) -> None:
        owner = self._owner_label(task)
        for member in self.store.list_notification_members(kind="busy"):
            if task.submitter_chat_id is not None and member.chat_id == task.submitter_chat_id:
                continue
            await self._send_message(
                member.chat_id,
                "\n".join(
                    [
                        f"{self.get_app_title()} 目前由 {owner} 使用中。",
                        f"任務編號: {task.id}",
                        "如需提交新任務，系統會自動排隊。",
                    ]
                ),
            )

    async def _notify_task_completed(self, task_id: str, result: WorkflowRunResult) -> None:
        task = self.store.get_task(task_id)
        if task is None:
            return
        if task.submitter_chat_id is not None:
            await self._send_task_video(
                task.submitter_chat_id,
                Path(result.final_video_path),
                caption=f"{self.get_app_title()} 成品視頻",
            )

    async def _notify_task_failed(self, task: WorkspaceTask, error_message: str) -> None:
        if task.submitter_chat_id is None:
            return
        await self._send_message(
            task.submitter_chat_id,
            "\n".join(
                [
                    "任務執行失敗。",
                    "詳細錯誤與原始紀錄已保存在工作台任務詳情。",
                    error_message,
                ]
            ),
        )

    async def _notify_task_cancelled(self, task: WorkspaceTask, reason: str) -> None:
        if task.submitter_chat_id is None:
            return
        await self._send_message(
            task.submitter_chat_id,
            "\n".join(
                [
                    "任務已強制停止。",
                    "工作流已中止，詳細紀錄已保存在工作台任務詳情。",
                    reason,
                ]
            ),
        )

    async def _broadcast_available(self, finished_task: WorkspaceTask) -> None:
        owner = self._owner_label(finished_task)
        status = self.store.get_task(finished_task.id)
        if status is None:
            return
        state_label = "已完成" if status.status == "completed" else "已釋放"
        for member in self.store.list_notification_members(kind="available"):
            if finished_task.submitter_chat_id is not None and member.chat_id == finished_task.submitter_chat_id:
                continue
            await self._send_message(
                member.chat_id,
                "\n".join(
                    [
                        f"{self.get_app_title()} 已恢復可用。",
                        f"上一位使用者: {owner}",
                        f"任務狀態: {state_label}",
                    ]
                ),
            )

    async def _send_message(self, chat_id: int, text: str) -> None:
        if self.bot is None:
            return
        try:
            await self.bot.send_message(chat_id=chat_id, text=text)
        except Exception:
            return

    async def _send_task_video(self, chat_id: int, video_path: Path, *, caption: str) -> None:
        if self.bot is None or not video_path.exists():
            return
        try:
            await self.bot.send_video(chat_id=chat_id, video=FSInputFile(str(video_path)), caption=caption)
            return
        except Exception:
            pass
        try:
            await self.bot.send_document(chat_id=chat_id, document=FSInputFile(str(video_path)), caption=caption)
        except Exception:
            return

    @staticmethod
    def _to_user_progress_message(message: str) -> str | None:
        if not message:
            return None
        if "目前繁忙" in message:
            return "工作台正在排隊處理，系統會自動重試。"
        if "開始執行工作流" in message or "來源視頻" in message or "音頻擷取" in message or "擷取音頻" in message:
            return "步驟 1/3：正在從視頻擷取音頻。"
        if "語音克隆" in message or "參考音頻" in message or "克隆音頻" in message:
            return "步驟 2/3：正在生成口播音頻。"
        if "數字人" in message or "照片與克隆音頻" in message or "最終視頻時長" in message:
            return "步驟 3/3：正在生成數字人口播視頻。"
        if "工作流完成" in message or "成品已輸出" in message:
            return "已完成製作，正在整理成品。"
        return None

    @classmethod
    def _task_public_summary(cls, task: WorkspaceTask) -> str:
        public_message = cls._to_user_progress_message(task.current_stage)
        if public_message:
            return public_message
        summary = str(task.summary or "").strip()
        if summary and not cls._looks_internal_message(summary):
            return summary
        stage = str(task.current_stage or "").strip()
        if stage and not cls._looks_internal_message(stage):
            return stage
        return cls._status_label(task.status)

    @staticmethod
    def _status_label(status: str) -> str:
        labels = {
            "queued": "排隊中",
            "processing": "製作中",
            "completed": "已完成",
            "failed": "失敗",
            "cancelled": "已取消",
        }
        return labels.get(status, status)

    @staticmethod
    def _looks_internal_message(text: str) -> bool:
        value = str(text or "").strip()
        if not value:
            return False
        markers = ("RunningHub", "openapi/", ":\\", "/Users/", "\\Users\\", "source_video", "digital_human.mp4")
        return any(marker in value for marker in markers)

    def _raise_if_task_cancelled(self, task_id: str) -> None:
        cancel_event = self.task_cancel_events.get(task_id)
        if cancel_event is not None and cancel_event.is_set():
            reason = self.task_cancel_reasons.get(task_id) or "任務已強制停止"
            raise WorkflowCancelledError(reason)

    @staticmethod
    def _collect_task_files(task: WorkspaceTask) -> dict[str, dict[str, Any]]:
        files: dict[str, dict[str, Any]] = {}
        mapping = {
            "source_video": ("來源視頻", task.source_video_path),
            "avatar_image": ("數字人照片", task.avatar_image_path),
            "extracted_audio": ("擷取音頻", task.extracted_audio_path),
            "cloned_audio": ("克隆口播音頻", task.cloned_audio_path),
            "final_video": ("最終成品視頻", task.final_video_path),
        }
        for key, (label, value) in mapping.items():
            if not value:
                continue
            path = Path(value)
            if not path.exists():
                continue
            files[key] = {
                "label": label,
                "path": path,
                "name": path.name,
                "suffix": path.suffix.lower(),
                "size": path.stat().st_size,
            }
        return files

    @staticmethod
    def _owner_label(task: WorkspaceTask) -> str:
        if task.submitter_label:
            return task.submitter_label
        if task.submitter_chat_id is not None:
            return f"TG-{task.submitter_chat_id}"
        return "Web"

    @classmethod
    def _build_completed_summary_text(
        cls,
        *,
        created_at: float | None,
        started_at: float | None,
        finished_at: float | None,
    ) -> str:
        queue_wait = cls._seconds_between(created_at, started_at)
        processing = cls._seconds_between(started_at, finished_at)
        total = cls._seconds_between(created_at, finished_at)
        return (
            f"成品已生成，排隊等待 {cls._format_duration(queue_wait)}，"
            f"生成耗時 {cls._format_duration(processing)}，"
            f"總完成 {cls._format_duration(total)}"
        )

    @classmethod
    def _build_task_timings(cls, task: WorkspaceTask) -> dict[str, Any]:
        queue_wait = cls._seconds_between(task.created_at, task.started_at)
        processing = cls._seconds_between(task.started_at, task.finished_at)
        total = cls._seconds_between(task.created_at, task.finished_at)
        return {
            "queue_wait_seconds": queue_wait,
            "processing_seconds": processing,
            "total_seconds": total,
            "queue_wait_text": cls._format_duration(queue_wait),
            "processing_text": cls._format_duration(processing),
            "total_text": cls._format_duration(total),
        }

    @staticmethod
    def _seconds_between(start: float | None, end: float | None) -> float | None:
        if start is None or end is None:
            return None
        return max(float(end) - float(start), 0.0)

    @staticmethod
    def _format_duration(seconds: float | None) -> str:
        if seconds is None:
            return "-"
        total_seconds = int(round(float(seconds)))
        hours, remainder = divmod(total_seconds, 3600)
        minutes, secs = divmod(remainder, 60)
        parts: list[str] = []
        if hours:
            parts.append(f"{hours}小時")
        if minutes:
            parts.append(f"{minutes}分")
        if secs or not parts:
            parts.append(f"{secs}秒")
        return "".join(parts)

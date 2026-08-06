from __future__ import annotations

import asyncio
import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException

from webapp import video_workbench


def _create_tasks_db(path: Path) -> None:
    with sqlite3.connect(path) as conn:
        conn.execute(
            """
            CREATE TABLE tasks (
                id TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                type TEXT NOT NULL,
                status TEXT NOT NULL,
                input_json TEXT,
                output_json TEXT,
                error TEXT,
                runninghub_task_id TEXT,
                usage_json TEXT,
                cost_cents INTEGER,
                created_at INTEGER,
                updated_at INTEGER
            )
            """
        )


def _dependencies(path: Path, generate_prompt_preview):
    @contextmanager
    def db_factory():
        conn = sqlite3.connect(path)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    return video_workbench.VideoRouteDependencies(
        get_current_user=lambda: {"id": 1, "username": "owner"},
        enqueue_task=lambda *args, **kwargs: None,
        save_upload_file=lambda **kwargs: "",
        new_task_id=lambda: "unused-preview-task-id",
        workspace_username=lambda user: str(user["username"]),
        workspace_user_id=lambda user: int(user["id"]),
        db_factory=db_factory,
        json_loads=lambda value, default: json.loads(value) if value else default,
        json_dumps=lambda value: json.dumps(value, ensure_ascii=False),
        now_ts=lambda: 1_700_000_000,
        generate_prompt_preview=generate_prompt_preview,
    )


def _endpoint(app: FastAPI, path: str, method: str):
    return next(
        route.endpoint
        for route in app.router.routes
        if getattr(route, "path", "") == path and method in getattr(route, "methods", set())
    )


@pytest.fixture(autouse=True)
def _clear_prompt_preview_memory():
    with video_workbench._PROMPT_PREVIEW_RECOVERY_LOCK:
        video_workbench._PROMPT_PREVIEW_RECOVERY.clear()
    yield
    with video_workbench._PROMPT_PREVIEW_RECOVERY_LOCK:
        video_workbench._PROMPT_PREVIEW_RECOVERY.clear()


def test_completed_preview_recovers_after_memory_reset_and_post_is_idempotent(tmp_path: Path) -> None:
    database = tmp_path / "tasks.sqlite"
    _create_tasks_db(database)
    provider_calls: list[dict] = []

    def generate(**kwargs):
        provider_calls.append(kwargs)
        return {"prompt_text": "persisted prompt", "speech_text": "persisted speech"}

    first_app = FastAPI()
    video_workbench.register_video_routes(first_app, _dependencies(database, generate))
    preview = _endpoint(first_app, "/api/video/prompt-preview", "POST")
    owner = {"id": 1, "username": "owner"}
    first = asyncio.run(
        preview(
            module="digital_human_video",
            params_json=json.dumps({"prompt_text": "source"}),
            request_nonce="stable-nonce",
            files=None,
            user=owner,
        )
    )

    with sqlite3.connect(database) as conn:
        stored = conn.execute(
            "SELECT user_id, type, status, input_json, output_json FROM tasks"
        ).fetchall()
    assert len(stored) == 1
    assert stored[0][0:3] == (1, "video_prompt_preview", "success")
    assert json.loads(stored[0][3])["web_prompt_preview_nonce"] == "stable-nonce"
    assert json.loads(stored[0][4]) == first

    with video_workbench._PROMPT_PREVIEW_RECOVERY_LOCK:
        video_workbench._PROMPT_PREVIEW_RECOVERY.clear()

    def unexpected_generate(**kwargs):
        raise AssertionError("completed nonce must not call the provider again")

    restarted_app = FastAPI()
    video_workbench.register_video_routes(restarted_app, _dependencies(database, unexpected_generate))
    recover = _endpoint(restarted_app, "/api/video/prompt-preview/recover", "GET")
    repeated_preview = _endpoint(restarted_app, "/api/video/prompt-preview", "POST")

    assert asyncio.run(recover(request_nonce="stable-nonce", user=owner)) == first
    assert asyncio.run(
        repeated_preview(
            module="digital_human_video",
            params_json=json.dumps({"prompt_text": "different source"}),
            request_nonce="stable-nonce",
            files=None,
            user=owner,
        )
    ) == first
    assert len(provider_calls) == 1


def test_persisted_preview_is_user_isolated_and_hidden_from_video_task_list(tmp_path: Path) -> None:
    database = tmp_path / "tasks.sqlite"
    _create_tasks_db(database)
    app = FastAPI()
    dependencies = _dependencies(
        database,
        lambda **kwargs: {"prompt_text": "private prompt", "speech_text": "private speech"},
    )
    video_workbench.register_video_routes(app, dependencies)
    preview = _endpoint(app, "/api/video/prompt-preview", "POST")
    recover = _endpoint(app, "/api/video/prompt-preview/recover", "GET")
    task_list = _endpoint(app, "/api/video/tasks", "GET")
    owner = {"id": 1, "username": "owner"}

    asyncio.run(
        preview(
            module="digital_human_video",
            params_json="{}",
            request_nonce="shared-looking-nonce",
            files=None,
            user=owner,
        )
    )
    with sqlite3.connect(database) as conn:
        conn.execute(
            """
            INSERT INTO tasks(
                id, user_id, type, status, input_json, output_json, error,
                runninghub_task_id, usage_json, cost_cents, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "public-video-task",
                1,
                "create_video",
                "success",
                "{}",
                "{}",
                "",
                "",
                "{}",
                0,
                2,
                2,
            ),
        )
        conn.commit()

    with video_workbench._PROMPT_PREVIEW_RECOVERY_LOCK:
        video_workbench._PROMPT_PREVIEW_RECOVERY.clear()

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            recover(
                request_nonce="shared-looking-nonce",
                user={"id": 2, "username": "other"},
            )
        )
    assert exc_info.value.status_code == 404
    assert [item["id"] for item in asyncio.run(task_list(user=owner))["items"]] == ["public-video-task"]


def test_failed_preview_remains_memory_only(tmp_path: Path) -> None:
    database = tmp_path / "tasks.sqlite"
    _create_tasks_db(database)

    def fail(**kwargs):
        raise RuntimeError("provider unavailable")

    app = FastAPI()
    video_workbench.register_video_routes(app, _dependencies(database, fail))
    preview = _endpoint(app, "/api/video/prompt-preview", "POST")
    recover = _endpoint(app, "/api/video/prompt-preview/recover", "GET")
    owner = {"id": 1, "username": "owner"}

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            preview(
                module="digital_human_video",
                params_json="{}",
                request_nonce="failed-nonce",
                files=None,
                user=owner,
            )
        )
    assert exc_info.value.status_code == 503
    with sqlite3.connect(database) as conn:
        assert conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 0
    with pytest.raises(HTTPException) as recover_exc:
        asyncio.run(recover(request_nonce="failed-nonce", user=owner))
    assert recover_exc.value.status_code == 503

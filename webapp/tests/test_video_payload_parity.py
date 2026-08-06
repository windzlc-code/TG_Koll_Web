from __future__ import annotations

import asyncio
from io import BytesIO
import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from fastapi import FastAPI, UploadFile

from webapp import video_workbench


def test_digital_human_payload_keeps_both_presenters_and_product_slots() -> None:
    payload = video_workbench.build_video_submit_payload(
        "create_video",
        {
            "speech_text": "hello",
            "file_roles": ["model", "model", "product", "audio"],
        },
        [
            {"name": "presenter-a.png", "path": "C:/uploads/presenter-a.png", "kind": "image"},
            {"name": "presenter-b.png", "path": "C:/uploads/presenter-b.png", "kind": "image"},
            {"name": "product.png", "path": "C:/uploads/product.png", "kind": "image"},
            {"name": "voice.wav", "path": "C:/uploads/voice.wav", "kind": "audio"},
        ],
    )

    assert payload["model_image_local_path"] == "C:/uploads/presenter-a.png"
    assert payload["model_image_local_paths"] == [
        "C:/uploads/presenter-a.png",
        "C:/uploads/presenter-b.png",
    ]
    assert payload["product_image_local_paths"] == ["C:/uploads/product.png"]


def test_language_upload_is_voice_reference_not_rendered_target_track() -> None:
    payload = video_workbench.build_video_submit_payload(
        "video_language_replace",
        {
            "target_language": "English",
            "file_roles": ["video", "audio"],
        },
        [
            {"name": "source.mp4", "path": "C:/uploads/source.mp4", "kind": "video"},
            {"name": "voice.wav", "path": "C:/uploads/voice.wav", "kind": "audio"},
        ],
    )

    assert payload["voice_audio_local_path"] == "C:/uploads/voice.wav"
    assert payload["audio_local_path"] == "C:/uploads/voice.wav"
    assert "target_audio_local_path" not in payload


def test_video_workflows_use_personal_key_while_image_models_keep_enterprise_key() -> None:
    payload = video_workbench.apply_video_runtime_defaults(
        "create_video",
        {},
        {
            "runninghub_personal_api_key": "personal",
            "runninghub_enterprise_api_key": "enterprise",
        },
    )

    assert payload["video_runninghub_api_key"] == "personal"
    assert payload["runninghub_api_key"] == "personal"

    image_payload = video_workbench.apply_video_runtime_defaults(
        "image_generate",
        {},
        {
            "runninghub_personal_api_key": "personal",
            "runninghub_enterprise_api_key": "enterprise",
        },
    )
    assert image_payload["runninghub_api_key"] == "personal"
    assert image_payload["image_model_provider_api_key_gemini"] == "enterprise"


def test_prompt_preview_uses_shared_text_model_callback() -> None:
    calls: list[dict] = []
    app = FastAPI()
    dependencies = video_workbench.VideoRouteDependencies(
        get_current_user=lambda: {"id": 1, "username": "admin"},
        enqueue_task=lambda *args: None,
        save_upload_file=lambda **kwargs: "",
        new_task_id=lambda: "task-preview",
        workspace_username=lambda user: str(user["username"]),
        workspace_user_id=lambda user: int(user["id"]),
        generate_prompt_preview=lambda **kwargs: calls.append(kwargs) or {
            "speech_text": "generated copy",
            "prompt_text": "generated visual prompt",
            "storyboard": {"items": [{"segment_index": 1, "prompt": "shot one"}]},
        },
    )
    video_workbench.register_video_routes(app, dependencies)
    endpoint = next(
        route.endpoint
        for route in app.router.routes
        if getattr(route, "path", "") == "/api/video/prompt-preview"
    )

    result = asyncio.run(endpoint(
        module="digital_human_video",
        params_json=json.dumps({"product_name": "Demo"}),
        user={"id": 1, "username": "admin"},
    ))

    assert calls[0]["task_type"] == "create_video"
    assert result["generated"] is True
    assert result["speech_text"] == "generated copy"
    assert result["storyboard"]["items"][0]["prompt"] == "shot one"


def test_prompt_preview_passes_uploaded_images_to_shared_multimodal_model() -> None:
    captured_paths: list[str] = []

    def generate_preview(**kwargs):
        captured_paths.extend(kwargs["image_paths"])
        assert Path(captured_paths[0]).read_bytes() == b"presenter-image"
        assert Path(captured_paths[1]).read_bytes() == b"product-image"
        return {"speech_text": "image-aware copy"}

    app = FastAPI()
    dependencies = video_workbench.VideoRouteDependencies(
        get_current_user=lambda: {"id": 1, "username": "admin"},
        enqueue_task=lambda *args: None,
        save_upload_file=lambda **kwargs: "",
        new_task_id=lambda: "task-preview-images",
        workspace_username=lambda user: str(user["username"]),
        workspace_user_id=lambda user: int(user["id"]),
        generate_prompt_preview=generate_preview,
        max_upload_bytes=1024,
    )
    video_workbench.register_video_routes(app, dependencies)
    endpoint = next(
        route.endpoint
        for route in app.router.routes
        if getattr(route, "path", "") == "/api/video/prompt-preview"
    )

    result = asyncio.run(endpoint(
        module="digital_human_video",
        params_json=json.dumps({"product_name": "Demo"}),
        files=[
            UploadFile(filename="presenter.png", file=BytesIO(b"presenter-image")),
            UploadFile(filename="product.jpg", file=BytesIO(b"product-image")),
            UploadFile(filename="voice.wav", file=BytesIO(b"ignored-audio")),
        ],
        user={"id": 1, "username": "admin"},
    ))

    assert result["speech_text"] == "image-aware copy"
    assert len(captured_paths) == 2
    assert all(not Path(path).exists() for path in captured_paths)


def test_video_task_list_returns_owned_video_tasks_and_segment_metadata(tmp_path) -> None:
    database = tmp_path / "tasks.sqlite"
    connection = sqlite3.connect(database)
    connection.execute(
        "CREATE TABLE tasks (id TEXT, user_id INTEGER, type TEXT, status TEXT, output_json TEXT, updated_at INTEGER)"
    )
    connection.executemany(
        "INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?)",
        [
            ("video-owned", 1, "create_video", "success", json.dumps({"video_path": "out.mp4", "completed_segments": [{"index": 1}]}), 3),
            ("non-video", 1, "persona_post_generation", "success", "{}", 2),
            ("video-other", 2, "replace_model", "success", "{}", 1),
        ],
    )
    connection.commit()
    connection.close()

    @contextmanager
    def db_factory():
        conn = sqlite3.connect(database)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    app = FastAPI()
    dependencies = video_workbench.VideoRouteDependencies(
        get_current_user=lambda: {"id": 1, "username": "admin"},
        enqueue_task=lambda *args: None,
        save_upload_file=lambda **kwargs: "",
        new_task_id=lambda: "task-list",
        workspace_username=lambda user: str(user["username"]),
        workspace_user_id=lambda user: int(user["id"]),
        db_factory=db_factory,
    )
    video_workbench.register_video_routes(app, dependencies)
    endpoint = next(
        route.endpoint
        for route in app.router.routes
        if getattr(route, "path", "") == "/api/video/tasks" and "GET" in route.methods
    )

    result = asyncio.run(endpoint(user={"id": 1, "username": "admin"}))

    assert [item["id"] for item in result["items"]] == ["video-owned"]
    assert result["items"][0]["has_download"] is True
    assert result["items"][0]["completed_segments"] == [{"index": 1}]


def test_frontend_submits_the_confirmed_generated_preview() -> None:
    javascript = (Path(__file__).parents[1] / "static" / "assets" / "video-workbench.js").read_text(encoding="utf-8")

    assert "if (!draft.values._prompt_preview_ready || !draft.values._prompt_preview)" in javascript
    assert "await generatePromptDraft();" in javascript
    assert "applyStoredPromptPreviewForSubmit(module, submitValues, draft);" in javascript
    assert 'body.append("params_json", JSON.stringify({ ...submitValues, _file_roles: fileManifest }));' in javascript

from __future__ import annotations

from contextlib import AbstractAsyncContextManager
from datetime import datetime
from pathlib import Path
from typing import Callable

from fastapi import FastAPI, Form, HTTPException, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .config import AppConfig
from .workbench import WorkspaceService


def _format_dt(value: float | None) -> str:
    if not value:
        return "-"
    return datetime.fromtimestamp(float(value)).strftime("%Y-%m-%d %H:%M:%S")


def _format_size(value: int | None) -> str:
    if value is None:
        return "-"
    size = float(value)
    units = ["B", "KB", "MB", "GB"]
    for unit in units:
        if size < 1024.0 or unit == units[-1]:
            return f"{size:.1f} {unit}"
        size /= 1024.0
    return f"{size:.1f} GB"


def _redirect(path: str) -> RedirectResponse:
    return RedirectResponse(path, status_code=303)


def create_web_app(
    config: AppConfig,
    service: WorkspaceService,
    lifespan: Callable[[FastAPI], AbstractAsyncContextManager[None]] | None = None,
) -> FastAPI:
    app = FastAPI(title=config.app_title, lifespan=lifespan)
    app.mount("/static", StaticFiles(directory=str(config.static_dir)), name="static")
    templates = Jinja2Templates(directory=str(config.templates_dir))
    templates.env.filters["datetime"] = _format_dt
    templates.env.filters["filesize"] = _format_size

    def ctx(request: Request, active: str, **extra):
        payload = {
            "request": request,
            "active": active,
            "service_title": service.get_app_title(),
            "base_url": service.resolve_config().public_base_url,
        }
        payload.update(extra)
        return payload

    @app.get("/", response_class=HTMLResponse)
    async def dashboard(request: Request):
        snapshot = service.get_dashboard_snapshot()
        return templates.TemplateResponse(
            request,
            "dashboard.html",
            ctx(request, "dashboard", snapshot=snapshot, effective_config=service.resolve_config()),
        )

    @app.get("/tasks", response_class=HTMLResponse)
    async def tasks_page(request: Request, status: str | None = Query(default=None)):
        tasks = service.list_tasks(status=status, limit=200)
        counts = service.get_dashboard_snapshot()["counts"]
        return templates.TemplateResponse(
            request,
            "tasks.html",
            ctx(request, "tasks", tasks=tasks, counts=counts, status=status),
        )

    @app.get("/tasks/{task_id}", response_class=HTMLResponse)
    async def task_detail_page(request: Request, task_id: str):
        try:
            detail = service.get_task_detail(task_id)
        except RuntimeError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return templates.TemplateResponse(
            request,
            "task_detail.html",
            ctx(request, "tasks", detail=detail),
        )

    @app.post("/tasks/{task_id}/retry")
    async def retry_task(task_id: str):
        submission = await service.retry_task(task_id, submitter_chat_id=None, source="web-retry")
        return _redirect(f"/tasks/{submission.task.id}")

    @app.post("/tasks/{task_id}/cancel")
    async def cancel_task(task_id: str):
        try:
            await service.cancel_task(task_id, requested_by="Web 工作台")
        except RuntimeError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return _redirect(f"/tasks/{task_id}")

    @app.get("/tasks/{task_id}/files/{kind}")
    async def task_file(task_id: str, kind: str):
        try:
            path = service.resolve_task_file(task_id, kind)
        except RuntimeError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return FileResponse(path, filename=Path(path).name)

    @app.get("/settings", response_class=HTMLResponse)
    async def settings_page(request: Request):
        return templates.TemplateResponse(
            request,
            "settings.html",
            ctx(
                request,
                "settings",
                settings=service.get_settings(),
                effective_config=service.resolve_config(),
                members=service.list_members(),
            ),
        )

    @app.post("/settings/general")
    async def settings_general(
        app_title: str = Form(""),
        public_base_url: str = Form(""),
        runtime_config_path: str = Form(""),
        engine_api_key: str = Form(""),
        audio_workflow_id: str = Form(""),
        video_workflow_id: str = Form(""),
        source_video_path: str = Form(""),
        extracted_audio_path: str = Form(""),
        avatar_image_path: str = Form(""),
        cloned_audio_path: str = Form(""),
        final_video_path: str = Form(""),
        default_script_text: str = Form(""),
        poll_interval_seconds: str = Form("5"),
    ):
        service.save_settings(
            {
                "app_title": app_title,
                "public_base_url": public_base_url,
                "runtime_config_path": runtime_config_path,
                "engine_api_key": engine_api_key,
                "audio_workflow_id": audio_workflow_id,
                "video_workflow_id": video_workflow_id,
                "source_video_path": source_video_path,
                "extracted_audio_path": extracted_audio_path,
                "avatar_image_path": avatar_image_path,
                "cloned_audio_path": cloned_audio_path,
                "final_video_path": final_video_path,
                "default_script_text": default_script_text,
                "poll_interval_seconds": poll_interval_seconds,
            }
        )
        return _redirect("/settings")

    @app.post("/settings/members")
    async def settings_members(
        chat_id: str = Form(...),
        label: str = Form(""),
        enabled: str | None = Form(default=None),
        notify_busy: str | None = Form(default=None),
        notify_available: str | None = Form(default=None),
    ):
        chat_id_int = int(chat_id.strip())
        service.upsert_member(
            chat_id=chat_id_int,
            label=label,
            enabled=enabled == "on",
            notify_busy=notify_busy == "on",
            notify_available=notify_available == "on",
        )
        return _redirect("/settings")

    @app.post("/settings/members/{chat_id}/delete")
    async def settings_member_delete(chat_id: int):
        service.delete_member(chat_id)
        return _redirect("/settings")

    @app.get("/api/status")
    async def api_status():
        snapshot = service.get_status_snapshot()
        active_task = snapshot.get("active_task")
        if active_task is not None:
            snapshot["active_task"] = service.store.serialize_task(active_task)
        return JSONResponse(snapshot)

    @app.get("/api/tasks")
    async def api_tasks(status: str | None = Query(default=None)):
        tasks = service.list_tasks(status=status, limit=200)
        return JSONResponse([service.store.serialize_task(task) for task in tasks])

    @app.get("/api/tasks/{task_id}")
    async def api_task(task_id: str):
        try:
            detail = service.get_task_detail(task_id)
        except RuntimeError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return JSONResponse(
            {
                "task": service.store.serialize_task(detail["task"]),
                "timings": detail["timings"],
                "events": detail["events"],
                "files": {
                    key: {
                        "label": value["label"],
                        "name": value["name"],
                        "size": value["size"],
                    }
                    for key, value in detail["files"].items()
                },
            }
        )

    @app.post("/api/tasks/{task_id}/cancel")
    async def api_task_cancel(task_id: str):
        try:
            result = await service.cancel_task(task_id, requested_by="Web API")
        except RuntimeError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return JSONResponse(
            {
                "task_id": task_id,
                "state": result.state,
                "message": result.message,
            }
        )

    return app

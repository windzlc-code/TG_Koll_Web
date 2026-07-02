from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI

from .bot import TelegramWorkbenchBot
from .config import load_config
from .storage import WorkspaceStore
from .webapp import create_web_app
from .workbench import WorkspaceService


def create_app() -> FastAPI:
    project_root = Path(__file__).resolve().parents[2]
    config = load_config(project_root)
    store = WorkspaceStore(config.database_path)
    service = WorkspaceService(config, store)
    tg_bot = TelegramWorkbenchBot(config, service)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await service.start()
        await tg_bot.start()
        app.state.service = service
        app.state.tg_bot = tg_bot
        app.state.config = config
        try:
            yield
        finally:
            await tg_bot.stop()
            await service.stop()

    app = create_web_app(config, service, lifespan=lifespan)
    app.state.config = config
    return app


def main() -> None:
    app = create_app()
    config = app.state.config
    uvicorn.run(app, host=config.web_host, port=config.web_port)

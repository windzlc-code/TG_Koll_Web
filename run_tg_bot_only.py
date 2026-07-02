from __future__ import annotations

import asyncio
import signal
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from digital_human_tg_bot.bot import TelegramWorkbenchBot
from digital_human_tg_bot.config import load_config
from digital_human_tg_bot.storage import WorkspaceStore
from digital_human_tg_bot.workbench import WorkspaceService


async def amain() -> None:
    config = load_config(PROJECT_ROOT)
    store = WorkspaceStore(config.database_path)
    service = WorkspaceService(config, store)
    tg_bot = TelegramWorkbenchBot(config, service)
    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop_event.set)
        except NotImplementedError:
            pass
    await service.start()
    await tg_bot.start()
    try:
        await stop_event.wait()
    finally:
        await tg_bot.stop()
        await service.stop()


def main() -> None:
    asyncio.run(amain())


if __name__ == "__main__":
    main()

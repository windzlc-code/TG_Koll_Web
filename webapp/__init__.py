from typing import Any

__all__ = ["app"]


def __getattr__(name: str) -> Any:
    if name != "app":
        raise AttributeError(name)
    from .server import app

    return app

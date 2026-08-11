from __future__ import annotations

from typing import Any


class CRMError(RuntimeError):
    def __init__(
        self,
        code: str,
        message_key: str,
        *,
        status_code: int = 409,
        details: dict[str, Any] | None = None,
        retryable: bool = False,
    ) -> None:
        super().__init__(message_key)
        self.code = str(code)
        self.message_key = str(message_key)
        self.status_code = int(status_code)
        self.details = dict(details or {})
        self.retryable = bool(retryable)

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, Depends, FastAPI, HTTPException

from .auth import require_admin
from .collector_accounts import (
    CollectorAccountNotFoundError,
    CollectorAccountPool,
)
from .collector_db import get_collector_db_path
from .collector_vault import CollectorVault, CollectorVaultError


def _collector_pool() -> CollectorAccountPool | None:
    db_path = Path(get_collector_db_path())
    explicit = str(os.getenv("COLLECTOR_DB_PATH", "") or "").strip()
    if not explicit and not db_path.exists():
        return None
    try:
        return CollectorAccountPool(db_path, CollectorVault())
    except CollectorVaultError:
        return None


def create_collector_router() -> APIRouter:
    router = APIRouter(tags=["collector"])

    @router.get("/api/admin/collector/overview")
    def overview(_admin: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
        pool = _collector_pool()
        if pool is None:
            return {
                "configured": False,
                "summary": {
                    "account_count": 0,
                    "ready_account_count": 0,
                    "leased_account_count": 0,
                },
                "accounts": [],
            }
        accounts = pool.list_accounts()
        return {
            "configured": True,
            "summary": {
                "account_count": len(accounts),
                "ready_account_count": sum(1 for item in accounts if item["status"] == "ready"),
                "leased_account_count": sum(1 for item in accounts if item["leased"]),
            },
            "accounts": accounts,
        }

    @router.patch("/api/admin/collector/accounts/{account_id}/state")
    def patch_account_state(
        account_id: str,
        payload: dict[str, Any] = Body(...),
        _admin: dict[str, Any] = Depends(require_admin),
    ) -> dict[str, Any]:
        pool = _collector_pool()
        if pool is None:
            raise HTTPException(status_code=503, detail="collector account pool is not configured")
        try:
            account = pool.set_account_state(
                account_id,
                status=str(payload.get("status") or ""),
                health_status=str(payload.get("health_status") or "unknown"),
            )
        except CollectorAccountNotFoundError as exc:
            raise HTTPException(status_code=404, detail="collector account not found") from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"ok": True, "account": account}

    return router


def register_collector_routes(app: FastAPI) -> None:
    app.include_router(create_collector_router())


__all__ = ["create_collector_router", "register_collector_routes"]

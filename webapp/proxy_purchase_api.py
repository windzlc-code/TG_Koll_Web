from __future__ import annotations

import logging
import threading
from decimal import Decimal
from typing import Any, Callable, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import proxy_purchases
from .db import db
from .proxy_providers import ProxyProviderError


logger = logging.getLogger(__name__)
_WORKER_STOP = threading.Event()
_WORKER_THREAD: threading.Thread | None = None
_WORKER_LOCK = threading.Lock()


class _StrictModel(BaseModel):
    class Config:
        extra = "forbid"


class ProxyQuotePayload(_StrictModel):
    country: str = Field(min_length=2, max_length=16)
    auto_renew: bool = False


class ProxyOrderPayload(_StrictModel):
    quote_id: str = Field(min_length=8, max_length=160)
    idempotency_key: str = Field(min_length=8, max_length=160)


class ProxyRenewalPayload(_StrictModel):
    enabled: bool


class ProxyPurchaseConfigPayload(_StrictModel):
    provider: str = Field(default="proxy-cheap", max_length=40)
    service_id: Literal["static-residential-ipv4"] = "static-residential-ipv4"
    plan_id: str = Field(default="", max_length=160)
    default_country: str = Field(default="", max_length=16)
    default_period: int = Field(default=1, ge=1, le=36)
    quantity: int = Field(default=1, ge=1, le=1)
    setup_defaults: dict[str, Any] = Field(default_factory=dict)
    points_per_usd: Decimal = Field(gt=0, le=1_000_000)
    usd_to_ntd_rate: Decimal = Field(gt=0, le=1_000_000)
    payment_fee_rate: Decimal = Field(default=Decimal("0"), ge=0, le=1)
    fixed_fee_points: Decimal = Field(default=Decimal("0"), ge=0, le=1_000_000)
    max_vendor_cost_usd: Decimal = Field(gt=0, le=1_000_000)
    safety_buffer_usd: Decimal = Field(default=Decimal("0"), ge=0, le=1_000_000)
    minimum_profit_usd: Decimal = Field(default=Decimal("0"), ge=0, le=1_000_000)
    live_purchasing_enabled: bool = False


class ProxyPurchasePublishPayload(_StrictModel):
    admin_password: str = Field(min_length=1, max_length=256)
    totp_code: str = Field(min_length=1, max_length=64)


class ProxyPurchaseAdminActionPayload(ProxyPurchasePublishPayload):
    reason: str = Field(min_length=3, max_length=500)


class ProxyPurchaseAdminResolutionPayload(ProxyPurchaseAdminActionPayload):
    action: Literal["reconcile", "bind", "confirm_not_created"]
    provider_order_id: str = Field(default="", max_length=160)


class ProxyPurchaseAdminRenewalResolutionPayload(ProxyPurchaseAdminActionPayload):
    action: Literal["reconcile", "confirm_not_extended"]


def _identity_user_id(user: dict[str, Any]) -> int:
    user_id = int(user.get("_workspace_user_id") or user.get("id") or 0)
    if user_id <= 0:
        raise HTTPException(status_code=401, detail="登录状态无效")
    return user_id


def _error_response(exc: Exception) -> JSONResponse:
    status = int(getattr(exc, "status_code", 502) or 502)
    code = str(getattr(exc, "code", "PROXY_PURCHASE_ERROR"))
    return JSONResponse(
        status_code=status,
        content={"detail": {"code": code, "message": str(exc)}, "code": code},
    )


def register_proxy_purchase_routes(
    app: FastAPI,
    *,
    current_user_dependency: Callable[..., dict[str, Any]],
    admin_dependency: Callable[..., dict[str, Any]],
    admin_step_up: Callable[..., None],
    audit_callback: Callable[..., Any] | None = None,
) -> None:
    @app.exception_handler(proxy_purchases.ProxyPurchaseError)
    async def proxy_purchase_error_handler(_request: Request, exc: proxy_purchases.ProxyPurchaseError):
        return _error_response(exc)

    @app.exception_handler(ProxyProviderError)
    async def proxy_provider_error_handler(_request: Request, exc: ProxyProviderError):
        return _error_response(exc)

    @app.get("/api/proxy-purchases/options")
    def api_proxy_purchase_options(user: dict[str, Any] = Depends(current_user_dependency)):
        with db() as conn:
            return {"ok": True, **proxy_purchases.purchase_options(conn, user_id=_identity_user_id(user))}

    @app.post("/api/proxy-purchases/quotes")
    def api_proxy_purchase_quote(
        payload: ProxyQuotePayload,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        with db() as conn:
            quote = proxy_purchases.create_quote(
                conn,
                user_id=_identity_user_id(user),
                country=payload.country,
                auto_renew=payload.auto_renew,
            )
        return {"ok": True, "quote": quote}

    @app.post("/api/proxy-purchases/orders")
    def api_proxy_purchase_order(
        payload: ProxyOrderPayload,
        idempotency_header: str = Header(default="", alias="Idempotency-Key"),
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        body_key = str(payload.idempotency_key or "").strip()
        header_key = str(idempotency_header or "").strip()
        if header_key and header_key != body_key:
            raise HTTPException(status_code=409, detail="幂等键不一致")
        with db() as conn:
            order = proxy_purchases.create_order(
                conn,
                user_id=_identity_user_id(user),
                quote_id=payload.quote_id,
                idempotency_key=body_key,
            )
        return {"ok": True, "order": order}

    @app.get("/api/proxy-purchases/orders/recover")
    def api_proxy_purchase_order_recover(
        idempotency_key: str = Query(min_length=8, max_length=160),
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        user_id = _identity_user_id(user)
        with db() as conn:
            row = conn.execute(
                "SELECT * FROM proxy_purchase_orders WHERE user_id=? AND idempotency_key=?",
                (user_id, str(idempotency_key).strip()),
            ).fetchone()
            if row is None:
                raise proxy_purchases.ProxyPurchaseError(
                    "ORDER_NOT_FOUND", "未找到对应的采购订单", 404
                )
            order = proxy_purchases._public_order(row)
        return {"ok": True, "order": order}

    @app.get("/api/proxy-purchases/orders/{order_id}")
    def api_proxy_purchase_order_get(
        order_id: str,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        user_id = _identity_user_id(user)
        with db() as conn:
            # Browser polling reads only local state. Supplier reconciliation is
            # centralized in the worker/admin action to avoid multiplying API
            # calls and to preserve a single controlled retry policy.
            order = proxy_purchases.get_order(
                conn,
                user_id=user_id,
                order_id=str(order_id),
            )
        return {"ok": True, "order": order}

    @app.put("/api/proxy-purchases/orders/{order_id}/renewal")
    def api_proxy_purchase_renewal(
        order_id: str,
        payload: ProxyRenewalPayload,
        user: dict[str, Any] = Depends(current_user_dependency),
    ):
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            order = proxy_purchases.set_order_renewal(
                conn,
                user_id=_identity_user_id(user),
                order_id=str(order_id),
                enabled=payload.enabled,
            )
        return {"ok": True, "order": order}

    @app.get("/api/admin/proxy-purchases/config")
    def api_admin_proxy_purchase_config(_admin: dict[str, Any] = Depends(admin_dependency)):
        with db() as conn:
            config = proxy_purchases.get_config(conn, include_draft=True)
        provider = proxy_purchases.provider_from_environment()
        configured, purchasing = proxy_purchases._provider_ready(provider)
        return {
            "ok": True,
            "config": config,
            "credential_status": {
                "configured": configured,
                "live_purchasing_enabled": purchasing,
            },
        }

    @app.put("/api/admin/proxy-purchases/config")
    def api_admin_proxy_purchase_config_save(
        payload: ProxyPurchaseConfigPayload,
        admin: dict[str, Any] = Depends(admin_dependency),
    ):
        data = payload.model_dump() if hasattr(payload, "model_dump") else payload.dict()
        with db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            config = proxy_purchases.save_config_draft(
                conn,
                data,
                actor_user_id=int(admin.get("id") or 0),
            )
        return {"ok": True, "config": config}

    @app.post("/api/admin/proxy-purchases/config/publish")
    def api_admin_proxy_purchase_config_publish(
        payload: ProxyPurchasePublishPayload,
        admin: dict[str, Any] = Depends(admin_dependency),
    ):
        with db() as conn:
            draft = conn.execute(
                "SELECT id FROM proxy_purchase_config_versions WHERE status = 'draft' "
                "ORDER BY version_number DESC LIMIT 1"
            ).fetchone()
            if draft is None:
                raise proxy_purchases.ProxyPurchaseError(
                    "CONFIG_NOT_FOUND", "没有待发布的采购配置草稿", 404
                )
            admin_step_up(
                conn,
                admin,
                admin_password=payload.admin_password,
                totp_code=payload.totp_code,
            )
            provider = proxy_purchases.provider_from_environment()
            # publish_config validates provider setup before its first write,
            # so the network calls do not hold SQLite's write lock.
            config = proxy_purchases.publish_config(
                conn,
                str(draft["id"]),
                actor_user_id=int(admin.get("id") or 0),
                provider=provider,
            )
        return {"ok": True, "config": config}

    @app.get("/api/admin/proxy-purchases/provider-options")
    def api_admin_proxy_purchase_provider_options(
        service_id: str = Query(default="static-residential-ipv4", min_length=1, max_length=160),
        plan_id: str = Query(default="", max_length=160),
        _admin: dict[str, Any] = Depends(admin_dependency),
    ):
        with db() as conn:
            return {
                "ok": True,
                **proxy_purchases.provider_options(
                    conn,
                    service_id=str(service_id),
                    plan_id=str(plan_id),
                ),
            }

    @app.get("/api/admin/proxy-purchases/orders")
    def api_admin_proxy_purchase_orders(_admin: dict[str, Any] = Depends(admin_dependency)):
        with db() as conn:
            return {"ok": True, "items": proxy_purchases.list_orders(conn, limit=200)}

    @app.post("/api/admin/proxy-purchases/orders/{order_id}/reconcile")
    def api_admin_proxy_purchase_reconcile(
        order_id: str,
        payload: ProxyPurchaseAdminActionPayload,
        admin: dict[str, Any] = Depends(admin_dependency),
    ):
        pending_error: Exception | None = None
        with db() as conn:
            admin_step_up(
                conn,
                admin,
                admin_password=payload.admin_password,
                totp_code=payload.totp_code,
            )
            before_row = conn.execute(
                "SELECT * FROM proxy_purchase_orders WHERE id=?", (str(order_id),)
            ).fetchone()
            before = proxy_purchases._public_order(before_row) if before_row is not None else {}
            try:
                order = proxy_purchases.reconcile_order(conn, order_id=str(order_id))
            except Exception as exc:
                pending_error = exc
                order = before
            if audit_callback is not None:
                audit_callback(
                    conn,
                    actor_user_id=int(admin.get("id") or 0),
                    action="proxy_purchase.order_reconcile",
                    resource_type="proxy_purchase_order",
                    resource_id=str(order_id),
                    reason=payload.reason,
                    before=before,
                    after=order,
                    outcome="failure" if pending_error else "success",
                    error_code=str(getattr(pending_error, "code", "") or ""),
                    risk_level="high",
                )
        if pending_error is not None:
            raise pending_error
        return {"ok": True, "order": order}

    @app.post("/api/admin/proxy-purchases/orders/{order_id}/resolve")
    def api_admin_proxy_purchase_resolve(
        order_id: str,
        payload: ProxyPurchaseAdminResolutionPayload,
        admin: dict[str, Any] = Depends(admin_dependency),
    ):
        if payload.action == "reconcile":
            return api_admin_proxy_purchase_reconcile(order_id, payload, admin)
        if payload.action == "bind" and not payload.provider_order_id.strip():
            raise HTTPException(status_code=422, detail="绑定供应商订单时必须填写供应商订单 ID")
        pending_error: Exception | None = None
        with db() as conn:
            admin_step_up(
                conn,
                admin,
                admin_password=payload.admin_password,
                totp_code=payload.totp_code,
            )
            before_row = conn.execute(
                "SELECT * FROM proxy_purchase_orders WHERE id=?", (str(order_id),)
            ).fetchone()
            before = proxy_purchases._public_order(before_row) if before_row is not None else {}
            try:
                order = proxy_purchases.admin_resolve_order(
                    conn,
                    order_id=str(order_id),
                    action="confirm_not_ordered" if payload.action == "confirm_not_created" else payload.action,
                    provider_order_id=payload.provider_order_id.strip(),
                    actor_user_id=int(admin.get("id") or 0),
                )
            except Exception as exc:
                pending_error = exc
                order = before
            if audit_callback is not None:
                audit_callback(
                    conn,
                    actor_user_id=int(admin.get("id") or 0),
                    action=f"proxy_purchase.order_{payload.action}",
                    resource_type="proxy_purchase_order",
                    resource_id=str(order_id),
                    reason=payload.reason,
                    before=before,
                    after=order,
                    outcome="failure" if pending_error else "success",
                    error_code=str(getattr(pending_error, "code", "") or ""),
                    risk_level="critical",
                )
        if pending_error is not None:
            raise pending_error
        return {"ok": True, "order": order}

    @app.post("/api/admin/proxy-purchases/orders/{order_id}/renewal/resolve")
    def api_admin_proxy_purchase_renewal_resolve(
        order_id: str,
        payload: ProxyPurchaseAdminRenewalResolutionPayload,
        admin: dict[str, Any] = Depends(admin_dependency),
    ):
        pending_error: Exception | None = None
        with db() as conn:
            admin_step_up(
                conn,
                admin,
                admin_password=payload.admin_password,
                totp_code=payload.totp_code,
            )
            before_row = conn.execute(
                "SELECT orders.*,schedule.status AS renewal_status,schedule.expires_at AS renewal_expires_at "
                "FROM proxy_purchase_orders orders LEFT JOIN proxy_renewal_schedules schedule "
                "ON schedule.order_id=orders.id WHERE orders.id=?",
                (str(order_id),),
            ).fetchone()
            before = dict(before_row) if before_row is not None else {}
            try:
                order = proxy_purchases.admin_resolve_renewal(
                    conn,
                    order_id=str(order_id),
                    action=payload.action,
                    actor_user_id=int(admin.get("id") or 0),
                )
            except Exception as exc:
                pending_error = exc
                order = before
            if audit_callback is not None:
                audit_callback(
                    conn,
                    actor_user_id=int(admin.get("id") or 0),
                    action=f"proxy_purchase.renewal_{payload.action}",
                    resource_type="proxy_renewal_schedule",
                    resource_id=str(order_id),
                    reason=payload.reason,
                    before=before,
                    after=order,
                    outcome="failure" if pending_error else "success",
                    error_code=str(getattr(pending_error, "code", "") or ""),
                    risk_level="critical",
                )
        if pending_error is not None:
            raise pending_error
        return {"ok": True, "order": order}

    @app.post("/api/webhooks/proxycheap")
    async def api_proxycheap_webhook(
        request: Request,
        event_name: str = Header(default="", alias="Webhook-Event"),
        event_id: str = Header(default="", alias="Webhook-Id"),
        signature: str = Header(default="", alias="Webhook-Signature"),
    ):
        raw_body = await request.body()
        if len(raw_body) > 262_144:
            raise HTTPException(status_code=413, detail="Webhook 请求过大")
        with db() as conn:
            accepted = proxy_purchases.record_webhook(
                conn,
                raw_body=raw_body,
                event_name=event_name,
                event_id=event_id,
                signature=signature,
            )
        return {"ok": True, **accepted}


def _run_worker_job(name: str, callback: Callable[[Any], Any]) -> None:
    try:
        with db() as conn:
            callback(conn)
    except Exception:
        logger.exception("Proxy purchase worker job failed: %s", name)


def _run_worker_cycle() -> None:
    jobs: tuple[tuple[str, Callable[[Any], Any]], ...] = (
        ("webhook-consume", lambda conn: proxy_purchases.process_webhook_events(conn, limit=50)),
        ("order-reconcile", lambda conn: proxy_purchases.reconcile_due_orders(conn, limit=20)),
        ("active-sync", lambda conn: proxy_purchases.sync_active_assets(conn, limit=20)),
        ("renewals", lambda conn: proxy_purchases.process_due_renewals(conn, limit=20)),
    )
    for name, callback in jobs:
        _run_worker_job(name, callback)


def _worker_loop() -> None:
    while not _WORKER_STOP.wait(60):
        _run_worker_cycle()


def start_proxy_purchase_worker() -> None:
    global _WORKER_THREAD
    with _WORKER_LOCK:
        if _WORKER_THREAD is not None and _WORKER_THREAD.is_alive():
            return
        _WORKER_STOP.clear()
        _WORKER_THREAD = threading.Thread(
            target=_worker_loop,
            name="proxy-purchase-reconcile",
            daemon=True,
        )
        _WORKER_THREAD.start()


def stop_proxy_purchase_worker() -> None:
    global _WORKER_THREAD
    _WORKER_STOP.set()
    thread = _WORKER_THREAD
    if thread is not None and thread.is_alive():
        thread.join(timeout=2)
    _WORKER_THREAD = None

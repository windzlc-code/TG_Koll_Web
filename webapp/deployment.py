from __future__ import annotations

import os
from dataclasses import dataclass


APPLICATION_ROLE = "application"
COLLECTOR_ROLE = "collector"
_ROLE_ALIASES = {
    "": APPLICATION_ROLE,
    "app": APPLICATION_ROLE,
    "application": APPLICATION_ROLE,
    "product": APPLICATION_ROLE,
    "collector": COLLECTOR_ROLE,
    "capture": COLLECTOR_ROLE,
    "crawler": COLLECTOR_ROLE,
}


@dataclass(frozen=True)
class DeploymentBoundary:
    role: str
    blocked_pages: frozenset[str]
    blocked_api_prefixes: tuple[str, ...]
    blocked_api_paths: frozenset[str]

    @property
    def collector(self) -> bool:
        return self.role == COLLECTOR_ROLE

    def blocks(self, path: str) -> bool:
        clean_path = "/" + str(path or "").split("?", 1)[0].lstrip("/")
        if not self.collector:
            return False
        if clean_path in self.blocked_pages or clean_path in self.blocked_api_paths:
            return True
        return any(clean_path.startswith(prefix) for prefix in self.blocked_api_prefixes)


def deployment_role(value: str | None = None) -> str:
    raw = str(value if value is not None else os.getenv("TG_DEPLOYMENT_ROLE", "")).strip().lower()
    role = _ROLE_ALIASES.get(raw)
    if role is None:
        raise RuntimeError(f"unsupported TG_DEPLOYMENT_ROLE: {raw}")
    return role


def deployment_boundary(value: str | None = None) -> DeploymentBoundary:
    role = deployment_role(value)
    return DeploymentBoundary(
        role=role,
        blocked_pages=frozenset(
            {
                "/about-vecto.html",
                "/pricing.html",
                "/register.html",
                "/subscription.html",
                "/persona-automation-log.html",
            }
        ),
        blocked_api_prefixes=(
            "/api/auth/google/",
            "/api/billing/",
            "/api/persona_dashboard/refresh",
            "/api/persona_dashboard/selection",
            "/api/persona_dashboard/monitor",
            "/api/persona_dashboard/media",
            "/api/persona_dashboard/groups",
        ),
        blocked_api_paths=frozenset(
            {
                "/api/auth/apply",
                "/api/auth/email-binding/confirm",
                "/api/auth/email-verification/send",
                "/api/auth/register",
            }
        ),
    )


def is_collector_deployment(value: str | None = None) -> bool:
    return deployment_role(value) == COLLECTOR_ROLE


__all__ = [
    "APPLICATION_ROLE",
    "COLLECTOR_ROLE",
    "DeploymentBoundary",
    "deployment_boundary",
    "deployment_role",
    "is_collector_deployment",
]

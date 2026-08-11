from __future__ import annotations

from typing import Any


# This is the runtime truth used by both the API and the CRM SPA.  A capability
# is marked blocked when the legacy Node implementation has not yet been
# replaced by an evidence-producing Python handler.  Blocked capabilities stay
# visible for migration transparency, but the UI must not offer a write action.
CRM_CAPABILITIES: dict[str, dict[str, Any]] = {
    "data_workspace": {"status": "equivalent", "enabled": True},
    "customer_collection": {"status": "adapted", "enabled": True},
    "public_interaction": {"status": "adapted", "enabled": True},
    "threads_community_post": {"status": "adapted", "enabled": True},
    "task_orchestration": {"status": "equivalent", "enabled": True},
    "scheduling": {"status": "adapted", "enabled": True},
    "templates_media": {"status": "equivalent", "enabled": True},
    "analytics_tracking": {"status": "adapted", "enabled": True},
    "account_takeover": {"status": "adapted", "enabled": True},
    "legacy_import": {"status": "adapted", "enabled": True},
    "ai_demand_analysis": {
        "status": "adapted",
        "enabled": True,
    },
    "opc_history_live_query": {
        "status": "adapted",
        "enabled": True,
    },
    "direct_message_batch": {
        "status": "adapted",
        "enabled": True,
    },
    "instagram_group_management": {
        "status": "adapted",
        "enabled": True,
    },
    "relationship_live_verify": {
        "status": "adapted",
        "enabled": True,
    },
    "legacy_ai_secret_config": {
        "status": "blocked",
        "enabled": False,
        "reason_code": "crm_legacy_ai_secrets_not_migrated",
    },
}


def public_capabilities() -> dict[str, dict[str, Any]]:
    return {key: dict(value) for key, value in CRM_CAPABILITIES.items()}

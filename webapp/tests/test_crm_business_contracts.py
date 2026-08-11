from __future__ import annotations

import sqlite3

import pytest

from webapp import db as db_module
from webapp.crm.business import (
    add_pool_members,
    deduplicate_pool_members,
    get_resource_detail,
    list_pool_members,
    list_resources_filtered,
    normalize_list_filters,
    patch_pool_member,
    patch_resource,
    remove_pool_member,
    soft_delete_resource,
)
from webapp.crm.errors import CRMError
from webapp.crm.repository import create_resource


@pytest.fixture()
def business_db(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "app.db"))
    monkeypatch.setenv("WEBAPP_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("CRM_ENABLED", "1")
    db_module.init_db()
    conn = sqlite3.connect(db_module.get_db_path())
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    now = 1_700_000_000
    user_ids = []
    for username in ("tenant_one", "tenant_two"):
        user_ids.append(
            int(
                conn.execute(
                    """
                    INSERT INTO users(username,password_hash,is_admin,is_disabled,approval_status,created_at,updated_at)
                    VALUES (?, 'x', 0, 0, 'approved', ?, ?)
                    """,
                    (username, now, now),
                ).lastrowid
            )
        )
    conn.commit()
    try:
        yield conn, user_ids[0], user_ids[1]
    finally:
        conn.close()


def _lead(conn, user_id: int, lead_id: str, username: str, *, stage: str = "new", platform_key: str = ""):
    return create_resource(
        conn,
        "leads",
        user_id=user_id,
        record_id=lead_id,
        payload={
            "platform": "threads",
            "platform_user_key": platform_key,
            "username": username,
            "display_name": f"Display {username}",
            "stage": stage,
            "tags": [],
            "profile": {},
        },
    )


def _pool(conn, user_id: int, pool_id: str, name: str = "Pool"):
    return create_resource(
        conn,
        "pools",
        user_id=user_id,
        record_id=pool_id,
        payload={"name": name, "description": "", "tags": [], "snapshot": {}},
    )


def test_resource_detail_patch_and_soft_delete_are_tenant_isolated(business_db):
    conn, tenant_one, tenant_two = business_db
    _pool(conn, tenant_one, "pool-one", "One")
    _pool(conn, tenant_two, "pool-two", "Two")
    _lead(conn, tenant_one, "lead-one", "alice")
    add_pool_members(conn, user_id=tenant_one, pool_id="pool-one", lead_ids=["lead-one"])

    assert get_resource_detail(conn, "pools", user_id=tenant_one, record_id="pool-one")["name"] == "One"
    with pytest.raises(CRMError) as hidden:
        get_resource_detail(conn, "pools", user_id=tenant_one, record_id="pool-two")
    assert hidden.value.code == "crm_resource_not_found"

    updated = patch_resource(
        conn,
        "pools",
        user_id=tenant_one,
        record_id="pool-one",
        payload={"name": "Renamed", "tags": ["VIP", "vip", " Warm "]},
    )
    assert updated["name"] == "Renamed"
    assert updated["tags"] == ["VIP", "Warm"]

    with pytest.raises(CRMError) as forbidden:
        patch_resource(
            conn,
            "pools",
            user_id=tenant_one,
            record_id="pool-one",
            payload={"user_id": tenant_two, "active": 0},
        )
    assert forbidden.value.code == "crm_invalid_field"

    deleted = soft_delete_resource(conn, "pools", user_id=tenant_one, record_id="pool-one")
    assert deleted["active"] == 0
    assert conn.execute(
        "SELECT active FROM crm_pool_members WHERE pool_id='pool-one' AND lead_id='lead-one'"
    ).fetchone()["active"] == 0
    with pytest.raises(CRMError):
        get_resource_detail(conn, "pools", user_id=tenant_one, record_id="pool-one")


def test_patch_enforces_same_tenant_references_and_https_destination(business_db):
    conn, tenant_one, tenant_two = business_db
    create_resource(
        conn,
        "media",
        user_id=tenant_one,
        record_id="media-one",
        payload={"storage_path": "1/a.png", "sha256": "a" * 64, "mime_type": "image/png", "size_bytes": 1},
    )
    create_resource(
        conn,
        "media",
        user_id=tenant_two,
        record_id="media-two",
        payload={"storage_path": "2/b.png", "sha256": "b" * 64, "mime_type": "image/png", "size_bytes": 1},
    )
    create_resource(
        conn,
        "templates",
        user_id=tenant_one,
        record_id="template-one",
        payload={"name": "Welcome", "media_ids": [], "content": "hello"},
    )
    with pytest.raises(CRMError) as immutable_storage:
        patch_resource(
            conn,
            "media",
            user_id=tenant_one,
            record_id="media-one",
            payload={"storage_path": "../escape.png"},
        )
    assert immutable_storage.value.code == "crm_invalid_field"
    assert patch_resource(
        conn,
        "templates",
        user_id=tenant_one,
        record_id="template-one",
        payload={"media_ids": ["media-one"]},
    )["media_ids"] == ["media-one"]
    with pytest.raises(CRMError) as cross_tenant:
        patch_resource(
            conn,
            "templates",
            user_id=tenant_one,
            record_id="template-one",
            payload={"media_ids": ["media-two"]},
        )
    assert cross_tenant.value.code == "crm_invalid_tenant_reference"

    create_resource(
        conn,
        "destinations",
        user_id=tenant_one,
        record_id="destination-one",
        payload={"name": "Landing", "url": "https://example.com", "enabled": True},
    )
    with pytest.raises(CRMError) as insecure:
        patch_resource(
            conn,
            "destinations",
            user_id=tenant_one,
            record_id="destination-one",
            payload={"url": "http://example.com"},
        )
    assert insecure.value.code == "crm_destination_https_required"


def test_server_side_filters_are_normalized_whitelisted_and_paginated(business_db):
    conn, tenant_one, tenant_two = business_db
    _lead(conn, tenant_one, "lead-a", "Alice", stage="qualified")
    _lead(conn, tenant_one, "lead-b", "Bob", stage="new")
    _lead(conn, tenant_two, "lead-other", "Alice Other", stage="qualified")

    normalized = normalize_list_filters(
        "leads", {"q": " Alice ", "platform": "THREADS", "stage": "QUALIFIED"}
    )
    assert normalized == {"q": "Alice", "platform": "threads", "stage": "qualified"}
    result = list_resources_filtered(
        conn,
        "leads",
        user_id=tenant_one,
        filters={"q": "Ali", "platform": "THREADS", "stage": "QUALIFIED"},
        limit=1,
    )
    assert [item["id"] for item in result["items"]] == ["lead-a"]
    assert result["filters"]["platform"] == "threads"

    with pytest.raises(CRMError) as unknown:
        normalize_list_filters("leads", {"user_id": tenant_two})
    assert unknown.value.code == "crm_invalid_filter"
    with pytest.raises(CRMError):
        normalize_list_filters("schedules", {"enabled": "yes"})


def test_pool_member_add_dedup_page_patch_remove_and_reactivate(business_db):
    conn, tenant_one, tenant_two = business_db
    _pool(conn, tenant_one, "pool-one")
    _lead(conn, tenant_one, "lead-a", "Alice", stage="new")
    _lead(conn, tenant_one, "lead-b", "Bob", stage="new")
    _lead(conn, tenant_two, "lead-other", "Other", stage="new")

    added = add_pool_members(
        conn,
        user_id=tenant_one,
        pool_id="pool-one",
        lead_ids=["lead-a", "lead-a", "lead-b"],
        source="collection",
    )
    assert added["created"] == ["lead-a", "lead-b"]
    assert added["deduplicated_input_count"] == 1
    replay = add_pool_members(
        conn, user_id=tenant_one, pool_id="pool-one", lead_ids=["lead-a"]
    )
    assert replay["existing"] == ["lead-a"]

    first = list_pool_members(conn, user_id=tenant_one, pool_id="pool-one", limit=1)
    assert len(first["items"]) == 1
    assert first["has_more"] is True
    second = list_pool_members(
        conn, user_id=tenant_one, pool_id="pool-one", limit=1, cursor=first["next_cursor"]
    )
    assert len(second["items"]) == 1
    assert first["items"][0]["lead_id"] != second["items"][0]["lead_id"]

    patched = patch_pool_member(
        conn,
        user_id=tenant_one,
        pool_id="pool-one",
        lead_id="lead-a",
        payload={"status": "contacted", "stage": "warm", "tags": ["VIP", "vip"]},
    )
    assert patched["status"] == "contacted"
    assert patched["lead"]["stage"] == "warm"
    assert patched["lead"]["tags"] == ["VIP"]
    assert list_pool_members(
        conn,
        user_id=tenant_one,
        pool_id="pool-one",
        filters={"q": "ali", "status": "CONTACTED", "stage": "WARM"},
    )["items"][0]["lead_id"] == "lead-a"

    with pytest.raises(CRMError) as cross_tenant:
        add_pool_members(
            conn, user_id=tenant_one, pool_id="pool-one", lead_ids=["lead-other"]
        )
    assert cross_tenant.value.code == "crm_invalid_tenant_reference"
    with pytest.raises(CRMError) as scalar_ids:
        add_pool_members(
            conn, user_id=tenant_one, pool_id="pool-one", lead_ids="lead-a"
        )
    assert scalar_ids.value.code == "crm_invalid_pool_members"

    removed = remove_pool_member(
        conn, user_id=tenant_one, pool_id="pool-one", lead_id="lead-a"
    )
    assert removed["removed"] is True
    reactivated = add_pool_members(
        conn, user_id=tenant_one, pool_id="pool-one", lead_ids=["lead-a"]
    )
    assert reactivated["reactivated"] == ["lead-a"]


def test_pool_identity_dedup_keeps_oldest_membership(business_db):
    conn, tenant_one, _ = business_db
    _pool(conn, tenant_one, "pool-one")
    _lead(conn, tenant_one, "lead-a", "Same_User")
    _lead(conn, tenant_one, "lead-b", "@same_user")
    _lead(conn, tenant_one, "lead-c", "Different")
    add_pool_members(
        conn, user_id=tenant_one, pool_id="pool-one", lead_ids=["lead-a", "lead-b", "lead-c"]
    )
    conn.execute(
        "UPDATE crm_pool_members SET created_at=1 WHERE pool_id='pool-one' AND lead_id='lead-a'"
    )
    conn.execute(
        "UPDATE crm_pool_members SET created_at=2 WHERE pool_id='pool-one' AND lead_id='lead-b'"
    )

    result = deduplicate_pool_members(conn, user_id=tenant_one, pool_id="pool-one")
    assert result == {
        "pool_id": "pool-one",
        "removed_count": 1,
        "duplicates": [{"lead_id": "lead-b", "kept_lead_id": "lead-a"}],
    }
    visible = list_pool_members(conn, user_id=tenant_one, pool_id="pool-one")
    assert {item["lead_id"] for item in visible["items"]} == {"lead-a", "lead-c"}

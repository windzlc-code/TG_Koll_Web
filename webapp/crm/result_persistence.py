from __future__ import annotations

import json
import re
import sqlite3
from typing import Any, Iterable, Mapping
from urllib.parse import urlparse

from .repository import dumps, new_id, now_ts


_USERNAME_RE = re.compile(r"^[A-Za-z0-9._]{1,80}$")
_COLLECTION_RESULT_KEYS = ("leads", "data", "items", "results")


def _object(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    if isinstance(value, str):
        try:
            decoded = json.loads(value)
        except (TypeError, ValueError, json.JSONDecodeError):
            return {}
        return dict(decoded) if isinstance(decoded, Mapping) else {}
    return {}


def _list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    return []


def _username(value: Any) -> str:
    clean = str(value or "").strip().strip("/@").lower()
    return clean if _USERNAME_RE.fullmatch(clean) else ""


def _platform(value: Any, fallback: str = "threads") -> str:
    clean = str(value or "").strip().lower()
    return clean if clean in {"threads", "instagram"} else fallback


def _https_url(value: Any) -> str:
    clean = str(value or "").strip()
    try:
        parsed = urlparse(clean)
    except ValueError:
        return ""
    if parsed.scheme != "https" or not parsed.hostname:
        return ""
    return clean[:1_200]


def _nonnegative_int(value: Any) -> int:
    try:
        return max(int(float(value or 0)), 0)
    except (TypeError, ValueError, OverflowError):
        return 0


def _number(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError, OverflowError):
        return 0.0


def _profile_identity_from_url(value: Any) -> tuple[str, str]:
    url = _https_url(value)
    if not url:
        return "", ""
    parsed = urlparse(url)
    host = str(parsed.hostname or "").lower()
    parts = [part for part in parsed.path.split("/") if part]
    if host == "instagram.com" or host.endswith(".instagram.com"):
        if not parts or parts[0].lower() in {"p", "reel", "reels", "stories", "direct", "explore"}:
            return "", ""
        return "instagram", _username(parts[0])
    if host in {"threads.net", "threads.com"} or host.endswith((".threads.net", ".threads.com")):
        if not parts or not parts[0].startswith("@"):
            return "", ""
        return "threads", _username(parts[0])
    return "", ""


def _candidate_rows(result: Mapping[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for key in _COLLECTION_RESULT_KEYS:
        for item in _list(result.get(key)):
            if isinstance(item, Mapping):
                rows.append(dict(item))
    pool = result.get("pool")
    if isinstance(pool, Mapping):
        for item in _list(pool.get("leads")):
            if isinstance(item, Mapping):
                rows.append(dict(item))
    return rows[:2_000]


def _normalize_candidate(
    raw: Mapping[str, Any],
    *,
    fallback_platform: str,
    source_url: str,
    query: str,
) -> dict[str, Any] | None:
    profile_url = _https_url(raw.get("profile_url") or raw.get("profileUrl"))
    inferred_platform, inferred_username = _profile_identity_from_url(profile_url)
    username = _username(
        raw.get("username")
        or raw.get("user_name")
        or raw.get("userName")
        or raw.get("author_username")
        or raw.get("authorUsername")
        or inferred_username
    )
    if not username:
        return None
    platform = _platform(raw.get("platform") or inferred_platform, fallback_platform)
    if not profile_url:
        profile_url = (
            f"https://www.instagram.com/{username}/"
            if platform == "instagram"
            else f"https://www.threads.com/@{username}"
        )
    candidate_source = _https_url(
        raw.get("source_url")
        or raw.get("sourceUrl")
        or raw.get("post_url")
        or raw.get("postUrl")
        or raw.get("permalink")
        or source_url
    )
    raw_tags = _list(raw.get("tags"))
    audience_tier = str(raw.get("audience_tier") or raw.get("audienceTier") or "").strip().lower()
    if audience_tier not in {"precision", "expanded", "excluded"}:
        audience_tier = ""
    tags = []
    for tag in [
        *raw_tags,
        f"channel:{platform}",
        *([f"keyword:{query}"] if query else []),
        *([f"audience:{audience_tier}"] if audience_tier else []),
    ]:
        clean = str(tag or "").strip()[:120]
        if clean and clean not in tags:
            tags.append(clean)
    return {
        "platform": platform,
        "platform_user_key": username,
        "username": username,
        "display_name": str(raw.get("display_name") or raw.get("displayName") or raw.get("name") or "").strip()[:160],
        "stage": "new",
        "score": _number(raw.get("score")),
        "tags": tags[:100],
        "profile": {
            "profileUrl": profile_url,
            "sourceUrl": candidate_source,
            "keyword": str(raw.get("keyword") or query or "").strip()[:120],
            "text": str(raw.get("text") or raw.get("content") or raw.get("bio") or "").strip()[:3_000],
            "likeCount": _nonnegative_int(raw.get("like_count") or raw.get("likeCount")),
            "replyCount": _nonnegative_int(raw.get("reply_count") or raw.get("replyCount")),
            "repostCount": _nonnegative_int(raw.get("repost_count") or raw.get("repostCount")),
            "audienceTier": audience_tier,
            "audienceReason": str(raw.get("audience_reason") or raw.get("audienceReason") or "").strip()[:160],
            "audienceMatchedGroups": [
                str(item or "").strip()[:120]
                for item in _list(raw.get("audience_matched_groups") or raw.get("audienceMatchedGroups"))[:20]
                if str(item or "").strip()
            ],
            "audienceMatchedKeywords": [
                str(item or "").strip()[:120]
                for item in _list(raw.get("audience_matched_keywords") or raw.get("audienceMatchedKeywords"))[:50]
                if str(item or "").strip()
            ],
        },
    }


def _history_candidates(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    platform: str,
    query: str,
    source_url: str,
    limit: int,
) -> list[dict[str, Any]]:
    """Return only tenant-owned real OPC/imported leads; never invent a lead."""

    rows = conn.execute(
        "SELECT platform,platform_user_key,username,display_name,stage,score,tags_json,profile_json "
        "FROM crm_leads WHERE user_id=? AND active=1 AND import_batch_id<>'' "
        "ORDER BY updated_at DESC,id DESC LIMIT 10000",
        (int(user_id),),
    ).fetchall()
    needle = query.casefold()
    expected_source = source_url.casefold()
    matches: list[dict[str, Any]] = []
    for row in rows:
        row_platform = _platform(row["platform"])
        if platform and row_platform != platform:
            continue
        profile = _object(row["profile_json"])
        tags = [str(item or "") for item in _list(row["tags_json"] if isinstance(row["tags_json"], list) else None)]
        if not tags:
            try:
                tags = [str(item or "") for item in _list(json.loads(str(row["tags_json"] or "[]")))]
            except (TypeError, ValueError, json.JSONDecodeError):
                tags = []
        row_source = str(profile.get("sourceUrl") or profile.get("source_url") or profile.get("permalink") or "")
        haystack = " ".join(
            [str(row["username"] or ""), str(row["display_name"] or ""), str(profile.get("text") or ""), *tags]
        ).casefold()
        if expected_source and row_source.casefold() != expected_source:
            continue
        if needle and needle not in haystack:
            continue
        matches.append(
            {
                "platform": row_platform,
                "platform_user_key": str(row["platform_user_key"] or row["username"] or ""),
                "username": str(row["username"] or ""),
                "display_name": str(row["display_name"] or ""),
                "stage": str(row["stage"] or "new"),
                "score": _number(row["score"]),
                "tags": tags,
                "profile": profile,
                "existing": True,
            }
        )
        if len(matches) >= limit:
            break
    return matches


def _collection_pool(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    workflow_id: str,
    task_id: str,
    title: str,
    query: str,
    source_url: str,
    now: int,
) -> str:
    durable_key = workflow_id or task_id
    existing = conn.execute(
        "SELECT id FROM crm_pools WHERE user_id=? AND legacy_id=? AND active=1 LIMIT 1",
        (int(user_id), durable_key),
    ).fetchone()
    if existing is not None:
        return str(existing["id"])
    pool_id = new_id("crm_pool")
    conn.execute(
        """
        INSERT INTO crm_pools(
          id,user_id,name,description,tags_json,snapshot_json,import_batch_id,active,
          legacy_id,legacy_payload_json,schema_version,created_at,updated_at
        ) VALUES (?,?,?,'Native CRM collection','[]',?,'',1,?,'{}',1,?,?)
        """,
        (
            pool_id,
            int(user_id),
            (title or query or "CRM collection")[:120],
            dumps({"source": "native_collection", "workflow_id": workflow_id, "query": query, "source_url": source_url}),
            durable_key,
            now,
            now,
        ),
    )
    return pool_id


def persist_collection_result(
    conn: sqlite3.Connection,
    *,
    task: Mapping[str, Any],
    payload: Mapping[str, Any],
    result: Mapping[str, Any],
    persisted_at: int | None = None,
) -> dict[str, Any]:
    """Normalize, deduplicate and attach real collection results to one pool."""

    user_id = int(task.get("user_id") or 0)
    if user_id <= 0:
        raise ValueError("collection task has no tenant owner")
    task_id = str(task.get("id") or "")
    workflow_id = str(payload.get("_crm_workflow_id") or "")
    task_type = str(task.get("task_type") or "")
    fallback_platform = _platform(task.get("platform"))
    query = str(payload.get("query") or "").strip()[:120]
    source_url = _https_url(payload.get("target_url") or result.get("url"))
    limit = max(1, min(int(payload.get("limit") or 200), 2_000))
    normalized: list[dict[str, Any]] = []
    for row in _candidate_rows(result):
        candidate = _normalize_candidate(
            row,
            fallback_platform=fallback_platform,
            source_url=source_url,
            query=query,
        )
        if candidate is not None:
            normalized.append(candidate)
    # A requested profile URL is not identity evidence by itself.  The runner
    # must return a DOM-confirmed item; otherwise only tenant-owned imported OPC
    # history may satisfy the collection request.
    if not normalized:
        normalized = _history_candidates(
            conn,
            user_id=user_id,
            platform=fallback_platform,
            query=query,
            source_url=source_url if task_type == "browse_profile" else "",
            limit=limit,
        )

    deduplicated: dict[tuple[str, str], dict[str, Any]] = {}
    for candidate in normalized:
        identity = _username(candidate.get("platform_user_key") or candidate.get("username"))
        if identity:
            key = (_platform(candidate.get("platform")), identity)
            previous = deduplicated.get(key)
            if previous is None:
                deduplicated[key] = candidate
                continue
            merged = dict(previous)
            merged["tags"] = list(
                dict.fromkeys(
                    [
                        *(str(item) for item in previous.get("tags") or []),
                        *(str(item) for item in candidate.get("tags") or []),
                    ]
                )
            )[:100]
            profile = dict(previous.get("profile") or {})
            for field, value in dict(candidate.get("profile") or {}).items():
                if value not in (None, "", [], {}):
                    profile[field] = value
            merged["profile"] = profile
            if not str(merged.get("display_name") or "").strip():
                merged["display_name"] = candidate.get("display_name") or ""
            merged["score"] = max(_number(previous.get("score")), _number(candidate.get("score")))
            deduplicated[key] = merged
    candidates = list(deduplicated.values())[:limit]
    if not candidates:
        return {"pool_id": "", "collected": 0, "new_leads": 0, "new_members": 0, "duplicates_removed": len(normalized)}

    now = int(persisted_at or now_ts())
    workflow = conn.execute(
        "SELECT title FROM crm_workflows WHERE id=? AND user_id=? LIMIT 1",
        (workflow_id, user_id),
    ).fetchone()
    pool_id = _collection_pool(
        conn,
        user_id=user_id,
        workflow_id=workflow_id,
        task_id=task_id,
        title=str(workflow["title"] or "") if workflow else "",
        query=query,
        source_url=source_url,
        now=now,
    )
    new_leads = 0
    new_members = 0
    lead_ids: list[str] = []
    for candidate in candidates:
        member_added = False
        platform = _platform(candidate["platform"])
        identity = _username(candidate["platform_user_key"])
        existing = conn.execute(
            "SELECT id,tags_json,profile_json FROM crm_leads "
            "WHERE user_id=? AND platform=? AND platform_user_key=? AND active=1 LIMIT 1",
            (user_id, platform, identity),
        ).fetchone()
        if existing is None:
            lead_id = new_id("crm_lead")
            conn.execute(
                """
                INSERT INTO crm_leads(
                  id,user_id,platform,platform_user_key,username,display_name,stage,score,
                  tags_json,profile_json,import_batch_id,active,legacy_id,legacy_payload_json,
                  schema_version,created_at,updated_at
                ) VALUES (?,?,?,?,?,?,?, ?,?,?,'',1,'','{}',1,?,?)
                """,
                (
                    lead_id,
                    user_id,
                    platform,
                    identity,
                    _username(candidate["username"]),
                    str(candidate.get("display_name") or "")[:160],
                    str(candidate.get("stage") or "new")[:30],
                    float(candidate.get("score") or 0),
                    dumps(candidate.get("tags") or []),
                    dumps(candidate.get("profile") or {}),
                    now,
                    now,
                ),
            )
            new_leads += 1
        else:
            lead_id = str(existing["id"])
            try:
                old_tags = _list(json.loads(str(existing["tags_json"] or "[]")))
            except (TypeError, ValueError, json.JSONDecodeError):
                old_tags = []
            tags = list(dict.fromkeys([*(str(item) for item in old_tags), *(str(item) for item in candidate.get("tags") or [])]))[:100]
            profile = _object(existing["profile_json"])
            profile.update(candidate.get("profile") or {})
            conn.execute(
                "UPDATE crm_leads SET display_name=CASE WHEN ?<>'' THEN ? ELSE display_name END,"
                "tags_json=?,profile_json=?,updated_at=? WHERE id=? AND user_id=?",
                (
                    str(candidate.get("display_name") or "")[:160],
                    str(candidate.get("display_name") or "")[:160],
                    dumps(tags),
                    dumps(profile),
                    now,
                    lead_id,
                    user_id,
                ),
            )
        lead_ids.append(lead_id)
        membership = conn.execute(
            "SELECT active FROM crm_pool_members WHERE pool_id=? AND lead_id=? AND user_id=?",
            (pool_id, lead_id, user_id),
        ).fetchone()
        if membership is None:
            conn.execute(
                "INSERT INTO crm_pool_members(user_id,pool_id,lead_id,status,source,import_batch_id,active,created_at,updated_at) "
                "VALUES (?,?,?,'active','native_collection','',1,?,?)",
                (user_id, pool_id, lead_id, now, now),
            )
            new_members += 1
            member_added = True
        elif int(membership["active"] or 0) == 0:
            conn.execute(
                "UPDATE crm_pool_members SET active=1,status='active',source='native_collection',updated_at=? "
                "WHERE pool_id=? AND lead_id=? AND user_id=?",
                (now, pool_id, lead_id, user_id),
            )
            new_members += 1
            member_added = True
        event_legacy_id = f"{task_id}:{lead_id}"
        event_exists = conn.execute(
            "SELECT 1 FROM crm_events WHERE user_id=? AND event_type='collection_lead_captured' "
            "AND legacy_id=? AND active=1 LIMIT 1",
            (user_id, event_legacy_id),
        ).fetchone()
        if member_added and event_exists is None:
            conn.execute(
                "INSERT INTO crm_events(id,user_id,lead_id,workflow_id,event_type,occurred_at,payload_json,"
                "import_batch_id,active,legacy_id,legacy_payload_json,schema_version,created_at,updated_at) "
                "VALUES (?,?,?,?, 'collection_lead_captured',?,?,'',1,?,'{}',1,?,?)",
                (
                    new_id("crm_event"),
                    user_id,
                    lead_id,
                    workflow_id,
                    now,
                    dumps({"pool_id": pool_id, "social_task_id": task_id, "source_url": source_url}),
                    event_legacy_id,
                    now,
                    now,
                ),
            )
    total = int(
        conn.execute(
            "SELECT COUNT(*) AS value FROM crm_pool_members WHERE user_id=? AND pool_id=? AND active=1",
            (user_id, pool_id),
        ).fetchone()["value"]
    )
    conn.execute(
        "UPDATE crm_pools SET snapshot_json=?,updated_at=? WHERE id=? AND user_id=?",
        (
            dumps(
                {
                    "source": "native_collection",
                    "workflow_id": workflow_id,
                    "last_social_task_id": task_id,
                    "query": query,
                    "source_url": source_url,
                    "lead_count": total,
                }
            ),
            now,
            pool_id,
            user_id,
        ),
    )
    return {
        "pool_id": pool_id,
        "lead_ids": lead_ids,
        "collected": len(candidates),
        "pool_lead_count": total,
        "new_leads": new_leads,
        "new_members": new_members,
        "duplicates_removed": max(len(normalized) - len(candidates), 0),
    }


def _group_key(result: Mapping[str, Any], payload: Mapping[str, Any]) -> str:
    return str(
        result.get("target_url")
        or result.get("targetUrl")
        or payload.get("target_url")
        or payload.get("targetUrl")
        or ""
    ).strip()[:1_200]


def _members(values: Iterable[Any]) -> list[str]:
    result: list[str] = []
    for value in values:
        if isinstance(value, Mapping):
            value = value.get("username")
        clean = _username(value)
        if clean and clean not in result:
            result.append(clean)
    return result[:100]


def persist_instagram_group_result(
    conn: sqlite3.Connection,
    *,
    task: Mapping[str, Any],
    payload: Mapping[str, Any],
    result: Mapping[str, Any],
    persisted_at: int | None = None,
) -> dict[str, Any]:
    """Project verified Direct group worker truth into ``crm_groups``."""

    user_id = int(task.get("user_id") or 0)
    task_type = str(task.get("task_type") or "")
    workflow_id = str(payload.get("_crm_workflow_id") or "")
    now = int(persisted_at or now_ts())
    key = _group_key(result, payload)
    if not key:
        return {"group_id": "", "persisted": False}
    row = conn.execute(
        "SELECT * FROM crm_groups WHERE user_id=? AND platform='instagram' AND platform_group_key=? AND active=1 LIMIT 1",
        (user_id, key),
    ).fetchone()
    if row is None and task_type != "instagram_group_create":
        return {"group_id": "", "persisted": False}
    if row is None:
        group_id = new_id("crm_group")
        members = _members(result.get("members") or payload.get("members") or [])
        conn.execute(
            "INSERT INTO crm_groups(id,user_id,platform,name,platform_group_key,members_json,status,"
            "import_batch_id,active,legacy_id,legacy_payload_json,schema_version,created_at,updated_at) "
            "VALUES (?,?,'instagram',?,?,?,'active','',1,?,'{}',1,?,?)",
            (
                group_id,
                user_id,
                str(payload.get("group_name") or "")[:100],
                key,
                dumps(members),
                workflow_id,
                now,
                now,
            ),
        )
    else:
        group_id = str(row["id"])
        members = _members(json.loads(str(row["members_json"] or "[]")))
        if task_type == "instagram_group_members_add":
            members = _members([*members, *(result.get("added_members") or result.get("addedMembers") or payload.get("members") or [])])
        name = str(result.get("group_name") or payload.get("group_name") or row["name"] or "")[:100]
        status = "active"
        if task_type == "instagram_group_status_inspect" and result.get("status"):
            status = str(result.get("status"))[:30]
        conn.execute(
            "UPDATE crm_groups SET name=?,members_json=?,status=?,updated_at=? WHERE id=? AND user_id=?",
            (name, dumps(members), status, now, group_id, user_id),
        )
    task_id = str(task.get("id") or "")
    event_exists = conn.execute(
        "SELECT 1 FROM crm_events WHERE user_id=? AND event_type=? AND legacy_id=? AND active=1 LIMIT 1",
        (user_id, task_type, task_id),
    ).fetchone()
    if event_exists is None:
        conn.execute(
            "INSERT INTO crm_events(id,user_id,lead_id,workflow_id,event_type,occurred_at,payload_json,"
            "import_batch_id,active,legacy_id,legacy_payload_json,schema_version,created_at,updated_at) "
            "VALUES (?,?,'',?,?,?,?,'',1,?,'{}',1,?,?)",
            (
                new_id("crm_event"),
                user_id,
                workflow_id,
                task_type,
                now,
                dumps({"group_id": group_id, "platform_group_key": key, "social_task_id": task_id}),
                task_id,
                now,
                now,
            ),
        )
    return {"group_id": group_id, "platform_group_key": key, "members": members, "persisted": True}


__all__ = ["persist_collection_result", "persist_instagram_group_result"]

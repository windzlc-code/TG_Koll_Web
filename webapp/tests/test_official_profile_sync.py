from __future__ import annotations

import hmac
import hashlib
import json
from pathlib import Path
from unittest import mock

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from webapp.bundle_social import verify_webhook_signature
from webapp.bundle_social_config import save_configuration
from webapp.db import db, init_db
from webapp.official_profile_sync import (
    handle_official_auth_webhook,
    sync_official_homepage_metrics,
)
import webapp.server as server


class _Response:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code
        self.ok = 200 <= status_code < 300

    def json(self):
        return self._payload


class _Session:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        return self.responses.pop(0)


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    data_dir = tmp_path / "webapp_data"
    tool_dir = tmp_path / "tool_r18_runtime"
    data_dir.mkdir()
    tool_dir.mkdir()
    monkeypatch.setenv("WEBAPP_DATA_DIR", str(data_dir))
    monkeypatch.setenv("APP_DB_PATH", str(data_dir / "app.db"))
    monkeypatch.setenv("APP_RUNTIME_CONFIG_PATH", str(data_dir / "runtime_config.json"))
    monkeypatch.setenv("TOOL_R18_RUNTIME_DIR", str(tool_dir))
    monkeypatch.setenv("ADMIN_BOOTSTRAP_PASSWORD", "admin123secure")
    monkeypatch.setenv("SESSION_COOKIE_SECURE", "0")
    monkeypatch.setenv("PASSWORD_VAULT_KEY", Fernet.generate_key().decode("ascii"))
    monkeypatch.setenv("HTTPS_CANONICAL_ORIGIN", "https://www.vecto-ai.cn")
    server.RUNTIME_CONFIG_PATH = data_dir / "runtime_config.json"
    server.TOOL_R18_RUNTIME_DIR = tool_dir
    init_db()
    archives = [{
        "id": "persona-1",
        "name": "敏姐",
        "setup": {
            "hotMetrics": {
                "threads:hiro504522": {
                    "platform": "threads",
                    "username": "hiro504522",
                    "accountId": "acct-1",
                    "followers": 0,
                    "likes": 1,
                    "comments": 0,
                    "complete": True,
                    "scope": "authenticated_full_profile",
                    "postMetrics": [{
                        "sourceUrl": "https://www.threads.com/@hiro504522/post/abc",
                        "likeCount": 1,
                        "viewCount": 12,
                    }],
                }
            }
        },
        "publishHistory": [],
    }]
    (tool_dir / "persona_archives.json").write_text(json.dumps(archives), encoding="utf-8")
    with db() as conn:
        conn.execute(
            "INSERT INTO users(id, username, password_hash, is_admin, created_at, updated_at) VALUES (1, 'owner', 'x', 1, 1, 1)"
        )
        save_configuration(
            conn,
            api_base_url="https://api.bundle.social/api/v1",
            api_key="test-key",
            actor_user_id=1,
            webhook_secret="webhook-secret",
            homepage_overlay_enabled=True,
        )
        conn.execute(
            """
            INSERT INTO social_accounts(
              id, user_id, persona_id, platform, username, display_name, profile_dir, proxy_id, status,
              auth_provider, external_team_id, external_account_id, created_at, updated_at
            ) VALUES (?, 1, 'persona-1', 'threads', 'hiro504522', 'hiro', '', '', 'ready', 'bundle', 'team-1', 'sa-1', 1, 1)
            """,
            ("acct-1",),
        )
    return {"tool_dir": tool_dir, "data_dir": data_dir}


def test_verify_webhook_signature_accepts_hex_and_sha256_prefix():
    body = b'{"type":"post.published"}'
    secret = "webhook-secret"
    digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    assert verify_webhook_signature(raw_body=body, signature_header=digest, secret=secret)
    assert verify_webhook_signature(raw_body=body, signature_header=f"sha256={digest}", secret=secret)
    assert not verify_webhook_signature(raw_body=body, signature_header="deadbeef", secret=secret)


def test_homepage_overlay_reads_cached_analytics_and_keeps_post_metrics(runtime, monkeypatch):
    session = _Session([
        _Response({
            "socialAccount": {"id": "sa-1", "type": "THREADS", "teamId": "team-1"},
            "items": [{
                "id": "snap-1",
                "followers": 128,
                "views": 279,
                "likes": 9,
                "comments": 3,
                "postCount": 80,
                "forced": False,
                "updatedAt": "2026-09-05T01:00:00Z",
            }],
        })
    ])

    class _Client:
        def get_social_account_analytics(self, *, team_id, platform):
            assert team_id == "team-1"
            assert platform == "threads"
            return session.request("GET", f"analytics/social-account?teamId={team_id}").json()

    monkeypatch.setattr("webapp.official_profile_sync.BundleSocialClient", lambda timeout_seconds=20: _Client())
    result = sync_official_homepage_metrics(archive_id="persona-1", platform="threads")
    assert result["updated"] == 1
    assert "force" not in str(session.calls).lower()
    archives = json.loads((runtime["tool_dir"] / "persona_archives.json").read_text(encoding="utf-8"))
    metric = archives[0]["setup"]["hotMetrics"]["threads:hiro504522"]
    assert metric["followers"] == 128
    assert metric["recentViews"] == 279
    assert metric["likes"] == 9
    assert metric["comments"] == 3
    assert metric["scope"] == "authenticated_full_profile"
    assert metric["postMetrics"][0]["viewCount"] == 12
    assert metric["homepageSource"] == "official_profile"


def test_webhook_post_published_appends_history_without_import(runtime):
    payload = {
        "type": "post.published",
        "data": {
            "id": "post_1",
            "status": "POSTED",
            "updatedAt": "2026-09-05T02:00:00Z",
            "externalData": {
                "THREADS": {"permalink": "https://www.threads.com/@hiro504522/post/new-1"}
            },
            "data": {"THREADS": {"text": "hello homepage"}},
            "socialAccounts": [{"socialAccount": {"id": "sa-1", "type": "THREADS"}}],
        },
    }
    raw = json.dumps(payload).encode("utf-8")
    signature = hmac.new(b"webhook-secret", raw, hashlib.sha256).hexdigest()
    with mock.patch("webapp.official_profile_sync.sync_official_homepage_metrics", return_value={"updated": 1}):
        result = handle_official_auth_webhook(raw_body=raw, signature_header=signature)
    assert result["ok"] is True
    archives = json.loads((runtime["tool_dir"] / "persona_archives.json").read_text(encoding="utf-8"))
    history = archives[0]["publishHistory"]
    assert history
    assert "new-1" in str(history[0].get("publishedUrl") or "")


def test_webhook_disconnect_marks_account_expired(runtime):
    payload = {
        "type": "social-account.updated",
        "data": {
            "id": "sa-1",
            "type": "THREADS",
            "socialAction": {
                "details": {
                    "code": "REMOTE_DISCONNECT_REAUTH_REQUIRED",
                    "message": "reauth",
                }
            },
        },
    }
    raw = json.dumps(payload).encode("utf-8")
    signature = hmac.new(b"webhook-secret", raw, hashlib.sha256).hexdigest()
    result = handle_official_auth_webhook(raw_body=raw, signature_header=signature)
    assert result["ok"] is True
    import sqlite3
    conn = sqlite3.connect(str(runtime["data_dir"] / "app.db"))
    row = conn.execute("SELECT status FROM social_accounts WHERE id = 'acct-1'").fetchone()
    conn.close()
    assert row[0] == "cookie_expired"


def _insert_publish_task(*, task_id: str, status: str, result: dict, error: str = "") -> None:
    from webapp.db import db

    with db() as conn:
        conn.execute(
            """
            INSERT INTO social_automation_tasks(
              id, user_id, persona_id, account_id, platform, task_type, priority, status,
              scheduled_at, started_at, payload_json, result_json, error, retry_count,
              max_retries, created_by, created_at, updated_at
            ) VALUES (?, 1, 'persona-1', 'acct-1', 'threads', 'publish_post', 50,
                      ?, 1, 1, '{}', ?, ?, 0, 1, 'web', 1, 1)
            """,
            (task_id, status, json.dumps(result, ensure_ascii=False), error),
        )


def test_webhook_post_error_updates_failed_task_without_history_or_overlay(runtime):
    _insert_publish_task(
        task_id="task-fail",
        status="failed",
        result={"bundle_post_id": "post_fail"},
        error="平台已接收任务，但在等待结果时超时",
    )
    _insert_publish_task(
        task_id="task-ok",
        status="success",
        result={
            "bundle_post_id": "post_ok",
            "published_url": "https://www.threads.com/@hiro504522/post/ok-1",
            "status": "POSTED",
        },
    )
    payload = {
        "type": "post.published",
        "data": {
            "id": "post_fail",
            "status": "ERROR",
            "updatedAt": "2026-09-06T04:00:00Z",
            "errorsVerbose": {
                "THREADS": {"userFacingMessage": "内容未通过审核", "errorMessage": "rejected"}
            },
            "socialAccounts": [{"socialAccount": {"id": "sa-1", "type": "THREADS"}}],
        },
    }
    raw = json.dumps(payload).encode("utf-8")
    signature = hmac.new(b"webhook-secret", raw, hashlib.sha256).hexdigest()
    with mock.patch("webapp.official_profile_sync.sync_official_homepage_metrics") as overlay:
        result = handle_official_auth_webhook(raw_body=raw, signature_header=signature)
    assert result["ok"] is True
    overlay.assert_not_called()
    archives = json.loads((runtime["tool_dir"] / "persona_archives.json").read_text(encoding="utf-8"))
    assert archives[0]["publishHistory"] == []
    from webapp.db import db

    with db() as conn:
        failed = conn.execute(
            "SELECT status, error, result_json FROM social_automation_tasks WHERE id = 'task-fail'"
        ).fetchone()
        success = conn.execute(
            "SELECT status, error FROM social_automation_tasks WHERE id = 'task-ok'"
        ).fetchone()
        last = conn.execute(
            "SELECT webhook_last_event_type FROM bundle_social_provider_config WHERE id = 1"
        ).fetchone()
        account = conn.execute("SELECT status FROM social_accounts WHERE id = 'acct-1'").fetchone()
    assert failed["status"] == "failed"
    assert "内容未通过审核" in str(failed["error"] or "")
    stored = json.loads(str(failed["result_json"] or "{}"))
    assert stored["official_publish_error"]
    assert success["status"] == "success"
    assert str(success["error"] or "") == ""
    assert last["webhook_last_event_type"] == "post.published:ERROR"
    assert account["status"] == "ready"


def test_webhook_post_error_marks_reauth_without_touching_success_task(runtime):
    _insert_publish_task(
        task_id="task-expired",
        status="failed",
        result={"bundle_post_id": "post_expired"},
        error="平台已接收任务，但在等待结果时超时",
    )
    payload = {
        "type": "post.published",
        "data": {
            "id": "post_expired",
            "status": "ERROR",
            "updatedAt": "2026-09-06T04:10:00Z",
            "error": "The access token has expired",
            "socialAccounts": [{"socialAccount": {"id": "sa-1", "type": "THREADS"}}],
        },
    }
    raw = json.dumps(payload).encode("utf-8")
    signature = hmac.new(b"webhook-secret", raw, hashlib.sha256).hexdigest()
    with mock.patch("webapp.official_profile_sync.sync_official_homepage_metrics") as overlay:
        result = handle_official_auth_webhook(raw_body=raw, signature_header=signature)
    assert result["ok"] is True
    overlay.assert_not_called()
    from webapp.db import db

    with db() as conn:
        account = conn.execute("SELECT status, last_error FROM social_accounts WHERE id = 'acct-1'").fetchone()
        task = conn.execute("SELECT status FROM social_automation_tasks WHERE id = 'task-expired'").fetchone()
    assert account["status"] == "cookie_expired"
    assert task["status"] == "failed"


def test_webhook_rejects_bad_signature(runtime):
    result = handle_official_auth_webhook(raw_body=b"{}", signature_header="nope")
    assert result["ok"] is False
    assert result["status_code"] == 401


def test_refresh_worker_calls_homepage_overlay_before_http_first():
    worker = Path(server.__file__).read_text(encoding="utf-8")
    v2 = worker[worker.index("def _persona_dashboard_refresh_worker_v2"):]
    overlay_at = v2.index("sync_official_homepage_metrics")
    prefetch_at = v2.index("_prefetch_persona_dashboard_remote_metrics")
    assert overlay_at < prefetch_at
    assert "analytics/social-account/force" not in worker
    client_source = Path(server.ROOT_DIR / "webapp" / "bundle_social.py").read_text(encoding="utf-8")
    assert "analytics/social-account/force" not in client_source
    assert 'f"analytics/social-account?' in client_source


def test_frontend_copy_avoids_third_party_names():
    console = (Path(server.ROOT_DIR) / "webapp/static/assets/console.js").read_text(encoding="utf-8")
    dashboard = (Path(server.ROOT_DIR) / "webapp/static/assets/persona-dashboard.js").read_text(encoding="utf-8")
    admin = (Path(server.ROOT_DIR) / "webapp/static/admin.html").read_text(encoding="utf-8")
    assert "粉丝、热点/浏览、互动来自绑定账号主页" not in console
    assert "persona-profile-platform-metrics-hint" not in console
    assert "先同步账号主页数据，再同步帖文明细。" in dashboard
    for text in (console, dashboard, admin):
        assert "第三方平台" not in text
    assert "不会强制刷新" in admin
    assert 'source: "http_first"' in dashboard
    assert 'source: "http_first"' in console

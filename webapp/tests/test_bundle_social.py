from __future__ import annotations

import threading

import pytest
from cryptography.fernet import Fernet
from starlette.requests import Request

from social_automation import runner
from webapp.bundle_social import BundleSocialClient, BundleSocialError, platform_type
from webapp.bundle_social_config import configuration_status, resolve_configuration, save_configuration
from webapp.db import db, init_db
from webapp import social_automation_api


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


class _Logger:
    def __init__(self):
        self.events = []

    def log(self, *args):
        self.events.append(args)


def test_platform_type_is_exact_and_rejects_unknown():
    assert platform_type("threads") == "THREADS"
    assert platform_type("Instagram") == "INSTAGRAM"
    with pytest.raises(BundleSocialError):
        platform_type("facebook")


def test_portal_link_requests_only_selected_platform():
    session = _Session([_Response({"url": "https://portal.example/authorize"})])
    client = BundleSocialClient(api_key="test-key", api_base="https://api.example/api/v1", session=session)

    url = client.create_portal_link(
        team_id="team-1",
        platform="threads",
        redirect_url="https://vecto.example/callback",
    )

    assert url == "https://portal.example/authorize"
    body = session.calls[0][2]["json"]
    assert body["socialAccountTypes"] == ["THREADS"]
    assert body["expiresIn"] == 15
    assert "instagramConnectionMethod" not in body
    assert session.calls[0][2]["headers"]["x-api-key"] == "test-key"


def test_connection_check_uses_team_list_without_exposing_key():
    session = _Session([_Response({"items": [{"id": "team-1"}], "total": 3})])
    client = BundleSocialClient(api_key="test-key", api_base="https://api.example/api/v1", session=session)

    result = client.list_teams(limit=1)

    assert result == {"items": [{"id": "team-1"}], "count": 3}
    assert session.calls[0][0:2] == ("GET", "https://api.example/api/v1/team/?limit=1&offset=0")


def test_find_social_account_checks_team_and_platform():
    session = _Session(
        [
            _Response(
                [
                    {"id": "wrong", "type": "INSTAGRAM", "teamId": "team-1"},
                    {"id": "right", "type": "THREADS", "teamId": "team-1", "username": "owner"},
                ]
            )
        ]
    )
    client = BundleSocialClient(api_key="test-key", session=session)
    assert client.find_social_account(team_id="team-1", platform="threads")["id"] == "right"


def test_upload_uses_documented_trailing_slash_endpoint(tmp_path):
    media = tmp_path / "photo.jpg"
    media.write_bytes(b"jpeg")
    session = _Session([_Response({"id": "upload-1"})])
    client = BundleSocialClient(api_key="test-key", api_base="https://api.example/api/v1", session=session)

    assert client.upload_file(team_id="team-1", path=media) == "upload-1"
    assert session.calls[0][0:2] == ("POST", "https://api.example/api/v1/upload/")
    assert session.calls[0][2]["data"] == {"teamId": "team-1"}


def test_create_post_uses_selected_platform_and_reference_key():
    session = _Session([_Response({"id": "post-1", "status": "SCHEDULED"})])
    client = BundleSocialClient(api_key="test-key", session=session)

    created = client.create_post(
        team_id="team-1",
        platform="instagram",
        text="hello",
        upload_ids=["upload-1"],
        reference_key="task-1",
    )

    assert created["id"] == "post-1"
    body = session.calls[0][2]["json"]
    assert body["teamId"] == "team-1"
    assert body["socialAccountTypes"] == ["INSTAGRAM"]
    assert body["referenceKey"] == "task-1"
    assert body["data"]["INSTAGRAM"] == {
        "text": "hello",
        "uploadIds": ["upload-1"],
        "type": "POST",
        "autoFitImage": True,
    }


def test_create_comment_uses_imported_post_without_inventing_reference_key():
    session = _Session([_Response({"id": "comment-1", "status": "SCHEDULED"})])
    client = BundleSocialClient(api_key="test-key", session=session)

    created = client.create_comment(
        team_id="team-1",
        platform="threads",
        text="reply",
        imported_post_id="imported-1",
    )

    assert created["id"] == "comment-1"
    body = session.calls[0][2]["json"]
    assert body["socialAccountTypes"] == ["THREADS"]
    assert body["importedPostId"] == "imported-1"
    assert "internalPostId" not in body
    assert "referenceKey" not in body


def test_reply_to_imported_comment_uses_minimal_fetched_parent_payload():
    session = _Session([_Response({"id": "comment-2", "status": "SCHEDULED"})])
    client = BundleSocialClient(api_key="test-key", session=session)

    client.create_comment(
        team_id="team-1",
        platform="threads",
        text="reply",
        imported_post_id="imported-1",
        fetched_parent_comment_id="fetched-1",
    )

    assert session.calls[0][2]["json"] == {
        "teamId": "team-1",
        "fetchedParentCommentId": "fetched-1",
        "text": "reply",
    }


def test_bundle_runner_dispatch_does_not_open_browser(monkeypatch, tmp_path):
    called = {}

    def fake_run_bundle_social_task(**kwargs):
        called.update(kwargs)
        return {"ok": True, "provider": "bundle"}

    monkeypatch.setattr("webapp.bundle_social.run_bundle_social_task", fake_run_bundle_social_task)
    monkeypatch.setattr(
        runner,
        "_open_camoufox_context",
        lambda **_: pytest.fail("Bundle account must not start Camoufox"),
    )
    logger = _Logger()
    result = runner.run_social_task(
        task={
            "id": "task-1",
            "task_type": "publish_post",
            "platform": "threads",
            "payload": {"content": "hello"},
        },
        account={
            "id": "account-1",
            "platform": "threads",
            "auth_provider": "bundle",
            "external_team_id": "team-1",
            "external_account_id": "social-1",
        },
        proxy=None,
        data_dir=tmp_path,
        logger=logger,
        cancel_event=threading.Event(),
    )
    assert result == {"ok": True, "provider": "bundle"}
    assert called["task"]["payload"]["content"] == "hello"
    assert any(event[1] == "bundle_dispatch" for event in logger.events)


def test_bundle_account_storage_migration(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "bundle.db"))
    init_db()
    with db() as conn:
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(social_accounts)")}
        auth_table = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'social_account_auth_requests'"
        ).fetchone()
    assert {"auth_provider", "external_team_id", "external_account_id", "authorized_at"} <= columns
    assert auth_table["name"] == "social_account_auth_requests"


def test_bundle_system_config_is_encrypted_and_used_at_runtime(monkeypatch, tmp_path):
    raw_key = "bundle-secret-key"
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "bundle-config.db"))
    monkeypatch.setenv("PASSWORD_VAULT_KEY", Fernet.generate_key().decode("ascii"))
    monkeypatch.delenv("BUNDLE_SOCIAL_API_KEY", raising=False)
    init_db()

    with db() as conn:
        status = save_configuration(
            conn,
            api_base_url="https://api.bundle.social/api/v1",
            api_key=raw_key,
            actor_user_id=1,
        )
        stored = conn.execute("SELECT * FROM bundle_social_provider_config WHERE id = 1").fetchone()
        resolved = resolve_configuration(conn)
        public_status = configuration_status(conn)

    assert status["configured"] is True
    assert status["verified"] is True
    assert raw_key not in str(stored["api_key_ciphertext"])
    assert resolved["api_key"] == raw_key
    assert "api_key" not in public_status
    client = BundleSocialClient()
    assert client.api_key == raw_key
    assert client.api_base == "https://api.bundle.social/api/v1"


def test_bundle_callback_url_uses_forwarded_public_origin(monkeypatch):
    monkeypatch.delenv("HTTPS_CANONICAL_ORIGIN", raising=False)
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "scheme": "http",
            "server": ("127.0.0.1", 8000),
            "path": "/api/persona_dashboard/automation/accounts/bundle/authorize",
            "headers": [
                (b"host", b"127.0.0.1:8000"),
                (b"x-forwarded-proto", b"https"),
                (b"x-forwarded-host", b"www.vecto-ai.cn"),
            ],
        }
    )

    callback_url = social_automation_api._bundle_callback_url(request, "bundle_auth_1")

    assert callback_url == (
        "https://www.vecto-ai.cn/api/persona_dashboard/automation/accounts/bundle/callback"
        "?request_id=bundle_auth_1"
    )


def test_bundle_callback_url_prefers_server_canonical_origin(monkeypatch):
    monkeypatch.setenv("HTTPS_CANONICAL_ORIGIN", "https://www.vecto-ai.cn")
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "scheme": "http",
            "server": ("127.0.0.1", 8000),
            "path": "/api/persona_dashboard/automation/accounts/bundle/authorize",
            "headers": [(b"host", b"untrusted.example")],
        }
    )

    callback_url = social_automation_api._bundle_callback_url(request, "bundle_auth_2")

    assert callback_url == (
        "https://www.vecto-ai.cn/api/persona_dashboard/automation/accounts/bundle/callback"
        "?request_id=bundle_auth_2"
    )


def test_bundle_callback_persists_only_verified_platform_account(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "callback.db"))
    init_db()
    now = social_automation_api._now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO social_account_auth_requests(
              id, user_id, persona_id, account_id, platform, team_id,
              status, error, expires_at, created_at, updated_at
            ) VALUES ('request-1', 0, '', '', 'threads', 'team-1', 'pending', '', ?, ?, ?)
            """,
            (now + 900, now, now),
        )

    class _Client:
        def find_social_account(self, *, team_id, platform):
            assert (team_id, platform) == ("team-1", "threads")
            return {
                "id": "external-1",
                "type": "THREADS",
                "teamId": "team-1",
                "username": "verified_owner",
                "displayName": "Verified Owner",
            }

    monkeypatch.setattr("webapp.bundle_social.BundleSocialClient", _Client)
    monkeypatch.setattr(social_automation_api, "_identity_user_id", lambda _: 0)
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "scheme": "https",
            "server": ("vecto.example", 443),
            "path": "/api/persona_dashboard/automation/accounts/bundle/callback",
            "query_string": b"request_id=request-1&callback=threads-callback",
            "headers": [],
        }
    )
    response = social_automation_api._finalize_bundle_authorization("request-1", request, {"id": 0})
    with db() as conn:
        account = conn.execute("SELECT * FROM social_accounts").fetchone()
        auth_request = conn.execute("SELECT * FROM social_account_auth_requests WHERE id = 'request-1'").fetchone()
    assert response.status_code == 302
    assert "bundle_auth=success" in response.headers["location"]
    assert account["platform"] == "threads"
    assert account["auth_provider"] == "bundle"
    assert account["external_team_id"] == "team-1"
    assert account["external_account_id"] == "external-1"
    assert auth_request["status"] == "completed"


def test_bundle_callback_reauthorization_reuses_same_external_account(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "reauthorize.db"))
    init_db()
    now = social_automation_api._now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO social_accounts(
              id, user_id, persona_id, platform, username, display_name, profile_dir,
              status, auth_provider, external_team_id, external_account_id,
              authorized_at, created_at, updated_at
            ) VALUES ('account-1', 0, '', 'threads', 'owner', 'Owner', '', 'ready',
                      'bundle', 'team-old', 'external-1', ?, ?, ?)
            """,
            (now, now, now),
        )
        conn.execute(
            """
            INSERT INTO social_account_auth_requests(
              id, user_id, persona_id, account_id, platform, team_id,
              status, error, expires_at, created_at, updated_at
            ) VALUES ('request-2', 0, '', '', 'threads', 'team-new', 'pending', '', ?, ?, ?)
            """,
            (now + 900, now, now),
        )

    class _Client:
        def find_social_account(self, *, team_id, platform):
            return {
                "id": "external-1",
                "type": "THREADS",
                "teamId": team_id,
                "username": "owner",
            }

    monkeypatch.setattr("webapp.bundle_social.BundleSocialClient", _Client)
    monkeypatch.setattr(social_automation_api, "_identity_user_id", lambda _: 0)
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "scheme": "https",
            "server": ("vecto.example", 443),
            "path": "/api/persona_dashboard/automation/accounts/bundle/callback",
            "query_string": b"request_id=request-2&threads-callback=success",
            "headers": [],
        }
    )

    response = social_automation_api._finalize_bundle_authorization("request-2", request, {"id": 0})

    with db() as conn:
        accounts = conn.execute("SELECT * FROM social_accounts").fetchall()
    assert response.status_code == 302
    assert len(accounts) == 1
    assert accounts[0]["id"] == "account-1"
    assert accounts[0]["external_team_id"] == "team-new"

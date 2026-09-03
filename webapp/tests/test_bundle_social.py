from __future__ import annotations

import threading
from urllib.parse import parse_qs, urlparse

import pytest
from cryptography.fernet import Fernet
from fastapi import FastAPI
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


def test_custom_connect_link_requests_only_selected_platform():
    session = _Session([_Response({"url": "https://provider.example/oauth"})])
    client = BundleSocialClient(api_key="test-key", api_base="https://api.example/api/v1", session=session)

    url = client.create_connect_link(
        team_id="team-1",
        platform="threads",
        redirect_url="https://vecto.example/callback",
    )

    assert url == "https://provider.example/oauth"
    assert session.calls[0][0:2] == ("POST", "https://api.example/api/v1/social-account/connect")
    body = session.calls[0][2]["json"]
    assert body["type"] == "THREADS"
    assert "disableAutoLogin" not in body
    assert "instagramConnectionMethod" not in body
    assert "socialAccountTypes" not in body
    assert session.calls[0][2]["headers"]["x-api-key"] == "test-key"


def test_custom_connect_link_uses_direct_instagram_browser_oauth():
    session = _Session([_Response({"url": "https://instagram.example/oauth"})])
    client = BundleSocialClient(api_key="test-key", api_base="https://api.example/api/v1", session=session)

    client.create_connect_link(
        team_id="team-1",
        platform="instagram",
        redirect_url="https://vecto.example/callback",
    )

    body = session.calls[0][2]["json"]
    assert body["type"] == "INSTAGRAM"
    assert body["instagramConnectionMethod"] == "INSTAGRAM"
    assert body["forceBrowserOAuth"] is True


def test_connection_check_uses_team_list_without_exposing_key():
    session = _Session([_Response({"items": [{"id": "team-1"}], "total": 3})])
    client = BundleSocialClient(api_key="test-key", api_base="https://api.example/api/v1", session=session)

    result = client.list_teams(limit=1)

    assert result == {"items": [{"id": "team-1"}], "count": 3}
    assert session.calls[0][0:2] == ("GET", "https://api.example/api/v1/team/?limit=1&offset=0")


def test_provider_social_set_limit_error_is_localized():
    session = _Session([_Response({"message": "Social sets limit reached. Limit is 3 sets."}, status_code=400)])
    client = BundleSocialClient(api_key="test-key", api_base="https://api.example/api/v1", session=session)

    with pytest.raises(BundleSocialError) as exc_info:
        client.create_team("vecto-0-threads-request")

    assert str(exc_info.value) == "平台授权账号集合已达上限（最多 3 个），请完成已有授权后再试"


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


def test_disconnect_social_account_releases_selected_team_slot():
    session = _Session([_Response({"id": "external-1", "type": "THREADS", "teamId": "team-1"})])
    client = BundleSocialClient(api_key="test-key", api_base="https://api.example/api/v1", session=session)

    client.disconnect_social_account(team_id="team-1", platform="threads")

    assert session.calls[0][0:2] == ("DELETE", "https://api.example/api/v1/social-account/disconnect")
    assert session.calls[0][2]["json"] == {"type": "THREADS", "teamId": "team-1"}


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


def test_bundle_callback_url_preserves_admin_account_pool_return(monkeypatch):
    monkeypatch.setenv("HTTPS_CANONICAL_ORIGIN", "https://www.vecto-ai.cn")
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "scheme": "https",
            "server": ("www.vecto-ai.cn", 443),
            "path": "/api/persona_dashboard/automation/accounts/bundle/authorize",
            "headers": [],
        }
    )

    callback_url = social_automation_api._bundle_callback_url(
        request,
        "bundle_auth_admin",
        return_path="/admin-console.html?view=accounts&admin_console=1&admin_workspace_user_id=42",
    )

    parsed = urlparse(callback_url)
    callback_query = parse_qs(parsed.query)
    assert callback_query["request_id"] == ["bundle_auth_admin"]
    assert callback_query["return_path"] == [
        "/admin-console.html?view=accounts&admin_console=1&admin_workspace_user_id=42"
    ]


def test_bundle_console_redirect_keeps_admin_session_boundary():
    response = social_automation_api._bundle_console_redirect(
        status="success",
        platform="threads",
        message="授权成功",
        return_path="/admin-console.html?view=accounts&admin_console=1&admin_workspace_user_id=42",
    )

    parsed = urlparse(response.headers["location"])
    query = parse_qs(parsed.query)
    assert parsed.path == "/bundle-auth-complete.html"
    assert query["bundle_auth"] == ["success"]
    assert query["bundle_platform"] == ["threads"]


def test_bundle_console_redirect_rejects_external_return_path():
    response = social_automation_api._bundle_console_redirect(
        status="error",
        platform="threads",
        return_path="https://attacker.example/admin-console.html?admin_console=1",
    )

    parsed = urlparse(response.headers["location"])
    assert parsed.path == "/bundle-auth-complete.html"
    assert parse_qs(parsed.query)["bundle_auth"] == ["error"]


def test_bundle_authorization_status_is_scoped_to_owner(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "bundle-status.db"))
    init_db()
    now = social_automation_api._now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO social_account_auth_requests(
              id, user_id, persona_id, account_id, platform, team_id,
              status, error, expires_at, created_at, updated_at
            ) VALUES ('request-status', 7, '', 'account-9', 'threads', 'team-9', 'completed', '', ?, ?, ?)
            """,
            (now + 900, now, now),
        )
    monkeypatch.setattr(social_automation_api, "_identity_user_id", lambda _user: 7)
    from fastapi import FastAPI

    app = FastAPI()
    social_automation_api.register_social_automation_routes(app)
    handler = next(
        route.endpoint
        for route in app.routes
        if getattr(route, "path", "") == "/api/persona_dashboard/automation/accounts/bundle/status"
    )
    result = handler(request_id="request-status", user={"id": 7})
    assert result["ok"] is True
    assert result["status"] == "completed"
    assert result["account_id"] == "account-9"
    assert result["platform"] == "threads"


def test_bundle_authorization_return_path_uses_admin_workspace_boundary():
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "scheme": "https",
            "server": ("www.vecto-ai.cn", 443),
            "path": "/api/persona_dashboard/automation/accounts/bundle/authorize",
            "query_string": b"",
            "headers": [(b"x-admin-console", b"1")],
        }
    )

    return_path = social_automation_api._bundle_authorization_return_path(
        request,
        {"id": 1, "_workspace_admin_user_id": 1, "_workspace_user_id": 42},
    )

    assert return_path == (
        "/admin-console.html?view=accounts&admin_console=1&admin_workspace_user_id=42"
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
    response = social_automation_api._finalize_bundle_authorization("request-1", request)
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
            ) VALUES ('request-2', 0, '', 'account-1', 'threads', 'team-new', 'pending', '', ?, ?, ?)
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

    response = social_automation_api._finalize_bundle_authorization("request-2", request)

    with db() as conn:
        accounts = conn.execute("SELECT * FROM social_accounts").fetchall()
    assert response.status_code == 302
    assert len(accounts) == 1
    assert accounts[0]["id"] == "account-1"
    assert accounts[0]["external_team_id"] == "team-new"


def test_bundle_new_authorization_rejects_same_identity_and_releases_team(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "same-identity-new-bundle-id.db"))
    init_db()
    now = social_automation_api._now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO social_accounts(
              id, user_id, persona_id, platform, username, display_name, profile_dir,
              status, auth_provider, external_team_id, external_account_id,
              authorized_at, created_at, updated_at
            ) VALUES ('account-existing', 0, 'persona-1', 'threads', 'same_owner',
                      'Old Name', 'profiles/old', 'ready', 'bundle', 'team-old',
                      'external-old', ?, ?, ?)
            """,
            (now, now, now),
        )
        conn.execute(
            """
            INSERT INTO social_account_auth_requests(
              id, user_id, persona_id, account_id, platform, team_id,
              status, error, expires_at, created_at, updated_at
            ) VALUES ('request-upgrade', 0, 'persona-1', '', 'threads', 'team-new',
                      'pending', '', ?, ?, ?)
            """,
            (now + 900, now, now),
        )

    disconnected = []

    class _Client:
        def find_social_account(self, *, team_id, platform):
            assert (team_id, platform) == ("team-new", "threads")
            return {
                "id": "external-new",
                "type": "THREADS",
                "teamId": team_id,
                "username": "same_owner",
                "displayName": "Current Name",
            }

        def disconnect_social_account(self, *, team_id, platform):
            disconnected.append((team_id, platform))

    monkeypatch.setattr("webapp.bundle_social.BundleSocialClient", _Client)
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "scheme": "https",
            "server": ("vecto.example", 443),
            "path": "/api/persona_dashboard/automation/accounts/bundle/callback",
            "query_string": b"request_id=request-upgrade&threads-callback=success",
            "headers": [],
        }
    )

    response = social_automation_api._finalize_bundle_authorization("request-upgrade", request)

    with db() as conn:
        accounts = conn.execute("SELECT * FROM social_accounts").fetchall()
        auth_request = conn.execute(
            "SELECT account_id, status FROM social_account_auth_requests WHERE id = 'request-upgrade'"
        ).fetchone()
    assert response.status_code == 302
    assert "bundle_auth=error" in response.headers["location"]
    assert "%E5%B7%B2%E5%AD%98%E5%9C%A8" in response.headers["location"]
    assert len(accounts) == 1
    assert accounts[0]["id"] == "account-existing"
    assert accounts[0]["auth_provider"] == "bundle"
    assert accounts[0]["external_team_id"] == "team-old"
    assert accounts[0]["external_account_id"] == "external-old"
    assert accounts[0]["username"] == "same_owner"
    assert accounts[0]["display_name"] == "Old Name"
    assert (auth_request["account_id"], auth_request["status"]) == ("", "failed")
    assert disconnected == [("team-new", "threads")]


def test_bundle_callback_route_does_not_require_console_session():
    app = FastAPI()
    social_automation_api.register_social_automation_routes(app)
    callback = next(
        route
        for route in app.routes
        if getattr(route, "path", "") == "/api/persona_dashboard/automation/accounts/bundle/callback"
    )

    assert callback.dependant.dependencies == []


def test_bundle_new_account_still_obeys_threads_account_limit(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "account-limit.db"))
    init_db()
    now = social_automation_api._now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO social_accounts(
              id, user_id, persona_id, platform, username, display_name, profile_dir,
              status, created_at, updated_at
            ) VALUES ('account-1', 0, 'persona-1', 'threads', 'first_owner', 'First Owner', '',
                      'ready', ?, ?)
            """,
            (now, now),
        )

    monkeypatch.setattr(social_automation_api, "_identity_user_id", lambda _: 0)
    monkeypatch.setattr(social_automation_api, "_require_persona_reference_access", lambda *_: None)
    monkeypatch.setattr(social_automation_api, "_require_active_owner_user", lambda *_: None)
    monkeypatch.setattr(social_automation_api, "_billing_admin_waived", lambda *_: False)
    monkeypatch.setattr(social_automation_api.commercial_billing, "require_write_access", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(social_automation_api.commercial_billing, "threads_account_limit", lambda *_args, **_kwargs: 1)
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "scheme": "https",
            "server": ("vecto.example", 443),
            "path": "/api/persona_dashboard/automation/accounts/bundle/authorize",
            "query_string": b"",
            "headers": [],
        }
    )

    with pytest.raises(social_automation_api.commercial_billing.BillingError) as exc_info:
        social_automation_api._start_bundle_authorization(
            social_automation_api.BundleAuthorizationPayload(platform="threads", persona_id="persona-1"),
            request,
            {"id": 0},
        )

    assert exc_info.value.code == "THREADS_ACCOUNT_LIMIT"


def test_bundle_authorization_reuses_existing_empty_team(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "reuse-empty-team.db"))
    init_db()
    now = social_automation_api._now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO social_account_auth_requests(
              id, user_id, persona_id, account_id, platform, team_id,
              status, error, expires_at, created_at, updated_at
            ) VALUES ('request-old', 0, '', '', 'threads', 'team-empty', 'failed', 'cancelled', ?, ?, ?)
            """,
            (now - 1, now - 30, now - 20),
        )

    class _Client:
        def list_teams(self, *, limit):
            assert limit == 100
            return {
                "items": [
                    {
                        "id": "team-empty",
                        "name": "vecto-0-threads-oldrequest",
                        "socialAccounts": [],
                    },
                    {
                        "id": "team-connected",
                        "name": "vecto-0-threads-connected",
                        "socialAccounts": [{"id": "social-existing", "type": "THREADS"}],
                    },
                ],
                "count": 2,
            }

        def create_team(self, _name):
            pytest.fail("an existing empty authorization team must be reused")

        def create_connect_link(self, *, team_id, platform, redirect_url):
            assert (team_id, platform) == ("team-empty", "threads")
            assert "request_id=" in redirect_url
            return "https://provider.example/oauth"

    monkeypatch.setattr("webapp.bundle_social.BundleSocialClient", _Client)
    monkeypatch.setattr(social_automation_api, "_identity_user_id", lambda _: 0)
    monkeypatch.setattr(social_automation_api, "_require_active_owner_user", lambda *_: None)
    monkeypatch.setattr(social_automation_api, "_billing_admin_waived", lambda *_: True)
    monkeypatch.setattr(
        social_automation_api.commercial_billing,
        "require_write_access",
        lambda *_args, **_kwargs: None,
    )
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "scheme": "https",
            "server": ("vecto.example", 443),
            "path": "/api/persona_dashboard/automation/accounts/bundle/authorize",
            "query_string": b"",
            "headers": [],
        }
    )

    result = social_automation_api._start_bundle_authorization(
        social_automation_api.BundleAuthorizationPayload(platform="threads"),
        request,
        {"id": 0},
    )

    with db() as conn:
        current = conn.execute(
            "SELECT team_id, status FROM social_account_auth_requests WHERE id = ?",
            (result["request_id"],),
        ).fetchone()
        previous = conn.execute(
            "SELECT status FROM social_account_auth_requests WHERE id = 'request-old'",
        ).fetchone()
    assert result["url"] == "https://provider.example/oauth"
    assert result["flow"] == "live_window"
    assert result["live_window"] is True
    assert str(result["task_id"] or "").startswith("social_task_")
    assert (current["team_id"], current["status"]) == ("team-empty", "pending")
    assert previous["status"] == "superseded"


def test_bundle_authorization_reuses_unbound_provider_empty_team(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "reuse-provider-empty-team.db"))
    init_db()

    class _Client:
        def list_teams(self, *, limit):
            assert limit == 100
            return {
                "items": [{"id": "team-provider-empty", "name": "test", "socialAccounts": []}],
                "count": 1,
            }

        def create_team(self, _name):
            pytest.fail("an unbound provider empty team must be reused before creating another team")

        def create_connect_link(self, *, team_id, platform, redirect_url):
            assert (team_id, platform) == ("team-provider-empty", "threads")
            assert "request_id=" in redirect_url
            return "https://provider.example/oauth"

    monkeypatch.setattr("webapp.bundle_social.BundleSocialClient", _Client)
    monkeypatch.setattr(social_automation_api, "_identity_user_id", lambda _: 0)
    monkeypatch.setattr(social_automation_api, "_require_active_owner_user", lambda *_: None)
    monkeypatch.setattr(social_automation_api, "_billing_admin_waived", lambda *_: True)
    monkeypatch.setattr(
        social_automation_api.commercial_billing,
        "require_write_access",
        lambda *_args, **_kwargs: None,
    )
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "scheme": "https",
            "server": ("vecto.example", 443),
            "path": "/api/persona_dashboard/automation/accounts/bundle/authorize",
            "query_string": b"",
            "headers": [],
        }
    )

    result = social_automation_api._start_bundle_authorization(
        social_automation_api.BundleAuthorizationPayload(platform="threads"),
        request,
        {"id": 0},
    )

    with db() as conn:
        current = conn.execute(
            "SELECT team_id, status FROM social_account_auth_requests WHERE id = ?",
            (result["request_id"],),
        ).fetchone()
    assert result["url"] == "https://provider.example/oauth"
    assert (current["team_id"], current["status"]) == ("team-provider-empty", "pending")


def test_bundle_callback_reuses_single_legacy_account_with_same_username(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "reuse-legacy-account.db"))
    init_db()
    now = social_automation_api._now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO social_accounts(
              id, user_id, persona_id, platform, username, display_name, profile_dir,
              status, auth_provider, external_team_id, external_account_id,
              authorized_at, created_at, updated_at
            ) VALUES ('legacy-account', 0, 'persona-old', 'threads', 'same_owner', 'Same Owner', '',
                      'needs_login', 'browser', '', '', 0, ?, ?)
            """,
            (now, now),
        )
        conn.execute(
            """
            INSERT INTO social_account_auth_requests(
              id, user_id, persona_id, account_id, platform, team_id,
              status, error, expires_at, created_at, updated_at
            ) VALUES ('request-reuse-legacy', 0, '', '', 'threads', 'team-new', 'pending', '', ?, ?, ?)
            """,
            (now + 900, now, now),
        )

    class _Client:
        def find_social_account(self, *, team_id, platform):
            assert (team_id, platform) == ("team-new", "threads")
            return {
                "id": "external-new",
                "type": "THREADS",
                "teamId": team_id,
                "username": "same_owner",
            }

    monkeypatch.setattr("webapp.bundle_social.BundleSocialClient", _Client)
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "scheme": "https",
            "server": ("vecto.example", 443),
            "path": "/api/persona_dashboard/automation/accounts/bundle/callback",
            "query_string": b"request_id=request-reuse-legacy&threads-callback=success",
            "headers": [],
        }
    )

    response = social_automation_api._finalize_bundle_authorization("request-reuse-legacy", request)

    with db() as conn:
        accounts = conn.execute(
            "SELECT id, auth_provider, external_team_id, external_account_id, status FROM social_accounts"
        ).fetchall()
    assert response.status_code == 302
    assert len(accounts) == 1
    assert dict(accounts[0]) == {
        "id": "legacy-account",
        "auth_provider": "bundle",
        "external_team_id": "team-new",
        "external_account_id": "external-new",
        "status": "ready",
    }


def test_bundle_new_authorization_keeps_existing_persona_account(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "multiple-accounts.db"))
    init_db()
    now = social_automation_api._now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO social_accounts(
              id, user_id, persona_id, platform, username, display_name, profile_dir,
              status, auth_provider, external_team_id, external_account_id,
              authorized_at, created_at, updated_at
            ) VALUES ('account-1', 0, 'persona-1', 'threads', 'first_owner', 'First Owner', '', 'ready',
                      'bundle', 'team-old', 'external-1', ?, ?, ?)
            """,
            (now, now, now),
        )
        conn.execute(
            """
            INSERT INTO social_account_auth_requests(
              id, user_id, persona_id, account_id, platform, team_id,
              status, error, expires_at, created_at, updated_at
            ) VALUES ('request-3', 0, 'persona-1', '', 'threads', 'team-new', 'pending', '', ?, ?, ?)
            """,
            (now + 900, now, now),
        )

    class _Client:
        def find_social_account(self, *, team_id, platform):
            assert (team_id, platform) == ("team-new", "threads")
            return {
                "id": "external-2",
                "type": "THREADS",
                "teamId": team_id,
                "username": "second_owner",
            }

    monkeypatch.setattr("webapp.bundle_social.BundleSocialClient", _Client)
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "scheme": "https",
            "server": ("vecto.example", 443),
            "path": "/api/persona_dashboard/automation/accounts/bundle/callback",
            "query_string": b"request_id=request-3&threads-callback=success",
            "headers": [],
        }
    )

    response = social_automation_api._finalize_bundle_authorization("request-3", request)

    with db() as conn:
        accounts = conn.execute(
            "SELECT id, username, external_account_id FROM social_accounts ORDER BY created_at, id"
        ).fetchall()
    assert response.status_code == 302
    assert "bundle_account_id=" in response.headers["location"]
    assert len(accounts) == 2
    assert (accounts[0]["id"], accounts[0]["username"], accounts[0]["external_account_id"]) == (
        "account-1", "first_owner", "external-1",
    )
    assert accounts[1]["id"] != "account-1"
    assert (accounts[1]["username"], accounts[1]["external_account_id"]) == (
        "second_owner", "external-2",
    )


def test_oauth_flow_presentation_only_asks_for_authorize_inputs():
    credentials = runner._bundle_oauth_assistance_presentation({
        "status": "cookie_expired",
        "oauth_flow": True,
        "reason": "请填写要添加的平台账号和密码，然后点击授权。",
    })
    consent = runner._bundle_oauth_assistance_presentation({
        "status": "oauth_consent",
        "oauth_flow": True,
        "reason": "账号已就绪，请确认授权。",
    })
    success = runner._bundle_oauth_assistance_presentation({
        "status": "ready",
        "oauth_flow": True,
        "reason": "平台账号已授权",
    })

    assert credentials["kind"] == "credentials"
    assert credentials["submit_label"] == "授权"
    assert "账号" in credentials["title"]
    assert consent["kind"] == "choice"
    assert consent["submit_label"] == "授权"
    assert success["kind"] == "success"
    assert success["title"] == "授权成功"


def test_regular_login_assistance_keeps_original_copy_during_oauth_support():
    credentials = runner._login_assistance_presentation({
        "status": "cookie_expired",
        "reason": "自动登录未成功，请人工输入账号和密码。",
    })
    success = runner._login_assistance_presentation({"status": "ready"})

    assert credentials["title"] == "需要登录信息"
    assert credentials["submit_label"] == "提交并继续"
    assert success["title"] == "登录成功"


def test_bundle_oauth_result_from_complete_url():
    success = runner._bundle_oauth_result_from_url(
        "https://www.vecto-ai.cn/bundle-auth-complete.html?bundle_auth=success&bundle_platform=threads&bundle_account_id=acc-1&bundle_message=ok"
    )
    error = runner._bundle_oauth_result_from_url(
        "https://www.vecto-ai.cn/bundle-auth-complete.html?bundle_auth=error&bundle_message=denied"
    )
    ignored = runner._bundle_oauth_result_from_url("https://www.threads.com/login/")

    assert success == {
        "status": "success",
        "platform": "threads",
        "message": "ok",
        "account_id": "acc-1",
    }
    assert error["status"] == "error"
    assert ignored is None


def test_bundle_authorization_starts_isolated_live_window_task(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "live-window-auth.db"))
    init_db()

    class _Client:
        def list_teams(self, *, limit):
            return {"items": [{"id": "team-live", "name": "vecto-0-threads-live", "socialAccounts": []}], "count": 1}

        def create_team(self, _name):
            pytest.fail("should reuse empty team")

        def create_connect_link(self, *, team_id, platform, redirect_url):
            assert team_id == "team-live"
            assert platform == "threads"
            assert "request_id=" in redirect_url
            return "https://provider.example/oauth"

    monkeypatch.setattr("webapp.bundle_social.BundleSocialClient", _Client)
    monkeypatch.setattr(social_automation_api, "_identity_user_id", lambda _: 0)
    monkeypatch.setattr(social_automation_api, "_require_active_owner_user", lambda *_: None)
    monkeypatch.setattr(social_automation_api, "_billing_admin_waived", lambda *_: True)
    monkeypatch.setattr(
        social_automation_api.commercial_billing,
        "require_write_access",
        lambda *_args, **_kwargs: None,
    )
    woken = []
    monkeypatch.setattr(social_automation_api, "wake_social_automation_worker", lambda: woken.append(True))
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "scheme": "https",
            "server": ("vecto.example", 443),
            "path": "/api/persona_dashboard/automation/accounts/bundle/authorize",
            "query_string": b"",
            "headers": [],
        }
    )

    result = social_automation_api._start_bundle_authorization(
        social_automation_api.BundleAuthorizationPayload(platform="threads"),
        request,
        {"id": 0},
    )

    with db() as conn:
        task = conn.execute(
            "SELECT task_type, account_id, payload_json, status FROM social_automation_tasks WHERE id = ?",
            (result["task_id"],),
        ).fetchone()
        host = conn.execute(
            "SELECT username, display_name FROM social_accounts WHERE id = ?",
            (task["account_id"],),
        ).fetchone()
    payload = __import__("json").loads(task["payload_json"])
    assert result["flow"] == "live_window"
    assert result["live_window"] is True
    assert woken == [True]
    assert task["task_type"] == "bundle_oauth"
    assert task["status"] == "queued"
    assert str(task["account_id"]).startswith("oauth_host_")
    assert host is None
    assert payload["oauth_url"] == "https://provider.example/oauth"
    assert payload["bundle_request_id"] == result["request_id"]
    assert payload["manual_takeover"] is True


def test_bundle_reauthorization_keeps_task_attached_to_existing_account(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "existing-account-auth.db"))
    init_db()

    class _Client:
        def create_connect_link(self, *, team_id, platform, redirect_url):
            assert team_id == "team-existing"
            assert platform == "threads"
            assert "request_id=" in redirect_url
            return "https://provider.example/oauth"

    monkeypatch.setattr("webapp.bundle_social.BundleSocialClient", _Client)
    monkeypatch.setattr(social_automation_api, "_identity_user_id", lambda _: 0)
    monkeypatch.setattr(social_automation_api, "_require_active_owner_user", lambda *_: None)
    monkeypatch.setattr(social_automation_api, "_billing_admin_waived", lambda *_: True)
    monkeypatch.setattr(
        social_automation_api.commercial_billing,
        "require_write_access",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(social_automation_api, "wake_social_automation_worker", lambda: None)
    now = social_automation_api._now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO social_accounts(
              id, user_id, persona_id, platform, username, display_name, profile_dir,
              status, auth_provider, external_team_id, external_account_id,
              created_at, updated_at
            ) VALUES ('account-existing', 0, '', 'threads', 'existing', 'Existing', '',
                      'ready', 'bundle', 'team-existing', 'external-existing', ?, ?)
            """,
            (now, now),
        )
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "scheme": "https",
            "server": ("vecto.example", 443),
            "path": "/api/persona_dashboard/automation/accounts/bundle/authorize",
            "query_string": b"",
            "headers": [],
        }
    )

    result = social_automation_api._start_bundle_authorization(
        social_automation_api.BundleAuthorizationPayload(
            platform="threads",
            account_id="account-existing",
        ),
        request,
        {"id": 0},
    )

    with db() as conn:
        task = conn.execute(
            "SELECT account_id FROM social_automation_tasks WHERE id = ?",
            (result["task_id"],),
        ).fetchone()
    assert task["account_id"] == "account-existing"
    assert result["account_id"] == "account-existing"


def test_bundle_oauth_host_account_reuses_saved_login_credentials(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "oauth-host-credentials.db"))
    init_db()
    now = social_automation_api._now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO social_accounts(
              id, user_id, persona_id, platform, username, display_name, profile_dir,
              status, login_username, login_password, created_at, updated_at
            ) VALUES ('account-login', 0, '', 'threads', 'profile_name', 'Profile', '',
                      'pending_login', 'login@example.com', 'secret-value', ?, ?)
            """,
            (now, now),
        )

    account = social_automation_api._bundle_oauth_host_account(
        {"id": "task-login", "account_id": "account-login", "user_id": 0, "platform": "threads"}
    )

    assert account["id"] == "account-login"
    assert account["username"] == "profile_name"
    assert account["login_username"] == "login@example.com"
    assert account["login_password"] == "secret-value"


def test_bundle_oauth_queues_saved_credentials_once(monkeypatch):
    import queue

    actions = queue.Queue(maxsize=2)
    control = {"login_assistance_queue": actions}
    monkeypatch.setattr(runner, "_mapped_login_credentials", lambda _page: (object(), object(), object(), object()))

    assert runner._queue_bundle_oauth_saved_credentials(
        object(),
        {"login_username": "login@example.com", "login_password": "secret-value"},
        control,
    ) is True
    assert runner._queue_bundle_oauth_saved_credentials(
        object(),
        {"login_username": "login@example.com", "login_password": "secret-value"},
        control,
    ) is False
    assert actions.get_nowait() == {
        "kind": "credentials",
        "login_username": "login@example.com",
        "login_password": "secret-value",
    }


def test_bundle_oauth_browser_uses_and_removes_one_time_profile(monkeypatch, tmp_path):
    profile_dir = tmp_path / "one-time-oauth-profile"
    captured = {}

    class _Page:
        url = "https://vecto.example/bundle-auth-complete.html?bundle_auth=success&bundle_account_id=account-new"

        def goto(self, *_args, **_kwargs):
            return None

    class _Context:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    def _open_context(*, account, **_kwargs):
        captured.update(account)
        return _Context()

    def _make_profile(*_args, **_kwargs):
        profile_dir.mkdir()
        return str(profile_dir)

    monkeypatch.setattr(runner.tempfile, "mkdtemp", _make_profile)
    monkeypatch.setattr(runner, "_open_camoufox_context", _open_context)
    monkeypatch.setattr(runner, "_first_page", lambda _context: _Page())
    monkeypatch.setattr(runner, "_sync_live_browser_viewport", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(runner, "_publish_login_assistance_state", lambda *_args, **_kwargs: None)

    result = runner.run_bundle_oauth_browser_task(
        task={
            "id": "task-new",
            "platform": "threads",
            "payload": {"oauth_url": "https://provider.example/oauth"},
        },
        account={"username": "官方授权", "profile_dir": "shared-profile-must-not-be-used"},
        proxy=None,
        data_dir=tmp_path,
        logger=_Logger(),
        context_control={"live_browser_session_id": "live-task-new"},
    )

    assert result["ok"] is True
    assert result["account_id"] == "account-new"
    assert captured["profile_dir"] == str(profile_dir)
    assert captured["profile_dir"] != "shared-profile-must-not-be-used"
    assert not profile_dir.exists()


def test_bundle_task_cancel_releases_pending_authorization(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "cancel-bundle-auth.db"))
    init_db()
    calls = []

    class _Client:
        def disconnect_social_account(self, *, team_id, platform):
            calls.append((team_id, platform))

    monkeypatch.setattr("webapp.bundle_social.BundleSocialClient", _Client)
    monkeypatch.setattr(social_automation_api, "wake_social_automation_worker", lambda: None)
    monkeypatch.setattr(social_automation_api, "_force_stop_running_task", lambda _task_id: None)
    now = social_automation_api._now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO social_account_auth_requests(
              id, user_id, persona_id, account_id, platform, team_id,
              status, error, expires_at, created_at, updated_at
            ) VALUES ('request-cancel', 0, '', '', 'threads', 'team-cancel', 'pending', '', ?, ?, ?)
            """,
            (now + 900, now, now),
        )
        conn.execute(
            """
            INSERT INTO social_automation_tasks(
              id, user_id, persona_id, account_id, platform, task_type, priority, status,
              scheduled_at, payload_json, result_json, max_retries, created_at, updated_at
            ) VALUES ('task-cancel', 0, '', 'oauth_host_request-cancel', 'threads', 'bundle_oauth',
                      10, 'queued', 0, ?, '{}', 0, ?, ?)
            """,
            ('{"bundle_request_id":"request-cancel"}', now, now),
        )

    social_automation_api.cancel_social_task("task-cancel")

    with db() as conn:
        request_row = conn.execute(
            "SELECT status FROM social_account_auth_requests WHERE id = 'request-cancel'"
        ).fetchone()
    assert request_row["status"] == "cancelled"
    assert calls == [("team-cancel", "threads")]


def test_deleting_bundle_account_clears_authorization_record(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DB_PATH", str(tmp_path / "delete-bundle-account.db"))
    init_db()
    calls = []

    class _Client:
        def disconnect_social_account(self, *, team_id, platform):
            calls.append((team_id, platform))

    monkeypatch.setattr("webapp.bundle_social.BundleSocialClient", _Client)
    monkeypatch.setattr(social_automation_api, "wake_social_automation_worker", lambda: None)
    now = social_automation_api._now()
    with db() as conn:
        conn.execute(
            """
            INSERT INTO social_accounts(
              id, user_id, persona_id, platform, username, display_name, profile_dir,
              status, auth_provider, external_team_id, external_account_id,
              created_at, updated_at
            ) VALUES ('account-delete', 0, '', 'threads', 'owner', 'Owner', '',
                      'ready', 'bundle', 'team-delete', 'external-delete', ?, ?)
            """,
            (now, now),
        )
        conn.execute(
            """
            INSERT INTO social_account_auth_requests(
              id, user_id, persona_id, account_id, platform, team_id,
              status, error, expires_at, created_at, updated_at
            ) VALUES ('request-delete', 0, '', 'account-delete', 'threads', 'team-delete',
                      'completed', '', ?, ?, ?)
            """,
            (now + 900, now, now),
        )

    assert social_automation_api.delete_social_account("account-delete") == 1

    with db() as conn:
        request_row = conn.execute(
            "SELECT id FROM social_account_auth_requests WHERE id = 'request-delete'"
        ).fetchone()
    assert request_row is None
    assert calls == [("team-delete", "threads")]

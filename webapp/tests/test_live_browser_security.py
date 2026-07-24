import asyncio
import json
from http.cookies import SimpleCookie
from types import SimpleNamespace
from unittest import mock
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request
from starlette.responses import Response

from social_automation import live_browser
from webapp import social_automation_api
from webapp.auth import get_current_user


def test_live_browser_view_uses_stable_non_threaded_decoder():
    session = live_browser.LiveBrowserSession(
        id="live-task-1",
        task_id="task-1",
        account_id="account-1",
        account_username="account",
        platform="threads",
        task_type="publish_post",
        display=":90",
        width=1600,
        height=900,
        vnc_port=5900,
        web_port=6900,
        started_at=1,
    )

    public = live_browser._session_public(session)
    query = parse_qs(urlsplit(public["view_path"]).query)

    assert query["enable_threading"] == ["0"]
    assert query["enable_webp"] == ["1"]
    assert query["video_quality"] == ["1"]


def test_live_browser_admin_ticket_preserves_subresource_auth_for_only_one_session():
    request = Request({
        "type": "http",
        "method": "GET",
        "scheme": "https",
        "path": "/api/persona_dashboard/automation/browser_sessions/session-a/kasm",
        "query_string": b"admin_console=1&admin_workspace_user_id=42",
        "headers": [(b"cookie", b"admin_session_token=admin-token")],
        "server": ("testserver", 443),
        "client": ("127.0.0.1", 1234),
    })
    request.state.live_browser_use_admin_session = True
    request.state.live_browser_workspace_user_id = "42"
    response = Response()
    social_automation_api._set_live_browser_access_cookie(response, request, "session-a")
    cookie = SimpleCookie()
    cookie.load(response.headers["set-cookie"])
    access_token = cookie[social_automation_api._LIVE_BROWSER_ACCESS_COOKIE].value

    subresource = SimpleNamespace(
        query_params={},
        headers={},
        cookies={
            "admin_session_token": "admin-token",
            social_automation_api._LIVE_BROWSER_ACCESS_COOKIE: access_token,
        },
    )
    assert social_automation_api._live_browser_auth_selection(subresource, "session-a") == (
        "admin-token",
        True,
        "42",
    )
    assert social_automation_api._live_browser_auth_selection(subresource, "session-b") == ("", False, None)


def _set_encodings(*encodings: int) -> bytes:
    return bytes((2, 0)) + len(encodings).to_bytes(2, "big") + b"".join(
        encoding.to_bytes(4, "big", signed=True) for encoding in encodings
    )


def _client_fence(payload: bytes) -> bytes:
    return bytes((248, 0, 0, 0)) + bytes(4) + bytes((len(payload),)) + payload


def _set_desktop_size(screen_count: int = 1) -> bytes:
    return bytes((251, 0, 6, 64, 3, 132, screen_count, 0)) + bytes(16 * screen_count)


def test_rfb_inspector_allows_handshake_and_non_input_messages():
    inspector = social_automation_api._RfbClientMessageInspector()

    assert inspector.requires_input_permission(b"RFB 003.008\n") is False
    assert inspector.requires_input_permission(b"\x01") is False
    assert inspector.requires_input_permission(b"\x01") is False

    set_pixel_format = bytes((0, 0, 0, 0)) + bytes(16)
    framebuffer_request = bytes((3, 0)) + bytes(8)
    assert inspector.requires_input_permission(set_pixel_format + _set_encodings(0, -223) + framebuffer_request) is False


def test_rfb_inspector_allows_novnc_and_kasm_non_input_extensions():
    inspector = social_automation_api._RfbClientMessageInspector(handshake_complete=True)
    continuous_updates = bytes((150, 1)) + bytes(8)
    request_stats = bytes((178, 0, 0, 0))
    frame_stats = bytes((179, 0, 0, 0)) + bytes(8)
    video_encoders = bytes((184, 2)) + bytes(8)
    keep_alive = bytes((185,))
    max_video_resolution = bytes((252, 3, 192, 2, 28))
    framebuffer_request = bytes((3, 0)) + bytes(8)

    payload = (
        continuous_updates
        + _client_fence(b"sync")
        + _set_desktop_size(2)
        + request_stats
        + frame_stats
        + video_encoders
        + keep_alive
        + max_video_resolution
        + framebuffer_request
    )

    assert inspector.requires_input_permission(payload) is False


def test_rfb_inspector_blocks_qemu_extended_key_event_alone_or_combined():
    extended_key = bytes((255, 0, 0, 1)) + (65).to_bytes(4, "big") + (30).to_bytes(4, "big")
    non_input_prefix = bytes((150, 1)) + bytes(8) + _client_fence(b"")

    assert social_automation_api._RfbClientMessageInspector(handshake_complete=True).requires_input_permission(extended_key) is True
    assert social_automation_api._RfbClientMessageInspector(handshake_complete=True).requires_input_permission(non_input_prefix + extended_key) is True


@pytest.mark.parametrize(
    "payload",
    [
        bytes((4, 1, 0, 0, 0, 0, 0, 65)),
        bytes((5, 1, 0, 10, 0, 20)),
        bytes((6, 0, 0, 0, 0, 0, 0, 3)) + b"abc",
        bytes((3, 0)) + bytes(8) + bytes((5, 0, 0, 1, 0, 2)),
    ],
)
def test_rfb_inspector_detects_input_in_single_or_combined_messages(payload):
    inspector = social_automation_api._RfbClientMessageInspector(handshake_complete=True)

    assert inspector.requires_input_permission(payload) is True


@pytest.mark.parametrize(
    "payload",
    [
        bytes((0, 0, 0)),
        bytes((2, 0, 0, 2)) + bytes(4),
        bytes((3, 0, 0)),
        bytes((4, 1)),
        bytes((5, 0, 0)),
        bytes((6, 0, 0, 0, 0, 0, 0, 4)) + b"abc",
        bytes((150, 1, 0)),
        bytes((248, 0, 0, 0, 0, 0, 0, 0, 4)) + b"abc",
        bytes((251, 0, 0, 10, 0, 10, 1, 0)) + bytes(15),
        bytes((255, 0, 0)),
    ],
)
def test_rfb_inspector_fails_closed_for_known_truncated_messages(payload):
    inspector = social_automation_api._RfbClientMessageInspector(handshake_complete=True)

    assert inspector.requires_input_permission(payload) is True


def test_input_permission_queries_every_time_off_event_loop():
    async def exercise():
        with mock.patch.object(asyncio, "to_thread", new=mock.AsyncMock(side_effect=[True, False])) as to_thread:
            first = await social_automation_api._live_browser_input_allowed("task-1")
            second = await social_automation_api._live_browser_input_allowed("task-1")
        return first, second, to_thread

    first, second, to_thread = asyncio.run(exercise())

    assert (first, second) == (True, False)
    assert to_thread.await_count == 2


def test_open_login_requires_takeover_before_input_is_allowed():
    assert social_automation_api._live_browser_task_input_allowed({
        "status": "running",
        "task_type": "open_login",
        "payload_json": "{}",
    }) is False
    assert social_automation_api._live_browser_task_input_allowed({
        "status": "running",
        "task_type": "open_login",
        "payload_json": '{"auto_submit": true}',
    }) is False
    assert social_automation_api._live_browser_task_input_allowed({
        "status": "running",
        "task_type": "open_login",
        "payload_json": '{"auto_submit": false, "manual_takeover": true}',
    }) is True


def test_auto_login_switched_to_manual_remains_visible_in_overview():
    task = {"task_type": "open_login"}

    assert social_automation_api._is_manual_open_login_task(
        task,
        {"auto_submit": False, "manual_takeover": True},
    ) is False
    assert social_automation_api._is_manual_open_login_task(
        task,
        {"auto_submit": False},
    ) is True


def test_running_auto_login_allows_input_only_after_manual_takeover_acknowledgement():
    request_event = mock.Mock()
    request_event.is_set.return_value = True
    ack_event = mock.Mock()
    ack_event.is_set.return_value = False
    timeout_event = mock.Mock()
    timeout_event.is_set.return_value = False
    with mock.patch.dict(
        social_automation_api._RUNNING_TASK_CONTROLS,
        {"task-1": {
            "manual_takeover_event": request_event,
            "manual_takeover_ack_event": ack_event,
            "manual_takeover_timeout_event": timeout_event,
        }},
        clear=True,
    ):
        row = {
            "id": "task-1",
            "status": "running",
            "task_type": "open_login",
            "payload_json": '{"auto_submit": true}',
        }
        assert social_automation_api._running_task_login_mode("task-1") == "switching"
        assert social_automation_api._live_browser_task_input_allowed(row) is False
        timeout_event.is_set.return_value = True
        assert social_automation_api._running_task_login_mode("task-1") == "takeover_timeout"
        assert social_automation_api._live_browser_open_login_mode(row) == "takeover_timeout"
        ack_event.is_set.return_value = True
        allowed = social_automation_api._live_browser_task_input_allowed(row)
        assert social_automation_api._running_task_login_mode("task-1") == "manual"
        assert social_automation_api._live_browser_open_login_mode(row) == "manual"

    assert allowed is True
    assert social_automation_api._live_browser_task_input_allowed({
        "status": "running",
        "task_type": "publish_post",
        "payload_json": "{}",
    }) is False


def test_live_browser_session_blocks_manual_input_until_camoufox_is_ready():
    row = {
        "status": "running",
        "task_type": "open_login",
        "payload_json": "{}",
    }
    session = {"browser_ready": False}

    session["input_allowed"] = bool(session["browser_ready"]) and social_automation_api._live_browser_task_input_allowed(row)

    assert session["input_allowed"] is False


@pytest.mark.parametrize("auto_submit", [1, 0, "true", "false", None, [], {}])
def test_invalid_auto_submit_values_fail_closed(auto_submit):
    row = {
        "status": "running",
        "task_type": "open_login",
        "payload_json": social_automation_api.json.dumps({"auto_submit": auto_submit}),
    }

    assert social_automation_api._live_browser_task_input_allowed(row) is False
    assert social_automation_api._is_manual_open_login_task(row, {"auto_submit": auto_submit}) is False


def test_invalid_or_damaged_open_login_payload_fails_closed():
    assert social_automation_api._live_browser_task_input_allowed({
        "status": "running",
        "task_type": "open_login",
        "payload_json": "{damaged",
    }) is False


def test_account_confirmation_status_is_allowed_and_ranked_for_account_updates():
    assert "account_confirmation_required" in social_automation_api.SOCIAL_ACCOUNT_STATUSES
    assert social_automation_api._account_dedupe_rank({
        "status": "account_confirmation_required",
        "updated_at": 42,
        "created_at": 1,
    }) == (4, 42)


def _security_test_client() -> TestClient:
    app = FastAPI()
    social_automation_api.register_social_automation_routes(app)
    app.dependency_overrides[get_current_user] = lambda: {"id": "test-user"}
    return TestClient(app)


def test_browser_sessions_strict_lookup_reports_backend_failure():
    with mock.patch.object(live_browser, "list_live_browser_sessions", side_effect=OSError("registry unavailable")):
        with pytest.raises(social_automation_api.HTTPException) as raised:
            social_automation_api._live_browser_sessions(user_id=1, raise_on_error=True)

    assert raised.value.status_code == 503


@pytest.mark.parametrize("auto_submit", [1, "true", "false", None])
def test_open_login_http_rejects_non_boolean_auto_submit(auto_submit):
    client = _security_test_client()
    with (
        mock.patch.object(social_automation_api, "_require_account_access"),
        mock.patch.object(social_automation_api, "create_account_task") as create_task,
    ):
        response = client.post(
            "/api/persona_dashboard/automation/accounts/account-1/open_login",
            json={"auto_submit": auto_submit},
        )

    assert response.status_code == 422
    create_task.assert_not_called()


@pytest.mark.parametrize("payload", [{}, {"auto_submit": True}])
def test_open_login_http_always_starts_in_automatic_mode(payload):
    client = _security_test_client()
    with (
        mock.patch.object(
            social_automation_api,
            "_require_account_access",
            return_value={"login_username": "saved-user", "username": "saved-user", "login_password": "saved-password"},
        ),
        mock.patch.object(
            social_automation_api,
            "create_account_task",
            return_value={"id": "task-1"},
        ) as create_task,
    ):
        response = client.post(
            "/api/persona_dashboard/automation/accounts/account-1/open_login",
            json=payload,
        )

    assert response.status_code == 200
    submitted = create_task.call_args.args[2]
    assert submitted["auto_submit"] is True


def test_open_login_http_rejects_manual_start_mode():
    client = _security_test_client()
    with (
        mock.patch.object(
            social_automation_api,
            "_require_account_access",
            return_value={"login_username": "saved-user", "username": "saved-user", "login_password": "saved-password"},
        ),
        mock.patch.object(social_automation_api, "create_account_task") as create_task,
    ):
        response = client.post(
            "/api/persona_dashboard/automation/accounts/account-1/open_login",
            json={"auto_submit": False},
        )

    assert response.status_code == 409
    create_task.assert_not_called()


def test_generic_task_http_rejects_manual_login_start_mode():
    client = _security_test_client()
    with (
        mock.patch.object(social_automation_api, "_require_account_access"),
        mock.patch.object(social_automation_api, "_validate_user_task_media_paths"),
        mock.patch.object(social_automation_api, "_create_social_task_for_user") as create_task,
    ):
        response = client.post(
            "/api/persona_dashboard/automation/tasks",
            json={
                "persona_id": "persona-1",
                "account_id": "account-1",
                "platform": "threads",
                "task_type": "open_login",
                "payload": {"auto_submit": False},
            },
        )

    assert response.status_code == 409
    create_task.assert_not_called()


def test_generic_task_http_rejects_automatic_login_without_effective_credentials():
    client = _security_test_client()
    with (
        mock.patch.object(
            social_automation_api,
            "_require_account_access",
            return_value={"login_username": "", "username": "", "login_password": ""},
        ),
        mock.patch.object(social_automation_api, "_validate_user_task_media_paths"),
        mock.patch.object(social_automation_api, "_create_social_task_for_user") as create_task,
    ):
        response = client.post(
            "/api/persona_dashboard/automation/tasks",
            json={
                "persona_id": "persona-1",
                "account_id": "account-1",
                "platform": "threads",
                "task_type": "open_login",
                "payload": {"auto_submit": True},
            },
        )

    assert response.status_code == 409
    create_task.assert_not_called()


def test_live_browser_mode_endpoint_requests_manual_takeover():
    client = _security_test_client()
    with (
        mock.patch.object(social_automation_api, "_require_live_browser_session_access"),
        mock.patch.object(
            social_automation_api,
            "request_live_browser_manual_takeover",
            return_value={"task_id": "task-1", "session_id": "live-task-1", "mode": "manual"},
        ) as takeover,
    ):
        response = client.post(
            "/api/persona_dashboard/automation/browser_sessions/live-task-1/mode",
            json={"mode": "manual"},
        )

    assert response.status_code == 200
    assert response.json()["mode"] == "manual"
    takeover.assert_called_once_with("live-task-1")


def test_late_manual_takeover_ack_is_persisted_by_watcher():
    ack_event = mock.Mock()
    ack_event.wait.return_value = True
    with mock.patch.object(social_automation_api, "_persist_manual_takeover_ack") as persist:
        social_automation_api._await_and_persist_manual_takeover_ack("task-1", "live-task-1", ack_event)

    ack_event.wait.assert_called_once_with(timeout=30.0)
    persist.assert_called_once_with("task-1", "live-task-1")


def test_manual_takeover_watcher_exposes_timeout_and_allows_retry():
    ack_event = mock.Mock()
    ack_event.wait.return_value = False
    timeout_event = mock.Mock()
    control = {
        "manual_takeover_ack_event": ack_event,
        "manual_takeover_timeout_event": timeout_event,
        "manual_takeover_ack_watcher_started": True,
    }
    with mock.patch.dict(social_automation_api._RUNNING_TASK_CONTROLS, {"task-1": control}, clear=True):
        social_automation_api._await_and_persist_manual_takeover_ack("task-1", "live-task-1", ack_event)

    timeout_event.set.assert_called_once_with()
    assert control["manual_takeover_ack_watcher_started"] is False


def test_manual_takeover_request_does_not_block_waiting_for_runner_ack():
    event = mock.Mock()
    ack_event = mock.Mock()
    ack_event.is_set.return_value = False
    timeout_event = mock.Mock()
    control = {
        "live_browser_session_id": "live-task-1",
        "manual_takeover_event": event,
        "manual_takeover_ack_event": ack_event,
        "manual_takeover_timeout_event": timeout_event,
        "takeover_waiting_for": "threads_before_submit",
    }
    connection = mock.Mock()
    connection.execute.return_value.fetchone.return_value = {
        "id": "task-1",
        "status": "running",
        "task_type": "open_login",
    }
    database = mock.MagicMock()
    database.return_value.__enter__.return_value = connection

    with (
        mock.patch.dict(social_automation_api._RUNNING_TASK_CONTROLS, {"task-1": control}, clear=True),
        mock.patch.object(social_automation_api, "db", database),
        mock.patch.object(social_automation_api, "_persist_manual_takeover_ack") as persist,
        mock.patch.object(social_automation_api.threading, "Thread") as thread,
    ):
        result = social_automation_api.request_live_browser_manual_takeover("live-task-1")

    event.set.assert_called_once_with()
    ack_event.wait.assert_not_called()
    persist.assert_not_called()
    thread.return_value.start.assert_called_once_with()
    assert result["mode"] == "switching"
    assert result["acknowledged"] is False
    assert result["takeover_waiting_for"] == "threads_before_submit"


def test_manual_takeover_remains_available_after_task_enters_need_manual():
    event = mock.Mock()
    ack_event = mock.Mock()
    ack_event.is_set.side_effect = [False, True]
    timeout_event = mock.Mock()
    control = {
        "live_browser_session_id": "live-task-1",
        "manual_takeover_event": event,
        "manual_takeover_ack_event": ack_event,
        "manual_takeover_timeout_event": timeout_event,
    }
    connection = mock.Mock()
    connection.execute.return_value.fetchone.return_value = {
        "id": "task-1",
        "status": "need_manual",
        "task_type": "open_login",
    }
    database = mock.MagicMock()
    database.return_value.__enter__.return_value = connection

    with (
        mock.patch.dict(social_automation_api._RUNNING_TASK_CONTROLS, {"task-1": control}, clear=True),
        mock.patch.object(social_automation_api, "db", database),
        mock.patch.object(social_automation_api, "_persist_manual_takeover_ack") as persist,
    ):
        result = social_automation_api.request_live_browser_manual_takeover("live-task-1")

    event.set.assert_called_once_with()
    ack_event.set.assert_called_once_with()
    persist.assert_called_once_with("task-1", "live-task-1")
    assert result["mode"] == "manual"
    assert result["acknowledged"] is True


def test_manual_takeover_endpoint_accepts_running_publish_task():
    event = mock.Mock()
    ack_event = mock.Mock()
    ack_event.is_set.return_value = False
    timeout_event = mock.Mock()
    control = {
        "live_browser_session_id": "live-publish-1",
        "manual_takeover_event": event,
        "manual_takeover_ack_event": ack_event,
        "manual_takeover_timeout_event": timeout_event,
    }
    connection = mock.Mock()
    connection.execute.return_value.fetchone.return_value = {
        "id": "publish-task-1",
        "status": "running",
        "task_type": "publish_post",
    }
    database = mock.MagicMock()
    database.return_value.__enter__.return_value = connection

    with (
        mock.patch.dict(social_automation_api._RUNNING_TASK_CONTROLS, {"publish-task-1": control}, clear=True),
        mock.patch.object(social_automation_api, "db", database),
        mock.patch.object(social_automation_api.threading, "Thread") as thread,
    ):
        result = social_automation_api.request_live_browser_manual_takeover("live-publish-1")

    event.set.assert_called_once_with()
    thread.return_value.start.assert_called_once_with()
    assert result["mode"] == "switching"
    assert result["acknowledged"] is False


def test_need_manual_status_overrides_stale_running_control_mode():
    request_event = mock.Mock()
    request_event.is_set.return_value = False
    ack_event = mock.Mock()
    ack_event.is_set.return_value = False
    timeout_event = mock.Mock()
    timeout_event.is_set.return_value = True
    row = {
        "id": "task-1",
        "status": "need_manual",
        "task_type": "open_login",
        "payload_json": '{"auto_submit": false, "manual_takeover": true}',
    }

    with mock.patch.dict(
        social_automation_api._RUNNING_TASK_CONTROLS,
        {"task-1": {
            "manual_takeover_event": request_event,
            "manual_takeover_ack_event": ack_event,
            "manual_takeover_timeout_event": timeout_event,
        }},
        clear=True,
    ):
        assert social_automation_api._live_browser_open_login_mode(row) == "manual"


def test_manual_task_recovery_never_guesses_success_or_requeues_recent_task():
    connection = mock.Mock()
    connection.execute.return_value.fetchall.return_value = []
    database = mock.MagicMock()
    database.return_value.__enter__.return_value = connection

    with (
        mock.patch.dict(social_automation_api._RUNNING_TASK_CONTROLS, {}, clear=True),
        mock.patch.object(social_automation_api, "db", database),
    ):
        social_automation_api._recover_orphaned_manual_task(10_000)

    statements = "\n".join(str(call.args[0]) for call in connection.execute.call_args_list)
    assert "a.status = 'ready'" not in statements
    assert "SET status = 'success'" not in statements
    assert "SET status = 'queued'" not in statements
    assert "updated_at < ?" in statements


@pytest.mark.parametrize(
    ("payload_json", "expected_status"),
    [
        ("{}", 409),
        ('{"auto_submit": false}', 409),
        ('{"auto_submit": false, "manual_takeover": true}', 200),
        ('{"auto_submit": true}', 409),
        ('{"auto_submit": 1}', 409),
    ],
)
def test_http_text_input_enforces_live_task_permission(payload_json, expected_status):
    client = _security_test_client()
    connection = mock.Mock()
    connection.execute.return_value.fetchone.return_value = {
        "status": "running",
        "task_type": "open_login",
        "payload_json": payload_json,
    }
    database = mock.MagicMock()
    database.return_value.__enter__.return_value = connection

    with (
        mock.patch.object(
            social_automation_api,
            "_RUNNING_TASK_CONTROLS",
            {"task-1": {"live_browser_session_id": "live_task-1"}},
        ),
        mock.patch.object(social_automation_api, "db", database),
        mock.patch.object(
            social_automation_api,
            "_type_live_browser_session_text_via_display",
            return_value={"typed": True},
        ) as type_text,
        mock.patch.object(social_automation_api, "_require_live_browser_session_access"),
    ):
        response = client.post(
            "/api/persona_dashboard/automation/browser_sessions/live_task-1/type",
            json={"text": "123456"},
        )

    assert response.status_code == expected_status
    assert type_text.called is (expected_status == 200)


def test_running_control_lookup_supports_live_browser_screenshots():
    control = {
        "task": {"id": "task-1"},
        "live_browser_session_id": "live-task-1",
    }
    with mock.patch.dict(
        social_automation_api._RUNNING_TASK_CONTROLS,
        {"task-1": control},
        clear=True,
    ):
        assert social_automation_api._running_control_for_live_browser_session("live-task-1") is control
        assert social_automation_api._running_control_for_live_browser_session("live-missing") is None


def test_websocket_rfb_input_is_blocked_when_task_permission_is_denied():
    key_event = bytes((4, 1, 0, 0, 0, 0, 0, 65))

    class BrowserSocket:
        def __init__(self):
            self.headers = {}
            self.messages = [
                {"type": "websocket.receive", "bytes": key_event},
                {"type": "websocket.disconnect"},
            ]

        async def accept(self, **_kwargs):
            return None

        async def receive(self):
            return self.messages.pop(0)

        async def close(self, **_kwargs):
            return None

    class TargetSocket:
        def __init__(self):
            self.send = mock.AsyncMock()

        async def recv(self):
            await asyncio.Event().wait()

        async def close(self):
            return None

    browser = BrowserSocket()
    target = TargetSocket()

    with (
        mock.patch.object(
            live_browser,
            "get_live_browser_session",
            return_value=SimpleNamespace(web_port=6901, task_id="task-1"),
        ),
        mock.patch.dict(
            "sys.modules",
            {"websockets": SimpleNamespace(connect=mock.AsyncMock(return_value=target))},
        ),
        mock.patch.object(
            social_automation_api,
            "_live_browser_input_allowed",
            new=mock.AsyncMock(return_value=False),
        ) as input_allowed,
    ):
        asyncio.run(social_automation_api._proxy_live_browser_websocket(browser, "live_task-1"))

    input_allowed.assert_awaited_once_with("task-1")
    target.send.assert_not_awaited()


def test_websocket_auth_resolves_admin_workspace_query():
    websocket = SimpleNamespace(
        cookies={"admin_session_token": "admin-session"},
        headers={},
        query_params={"admin_workspace_user_id": "42"},
    )
    resolved = {"id": 1, "is_admin": 1, "_workspace_user_id": 42}

    with mock.patch.object(
        social_automation_api,
        "get_current_user_for_session",
        return_value=resolved,
    ) as authenticate:
        user = social_automation_api._authenticate_live_browser_websocket(websocket)

    assert user == resolved
    authenticate.assert_called_once_with(
        "admin-session",
        expected_admin_session=True,
        admin_workspace_user_id="42",
        request=None,
    )


def test_websocket_auth_never_falls_back_from_customer_to_admin_cookie():
    websocket = SimpleNamespace(
        cookies={"session_token": "customer-session", "admin_session_token": "admin-session"},
        headers={},
        query_params={},
    )
    customer = {"id": 20, "is_admin": 0}
    admin = {"id": 1, "is_admin": 1}

    with (
        mock.patch.object(
            social_automation_api,
            "get_current_user_for_session",
            side_effect=[customer, admin],
        ) as authenticate,
        mock.patch.object(
            social_automation_api,
            "_live_browser_session_accessible",
            side_effect=lambda _session_id, user: int(user.get("is_admin") or 0) == 1,
        ),
    ):
        user = social_automation_api._authenticate_live_browser_websocket(websocket, "other-customer-session")

    assert user is None
    authenticate.assert_called_once_with(
        "customer-session",
        expected_admin_session=False,
        admin_workspace_user_id=None,
        request=None,
    )


def test_websocket_explicit_admin_context_never_falls_back_to_customer_cookie():
    websocket = SimpleNamespace(
        cookies={"session_token": "customer-session", "admin_session_token": "expired-admin-session"},
        headers={},
        query_params={"admin_console": "1"},
    )

    with mock.patch.object(
        social_automation_api,
        "get_current_user_for_session",
        side_effect=RuntimeError("expired admin session"),
    ) as authenticate:
        user = social_automation_api._authenticate_live_browser_websocket(websocket, "target-session")

    assert user is None
    authenticate.assert_called_once_with(
        "expired-admin-session",
        expected_admin_session=True,
        admin_workspace_user_id=None,
        request=None,
    )


def test_admin_workspace_websocket_audit_uses_actor_and_target_ids():
    connection = mock.MagicMock()
    database = mock.MagicMock()
    database.return_value.__enter__.return_value = connection
    user = {"id": 1, "is_admin": 1, "_workspace_admin_user_id": 1, "_workspace_user_id": 42}

    with mock.patch.object(social_automation_api, "db", database):
        social_automation_api._audit_admin_live_browser_action(
            user,
            "workspace.browser_session.connect",
            "live_task-1",
        )

    args = connection.execute.call_args.args
    assert args[1][0:3] == (1, "workspace.browser_session.connect", 42)
    assert json.loads(args[1][3]) == {"session_id": "live_task-1"}


def test_admin_workspace_websocket_control_is_audited_once():
    key_event = bytes((4, 1, 0, 0, 0, 0, 0, 65))

    class BrowserSocket:
        headers = {}

        def __init__(self):
            self.messages = [
                {"type": "websocket.receive", "bytes": key_event},
                {"type": "websocket.receive", "bytes": key_event},
                {"type": "websocket.disconnect"},
            ]

        async def accept(self, **_kwargs):
            return None

        async def receive(self):
            return self.messages.pop(0)

        async def close(self, **_kwargs):
            return None

    class TargetSocket:
        def __init__(self):
            self.send = mock.AsyncMock()

        async def recv(self):
            await asyncio.Event().wait()

        async def close(self):
            return None

    user = {"id": 1, "is_admin": 1, "_workspace_admin_user_id": 1, "_workspace_user_id": 42}
    browser = BrowserSocket()
    target = TargetSocket()

    with (
        mock.patch.object(
            live_browser,
            "get_live_browser_session",
            return_value=SimpleNamespace(web_port=6901, task_id="task-1"),
        ),
        mock.patch.dict(
            "sys.modules",
            {"websockets": SimpleNamespace(connect=mock.AsyncMock(return_value=target))},
        ),
        mock.patch.object(
            social_automation_api,
            "_live_browser_input_allowed",
            new=mock.AsyncMock(return_value=True),
        ),
        mock.patch.object(social_automation_api, "_audit_admin_live_browser_action") as audit,
    ):
        asyncio.run(
            social_automation_api._proxy_live_browser_websocket(
                browser,
                "live_task-1",
                user=user,
            )
        )

    assert target.send.await_count == 2
    audit.assert_called_once_with(user, "workspace.browser_session.control", "live_task-1")


def test_stop_restored_registry_session_terminates_processes_before_removal():
    session = live_browser.LiveBrowserSession(
        id="live_task-1",
        task_id="task-1",
        account_id="account-1",
        account_username="user",
        platform="threads",
        task_type="open_login",
        display=":91",
        width=1600,
        height=900,
        vnc_port=5901,
        web_port=6901,
        started_at=1,
        process_pids=[4321],
    )
    events = []

    with (
        mock.patch.object(live_browser, "_load_registry_session", return_value=session),
        mock.patch.object(live_browser, "_terminate_registry_session_processes", side_effect=lambda target: events.append(("terminate", target.id))),
        mock.patch.object(live_browser, "_remove_session_registry", side_effect=lambda session_id: events.append(("remove", session_id))),
    ):
        live_browser.stop_live_browser_session(session.id)

    assert events == [("terminate", session.id), ("remove", session.id)]


def test_same_account_standby_cleanup_stops_registry_sessions():
    rows = {
        "live_old": {"id": "live_old", "account_id": "account-1", "status": "standby"},
        "live_other": {"id": "live_other", "account_id": "account-2", "status": "standby"},
    }

    with (
        mock.patch.object(live_browser, "_read_registry", return_value=rows),
        mock.patch.object(live_browser, "stop_live_browser_session") as stop_session,
    ):
        live_browser._stop_standby_sessions_for_account("account-1")

    stop_session.assert_called_once_with("live_old")


def test_expired_registry_session_uses_process_stopping_cleanup():
    session = live_browser.LiveBrowserSession(
        id="live_expired",
        task_id="expired",
        account_id="account-1",
        account_username="user",
        platform="threads",
        task_type="open_login",
        display=":92",
        width=1600,
        height=900,
        vnc_port=5902,
        web_port=6902,
        started_at=1,
        status="standby",
        close_at=100,
    )

    with (
        mock.patch.object(live_browser, "_load_registry_sessions", return_value=[session]),
        mock.patch.object(live_browser, "_session_processes_alive", return_value=True),
        mock.patch.object(live_browser.time, "time", return_value=101),
        mock.patch.object(live_browser, "stop_live_browser_session") as stop_session,
    ):
        sessions = live_browser.list_live_browser_sessions()

    assert sessions == []
    stop_session.assert_called_once_with(session.id)


def test_starting_session_is_visible_before_kasmvnc_is_ready(tmp_path, monkeypatch):
    monkeypatch.setenv("SOCIAL_AUTOMATION_KASMVNC_WWW_DIR", str(tmp_path))
    session_dir = tmp_path / "session"
    session_dir.mkdir()
    process = mock.Mock()
    process.pid = 4321
    process.poll.return_value = None
    observed = {}
    saved_statuses = []

    def wait_until_ready(session):
        observed["session"] = live_browser._SESSIONS.get(session.id)
        observed["status"] = session.status

    def record_registry(session):
        saved_statuses.append(session.status)

    live_browser._SESSIONS.clear()
    try:
        with (
            mock.patch.object(live_browser, "live_browser_enabled", return_value=True),
            mock.patch.object(live_browser, "_stop_standby_sessions_for_account"),
            mock.patch.object(live_browser, "_cleanup_orphaned_live_browser_processes"),
            mock.patch.object(live_browser.shutil, "which", return_value="/usr/bin/Xvnc"),
            mock.patch.object(live_browser, "_allocate_display_number", return_value=91),
            mock.patch.object(live_browser, "_allocate_tcp_port", return_value=6901),
            mock.patch.object(live_browser.tempfile, "mkdtemp", return_value=str(session_dir)),
            mock.patch.object(live_browser.subprocess, "Popen", return_value=process),
            mock.patch.object(live_browser, "_capture_session_process_identities"),
            mock.patch.object(live_browser, "_wait_for_live_browser_ready", side_effect=wait_until_ready),
            mock.patch.object(live_browser, "_save_session_registry", side_effect=record_registry),
        ):
            session = live_browser.start_live_browser_session(
                task={"id": "publish-1", "task_type": "publish_post", "platform": "threads"},
                account={"id": "account-1", "username": "tester", "platform": "threads"},
            )

        assert observed["session"] is session
        assert observed["status"] == "starting"
        assert saved_statuses == ["starting", "running"]
        assert session.status == "running"
    finally:
        live_browser._SESSIONS.clear()
        session_dir.rmdir()


def test_cancel_without_memory_control_reclaims_registry_session():
    with (
        mock.patch.object(social_automation_api, "_RUNNING_TASK_CONTROLS", {}),
        mock.patch.object(live_browser, "stop_live_browser_sessions_for_task") as stop_for_task,
        mock.patch.object(social_automation_api, "db") as database,
    ):
        database.return_value.__enter__.return_value = mock.Mock()
        social_automation_api._force_stop_running_task("task-1")

    stop_for_task.assert_called_once_with("task-1", timeout_seconds=3.0)

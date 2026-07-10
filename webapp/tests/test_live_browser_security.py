import asyncio
from unittest import mock

import pytest

from social_automation import live_browser
from webapp import social_automation_api


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


def test_cancel_without_memory_control_reclaims_registry_session():
    with (
        mock.patch.object(social_automation_api, "_RUNNING_TASK_CONTROLS", {}),
        mock.patch.object(live_browser, "stop_live_browser_sessions_for_task") as stop_for_task,
        mock.patch.object(social_automation_api, "db") as database,
    ):
        database.return_value.__enter__.return_value = mock.Mock()
        social_automation_api._force_stop_running_task("task-1")

    stop_for_task.assert_called_once_with("task-1")

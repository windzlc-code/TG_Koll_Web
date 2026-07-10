import signal
from unittest import mock

import pytest

from social_automation import live_browser


def _identity(
    *,
    pid: int = 4321,
    boot_id: str = "boot-a",
    start_ticks: str = "100",
    executable: str = "/usr/bin/Xvnc",
    argv0: str = "Xvnc",
    display: str = ":91",
) -> dict[str, object]:
    return {
        "pid": pid,
        "boot_id": boot_id,
        "start_ticks": start_ticks,
        "executable": executable,
        "argv0": argv0,
        "display": display,
    }


def _session(identity: dict[str, object]) -> live_browser.LiveBrowserSession:
    return live_browser.LiveBrowserSession(
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
        process_pids=[int(identity["pid"])],
        process_identities=[identity],
    )


def _current_identity(recorded: dict[str, object], **changes: object) -> dict[str, object]:
    current = dict(recorded)
    current["args"] = [str(recorded["argv0"]), str(recorded["display"]), "-geometry", "1600x900"]
    current.update(changes)
    return current


def test_registry_process_identity_is_preserved_without_live_popen_objects():
    recorded = _identity()
    registry_row = live_browser._session_registry_row(_session(recorded))

    assert registry_row["process_pids"] == [4321]
    assert registry_row["process_identities"] == [recorded]


def test_reused_registry_pid_is_not_signaled_when_start_identity_changed():
    recorded = _identity()
    current = _current_identity(recorded, start_ticks="999")

    with (
        mock.patch.object(live_browser, "_read_process_identity", return_value=current),
        mock.patch.object(live_browser, "_open_process_pidfd", return_value=None),
        mock.patch.object(live_browser, "_send_process_signal") as send_signal,
        mock.patch.object(live_browser.time, "sleep") as sleep,
    ):
        live_browser._terminate_registry_session_processes(_session(recorded))

    send_signal.assert_not_called()
    sleep.assert_not_called()


@pytest.mark.parametrize(
    "current",
    [
        _current_identity(_identity(), argv0="python", args=["python", ":91"]),
        _current_identity(_identity(), args=["Xvnc", ":92"]),
        _current_identity(_identity(), executable="/usr/bin/not-xvnc"),
        _current_identity(_identity(), boot_id="boot-b"),
    ],
)
def test_registry_pid_is_not_signaled_without_exact_xvnc_display_and_boot_identity(current):
    recorded = _identity()

    with (
        mock.patch.object(live_browser, "_read_process_identity", return_value=current),
        mock.patch.object(live_browser, "_open_process_pidfd", return_value=None),
        mock.patch.object(live_browser, "_send_process_signal") as send_signal,
        mock.patch.object(live_browser.time, "sleep") as sleep,
    ):
        live_browser._terminate_registry_session_processes(_session(recorded))

    send_signal.assert_not_called()
    sleep.assert_not_called()


def test_matching_registry_identity_retains_restart_cleanup():
    recorded = _identity()
    current = _current_identity(recorded)

    with (
        mock.patch.object(live_browser, "_read_process_identity", side_effect=[current, current]),
        mock.patch.object(live_browser, "_open_process_pidfd", return_value=None),
        mock.patch.object(live_browser, "_send_process_signal") as send_signal,
        mock.patch.object(live_browser.time, "sleep") as sleep,
    ):
        live_browser._terminate_registry_session_processes(_session(recorded))

    assert send_signal.call_args_list == [
        mock.call(4321, signal.SIGTERM, None),
        mock.call(4321, getattr(signal, "SIGKILL", 9), None),
    ]
    sleep.assert_called_once_with(0.4)


def test_registry_cleanup_does_not_kill_replacement_after_term():
    recorded = _identity()
    original = _current_identity(recorded)
    replacement = _current_identity(recorded, start_ticks="101", argv0="python", args=["python", "worker.py"])

    with (
        mock.patch.object(live_browser, "_read_process_identity", side_effect=[original, replacement]),
        mock.patch.object(live_browser, "_open_process_pidfd", return_value=None),
        mock.patch.object(live_browser, "_send_process_signal") as send_signal,
        mock.patch.object(live_browser.time, "sleep"),
    ):
        live_browser._terminate_registry_session_processes(_session(recorded))

    send_signal.assert_called_once_with(4321, signal.SIGTERM, None)


def test_legacy_registry_pid_without_identity_is_never_signaled():
    session = live_browser._session_from_registry(
        {
            "id": "live_legacy",
            "task_id": "legacy",
            "display": ":91",
            "web_port": 6901,
            "process_pids": [4321],
        }
    )
    assert session is not None
    assert session.process_identities == []

    with (
        mock.patch.object(live_browser, "_read_process_identity") as read_identity,
        mock.patch.object(live_browser, "_open_process_pidfd") as open_pidfd,
        mock.patch.object(live_browser, "_send_process_signal") as send_signal,
    ):
        live_browser._terminate_registry_session_processes(session)

    read_identity.assert_not_called()
    open_pidfd.assert_not_called()
    send_signal.assert_not_called()


def test_process_start_identity_reads_linux_stat_field_22(tmp_path):
    pid = 4321
    process_root = tmp_path / str(pid)
    boot_root = tmp_path / "sys" / "kernel" / "random"
    process_root.mkdir(parents=True)
    boot_root.mkdir(parents=True)
    stat_tail = ["S", *(str(field) for field in range(4, 22)), "98765"]
    (process_root / "stat").write_text(f"{pid} (Xvnc worker) {' '.join(stat_tail)}\n", encoding="utf-8")
    (process_root / "cmdline").write_bytes(b"Xvnc\x00:91\x00-geometry\x001600x900\x00")
    (boot_root / "boot_id").write_text("boot-a\n", encoding="utf-8")

    with mock.patch.object(live_browser.os, "readlink", return_value="/usr/bin/Xvnc"):
        identity = live_browser._read_process_identity(pid, tmp_path)

    assert identity is not None
    assert identity["start_ticks"] == "98765"
    assert identity["boot_id"] == "boot-a"
    assert identity["args"][:2] == ["Xvnc", ":91"]


def test_startup_orphan_cleanup_uses_only_registry_sessions():
    session = _session(_identity())

    with (
        mock.patch.object(live_browser, "_ORPHAN_CLEANUP_DONE", False),
        mock.patch.object(live_browser, "_SESSIONS", {}),
        mock.patch.object(live_browser, "_load_registry_sessions", return_value=[session]),
        mock.patch.object(live_browser, "_terminate_registry_session_processes", return_value=1) as terminate,
        mock.patch.object(live_browser, "_remove_session_registry") as remove_registry,
        mock.patch.object(live_browser.subprocess, "run") as run,
    ):
        live_browser._cleanup_orphaned_live_browser_processes()

    terminate.assert_called_once_with(session)
    remove_registry.assert_called_once_with(session.id)
    run.assert_not_called()


def test_startup_orphan_cleanup_with_no_registry_identity_never_scans_or_kills():
    legacy = _session(_identity())
    legacy.process_identities = []

    with (
        mock.patch.object(live_browser, "_ORPHAN_CLEANUP_DONE", False),
        mock.patch.object(live_browser, "_SESSIONS", {}),
        mock.patch.object(live_browser, "_load_registry_sessions", return_value=[legacy]),
        mock.patch.object(live_browser, "_send_process_signal") as send_signal,
        mock.patch.object(live_browser, "_remove_session_registry") as remove_registry,
        mock.patch.object(live_browser.subprocess, "run") as run,
    ):
        live_browser._cleanup_orphaned_live_browser_processes()

    send_signal.assert_not_called()
    remove_registry.assert_called_once_with(legacy.id)
    run.assert_not_called()

from __future__ import annotations

import subprocess

from social_automation import live_browser


class _SlowExitProcess:
    def __init__(self) -> None:
        self.terminated = False
        self.killed = False
        self.wait_timeouts: list[float] = []

    def poll(self):
        return 0 if self.killed else None

    def terminate(self) -> None:
        self.terminated = True

    def kill(self) -> None:
        self.killed = True

    def wait(self, timeout=None):
        self.wait_timeouts.append(float(timeout or 0))
        if not self.killed:
            raise subprocess.TimeoutExpired("slow-process", timeout)
        return 0


def test_stop_live_browser_session_kills_after_short_terminate_grace():
    process = _SlowExitProcess()
    session = live_browser.LiveBrowserSession(
        id="live-test",
        task_id="task-test",
        account_id="account-test",
        account_username="tester",
        platform="threads",
        task_type="open_login",
        display=":99",
        width=1280,
        height=720,
        vnc_port=5901,
        web_port=6901,
        started_at=1,
        processes=[process],
    )

    live_browser.stop_live_browser_session(session.id, session=session, timeout_seconds=0.25)

    assert process.terminated is True
    assert process.killed is True
    assert process.wait_timeouts
    assert process.wait_timeouts[0] <= 0.06

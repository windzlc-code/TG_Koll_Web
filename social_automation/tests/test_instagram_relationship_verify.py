from __future__ import annotations

from unittest import mock

import pytest

from social_automation import runner


class _Logger:
    def __init__(self) -> None:
        self.rows: list[tuple] = []

    def log(self, level, stage, message, data=None, screenshot_path="") -> None:
        self.rows.append((level, stage, message, data or {}, screenshot_path))


class _Page:
    def __init__(self, inspections: list[dict]) -> None:
        self.url = "https://www.instagram.com/"
        self.inspections = list(inspections)

    def evaluate(self, _script):
        return self.inspections.pop(0)


def _inspection(**overrides):
    result = {
        "senderFollowing": True,
        "senderRequested": False,
        "senderNotFollowing": False,
        "followsSender": True,
        "followingEvidence": "Following",
        "requestedEvidence": "",
        "notFollowingEvidence": "",
        "followsSenderEvidence": "Follows you",
        "unavailable": False,
        "loginWall": False,
        "profileSurface": True,
    }
    result.update(overrides)
    return result


def test_relationship_worker_records_only_proved_status_and_keeps_ambiguous_unknown(tmp_path) -> None:
    page = _Page([_inspection(), _inspection(profileSurface=False)])

    def navigate(current_page, url, *_args):
        current_page.url = url

    with (
        mock.patch.object(runner, "_goto", side_effect=navigate),
        mock.patch.object(runner, "_screenshot", side_effect=lambda *_args: "evidence.png"),
        mock.patch.object(runner.time, "sleep"),
    ):
        result = runner._run_instagram_relationship_verify(
            page,
            {"id": "task-rel"},
            {"username": "Owner.One"},
            {
                "expected_username": "owner.one",
                "target_usernames": ["alpha.user", "beta_user"],
            },
            tmp_path,
            _Logger(),
        )
    assert result["ok"] is True
    assert result["retryable"] is False
    assert result["verified_count"] == 1
    assert result["unknown_count"] == 1
    assert result["results"][0]["status"] == "mutual"
    assert result["results"][0]["evidence"]["sender_follows"] == "Following"
    assert result["results"][1]["status"] == "unknown"
    assert result["results"][1]["reason_code"] == "profile_evidence_incomplete"


def test_relationship_worker_treats_requested_as_unknown_not_following(tmp_path) -> None:
    page = _Page([
        _inspection(
            senderFollowing=False,
            senderRequested=True,
            requestedEvidence="Requested",
        )
    ])
    with (
        mock.patch.object(runner, "_goto", side_effect=lambda current, url, *_args: setattr(current, "url", url)),
        mock.patch.object(runner, "_screenshot", return_value="requested.png"),
        mock.patch.object(runner.time, "sleep"),
    ):
        result = runner._run_instagram_relationship_verify(
            page,
            {"id": "task-requested"},
            {"username": "owner.one"},
            {"target_usernames": ["alpha.user"]},
            tmp_path,
            _Logger(),
        )
    assert result["results"][0]["status"] == "unknown"
    assert result["results"][0]["sender_follows"] is None
    assert result["results"][0]["reason_code"] == "follow_request_pending"


def test_relationship_worker_escalates_login_wall_without_fabricating_results(tmp_path) -> None:
    page = _Page([_inspection(loginWall=True)])
    with (
        mock.patch.object(runner, "_goto", side_effect=lambda current, url, *_args: setattr(current, "url", url)),
        mock.patch.object(runner, "_screenshot", return_value="login.png"),
        mock.patch.object(runner.time, "sleep"),
    ):
        with pytest.raises(runner.NeedManualError) as caught:
            runner._run_instagram_relationship_verify(
                page,
                {"id": "task-login"},
                {"username": "owner.one"},
                {"target_usernames": ["alpha.user"]},
                tmp_path,
                _Logger(),
            )
    assert caught.value.status == "cookie_expired"
    assert caught.value.screenshot_path == "login.png"


def test_relationship_worker_rejects_duplicate_or_mismatched_targets(tmp_path) -> None:
    with pytest.raises(ValueError):
        runner._run_instagram_relationship_verify(
            _Page([]),
            {"id": "task-invalid"},
            {"username": "owner.one"},
            {"expected_username": "other", "target_usernames": ["alpha.user"]},
            tmp_path,
            _Logger(),
        )
    with pytest.raises(ValueError):
        runner._run_instagram_relationship_verify(
            _Page([]),
            {"id": "task-duplicate"},
            {"username": "owner.one"},
            {"target_usernames": ["alpha.user", "alpha.user"]},
            tmp_path,
            _Logger(),
        )

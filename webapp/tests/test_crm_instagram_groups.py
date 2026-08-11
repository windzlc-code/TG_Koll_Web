from __future__ import annotations

from contextlib import ExitStack
from unittest import mock

import pytest

from social_automation import runner
from webapp import social_automation_api
from webapp.crm import instagram_groups
from webapp.crm.repository import action_spec


class _UnknownOutcome(RuntimeError):
    pass


class _Locator:
    def __init__(self) -> None:
        self.values: list[str] = []

    @property
    def last(self):
        return self

    def fill(self, value: str) -> None:
        self.values.append(value)

    def filter(self, **_kwargs):
        return self


class _Page:
    def __init__(self, url: str = instagram_groups.INSTAGRAM_INBOX_URL) -> None:
        self.url = url
        self.input = _Locator()

    def locator(self, *_args, **_kwargs):
        return self.input

    def get_by_role(self, *_args, **_kwargs):
        return self.input


def _run(task_type: str, payload: dict, page: _Page | None = None):
    page = page or _Page()
    guards: list[bool] = []

    def guard(action):
        guards.append(True)
        return action()

    result = instagram_groups.run_instagram_group_task(
        page=page,
        task={"id": "crm-group-task", "task_type": task_type},
        account={"username": "Owner.One"},
        payload=payload,
        screenshot_dir="evidence",
        logger=mock.Mock(),
        navigate=lambda current, url, *_args: setattr(current, "url", url),
        screenshot=lambda *_args, **_kwargs: "evidence.png",
        submission_guard=guard,
        unknown_error_factory=lambda message, _shot: _UnknownOutcome(message),
        manual_error_factory=lambda message, _status, _shot: RuntimeError(message),
        cancel_check=lambda: None,
    )
    return result, guards


def test_all_native_group_workers_are_reachable_from_the_crm_action_contract() -> None:
    for task_type in instagram_groups.SUPPORTED_TASK_TYPES:
        spec = action_spec(task_type)
        assert spec["task_type"] == task_type
        assert spec["platform"] == "instagram"
        assert task_type in social_automation_api._CRM_ACTION_TASK_TYPES
        assert social_automation_api._CRM_ACTION_TO_SOCIAL_TASK[task_type] == task_type
        if task_type in instagram_groups.WRITE_TASK_TYPES:
            assert spec["write"] is True
            assert spec["sku"] == "crm_group_invite_batch"
        else:
            assert spec["write"] is False
            assert spec["sku"] == ""


def test_group_contract_is_registered_in_api_and_runner_without_retries() -> None:
    assert instagram_groups.SUPPORTED_TASK_TYPES <= runner.SUPPORTED_TASK_TYPES
    assert instagram_groups.SUPPORTED_TASK_TYPES <= social_automation_api.SOCIAL_TASK_TYPES
    for task_type in instagram_groups.SUPPORTED_TASK_TYPES:
        assert social_automation_api.SOCIAL_TASK_REQUIRED_PLATFORM[task_type] == "instagram"
        assert instagram_groups.operation_contract(task_type)["max_retries"] == 0
    for task_type in instagram_groups.WRITE_TASK_TYPES:
        assert social_automation_api.social_task_billing_sku("instagram", task_type) == "crm_group_invite_batch"


def test_payload_validation_preserves_legacy_aliases_and_requires_confirmation() -> None:
    clean = instagram_groups.validate_task_payload(
        "instagram_group_settings_update",
        {
            "expectedUsername": "@OWNER.ONE",
            "targetUrl": "https://instagram.com/direct/t/thread-42?ignored=1",
            "groupName": "VIP customers",
            "photoRequested": True,
            "confirmed": True,
        },
        {"username": "owner.one"},
    )
    assert clean == {
        "expected_username": "owner.one",
        "confirmed": True,
        "target_url": "https://www.instagram.com/direct/t/thread-42/",
        "group_name": "VIP customers",
        "photo_requested": True,
    }
    with pytest.raises(ValueError, match="confirmation"):
        instagram_groups.validate_task_payload(
            "instagram_group_create",
            {"members": ["alpha", "beta"]},
            {"username": "owner.one"},
        )
    assert instagram_groups.normalize_conversation_url("https://example.com/direct/t/42/") == ""


def test_candidate_and_recent_inspections_return_observed_evidence_without_writes() -> None:
    search = _Locator()
    with (
        mock.patch.object(instagram_groups, "_wait"),
        mock.patch.object(instagram_groups, "_login_wall", return_value=False),
        mock.patch.object(instagram_groups, "_open_new_message", return_value=True),
        mock.patch.object(instagram_groups, "_recipient_search", return_value=search),
        mock.patch.object(
            instagram_groups,
            "_candidate_evidence",
            side_effect=lambda _page, username: {
                "matchedTexts": [f"@{username}"] if username == "alpha" else [],
                "sample": "recipient search",
            },
        ),
    ):
        result, guards = _run(
            "instagram_group_candidates_inspect",
            {"expected_username": "owner.one", "members": ["alpha", "beta"]},
        )
    assert guards == []
    assert [item["status"] for item in result["results"]] == ["verified", "not_selectable"]
    assert result["expectedUsername"] == "owner.one"
    assert result["results"][0]["visibleMatch"] is True
    assert result["results"][0]["matchedTexts"] == ["@alpha"]
    assert result["screenshot_path"] == "evidence.png"

    with (
        mock.patch.object(instagram_groups, "_wait"),
        mock.patch.object(instagram_groups, "_login_wall", return_value=False),
        mock.patch.object(
            instagram_groups,
            "_conversation_links",
            return_value=[{"url": "https://www.instagram.com/direct/t/77/", "text": "Alpha", "unread": True}],
        ),
    ):
        recent, recent_guards = _run(
            "instagram_recent_conversations_inspect",
            {"expected_username": "owner.one"},
        )
    assert recent_guards == []
    assert recent["count"] == 1
    assert recent["conversations"][0]["unread"] is True


def test_login_wall_escalates_to_manual_takeover_with_evidence() -> None:
    page = _Page()
    with (
        mock.patch.object(instagram_groups, "_wait"),
        mock.patch.object(instagram_groups, "_login_wall", return_value=True),
    ):
        with pytest.raises(RuntimeError, match="login expired"):
            _run(
                "instagram_recent_conversations_inspect",
                {"expected_username": "owner.one"},
                page,
            )


def test_create_uses_three_initial_members_and_defers_the_rest_with_url_evidence() -> None:
    page = _Page()
    selected: list[str] = []

    def select(_page, username: str) -> bool:
        selected.append(username)
        return True

    def click(_groups, **_kwargs) -> bool:
        page.url = "https://www.instagram.com/direct/t/new-thread/"
        return True

    with (
        mock.patch.object(instagram_groups, "_wait"),
        mock.patch.object(instagram_groups, "_login_wall", return_value=False),
        mock.patch.object(instagram_groups, "_open_new_message", return_value=True),
        mock.patch.object(instagram_groups, "_recipient_search", return_value=_Locator()),
        mock.patch.object(instagram_groups, "_select_recipient", side_effect=select),
        mock.patch.object(instagram_groups, "_click_first", side_effect=click),
        mock.patch.object(instagram_groups, "_conversation_links", return_value=[]),
    ):
        result, guards = _run(
            "instagram_group_create",
            {
                "expected_username": "owner.one",
                "confirmed": True,
                "members": ["alpha", "beta", "gamma", "delta"],
            },
            page,
        )
    assert selected == ["alpha", "beta", "gamma"]
    assert result["members"] == selected
    assert result["deferred_members"] == [
        {"username": "delta", "reason": "deferred_after_initial_group_validation"}
    ]
    assert result["target_url"] == "https://www.instagram.com/direct/t/new-thread/"
    assert result["targetUrl"] == result["target_url"]
    assert result["groupCreated"] is True
    assert result["deferredMembers"] == result["deferred_members"]
    assert len(guards) == 1


def test_submitted_create_without_unique_conversation_proof_becomes_unknown() -> None:
    with (
        mock.patch.object(instagram_groups, "_wait"),
        mock.patch.object(instagram_groups, "_login_wall", return_value=False),
        mock.patch.object(instagram_groups, "_open_new_message", return_value=True),
        mock.patch.object(instagram_groups, "_recipient_search", return_value=_Locator()),
        mock.patch.object(instagram_groups, "_select_recipient", return_value=True),
        mock.patch.object(instagram_groups, "_click_first", return_value=True),
        mock.patch.object(instagram_groups, "_conversation_links", return_value=[]),
    ):
        with pytest.raises(_UnknownOutcome, match="no unique Direct conversation URL"):
            _run(
                "instagram_group_create",
                {
                    "expected_username": "owner.one",
                    "confirmed": True,
                    "members": ["alpha", "beta"],
                },
            )


def test_create_preserves_legacy_media_path_and_requires_visible_media_evidence(tmp_path) -> None:
    page = _Page()
    media_path = tmp_path / "group.png"
    media_path.write_bytes(b"image")

    def click(_groups, **_kwargs) -> bool:
        page.url = "https://www.instagram.com/direct/t/media-thread/"
        return True

    with (
        mock.patch.object(instagram_groups, "_wait"),
        mock.patch.object(instagram_groups, "_login_wall", return_value=False),
        mock.patch.object(instagram_groups, "_open_new_message", return_value=True),
        mock.patch.object(instagram_groups, "_recipient_search", return_value=_Locator()),
        mock.patch.object(instagram_groups, "_select_recipient", return_value=True),
        mock.patch.object(instagram_groups, "_click_first", side_effect=click),
        mock.patch.object(instagram_groups, "_conversation_links", return_value=[]),
        mock.patch.object(instagram_groups, "_attach_media", return_value=True),
        mock.patch.object(instagram_groups, "_visible_conversation_media_count", side_effect=[0, 1]),
    ):
        result, guards = _run(
            "instagram_group_create",
            {
                "expectedUsername": "owner.one",
                "confirmed": True,
                "members": ["alpha", "beta"],
                "mediaPath": str(media_path),
            },
            page,
        )
    assert result["media_attached"] is True
    assert result["mediaAttached"] is True
    assert len(guards) == 2


@pytest.mark.parametrize(
    ("task_type", "payload", "patches", "message"),
    [
        (
            "instagram_group_settings_update",
            {
                "expected_username": "owner.one",
                "confirmed": True,
                "target_url": "https://www.instagram.com/direct/t/42/",
                "group_name": "New group",
            },
            {"_open_details": True, "_click_first": True, "_locator_visible": True, "_message_visible": False},
            "not visibly confirmed",
        ),
        (
            "instagram_group_members_add",
            {
                "expected_username": "owner.one",
                "confirmed": True,
                "target_url": "https://www.instagram.com/direct/t/42/",
                "members": ["alpha"],
            },
            {"_open_details": True, "_click_first": True, "_select_recipient": True},
            "not visible in chat details",
        ),
    ],
)
def test_submitted_settings_or_member_change_without_proof_becomes_unknown(
    task_type: str,
    payload: dict,
    patches: dict[str, bool],
    message: str,
) -> None:
    stack = [mock.patch.object(instagram_groups, "_wait"), mock.patch.object(instagram_groups, "_login_wall", return_value=False)]
    stack.extend(mock.patch.object(instagram_groups, name, return_value=value) for name, value in patches.items())
    if task_type == "instagram_group_members_add":
        stack.extend(
            [
                mock.patch.object(instagram_groups, "_recipient_search", return_value=_Locator()),
                mock.patch.object(instagram_groups, "_read_member_evidence", return_value={"memberUsernames": []}),
            ]
        )
    with ExitStack() as exit_stack:
        for patcher in stack:
            exit_stack.enter_context(patcher)
        with pytest.raises(_UnknownOutcome, match=message):
            _run(task_type, payload)


def test_group_post_reuses_open_conversation_and_requires_message_evidence() -> None:
    with (
        mock.patch.object(instagram_groups, "_wait"),
        mock.patch.object(instagram_groups, "_login_wall", return_value=False),
        mock.patch.object(instagram_groups, "_locator_visible", return_value=True),
        mock.patch.object(instagram_groups, "_click_first", return_value=True),
        mock.patch.object(instagram_groups, "_message_visible", return_value=True),
    ):
        result, guards = _run(
            "instagram_group_post",
            {
                "expectedUsername": "owner.one",
                "targetUrl": "https://www.instagram.com/direct/t/42/",
                "text": "Hello group",
                "confirmed": True,
            },
        )
    assert guards == [True]
    assert result["sent"] is True
    assert result["verified"] is True
    assert result["targetUrl"] == "https://www.instagram.com/direct/t/42/"
    assert result["submitEvidence"] == "message_visible"


def test_controls_members_and_status_inspections_keep_read_only_evidence() -> None:
    common = {
        "expected_username": "owner.one",
        "target_url": "https://www.instagram.com/direct/t/42/",
    }
    with (
        mock.patch.object(instagram_groups, "_wait"),
        mock.patch.object(instagram_groups, "_login_wall", return_value=False),
        mock.patch.object(instagram_groups, "_open_details", return_value=True),
        mock.patch.object(instagram_groups, "_read_conversation_controls", return_value={"bodySample": "Seen", "controls": []}),
        mock.patch.object(instagram_groups, "_message_visible", return_value=True),
        mock.patch.object(
            instagram_groups,
            "_read_member_evidence",
            side_effect=[
                {"acceptedMembers": ["alpha"], "acceptanceEvidence": [{"username": "alpha"}]},
                {"memberUsernames": ["owner.one", "alpha"]},
            ],
        ),
    ):
        controls, control_guards = _run(
            "instagram_conversation_controls_inspect",
            {**common, "open_details": True, "open_name_editor": False},
        )
        members, member_guards = _run(
            "instagram_group_members_inspect",
            {**common, "expected_members": ["alpha"]},
        )
        status, status_guards = _run(
            "instagram_group_status_inspect",
            {**common, "message": "hello"},
        )
    assert control_guards == member_guards == status_guards == []
    assert controls["probe_filled"] is False and controls["probe_cleared"] is True
    assert members["member_usernames"] == ["owner.one", "alpha"]
    assert members["accepted_members"] == ["alpha"]
    assert members["memberUsernames"] == members["member_usernames"]
    assert status["delivery_confirmed"] is True
    assert status["read_confirmed"] is True
    assert status["deliveryConfirmed"] is True
    assert status["readConfirmed"] is True

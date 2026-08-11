from __future__ import annotations

import pytest

from social_automation import runner


class _Page:
    url = "https://www.threads.net/@source/post/abc"


def test_public_text_requires_exact_match_after_reload(monkeypatch):
    page = _Page()
    counts = iter((0, 1))
    navigations: list[str] = []
    monkeypatch.setattr(runner, "_public_exact_text_count", lambda _page, _text: next(counts))
    monkeypatch.setattr(runner, "_goto", lambda _page, url, _logger, _stage: navigations.append(url))
    monkeypatch.setattr(runner, "_warmup_scroll", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(runner, "_screenshot", lambda *_args, **_kwargs: "/data/social_automation/screenshots/proof.png")

    result = runner._verify_public_text_after_reload(
        page,
        {"id": "task-1"},
        target_url=page.url,
        text="exact CRM comment",
        screenshot_dir="/tmp",
        logger=object(),
        stage="comment",
        cancel_event=None,
    )

    assert navigations == [page.url]
    assert result["verified"] is True
    assert result["platform_visible"] is True
    assert result["confirmation_source"] == "exact_text_after_reload"
    assert len(result["content_hash"]) == 64


def test_public_text_missing_after_reload_is_unknown(monkeypatch):
    page = _Page()
    monkeypatch.setattr(runner, "_public_exact_text_count", lambda _page, _text: 0)
    monkeypatch.setattr(runner, "_goto", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(runner, "_warmup_scroll", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(runner, "_screenshot", lambda *_args, **_kwargs: "/data/social_automation/screenshots/unknown.png")

    with pytest.raises(runner.ActionOutcomeUnknownError) as caught:
        runner._verify_public_text_after_reload(
            page,
            {"id": "task-2"},
            target_url=page.url,
            text="not visible",
            screenshot_dir="/tmp",
            logger=object(),
            stage="reply",
            cancel_event=None,
        )

    assert caught.value.action_outcome_unknown is True
    assert caught.value.retryable is False


def test_share_copy_is_explicitly_not_a_confirmed_write():
    with pytest.raises(runner.UnsupportedActionError, match="Copy link is not a share write"):
        runner._run_share_post(
            _Page(), {}, {"target_url": _Page.url}, "/tmp", object(),
        )

from __future__ import annotations

from social_automation import runner


class _Page:
    def __init__(self, url: str, evaluated: dict):
        self.url = url
        self.evaluated = evaluated
        self.evaluate_calls: list[tuple[str, dict]] = []

    def evaluate(self, script: str, payload: dict):
        self.evaluate_calls.append((script, payload))
        return self.evaluated


def test_feed_collection_returns_only_dom_confirmed_platform_identities(monkeypatch):
    page = _Page(
        "https://www.threads.net/",
        {
            "page_url": "https://www.threads.net/",
            "title": "Threads",
            "semantic_containers": 3,
            "visible_text_length": 900,
            "candidates": [
                {
                    "username": "Lead.One",
                    "display_name": "Lead One",
                    "profile_url": "https://www.threads.com/@Lead.One",
                    "source_url": "https://www.threads.com/@Lead.One/post/abc?tracking=1",
                    "text": "Visible post text",
                    "metrics": {"like_count": "12", "reply_count": 3},
                    "dom_confirmed": True,
                    "evidence": {
                        "container": "ARTICLE",
                        "post_href": "https://www.threads.com/@Lead.One/post/abc",
                        "has_time": True,
                        "visible_text_sample": "Lead One Visible post text",
                    },
                },
                {
                    "username": "not-visible",
                    "profile_url": "https://www.threads.net/@not-visible",
                    "dom_confirmed": False,
                },
                {
                    "username": "foreign",
                    "profile_url": "https://example.com/@foreign",
                    "dom_confirmed": True,
                },
            ],
        },
    )
    monkeypatch.setattr(runner, "_goto", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(runner, "_warmup_scroll", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(runner, "_screenshot", lambda *_args, **_kwargs: "/proof/feed.png")

    result = runner._run_browse_feed(
        page,
        {"id": "collect-1"},
        {"limit": 20},
        "/tmp",
        object(),
        platform="threads",
    )

    assert result["collection_status"] == "collected"
    assert result["collected"] == 1
    assert result["items"] == [
        {
            "platform": "threads",
            "username": "lead.one",
            "display_name": "Lead One",
            "profile_url": "https://www.threads.net/@Lead.One",
            "source_url": "https://www.threads.net/@Lead.One/post/abc",
            "text": "Visible post text",
            "tags": ["source:visible_dom", "channel:threads"],
            "like_count": 12,
            "reply_count": 3,
            "repost_count": 0,
            "quote_count": 0,
            "evidence": {
                "dom_confirmed": True,
                "container": "ARTICLE",
                "profile_href": "https://www.threads.net/@Lead.One",
                "post_href": "https://www.threads.net/@Lead.One/post/abc",
                "has_time": True,
                "visible_text_sample": "Lead One Visible post text",
            },
        }
    ]
    assert page.evaluate_calls[0][1] == {"platform": "threads", "surface": "feed", "limit": 20}


def test_empty_collection_is_explicit_and_does_not_invent_leads():
    page = _Page(
        "https://www.instagram.com/",
        {
            "page_url": "https://www.instagram.com/",
            "title": "Instagram",
            "semantic_containers": "not-a-number",
            "visible_text_length": None,
            "empty_reason": "no_dom_verified_profile_links",
            "candidates": [],
        },
    )

    result = runner._extract_visible_collection_items(
        page,
        platform="instagram",
        surface="feed",
        limit=50,
    )

    assert result["items"] == []
    assert result["collected"] == 0
    assert result["collection_status"] == "empty"
    assert result["collection_reason"] == "no_dom_verified_profile_links"
    assert result["dom_evidence"]["semantic_containers"] == 0


def test_directed_feed_collection_submits_query_before_extracting(monkeypatch):
    page = _Page(
        "https://www.threads.net/",
        {
            "page_url": "https://www.threads.net/search?q=mortgage",
            "title": "Search",
            "semantic_containers": 0,
            "visible_text_length": 20,
            "candidates": [],
        },
    )
    searches: list[tuple[str, str]] = []
    monkeypatch.setattr(runner, "_goto", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(runner, "_warmup_scroll", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(runner, "_screenshot", lambda *_args, **_kwargs: "/proof/search.png")
    monkeypatch.setattr(
        runner,
        "_search_warmup_interest_surface",
        lambda _page, platform, query, _logger: searches.append((platform, query)) or "visible_search_ui",
    )

    result = runner._run_browse_feed(
        page,
        {"id": "collect-search"},
        {"query": "  mortgage   refinance ", "limit": 12},
        "/tmp",
        object(),
        platform="threads",
    )

    assert searches == [("threads", "mortgage refinance")]
    assert result["query"] == "mortgage refinance"
    assert result["search_driver"] == "visible_search_ui"
    assert page.evaluate_calls[0][1] == {
        "platform": "threads",
        "surface": "search:mortgage refinance",
        "limit": 12,
    }


def test_threads_profile_collection_preserves_native_navigation_logic(monkeypatch):
    page = _Page(
        "https://www.threads.net/",
        {
            "page_url": "https://www.threads.net/@lead.one",
            "title": "Lead One on Threads",
            "semantic_containers": 0,
            "visible_text_length": 120,
            "candidates": [
                {
                    "username": "lead.one",
                    "display_name": "Lead One",
                    "profile_url": "https://www.threads.net/@lead.one",
                    "source_url": "https://www.threads.net/@lead.one",
                    "text": "@lead.one visible profile biography",
                    "metrics": {},
                    "dom_confirmed": True,
                    "evidence": {"container": "main", "profile_href": "https://www.threads.net/@lead.one"},
                }
            ],
        },
    )
    navigated: list[str] = []

    def fake_goto(target_page, url, _logger, _stage):
        navigated.append(url)
        target_page.url = url

    monkeypatch.setattr(runner, "_goto", fake_goto)
    monkeypatch.setattr(runner, "_warmup_scroll", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(runner, "_screenshot", lambda *_args, **_kwargs: "/proof/profile.png")

    result = runner._run_browse_profile(
        page,
        {"id": "profile-1"},
        {"username": "@Lead.One"},
        "/tmp",
        object(),
        platform="threads",
    )

    assert navigated == ["https://www.threads.net/@lead.one"]
    assert result["platform"] == "threads"
    assert result["collected"] == 1
    assert result["items"][0]["username"] == "lead.one"
    assert page.evaluate_calls[0][1]["surface"] == "profile"
